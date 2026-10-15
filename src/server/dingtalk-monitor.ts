import type { DingTalkService, DingTalkMonitorPrincipal } from './dingtalk.ts';
import type { Store, DingTalkGroupSelection } from './store.ts';

type MonitorState = 'starting' | 'listening' | 'reconnecting';
type EnabledMonitor = DingTalkGroupSelection & { tenantId: string; userId: string; conversationId: string; enabled: boolean };

interface ActiveMonitor { controller: AbortController; state: MonitorState }

export class DingTalkMonitorSupervisor {
  private readonly active = new Map<string, ActiveMonitor>();
  private timer: NodeJS.Timeout | null = null;
  private reconciling = false;
  private stopped = false;

  constructor(
    private readonly store: Store,
    private readonly dingtalk: Pick<DingTalkService, 'watchGroupMessages'>,
    private readonly onChange: () => void = () => undefined,
  ) {}

  start() {
    this.stopped = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => { void this.reconcile(); }, 5_000);
    void this.reconcile();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const monitor of this.active.values()) monitor.controller.abort();
    this.active.clear();
  }

  status(tenantId: string, userId: string, conversationId: string): MonitorState | 'off' {
    return this.active.get(keyOf({ tenantId, userId, conversationId }))?.state || 'starting';
  }

  async reconcile() {
    if (this.stopped || this.reconciling) return;
    this.reconciling = true;
    try {
      const desired = this.store.enabledDingtalkGroupMonitors();
      const desiredKeys = new Set(desired.map(keyOf));
      for (const [key, monitor] of this.active) {
        if (!desiredKeys.has(key)) {
          monitor.controller.abort();
          this.active.delete(key);
        }
      }
      for (const row of desired) {
        const key = keyOf(row);
        if (!this.active.has(key)) this.launch(row);
      }
    } finally { this.reconciling = false; }
  }

  private launch(row: EnabledMonitor) {
    const monitor: ActiveMonitor = { controller: new AbortController(), state: 'starting' };
    const key = keyOf(row);
    this.active.set(key, monitor);
    void this.run(row, monitor).finally(() => {
      if (this.active.get(key) === monitor) this.active.delete(key);
      this.onChange();
    });
  }

  private async run(row: EnabledMonitor, active: ActiveMonitor) {
    const principal: DingTalkMonitorPrincipal = { tenantId: row.tenantId, userId: row.userId };
    let retryMs = 1_000;
    while (!active.controller.signal.aborted && !this.stopped) {
      try {
        for await (const frame of this.dingtalk.watchGroupMessages(principal, row.conversationId, active.controller.signal)) {
          if (active.controller.signal.aborted || this.stopped) return;
          if (frame.type === 'ready') {
            active.state = 'listening';
            retryMs = 1_000;
            this.onChange();
            continue;
          }
          if (frame.type !== 'message') continue;
          const message = frame.message;
          if (message.conversationId !== row.conversationId) continue;
          const result = this.store.ingestDingtalkMessage({
            corpId: row.corpId,
            conversationId: row.conversationId,
            messageId: message.messageId,
            senderId: message.senderId,
            senderName: message.senderName,
            text: message.text,
          });
          if (result.tasks.length) this.onChange();
        }
      } catch {
        if (active.controller.signal.aborted || this.stopped) return;
      }
      if (active.controller.signal.aborted || this.stopped) return;
      active.state = 'reconnecting';
      this.onChange();
      await delay(retryMs, active.controller.signal);
      retryMs = Math.min(retryMs * 2, 60_000);
      if (!active.controller.signal.aborted) active.state = 'starting';
    }
  }
}

function keyOf(value: { tenantId: string; userId: string; conversationId: string }) {
  return `${value.tenantId}\0${value.userId}\0${value.conversationId}`;
}

function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
