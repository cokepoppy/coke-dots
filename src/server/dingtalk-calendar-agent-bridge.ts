import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export type DingTalkCalendarAction = 'list' | 'create';

export interface DingTalkCalendarAgentGrant {
  tenantId: string;
  userId: string;
  taskId: string;
  actions: DingTalkCalendarAction[];
  expiresAt: number;
  nonce: string;
}

export interface DingTalkCalendarAgentBridge {
  url: string;
  token: string;
  actions: DingTalkCalendarAction[];
}

const audience = 'coke-dots-dingtalk-calendar-v1';
const grantLifetimeSeconds = 15 * 60;
const calendarIntent = /(?:日程|日历|会议|calendar|agenda|my\s+schedule)/i;
const readIntent = /(?:查|查看|看看|列出|读取|获取|告诉我|有哪些|有什么|有没有|总结|准备|梳理|read|list|what(?:'s| is)|upcoming|prepare|prep(?:are)?|agenda)/i;
const createIntent = /(?:创建|安排|新增|预约|订一个|添加|create|schedule|book|set\s+up)/i;
const destructiveIntent = /(?:取消|删除|修改|更新|移除|cancel|delete|update|change|remove)/i;
const documentCalendarInstructionsIntent = /(?:文档|知识库|钉盘|document|knowledge\s?base|drive).{0,20}(?:里|中|about|containing).{0,20}(?:日程|日历|会议|calendar|agenda)/i;

export function requestsDingTalkCalendarRead(instruction: string): boolean {
  // The grant is always list-only, so a separate document-output request may still
  // need the calendar as input for meeting preparation.
  return calendarIntent.test(instruction) && readIntent.test(instruction) && !documentCalendarInstructionsIntent.test(instruction);
}

export function requestsDingTalkCalendarCreate(instruction: string): boolean {
  return calendarIntent.test(instruction) && createIntent.test(instruction) && !destructiveIntent.test(instruction);
}

function actionsForInstruction(instruction: string): DingTalkCalendarAction[] {
  if (destructiveIntent.test(instruction)) return [];
  const actions: DingTalkCalendarAction[] = [];
  if (requestsDingTalkCalendarRead(instruction)) actions.push('list');
  if (requestsDingTalkCalendarCreate(instruction)) actions.push('create');
  return actions;
}

export function createDingTalkCalendarAgentBridge(input: {
  tenantId: string;
  userId: string;
  taskId: string;
  instruction: string;
  publicOrigin: string;
  basePath?: string;
  secret: string;
  now?: number;
}): DingTalkCalendarAgentBridge | null {
  const actions = actionsForInstruction(input.instruction);
  if (!actions.length || input.secret.length < 32) return null;
  const origin = parsePublicOrigin(input.publicOrigin);
  const basePath = normalizeBasePath(input.basePath || '');
  if (!origin || basePath === null || !validIdentity(input.tenantId) || !validIdentity(input.userId) || !validTaskId(input.taskId)) return null;
  const now = input.now ?? Date.now();
  const grant: DingTalkCalendarAgentGrant = {
    tenantId: input.tenantId,
    userId: input.userId,
    taskId: input.taskId,
    actions,
    expiresAt: Math.floor(now / 1000) + grantLifetimeSeconds,
    nonce: randomUUID(),
  };
  const encoded = Buffer.from(JSON.stringify({ aud: audience, ...grant })).toString('base64url');
  const signature = createHmac('sha256', input.secret).update(`${audience}\0${encoded}`).digest('base64url');
  const url = new URL(`${basePath}/api/agent/dingtalk/calendar`, origin);
  return { url: url.toString(), token: `${encoded}.${signature}`, actions: grant.actions };
}

export function verifyDingTalkCalendarAgentGrant(token: string, secret: string, now = Date.now()): DingTalkCalendarAgentGrant | null {
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
      || typeof row.nonce !== 'string' || !/^[a-f0-9-]{36}$/i.test(row.nonce)
      || !Array.isArray(row.actions) || !row.actions.length || row.actions.length > 2
      || row.actions.some(action => action !== 'list' && action !== 'create')) return null;
  const actions = [...new Set(row.actions as DingTalkCalendarAction[])];
  return { tenantId: row.tenantId, userId: row.userId, taskId: row.taskId, actions, expiresAt: Number(row.expiresAt), nonce: row.nonce };
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}

function validTaskId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9-]{8,64}$/i.test(value);
}

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
