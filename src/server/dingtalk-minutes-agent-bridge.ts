import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export type DingTalkMinutesAction = 'search' | 'detail';

export interface DingTalkMinutesAgentGrant {
  tenantId: string;
  userId: string;
  taskId: string;
  actions: DingTalkMinutesAction[];
  expiresAt: number;
  nonce: string;
}

export interface DingTalkMinutesAgentBridge {
  url: string;
  token: string;
  actions: DingTalkMinutesAction[];
}

const audience = 'coke-dots-dingtalk-minutes-v1';
const grantLifetimeSeconds = 15 * 60;
const minutesObject = /(?:AI\s*听记|听记|会议纪要|会议记录|会议转写|会议录音纪要|transcripts?|meeting\s+minutes|meeting\s+notes)/i;
const readIntent = /(?:查|查看|找|搜索|读取|总结|汇总|提取|梳理|核对|补充|继续|剩余|详细|要点|清单|内容|列举|有哪些|有什么|read|find|search|summari[sz]e|review|show|list|detail|continue|remaining|more)/i;

export function requestsDingTalkMinutesRead(instruction: string): boolean {
  return minutesObject.test(instruction) && readIntent.test(instruction);
}

export function createDingTalkMinutesAgentBridge(input: {
  tenantId: string; userId: string; taskId: string; instruction: string;
  publicOrigin: string; basePath?: string; secret: string; now?: number;
}): DingTalkMinutesAgentBridge | null {
  if (!requestsDingTalkMinutesRead(input.instruction) || input.secret.length < 32) return null;
  const origin = parsePublicOrigin(input.publicOrigin);
  const basePath = normalizeBasePath(input.basePath || '');
  if (!origin || basePath === null || !validIdentity(input.tenantId) || !validIdentity(input.userId) || !validTaskId(input.taskId)) return null;
  const actions: DingTalkMinutesAction[] = ['search', 'detail'];
  const now = input.now ?? Date.now();
  const grant: DingTalkMinutesAgentGrant = {
    tenantId: input.tenantId,
    userId: input.userId,
    taskId: input.taskId,
    actions,
    expiresAt: Math.floor(now / 1000) + grantLifetimeSeconds,
    nonce: randomUUID(),
  };
  const encoded = Buffer.from(JSON.stringify({ aud: audience, ...grant })).toString('base64url');
  const signature = createHmac('sha256', input.secret).update(`${audience}\0${encoded}`).digest('base64url');
  const url = new URL(`${basePath}/api/agent/dingtalk/minutes`, origin);
  return { url: url.toString(), token: `${encoded}.${signature}`, actions };
}

export function verifyDingTalkMinutesAgentGrant(token: string, secret: string, now = Date.now()): DingTalkMinutesAgentGrant | null {
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
      || row.actions.length !== 2 || row.actions.some(action => action !== 'search' && action !== 'detail')) return null;
  return { tenantId: row.tenantId, userId: row.userId, taskId: row.taskId, actions: ['search', 'detail'], expiresAt: Number(row.expiresAt), nonce: row.nonce };
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
