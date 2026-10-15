import { createHmac, randomUUID } from 'node:crypto';
import type { AuthSession } from './store.ts';

interface DingTalkGatewayResponse<T> { ok: boolean; data?: T; error?: string }

export interface DingTalkGroup {
  conversationId: string;
  name: string;
}

export interface DingTalkGroupSearch {
  groups: DingTalkGroup[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface DingTalkPersonalMessage {
  conversationId: string;
  messageId: string;
  senderId: string;
  senderName: string;
  text: string;
}

export interface DingTalkMonitorPrincipal { tenantId: string; userId: string }
export type DingTalkMonitorFrame = { type: 'ready' } | { type: 'ping' } | { type: 'message'; message: DingTalkPersonalMessage };

interface DingTalkAuthorization {
  id: string;
  state: 'starting' | 'awaiting-user' | 'verifying' | 'authorized' | 'failed' | 'cancelled' | 'expired';
  authorizationUrl?: string;
  userCode?: string;
  expiresAt?: string;
  reason?: string;
  installation?: { accountName?: string; organizationName?: string; expiresAt?: string };
}

const publicErrors: Record<string, string> = {
  DINGTALK_CONNECTOR_REQUEST_FAILED: '钉钉连接服务暂时不可用，请稍后重试。',
  DINGTALK_CONNECTOR_CONFIGURATION_REQUIRED: '钉钉连接服务尚未配置。',
  DWS_PROFILE_NOT_INSTALLED: '请先连接钉钉账号。',
  DWS_PROFILE_NOT_AUTHENTICATED: '钉钉授权已过期，请重新连接。',
  DWS_PROFILE_BUSY: '钉钉账号正在执行其他操作，请稍后重试。',
  CONNECTOR_PROFILE_BUSY: '钉钉账号正在执行其他操作，请稍后重试。',
  DWS_PROFILE_SELECTION_REQUIRED: '钉钉账号状态不明确，请断开后重新连接。',
  DWS_PROFILE_ALREADY_CONNECTED: '钉钉账号已经连接。',
  DWS_GROUP_QUERY_INVALID: '请输入要搜索的群名称关键词。',
  DWS_GROUP_SEARCH_INVALID_RESULT: '钉钉没有返回可识别的群聊结果，请重试。',
  DWS_EVENT_LISTENER_FAILED: '钉钉群消息实时监听未能启动，请检查当前账号的事件订阅权限。',
  DWS_MONITOR_ALREADY_ACTIVE: '这个钉钉群已经有一个实时监听连接。',
  CONNECTOR_AUTHORIZATION_NOT_FOUND: '这次授权流程已过期，请重新开始。',
  CONNECTOR_IDENTITY_READBACK_FAILED: '钉钉授权未能确认账号身份，请重试。',
  DWS_AUTHORIZATION_EXPIRED: '钉钉授权已过期，请重新开始。',
  DWS_AUTHORIZATION_FAILED: '钉钉授权失败，请检查组织是否允许 DWS CLI 登录。',
  DWS_AUTHORIZATION_START_TIMEOUT: '钉钉授权页面启动超时，请重试。',
};

export class DingTalkService {
  private readonly gatewayUrl: URL | null;
  private readonly serviceToken: string;
  private readonly ticketSecret: string;
  private readonly e2eMock: boolean;
  private readonly mockAccounts = new Map<string, { state: string; accountName?: string; organizationName?: string; corpId?: string; expiresAt?: string }>();
  private readonly mockAuthorizations = new Map<string, DingTalkAuthorization & { owner: string; testOnly: true }>();

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.serviceToken = env.DINGTALK_CONNECTOR_SERVICE_TOKEN?.trim() || '';
    this.ticketSecret = env.DINGTALK_CONNECTOR_TICKET_SECRET?.trim() || '';
    this.gatewayUrl = parseGatewayUrl(env.DINGTALK_CONNECTOR_GATEWAY_URL);
    this.e2eMock = env.NODE_ENV === 'test' && env.DOTS_E2E_AUTH === '1' && env.DOTS_E2E_DINGTALK === '1';
  }

  configured() {
    return this.e2eMock || Boolean(this.gatewayUrl && this.serviceToken.length >= 32 && this.ticketSecret.length >= 32);
  }

  isE2eMock() { return this.e2eMock; }

  async status(session: AuthSession) {
    if (this.e2eMock) {
      const owner = ownerKey(session);
      const pending = [...this.mockAuthorizations.values()].find(item => item.owner === owner && ['starting', 'awaiting-user', 'verifying'].includes(item.state));
      const account = pending ? publicAuthorization(pending) : this.mockAccounts.get(owner) || { state: 'not-installed' };
      return { configured: true, testOnly: true, account };
    }
    if (!this.configured()) return { configured: false, account: { state: 'not-configured' } };
    try { return { configured: true, account: await this.call(session, '/v1/status', 'GET') }; }
    catch (error) { throw serviceError(error); }
  }

  async startAuthorization(session: AuthSession) {
    if (this.e2eMock) {
      const id = randomUUID();
      const flow = { id, owner: ownerKey(session), state: 'awaiting-user' as const, authorizationUrl: 'https://login.dingtalk.com/oauth2/device?user_code=E2E-CODE', userCode: 'E2E-CODE', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), testOnly: true as const };
      this.mockAuthorizations.set(id, flow);
      return publicAuthorization(flow);
    }
    this.requireConfigured();
    try { return await this.call(session, '/v1/authorization', 'POST', {}); }
    catch (error) { throw serviceError(error); }
  }

