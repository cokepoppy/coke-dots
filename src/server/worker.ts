import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '../shared/types.ts';
import { Store } from './store.ts';
import { adapters } from './adapters.ts';
import { loadModelSettings } from './model-settings.ts';
import { sendDesktopNotification, type DesktopNotifier } from './notifications.ts';

export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private active = new Set<string>();
  private activeByTenant = new Map<string, number>();
  private stopped = false;

  constructor(private store: Store, private onChange: () => void, private workspaceRoot = join(process.cwd(), 'data', 'workspaces'), private notify: DesktopNotifier = sendDesktopNotification) {}

  start() { this.stopped = false; this.timer = setInterval(() => void this.tick(), 2000); void this.tick(); }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick() {
    if (this.stopped) return;
    for (const task of this.store.dueTasks()) {
      if (this.active.size >= 4) break;
      if (this.active.has(task.id)) continue;
      const tenantActive = this.activeByTenant.get(task.tenantId) || 0;
      if (tenantActive >= 2) continue;
      this.active.add(task.id);
      this.activeByTenant.set(task.tenantId, tenantActive + 1);
      void this.run(task).finally(() => {
        this.active.delete(task.id);
        const count = (this.activeByTenant.get(task.tenantId) || 1) - 1;
        if (count > 0) this.activeByTenant.set(task.tenantId, count);
        else this.activeByTenant.delete(task.tenantId);
      });
    }
  }

  private async run(task: Task) {
    loadModelSettings(this.store.getSetting('modelBaseUrl', task.tenantId), this.store.getSetting('modelName', task.tenantId), task.tenantId);
    const adapter = adapters[task.engine];
    if (!adapter?.available(task.tenantId)) {
      this.store.updateTask(task.id, { status: 'failed', error: `${task.engine} 内核尚未配置或安装。` }, task.tenantId);
      this.store.addEntry('system', `${task.engine} 内核不可用，任务没有执行。配置后可重试。`, task.id, task.tenantId);
      this.notifyIfEnabled(task.tenantId, `“${task.title}”无法开始，需要检查工作区设置。`);
      this.onChange();
      return;
    }
    this.store.updateTask(task.id, { status: 'working', error: null }, task.tenantId);
    this.store.addEntry('system', `使用 ${task.engine} 开始处理。`, task.id, task.tenantId);
    this.onChange();
    try {
      const workspace = join(this.workspaceRoot, task.tenantId, task.id);
      mkdirSync(workspace, { recursive: true });
      const decision = await adapter.run({
        tenantId: task.tenantId, prompt: task.instruction, priorResult: task.result, sessionId: task.agentSessionId,
        workspace,
        onEvent: message => { this.store.addEntry('system', message, task.id, task.tenantId); this.onChange(); },
      });
      const current = this.store.getTask(task.id, task.tenantId);
      if (!current || current.status !== 'working') return;
      const nextMinutes = Math.max(1, Math.min(1440, Math.floor(decision.nextMinutes || current.scheduleMinutes || 15)));
      const nextRunAt = decision.status === 'scheduled' || (current.scheduleMinutes && decision.status === 'done')
        ? new Date(Date.now() + nextMinutes * 60_000).toISOString() : null;
      const status = current.scheduleMinutes && decision.status === 'done' ? 'scheduled' : decision.status;
      this.store.updateTask(task.id, {
        status, result: decision.status === 'done' ? decision.message : current.result,
        nextRunAt, error: null, agentSessionId: decision.sessionId || current.agentSessionId,
      }, task.tenantId);
      this.store.addEntry('dot', decision.message, task.id, task.tenantId);
      if (decision.status === 'waiting') this.notifyIfEnabled(task.tenantId, `“${task.title}”正在等待你的回复。`);
      else if (decision.status === 'done') this.notifyIfEnabled(task.tenantId, `“${task.title}”已有新结果。`);
      this.onChange();
    } catch (error) {
      const current = this.store.getTask(task.id, task.tenantId);
      if (!current || current.status !== 'working') return;
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateTask(task.id, { status: 'failed', error: message.slice(0, 400) }, task.tenantId);
      this.store.addEntry('system', `执行失败：${message.slice(0, 400)}`, task.id, task.tenantId);
      this.notifyIfEnabled(task.tenantId, `“${task.title}”执行失败，需要你查看。`);
      this.onChange();
    }
  }

  private notifyIfEnabled(tenantId: string, body: string) {
    if (this.store.getSetting('desktopNotifications', tenantId) !== 'true') return;
    try { this.notify(this.store.getProfile(tenantId).name, body); }
    catch { /* A desktop notification must never stop background work. */ }
  }
}
