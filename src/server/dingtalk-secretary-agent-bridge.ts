import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export type DingTalkSecretaryAction = 'todo-create' | 'cokeclaw-send';

export interface DingTalkSecretaryAgentGrant {
  tenantId: string;
  userId: string;
  taskId: string;
  actions: DingTalkSecretaryAction[];
  expiresAt: number;
  nonce: string;
}

export interface DingTalkSecretaryAgentBridge {
  url: string;
  token: string;
  actions: DingTalkSecretaryAction[];
}

const audience = 'coke-dots-dingtalk-secretary-v1';
const grantLifetimeSeconds = 15 * 60;
const writeVerb = /(?:创建|安排|新增|设置|提醒|create|schedule|add|remind)/i;
const destructiveTodoVerb = /(?:删除|取消|完成|标记完成|delete|cancel|complete|finish)/i;
const todoObject = /(?:待办|任务提醒|个人任务|\btodo\b|\btasks?\b)/i;
const cokeclawTarget = /(?:cokeclaw|coke\s*claw)/i;
const messageVerb = /(?:发送|发到|发给|推送|通知|post|send|share)/i;

function requestedActions(instruction: string): DingTalkSecretaryAction[] {
  const actions: DingTalkSecretaryAction[] = [];
  if (todoObject.test(instruction) && writeVerb.test(instruction) && !destructiveTodoVerb.test(instruction)) actions.push('todo-create');
  if (cokeclawTarget.test(instruction) && messageVerb.test(instruction)) actions.push('cokeclaw-send');
  return actions;
}

export function createDingTalkSecretaryAgentBridge(input: {
  tenantId: string; userId: string; taskId: string; instruction: string;
  publicOrigin: string; basePath?: string; secret: string; now?: number;
}): DingTalkSecretaryAgentBridge | null {
  const actions = requestedActions(input.instruction);
  if (!actions.length || input.secret.length < 32) return null;
  const origin = parsePublicOrigin(input.publicOrigin);
  const basePath = normalizeBasePath(input.basePath || '');
  if (!origin || basePath === null || !validIdentity(input.tenantId) || !validIdentity(input.userId) || !validTaskId(input.taskId)) return null;
  const now = input.now ?? Date.now();
  const grant: DingTalkSecretaryAgentGrant = { tenantId: input.tenantId, userId: input.userId, taskId: input.taskId, actions, expiresAt: Math.floor(now / 1000) + grantLifetimeSeconds, nonce: randomUUID() };
  const encoded = Buffer.from(JSON.stringify({ aud: audience, ...grant })).toString('base64url');
  const signature = createHmac('sha256', input.secret).update(`${audience}\0${encoded}`).digest('base64url');
  const url = new URL(`${basePath}/api/agent/dingtalk/secretary`, origin);
  return { url: url.toString(), token: `${encoded}.${signature}`, actions };
}

export function verifyDingTalkSecretaryAgentGrant(token: string, secret: string, now = Date.now()): DingTalkSecretaryAgentGrant | null {
  if (secret.length < 32 || typeof token !== 'string' || token.length > 4096) return null;
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra) return null;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${audience}\0${encoded}`).digest('base64url'), 'base64url');
  let actual: Buffer;
  try { actual = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  let value: unknown;
  try { value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const nowSeconds = Math.floor(now / 1000);
  if (row.aud !== audience || !validIdentity(row.tenantId) || !validIdentity(row.userId) || !validTaskId(row.taskId)
      || !Number.isInteger(row.expiresAt) || Number(row.expiresAt) < nowSeconds || Number(row.expiresAt) > nowSeconds + grantLifetimeSeconds
      || typeof row.nonce !== 'string' || !/^[a-f0-9-]{36}$/i.test(row.nonce) || !Array.isArray(row.actions)
      || !row.actions.length || row.actions.length > 2 || row.actions.some(action => action !== 'todo-create' && action !== 'cokeclaw-send')) return null;
  return { tenantId: row.tenantId, userId: row.userId, taskId: row.taskId, actions: [...new Set(row.actions as DingTalkSecretaryAction[])], expiresAt: Number(row.expiresAt), nonce: row.nonce };
}

export function deterministicDingTalkSecretaryRequestId(taskId: string, action: DingTalkSecretaryAction, secret: string): string {
  const hex = createHmac('sha256', secret).update(`dingtalk-secretary-v1\0${taskId}\0${action}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validIdentity(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value); }
function validTaskId(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9-]{8,64}$/i.test(value); }

function parsePublicOrigin(value: string) {
  try {
    const origin = new URL(value.trim());
    const loopbackHttp = origin.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(origin.hostname);
    if ((!loopbackHttp && origin.protocol !== 'https:') || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return null;
    return origin.origin;
  } catch { return null; }
}

function normalizeBasePath(value: string): string | null {
  const basePath = value.trim().replace(/\/+$/, '');
  if (!basePath) return '';
  if (!basePath.startsWith('/') || basePath.includes('..') || !/^\/[A-Za-z0-9/_-]+$/.test(basePath)) return null;
  return basePath;
}