  async authorization(session: AuthSession, id: string) {
    if (this.e2eMock) {
      const item = this.mockAuthorizations.get(id);
      if (!item || item.owner !== ownerKey(session)) throw new Error(publicErrors.CONNECTOR_AUTHORIZATION_NOT_FOUND);
      const { owner: _owner, ...flow } = item;
      return flow;
    }
    try { return await this.call(session, `/v1/authorization/${encodeURIComponent(assertAuthorizationId(id))}`, 'GET'); }
    catch (error) { throw serviceError(error); }
  }

  async cancelAuthorization(session: AuthSession, id: string) {
    if (this.e2eMock) {
      const item = this.mockAuthorizations.get(id);
      if (!item || item.owner !== ownerKey(session)) throw new Error(publicErrors.CONNECTOR_AUTHORIZATION_NOT_FOUND);
      item.state = 'cancelled';
      return { id, state: 'cancelled' };
    }
    try { return await this.call(session, `/v1/authorization/${encodeURIComponent(assertAuthorizationId(id))}`, 'DELETE'); }
    catch (error) { throw serviceError(error); }
  }

  async searchGroups(session: AuthSession, query: string, cursor = '0'): Promise<DingTalkGroupSearch> {
    const cleanQuery = String(query || '').trim();
    const cleanCursor = String(cursor || '0');
    if (!cleanQuery || cleanQuery.length > 100 || cleanCursor.length > 200) throw new Error(publicErrors.DWS_GROUP_QUERY_INVALID);
    if (this.e2eMock) {
      if (this.mockAccounts.get(ownerKey(session))?.state !== 'identity-verified') throw new Error(publicErrors.DWS_PROFILE_NOT_AUTHENTICATED);
      return {
        groups: /告警|incident|运维/i.test(cleanQuery) ? [{ conversationId: 'e2e-incident-alerts', name: '系统监控告警群' }] : [],
        hasMore: false,
      };
    }
    this.requireConfigured();
    try { return await this.call(session, '/v1/groups/search', 'POST', { query: cleanQuery, cursor: cleanCursor }); }
    catch (error) { throw serviceError(error); }
  }

