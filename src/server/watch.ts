import { createHash } from 'node:crypto';
import { Store } from './store.ts';
import type { Watch } from '../shared/types.ts';
import { sendDesktopNotification, type DesktopNotifier } from './notifications.ts';

export function validateWatchUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) throw new Error('请填写不含凭据或锚点的 HTTPS 网址');
  return url.toString();
}

export class WatchRunner {
  private active = new Map<string, { tenantId: string; controller: AbortController }>();
  private timer: NodeJS.Timeout | null = null;
  constructor(private store: Store, private onChange: () => void, private fetcher: typeof fetch = fetch, private notify: DesktopNotifier = sendDesktopNotification) {}

  start() { this.timer = setInterval(() => void this.tick(), 30_000); void this.tick(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  pauseWorkspace(tenantId: string) {
    for (const [watchId, active] of this.active) {
      if (active.tenantId === tenantId) active.controller.abort(new Error('Dot paused by user'));
    }
  }

  async tick() {
    for (const watch of this.store.dueWatches()) {
      if (this.store.isDotPaused(watch.tenantId)) continue;
      if (this.active.size >= 2) break;
      if (this.active.has(watch.id)) continue;
      const controller = new AbortController();
      this.active.set(watch.id, { tenantId: watch.tenantId, controller });
      void this.check(watch, controller.signal).finally(() => this.active.delete(watch.id));
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
      const hash = createHash('sha256');
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 1_000_000) throw new Error('页面超过 1 MB 检查上限');
          hash.update(value);
        }
      } finally { reader.releaseLock(); }
      const digest = hash.digest('hex');
      const previous = this.store.watchHash(watch.id, watch.tenantId);
      if (previous && previous !== digest) {
        this.store.addEntry('dot', `检测到页面内容变化：${watch.url}`, null, watch.tenantId);
        this.notifyIfEnabled(watch.tenantId, '你关注的网页有新变化。');
      }
      const current = this.store.getWatch(watch.id, watch.tenantId);
      if (current?.status === 'active') this.store.updateWatch(watch.id, { lastHash: digest, lastCheckedAt: new Date().toISOString(), lastStatus: previous && previous !== digest ? '内容有变化' : previous ? '没有变化' : '已建立基线', error: null }, watch.tenantId);
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
