import type { Task } from '../shared/types.ts';
import { Store } from './store.ts';

export interface ModelConfig { baseUrl: string; model: string; apiKey: string }
export const modelConfig = (): ModelConfig | null => {
  const apiKey = process.env.DOTS_MODEL_API_KEY?.trim();
  const model = process.env.DOTS_MODEL?.trim();
  if (!apiKey || !model) return null;
  return { apiKey, model, baseUrl: (process.env.DOTS_MODEL_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '') };
};

type Decision = { status: 'done' | 'waiting' | 'scheduled'; message: string; nextMinutes?: number };

export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private active = new Set<string>();
  private stopped = false;

  constructor(private store: Store, private onChange: () => void) {}

  start() {
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), 2000);
    void this.tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

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
    const config = modelConfig();
    if (!config) {
      this.store.updateTask(task.id, { status: 'failed', error: '未配置 DOTS_MODEL 和 DOTS_MODEL_API_KEY。' });
      this.store.addEntry('system', '模型未配置，任务没有执行。配置后可重试。', task.id);
      this.onChange();
      return;
    }
    this.store.updateTask(task.id, { status: 'working', error: null });
    this.store.addEntry('system', '开始处理。', task.id);
    this.onChange();
    try {
      const decision = await decide(task, config);
      const current = this.store.getTask(task.id);
      if (!current || current.status !== 'working') return; // Paused or redirected during the call.
      const nextMinutes = Math.max(1, Math.min(1440, Math.floor(decision.nextMinutes || current.scheduleMinutes || 15)));
      const nextRunAt = decision.status === 'scheduled' || current.scheduleMinutes
        ? new Date(Date.now() + nextMinutes * 60_000).toISOString() : null;
      const status = current.scheduleMinutes && decision.status === 'done' ? 'scheduled' : decision.status;
      this.store.updateTask(task.id, {
        status,
        result: decision.status === 'done' ? decision.message : current.result,
        nextRunAt,
        error: null,
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

async function decide(task: Task, config: ModelConfig): Promise<Decision> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: 'You are a personal agent. Reply with one JSON object only: {"status":"done|waiting|scheduled","message":"...","nextMinutes":15}. No external tools are connected in this version. Never claim to have browsed, read files, sent messages, created artifacts, or completed an external action. If the user requests such work, choose waiting and explain what capability or information is needed. For a monitoring request, choose scheduled and describe the next check. Give a useful answer directly only when the supplied text is enough. Keep the message in the user language.' },
          { role: 'user', content: `Task: ${task.instruction}\nPrior result: ${task.result || '(none)'}\nCurrent time: ${new Date().toISOString()}` },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`模型服务返回 HTTP ${response.status}`);
    const data = await response.json() as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) throw new Error('模型没有返回内容');
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('模型没有返回结构化结果');
    const decision = JSON.parse(match[0]) as Partial<Decision>;
    if (!['done', 'waiting', 'scheduled'].includes(String(decision.status)) || typeof decision.message !== 'string' || !decision.message.trim()) {
      throw new Error('模型返回的任务状态无效');
    }
    return decision as Decision;
  } finally {
    clearTimeout(timeout);
  }
}
