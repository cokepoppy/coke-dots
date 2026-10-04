import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { effectiveModelConfig } from './model-settings.ts';

const require = createRequire(import.meta.url);

export type Engine = 'model' | 'claude' | 'pi' | 'dsh';
export interface AgentRequest {
  prompt: string;
  priorResult: string | null;
  sessionId: string | null;
  workspace: string;
  onEvent: (message: string) => void;
}
export interface AgentDecision { status: 'done' | 'waiting' | 'scheduled'; message: string; nextMinutes?: number; sessionId?: string }
export interface AgentAdapter { id: Engine; available(): boolean; run(input: AgentRequest): Promise<AgentDecision> }

const instruction = 'You are a personal agent. Finish with one JSON object only: {"status":"done|waiting|scheduled","message":"...","nextMinutes":15}. Do not claim external actions you did not perform. Do not send messages, change external accounts, or edit files. If an action would require that access, choose waiting and explain the needed permission. For an ongoing check, choose scheduled. Use the user language.';
const formatPrompt = (input: AgentRequest) => `${instruction}\n\nTask: ${input.prompt}\nPrior result: ${input.priorResult || '(none)'}\nCurrent time: ${new Date().toISOString()}`;

export function parseDecision(raw: string, sessionId?: string): AgentDecision {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('代理没有返回结构化结果');
  const value = JSON.parse(match[0]) as Partial<AgentDecision>;
  if (!['done', 'waiting', 'scheduled'].includes(String(value.status)) || typeof value.message !== 'string' || !value.message.trim()) throw new Error('代理返回的任务状态无效');
  return { status: value.status!, message: value.message.trim(), nextMinutes: value.nextMinutes, sessionId };
}

