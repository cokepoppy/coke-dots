import { createHash } from 'node:crypto';
import { Store } from './store.ts';
import type { Watch } from '../shared/types.ts';
import { sendDesktopNotification, type DesktopNotifier } from './notifications.ts';

export function validateWatchUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) throw new Error('请填写不含凭据或锚点的 HTTPS 网址');
  return url.toString();
}

export function extractVisibleText(source: string, contentType: string): string {
  let text = source;
  if (contentType.includes('text/html')) {
    text = text
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<(br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article|main|header|footer|blockquote)\s*>/gi, '\n')
      .replace(/<[^>]*>/g, ' ');
  }
  return text
    .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&#(?:x([\da-f]+)|(\d+));?/gi, (entity, hexadecimal: string | undefined, decimal: string | undefined) => {
      const codePoint = Number.parseInt(hexadecimal || decimal || '', hexadecimal ? 16 : 10);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : ' ';
    })
    .replace(/[\t\r\n\f ]+/g, ' ')
    .trim()
    .slice(0, 12_000);
}

export class WatchRunner {
  private active = new Map<string, { tenantId: string; controller: AbortController; completion: Promise<void> }>();
  private resettingTenants = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  constructor(private store: Store, private onChange: () => void, private fetcher: typeof fetch = fetch, private notify: DesktopNotifier = sendDesktopNotification) {}

  start() { this.timer = setInterval(() => void this.tick(), 30_000); void this.tick(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  pauseWorkspace(tenantId: string) {
    for (const [watchId, active] of this.active) {
      if (active.tenantId === tenantId) active.controller.abort(new Error('Dot paused by user'));
    }
  }

  async beginWorkspaceReset(tenantId: string) {
    this.resettingTenants.add(tenantId);
    const checks = [...this.active.values()].filter(item => item.tenantId === tenantId);
    for (const check of checks) check.controller.abort(new Error('Dot reset by user'));
    await Promise.all(checks.map(check => check.completion.catch(() => undefined)));
  }

  endWorkspaceReset(tenantId: string) {
    this.resettingTenants.delete(tenantId);
    void this.tick();
  }

  async tick() {
    for (const watch of this.store.dueWatches()) {
      if (this.resettingTenants.has(watch.tenantId)) continue;
      if (this.store.isDotPaused(watch.tenantId)) continue;
      if (this.active.size >= 2) break;
      if (this.active.has(watch.id)) continue;
      const controller = new AbortController();
      const active = { tenantId: watch.tenantId, controller, completion: Promise.resolve() };
      this.active.set(watch.id, active);
      active.completion = this.check(watch, controller.signal).finally(() => this.active.delete(watch.id));
    }
  }

  private async check(watch: Watch, signal: AbortSignal) {
    const nextCheckAt = new Date(Date.now() + watch.intervalMinutes * 60_000).toISOString();
    // Reserve the next check before network I/O, so a restart cannot send duplicate checks.
    this.store.updateWatch(watch.id, { nextCheckAt }, watch.tenantId);
    this.onChange();
    try {
      const response = await this.fetcher(watch.url, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), headers: { accept: 'text/html,text/plain;q=0.9' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('text/plain')) throw new Error('页面不是 HTML 或纯文本');
      const reader = response.body?.getReader();
      if (!reader) throw new Error('没有可读取的页面内容');
      const decoder = new TextDecoder();
      let source = '';
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 1_000_000) throw new Error('页面超过 1 MB 检查上限');
          source += decoder.decode(value, { stream: true });
        }
      } finally { reader.releaseLock(); }
      source += decoder.decode();
      const content = extractVisibleText(source, contentType);
      const digest = createHash('sha256').update(content).digest('hex');
      if (signal.aborted) { this.onChange(); return; }
      const result = this.store.recordWatchResponse(watch.id, watch.tenantId, digest, content, new Date().toISOString(), nextCheckAt);
      if (result.outcome === 'changed') {
        this.store.addEntry('dot', `检测到页面内容变化：${watch.url}`, null, watch.tenantId);
        this.notifyIfEnabled(watch.tenantId, '你关注的网页有变化，已启动只读分析。');
      }
      this.onChange();
    } catch (error) {
      if (signal.aborted) { this.onChange(); return; }
      const message = error instanceof Error ? error.message : String(error);
      const current = this.store.getWatch(watch.id, watch.tenantId);
      if (current?.status === 'active') this.store.updateWatch(watch.id, { lastCheckedAt: new Date().toISOString(), lastStatus: '检查失败', error: message.slice(0, 300) }, watch.tenantId);
      this.store.addEntry('system', `页面检查失败：${watch.url}（${message.slice(0, 150)}）`, null, watch.tenantId);
      this.onChange();
    }
  }

  private notifyIfEnabled(tenantId: string, body: string) {
    if (this.store.getSetting('desktopNotifications', tenantId) !== 'true') return;
    try { this.notify(this.store.getProfile(tenantId).name, body); }
    catch { /* A desktop notification must never stop a watch check. */ }
  }
}
