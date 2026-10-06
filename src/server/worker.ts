import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '../shared/types.ts';
import { nextScheduleOccurrence, scheduleForTask } from '../shared/scheduling.ts';
import { Store } from './store.ts';
import { adapters, formatAgentPrompt, parseDecision, type AgentRequest, type Engine } from './adapters.ts';
import type { ComputerRuntime } from './computer.ts';
import { loadModelSettings } from './model-settings.ts';
import { sendDesktopNotification, type DesktopNotifier } from './notifications.ts';

export class Worker {
  private static readonly maxActiveTasks = 4;
  private static readonly maxActiveTasksPerTenant = 3;
  private timer: NodeJS.Timeout | null = null;
  private active = new Set<string>();
  private abortControllers = new Map<string, AbortController>();
  private activeByTenant = new Map<string, number>();
  private stopped = false;

  constructor(private store: Store, private onChange: () => void, private workspaceRoot = join(process.cwd(), 'data', 'workspaces'), private notify: DesktopNotifier = sendDesktopNotification, private computerFor?: (tenantId: string) => ComputerRuntime) {}

  start() { this.stopped = false; this.timer = setInterval(() => void this.tick(), 2000); void this.tick(); }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; }
  pauseTask(taskId: string) { this.abortControllers.get(taskId)?.abort(new Error('Task paused by user')); }
  stopTask(taskId: string) { this.abortControllers.get(taskId)?.abort(new Error('Task stopped by user')); }

  async tick() {
    if (this.stopped) return;
    this.store.releaseReadyDelegations();
    for (const task of this.store.dueTasks()) {
      if (this.active.size >= Worker.maxActiveTasks) break;
      if (this.active.has(task.id)) continue;
      const tenantActive = this.activeByTenant.get(task.tenantId) || 0;
      if (tenantActive >= Worker.maxActiveTasksPerTenant) continue;
      this.active.add(task.id);
      const controller = new AbortController();
      this.abortControllers.set(task.id, controller);
      this.activeByTenant.set(task.tenantId, tenantActive + 1);
      void this.run(task, controller.signal).finally(() => {
        this.active.delete(task.id);
        if (this.abortControllers.get(task.id) === controller) this.abortControllers.delete(task.id);
        const count = (this.activeByTenant.get(task.tenantId) || 1) - 1;
        if (count > 0) this.activeByTenant.set(task.tenantId, count);
        else this.activeByTenant.delete(task.tenantId);
        void this.tick();
      });
    }
  }

  private async run(task: Task, signal: AbortSignal) {
    loadModelSettings(this.store.getSetting('modelBaseUrl', task.tenantId), this.store.getSetting('modelName', task.tenantId), task.tenantId);
    const adapter = adapters[task.engine];
    const computer = this.computerFor?.(task.tenantId);
    const remoteEngines = parseRemoteEngines();
    const useDesktopRuntime = Boolean(computer?.runAgentTask && process.env.DOTS_COMPUTER_BACKEND === 'linux-desktop' && remoteEngines.includes(task.engine));
    if (!useDesktopRuntime && !adapter?.available(task.tenantId)) {
      this.store.updateTask(task.id, { status: 'failed', error: `${task.engine} 内核尚未配置或安装。` }, task.tenantId);
      this.store.addEntry('system', `${task.engine} 内核不可用，任务没有执行。配置后可重试。`, task.id, task.tenantId);
      this.notifyIfEnabled(task.tenantId, `“${task.title}”无法开始，需要检查工作区设置。`);
      this.onChange();
      return;
    }
    const availableEngines = (Object.keys(adapters) as Engine[]).filter(engine => adapters[engine].available(task.tenantId));
    for (const engine of remoteEngines) if (!availableEngines.includes(engine)) availableEngines.push(engine);
    this.store.updateTask(task.id, { status: 'working', error: null }, task.tenantId);
    this.store.addEntry('system', `使用 ${task.engine} 开始处理。`, task.id, task.tenantId);
    this.onChange();
    try {
      const workspace = join(this.workspaceRoot, task.tenantId, task.id);
      mkdirSync(workspace, { recursive: true });
      const children = this.store.delegatedTasks(task.id, task.tenantId);
      const input: AgentRequest = {
        tenantId: task.tenantId, prompt: task.instruction, memories: this.store.tenantMemories(task.tenantId).map(memory => memory.note),
        pages: this.store.tenantPages(task.tenantId).slice(0, 10).map(({ id, title, content }) => ({ id, title, content })),
        actionRule: this.store.tenantActionRule(task.tenantId),
        allowDelegation: !task.parentTaskId && children.length === 0,
        availableEngines,
        delegatedResults: children.map(child => ({ title: child.title, status: child.status, result: child.result, error: child.error })),
        priorResult: task.result, sessionId: task.agentSessionId,
        workspace,
        signal,
        onEvent: message => { this.store.addEntry('system', message, task.id, task.tenantId); this.onChange(); },
      };
      const decision = useDesktopRuntime
        ? parseDecision(JSON.stringify(await computer!.runAgentTask!({ engine: task.engine, taskId: task.id, prompt: formatAgentPrompt(input), sessionId: task.agentSessionId, signal })), task.agentSessionId || undefined, { allowDelegation: input.allowDelegation, availableEngines })
        : await adapter.run(input);
      const current = this.store.getTask(task.id, task.tenantId);
      if (!current || current.status !== 'working') return;
      if (task.parentTaskId && decision.status === 'scheduled') throw new Error('子任务不能创建周期安排');
      if (decision.status === 'delegating') {
        const delegated = this.store.createDelegatedTasks(task.id, task.tenantId, decision.delegations || [], decision.message, decision.sessionId);
        this.notifyIfEnabled(task.tenantId, `“${task.title}”已拆分为 ${delegated.length} 项并行工作。`);
        this.onChange();
        return;
      }
      const nextMinutes = Math.max(1, Math.min(1440, Math.floor(decision.nextMinutes || current.scheduleMinutes || 15)));
      const recurrence = scheduleForTask(current.scheduleSpec, current.scheduleMinutes);
      const shouldContinueSchedule = recurrence && ['done', 'scheduled'].includes(decision.status);
      const nextRunAt = shouldContinueSchedule
        ? nextScheduleOccurrence(recurrence, new Date())
        : decision.status === 'scheduled' ? new Date(Date.now() + nextMinutes * 60_000).toISOString() : null;
      const status = shouldContinueSchedule ? nextRunAt ? 'scheduled' : 'done' : decision.status;
      const actionRule = this.store.tenantActionRule(task.tenantId);
      let outputMessage = decision.message;
      if (decision.pageAction) {
        if (actionRule?.mode === 'ask-before') {
          this.store.requestPageActionApproval(task.tenantId, task.id, decision.pageAction, decision.message, status === 'scheduled' ? 'scheduled' : 'done', nextRunAt, decision.sessionId || current.agentSessionId);
          this.notifyIfEnabled(task.tenantId, `“${task.title}”正在等待你批准 Scratchpad 页面写入。`);
          this.onChange();
          return;
        }
        if (actionRule?.mode === 'hand-off') {
          const message = `我没有修改 Scratchpad。请由你自行${decision.pageAction.action === 'create' ? '创建' : '编辑'}页面「${decision.pageAction.title}」；完成后可以在这里告诉我继续。`;
          this.store.updateTask(task.id, { status: 'waiting', nextRunAt: null, error: null }, task.tenantId);
          this.store.addEntry('dot', message, task.id, task.tenantId);
          this.store.addEntry('system', '按工作区规则将 Scratchpad 写入交由用户手动完成；页面未更改。', task.id, task.tenantId);
          this.notifyIfEnabled(task.tenantId, `“${task.title}”需要你手动处理 Scratchpad 页面。`);
          this.onChange();
          return;
        }
        if ((actionRule?.mode || 'when-requested') === 'when-requested' && !explicitScratchpadRequest(task.instruction)) {
          const message = '我没有修改 Scratchpad，因为当前规则只允许在你明确要求创建或更新页面时执行。请说明要创建或修改哪一页，我再继续。';
          this.store.updateTask(task.id, { status: 'waiting', nextRunAt: null, error: null }, task.tenantId);
          this.store.addEntry('dot', message, task.id, task.tenantId);
          this.store.addEntry('system', '当前工作区规则要求明确的 Scratchpad 页面指令；页面未更改。', task.id, task.tenantId);
          this.notifyIfEnabled(task.tenantId, `“${task.title}”正在等待你确认 Scratchpad 页面操作。`);
          this.onChange();
          return;
        }
        const page = decision.pageAction.action === 'create'
          ? this.store.createTenantPage(task.tenantId, decision.pageAction.title, decision.pageAction.content, null, task.id)
          : this.store.updateTenantPage(task.tenantId, decision.pageAction.pageId, decision.pageAction.title, decision.pageAction.content);
        if (!page) throw new Error('找不到这个工作区里的 Scratchpad 页面，页面没有被修改。');
        const actionText = decision.pageAction.action === 'create' ? '创建' : '更新';
        this.store.addEntry('system', `Dot ${actionText}了 Scratchpad 页面「${page.title}」。`, task.id, task.tenantId);
        outputMessage += `\n[[page:${page.id}|${encodeURIComponent(page.title)}]]`;
      }
      this.store.updateTask(task.id, {
        status, result: decision.status === 'done' ? decision.message : current.result,
        nextRunAt, error: null, agentSessionId: decision.sessionId || current.agentSessionId,
      }, task.tenantId);
      this.store.addEntry('dot', outputMessage, task.id, task.tenantId);
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

function parseRemoteEngines(): Engine[] {
  if (process.env.DOTS_COMPUTER_BACKEND !== 'linux-desktop') return [];
  try {
    const configured = JSON.parse(process.env.DOTS_AGENT_KERNELS_JSON || '{}') as Record<string, unknown>;
    return (Object.keys(configured) as string[]).filter((engine): engine is Engine => ['claude', 'pi', 'dsh'].includes(engine) && Boolean(configured[engine]));
  } catch { return []; }
}

function explicitScratchpadRequest(instruction: string) {
  return /(scratchpad|page|pages|note|notes|页面|便笺|笔记)/i.test(instruction)
    && /(create|make|write|add|update|edit|改|创建|新增|写|更新|修改|编辑)/i.test(instruction);
}