export const adapters: Record<Engine, AgentAdapter> = {
  model: {
    id: 'model',
    available: () => Boolean(effectiveModelConfig()),
    async run(input) {
      const config = effectiveModelConfig();
      if (!config) throw new Error('模型尚未配置');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90_000);
      try {
        const response = await fetch(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
          body: JSON.stringify({ model: config.model, temperature: 0.2, messages: [{ role: 'system', content: instruction }, { role: 'user', content: formatPrompt(input) }] }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`模型服务返回 HTTP ${response.status}`);
        const data = await response.json() as { choices?: { message?: { content?: string } }[] };
        if (!data.choices?.[0]?.message?.content) throw new Error('模型没有返回内容');
        return parseDecision(data.choices[0].message.content);
      } finally { clearTimeout(timeout); }
    },
  },
  claude: {
    id: 'claude',
    available: () => Boolean(resolveExecutable(claudeBin())),
    async run(input) {
      const bin = claudeBin();
      const command = bin.endsWith('.js') ? 'node' : bin;
      const prefix = bin.endsWith('.js') ? [bin] : [];
      const sessionId = input.sessionId || randomUUID();
      const args = [...prefix, '--print', '--output-format', 'text', '--permission-mode', 'plan', '--tools', 'Read,Glob,Grep,WebSearch,WebFetch', '--disallowedTools', 'mcp__*', '--max-turns', '4'];
      if (input.sessionId) args.push('--resume', sessionId);
      else args.push('--session-id', sessionId);
      args.push(formatPrompt(input));
      const output = await runCommand(command, args, input.workspace, input.onEvent);
      return parseDecision(output, sessionId);
    },
  },
  pi: {
    id: 'pi',
    available: () => Boolean(process.env.DOTS_PI_ENABLED === '1' && packageAvailable('@mariozechner/pi-coding-agent')),
    async run(input) {
      const moduleName = '@mariozechner/pi-coding-agent';
      const sdk = await import(moduleName) as {
        createAgentSession: (options: Record<string, unknown>) => Promise<{ session: { prompt: (text: string) => Promise<void>; messages: unknown[]; sessionId: string; dispose: () => void; subscribe: (handler: (event: Record<string, unknown>) => void) => () => void } }>;
        SessionManager: { inMemory: (cwd: string) => unknown };
        createReadOnlyTools: (cwd: string) => unknown[];
      };
      const { session } = await sdk.createAgentSession({
        cwd: input.workspace,
        tools: sdk.createReadOnlyTools(input.workspace),
        sessionManager: sdk.SessionManager.inMemory(input.workspace),
      });
      const unsubscribe = session.subscribe(event => { if (event.type === 'tool_execution_start') input.onEvent('Pi 正在使用只读工具。'); });
      try {
        await session.prompt(formatPrompt(input));
        const assistant = [...session.messages].reverse().find((row: unknown) => (row as { role?: string }).role === 'assistant') as { content?: { type?: string; text?: string }[] } | undefined;
        const text = assistant?.content?.filter(item => item.type === 'text').map(item => item.text || '').join('\n') || '';
        return parseDecision(text);
      } finally { unsubscribe(); session.dispose(); }
    },
  },
  dsh: {
    id: 'dsh',
    available: () => Boolean(process.env.DOTS_DSH_READ_ONLY_CONFIG && process.env.DOTS_DSH_BIN && packageAvailable('@deepseek-ai/dsh-sdk-client')),
    async run(input) {
      const config = process.env.DOTS_DSH_READ_ONLY_CONFIG;
      const bin = process.env.DOTS_DSH_BIN;
      if (!config || !bin) throw new Error('DeepSeek Harness 需要显式配置只读 profile 与运行程序');
      accessSync(config, constants.R_OK);
      const moduleName = '@deepseek-ai/dsh-sdk-client';
      const sdk = await import(moduleName) as { DeepSeekHarness: new (options: Record<string, unknown>) => { run: (prompt: string, options: { sessionId?: string; onNotification: (row: { method: string }) => void }) => Promise<{ finalResponse: string; sessionId: string }>; close: () => Promise<void> } };
      const harness = new sdk.DeepSeekHarness({ launch: { command: bin, args: [config], cwd: input.workspace, env: process.env }, cwd: input.workspace });
      try {
        const result = await harness.run(formatPrompt(input), { sessionId: input.sessionId || undefined, onNotification: row => { if (row.method === 'session.event') input.onEvent('DeepSeek Harness 正在处理任务。'); } });
        return parseDecision(result.finalResponse, result.sessionId);
      } finally { await harness.close(); }
    },
  },
};

function resolveExecutable(bin: string): string | null {
  if (bin.includes('/')) { try { accessSync(bin, constants.R_OK); return bin; } catch { return null; } }
  for (const dir of (process.env.PATH || '').split(':')) {
    const path = join(dir, bin);
    try { accessSync(path, constants.X_OK); return path; } catch { /* keep searching */ }
  }
  return null;
}

function packageAvailable(name: string) { try { require.resolve(name); return true; } catch { return false; } }

function claudeBin() {
  if (process.env.DOTS_CLAUDE_BIN) return process.env.DOTS_CLAUDE_BIN;
  const nearby = resolve(process.cwd(), '../coke-codex-app/vendor/claude-code/cli.js');
  return resolveExecutable(nearby) || 'claude';
}

async function runCommand(command: string, args: string[], cwd: string, onEvent: (message: string) => void): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: resolve(cwd), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let error = '';
    const timeout = setTimeout(() => child.kill('SIGTERM'), 5 * 60_000);
    child.stdout.on('data', chunk => { output += chunk.toString(); if (output.length > 1_000_000) child.kill('SIGTERM'); });
    child.stderr.on('data', chunk => { error += chunk.toString(); if (error.length > 100_000) child.kill('SIGTERM'); });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timeout); if (code === 0) { onEvent('Claude Code 已返回结果。'); resolvePromise(output); } else reject(new Error(`Claude Code 退出码 ${code}: ${error.slice(-500)}`)); });
  });
}
