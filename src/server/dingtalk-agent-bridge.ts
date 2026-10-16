import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export type DingTalkDocumentAction = 'search' | 'fetch' | 'create';

export interface DingTalkAgentGrant {
  tenantId: string;
  userId: string;
  taskId: string;
  actions: DingTalkDocumentAction[];
  expiresAt: number;
  nonce: string;
}

export interface DingTalkAgentBridge {
  url: string;
  token: string;
  actions: DingTalkDocumentAction[];
}

const audience = 'coke-dots-dingtalk-documents-v1';
const grantLifetimeSeconds = 15 * 60;
const documentTarget = /(?:钉钉.{0,16}(?:文档|知识库|钉盘)|(?:Ding\s?Talk|DingTalk).{0,24}(?:documents?|knowledge\s?base|drive)|alidocs)/i;
const readAction = /(?:搜索|查找|查询|读取|打开|检索|总结|查看|获取|search|find|look\s?up|read|open|retrieve|summari[sz]e)/i;
const writeAction = /(?:创建|新建|写入|写成|写到|保存到|更新|追加|修改|整理成|create|write|append|update)/i;
const readIntent = new RegExp(`(?:${readAction.source}).{0,64}(?:${documentTarget.source})|(?:${documentTarget.source}).{0,64}(?:${readAction.source})`, 'i');
const writeIntent = new RegExp(`(?:${writeAction.source}).{0,64}(?:${documentTarget.source})|(?:在|到)\\s*(?:${documentTarget.source}).{0,24}(?:${writeAction.source})`, 'i');
const documentReadNegation = new RegExp(
  `(?:不要|不需要|无需|禁止|暂不|don't|do not|no need to)\\s*[^,.!?;，。！？；\\n]{0,32}?(?:${readAction.source})[^,.!?;，。！？；\\n]{0,32}?(?:${documentTarget.source})|(?:不要|不需要|无需|禁止|暂不|don't|do not|no need to)\\s*[^,.!?;，。！？；\\n]{0,32}?(?:${documentTarget.source})[^,.!?;，。！？；\\n]{0,32}?(?:${readAction.source})`,
  'i',
);
const documentWriteNegation = new RegExp(
  `(?:不要|不需要|无需|禁止|暂不|don't|do not|no need to)\\s*(?:再\\s*)?(?:(?:创建|新建|写入|写成|写到|保存到|追加|create|write|append)\\s*(?:(?:一份|一个|任何|新的?|a|an|any|new)\\s*){0,2}(?:${documentTarget.source})|(?:在|到)\\s*(?:${documentTarget.source}).{0,24}(?:创建|新建|写入|写成|写到|保存到|追加|create|write|append))`,
  'i',
);

export function requestedDingTalkDocumentActions(instruction: string): DingTalkDocumentAction[] {
  if (!documentTarget.test(instruction)) return [];
  const actions: DingTalkDocumentAction[] = [];
  if (readIntent.test(instruction) && !documentReadNegation.test(instruction)) actions.push('search', 'fetch');
  if (writeIntent.test(instruction) && !documentWriteNegation.test(instruction)) actions.push('create');
  return actions;
}

export function createDingTalkAgentBridge(input: {
  tenantId: string;
  userId: string;
  taskId: string;
  instruction: string;
  publicOrigin: string;
  basePath?: string;
  secret: string;
  now?: number;
}): DingTalkAgentBridge | null {
  const actions = requestedDingTalkDocumentActions(input.instruction);
  if (!actions.length || input.secret.length < 32) return null;
  const origin = parsePublicOrigin(input.publicOrigin);
  const basePath = normalizeBasePath(input.basePath || '');
  if (!origin || basePath === null || !validIdentity(input.tenantId) || !validIdentity(input.userId) || !validTaskId(input.taskId)) return null;
  const now = input.now ?? Date.now();
  const grant: DingTalkAgentGrant = {
    tenantId: input.tenantId,
    userId: input.userId,
    taskId: input.taskId,
    actions,
    expiresAt: Math.floor(now / 1000) + grantLifetimeSeconds,
    nonce: randomUUID(),
  };
  const encoded = Buffer.from(JSON.stringify({ aud: audience, ...grant })).toString('base64url');
  const signature = sign(encoded, input.secret);
  const url = new URL(`${basePath}/api/agent/dingtalk/documents`, origin);
  return { url: url.toString(), token: `${encoded}.${signature}`, actions };
}

export function verifyDingTalkAgentGrant(token: string, secret: string, now = Date.now()): DingTalkAgentGrant | null {
  if (secret.length < 32 || typeof token !== 'string' || token.length > 4096) return null;
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra) return null;
  const expected = Buffer.from(sign(encoded, secret), 'base64url');
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
      || !Array.isArray(row.actions) || !row.actions.length || row.actions.length > 3
      || row.actions.some(action => !['search', 'fetch', 'create'].includes(String(action)))) return null;
  const actions = [...new Set(row.actions as DingTalkDocumentAction[])];
  return { tenantId: row.tenantId, userId: row.userId, taskId: row.taskId, actions, expiresAt: Number(row.expiresAt), nonce: row.nonce };
}

export function deterministicDingTalkCreateRequestId(taskId: string, secret: string) {
  const hex = createHmac('sha256', secret).update(`dingtalk-doc-create-v1\0${taskId}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sign(encoded: string, secret: string) {
  return createHmac('sha256', secret).update(`${audience}\0${encoded}`).digest('base64url');
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
