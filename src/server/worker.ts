import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '../shared/types.ts';
import { Store } from './store.ts';
import { adapters } from './adapters.ts';

export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private active = new Set<string>();
  private stopped = false;

  constructor(private store: Store, private onChange: () => void, private workspaceRoot = join(process.cwd(), 'data', 'workspaces')) {}

  start() { this.stopped = false; this.timer = setInterval(() => void this.tick(), 2000); void this.tick(); }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick() {
    if (this.stopped) return;
    for (const task of this.store.dueTasks()) {
      if (this.active.size >= 2) break;
      if (this.active.has(task.id)) continue;
      this.active.add(task.id);
      void this.run(task).finally(() => this.active.delete(task.id));
    }
  }

  private async run(task: Task) {
    const adapter = adapters[task.engine];
    if (!adapter?.available()) {
      this.store.updateTask(task.id, { status: 'failed', error: `${task.engine} 内核尚未配置或安装。` });
      this.store.addEntry('system', `${task.engine} 内核不可用，任务没有执行。配置后可重试。`, task.id);
      this.onChange();
      return;
    }
    this.store.updateTask(task.id, { status: 'working', error: null });
    this.store.addEntry('system', `使用 ${task.engine} 开始处理。`, task.id);
    this.onChange();
    try {
      const workspace = join(this.workspaceRoot, task.id);
      mkdirSync(workspace, { recursive: true });
      const decision = await adapter.run({
        prompt: task.instruction, priorResult: task.result, sessionId: task.agentSessionId,
        workspace,
        onEvent: message => { this.store.addEntry('system', message, task.id); this.onChange(); },
      });
      const current = this.store.getTask(task.id);
      if (!current || current.status !== 'working') return;
      const nextMinutes = Math.max(1, Math.min(1440, Math.floor(decision.nextMinutes || current.scheduleMinutes || 15)));
      const nextRunAt = decision.status === 'scheduled' || (current.scheduleMinutes && decision.status === 'done')
        ? new Date(Date.now() + nextMinutes * 60_000).toISOString() : null;
      const status = current.scheduleMinutes && decision.status === 'done' ? 'scheduled' : decision.status;
      this.store.updateTask(task.id, {
        status, result: decision.status === 'done' ? decision.message : current.result,
        nextRunAt, error: null, agentSessionId: decision.sessionId || current.agentSessionId,
      });
      this.store.addEntry('dot', decision.message, task.id);
      this.onChange();
    } catch (error) {
      const current = this.store.getTask(task.id);
      if (!current || current.status !== 'working') return;
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateTask(task.id, { status: 'failed', error: message.slice(0, 400) });
      this.store.addEntry('system', `执行失败：${message.slice(0, 400)}`, task.id);
      this.onChange();
    }
  }
}