  async *watchGroupMessages(principal: DingTalkMonitorPrincipal, conversationId: string, signal: AbortSignal): AsyncGenerator<DingTalkMonitorFrame> {
    const cleanConversationId = String(conversationId || '').trim();
    if (!cleanConversationId || cleanConversationId.length > 512) throw new Error(publicErrors.DWS_GROUP_QUERY_INVALID);
    if (this.e2eMock) {
      yield { type: 'ready' };
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      return;
    }
    this.requireConfigured();
    const url = new URL('v1/monitors/events', ensureTrailingSlash(this.gatewayUrl!));
    const principalSession = { tenant: { id: principal.tenantId }, user: { id: principal.userId } };
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.serviceToken}`,
          'x-dots-principal-ticket': signPrincipalTicket(principalSession, this.ticketSecret),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ conversationId: cleanConversationId }),
        signal,
      });
    } catch {
      if (signal.aborted) return;
      throw new Error(publicErrors.DWS_EVENT_LISTENER_FAILED);
    }
    if (!response.ok) {
      const result = await response.json().catch(() => null) as { error?: string } | null;
      throw serviceError(new Error(result?.error || 'DWS_EVENT_LISTENER_FAILED'));
    }
    if (!response.body) throw new Error(publicErrors.DWS_EVENT_LISTENER_FAILED);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    let gotReady = false;
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        if (buffered.length > 512 * 1024) throw new Error(publicErrors.DWS_EVENT_LISTENER_FAILED);
        let boundary: number;
        while ((boundary = buffered.indexOf('\n')) >= 0) {
          const line = buffered.slice(0, boundary).trim();
          buffered = buffered.slice(boundary + 1);
          if (!line) continue;
          let frame: unknown;
          try { frame = JSON.parse(line); } catch { continue; }
          if (!frame || typeof frame !== 'object' || Array.isArray(frame)) continue;
          const row = frame as Record<string, unknown>;
          if (row.type === 'ping') { yield { type: 'ping' }; continue; }
          if (row.type === 'error') throw serviceError(new Error(String(row.error || 'DWS_EVENT_LISTENER_FAILED')));
          if (row.type === 'ready') { gotReady = true; yield { type: 'ready' }; continue; }
          if (row.type !== 'message' || !row.message || typeof row.message !== 'object' || Array.isArray(row.message)) continue;
          const message = row.message as Record<string, unknown>;
          const normalized: DingTalkPersonalMessage = {
            conversationId: String(message.conversationId || ''),
            messageId: String(message.messageId || ''),
            senderId: String(message.senderId || ''),
            senderName: String(message.senderName || ''),
            text: String(message.text || ''),
          };
          if (!normalized.messageId || !normalized.text.trim() || normalized.conversationId !== cleanConversationId) continue;
          yield { type: 'message', message: normalized };
        }
      }
      if (!signal.aborted && !gotReady) throw new Error(publicErrors.DWS_EVENT_LISTENER_FAILED);
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  async saveTestAuthorization(session: AuthSession, id: string) {
    if (!this.e2eMock) throw new Error('DINGTALK_CONNECTOR_NOT_CONFIGURED');
    const auth = this.mockAuthorizations.get(id);
    if (!auth || auth.owner !== ownerKey(session)) throw new Error(publicErrors.CONNECTOR_AUTHORIZATION_NOT_FOUND);
    auth.state = 'authorized';
    this.mockAccounts.set(auth.owner, { state: 'identity-verified', accountName: '测试钉钉账号', organizationName: 'Dots E2E 测试组织', corpId: 'e2e-corp', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    return { id, state: 'authorized', installation: this.mockAccounts.get(auth.owner) };
  }

  async disconnect(session: AuthSession) {
    if (this.e2eMock) {
      this.mockAccounts.delete(ownerKey(session));
      for (const [id, item] of this.mockAuthorizations) if (item.owner === ownerKey(session)) this.mockAuthorizations.delete(id);
      return { disconnected: true, serverGrantRevoked: false };
    }
    this.requireConfigured();
    try { return await this.call(session, '/v1/account', 'DELETE'); }
    catch (error) { throw serviceError(error); }
  }

  private requireConfigured() {
    if (!this.configured()) throw new Error(publicErrors.DINGTALK_CONNECTOR_CONFIGURATION_REQUIRED);
  }

  private async call<T = Record<string, unknown>>(session: AuthSession, route: string, method: 'GET' | 'POST' | 'DELETE', body?: object): Promise<T> {
    this.requireConfigured();
    const url = new URL(route.replace(/^\//, ''), ensureTrailingSlash(this.gatewayUrl!));
    const ticket = signPrincipalTicket(session, this.ticketSecret);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${this.serviceToken}`, 'x-dots-principal-ticket': ticket, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(method === 'GET' ? 15_000 : 35_000),
      });
    } catch { throw new Error('DINGTALK_CONNECTOR_REQUEST_FAILED'); }
    const result = await response.json().catch(() => null) as DingTalkGatewayResponse<T> | null;
    if (!response.ok || !result || result.ok !== true || result.data === undefined) {
      throw new Error(result?.error || 'DINGTALK_CONNECTOR_REQUEST_FAILED');
    }
    return result.data;
  }
}

function publicAuthorization(value: DingTalkAuthorization & { owner?: string; testOnly?: true }) {
  const { owner: _owner, ...authorization } = value;
  return authorization;
}

function parseGatewayUrl(value: string | undefined) {
  try {
    const url = new URL(value || '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch { return null; }
}

function ensureTrailingSlash(url: URL) {
  const copy = new URL(url);
  if (!copy.pathname.endsWith('/')) copy.pathname += '/';
  return copy;
}

function signPrincipalTicket(session: { tenant: { id: string }; user: { id: string } }, secret: string) {
  const encoded = Buffer.from(JSON.stringify({ tenantId: session.tenant.id, userId: session.user.id, expiresAt: Math.floor(Date.now() / 1000) + 60, nonce: randomUUID() })).toString('base64url');
  return `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;
}

function ownerKey(session: AuthSession) { return `${session.tenant.id}\0${session.user.id}`; }

function assertAuthorizationId(value: string) {
  if (!/^[a-f0-9-]{36}$/i.test(value)) throw new Error(publicErrors.CONNECTOR_AUTHORIZATION_NOT_FOUND);
  return value;
}

function serviceError(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  return new Error(publicErrors[code] || publicErrors.DINGTALK_CONNECTOR_REQUEST_FAILED);
}
