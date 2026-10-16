import { createHmac, randomUUID } from 'node:crypto';
import type { AuthSession } from './store.ts';
import { createDingTalkAgentBridge, deterministicDingTalkCreateRequestId, verifyDingTalkAgentGrant, type DingTalkAgentGrant, type DingTalkAgentBridge } from './dingtalk-agent-bridge.ts';
import { createDingTalkCalendarAgentBridge, verifyDingTalkCalendarAgentGrant, type DingTalkCalendarAgentGrant, type DingTalkCalendarAgentBridge } from './dingtalk-calendar-agent-bridge.ts';

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

export interface DingTalkGroupList extends DingTalkGroupSearch {
  complete: boolean;
  failureCount: number;
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
  DWS_GROUP_LIST_LIMIT_INVALID: '群聊加载参数无效，请重新加载。',
  DWS_GROUP_SEARCH_INVALID_RESULT: '钉钉没有返回可识别的群聊结果，请重试。',
  DWS_EVENT_LISTENER_FAILED: '钉钉群消息实时监听未能启动，请检查当前账号的事件订阅权限。',
  DWS_EVENT_SUBSCRIPTION_REJECTED: '钉钉事件中心拒绝了群消息订阅，请检查组织策略及该群是否支持个人 IM 监听。',
  DWS_EVENT_PERMISSION_DENIED: '钉钉拒绝了群消息事件权限，请检查当前账号和组织的事件订阅授权。',
  DWS_EVENT_NETWORK_UNAVAILABLE: '连接钉钉事件服务失败，请检查 Connector 的网络和 TLS 连通性。',
  DWS_EVENT_COMMAND_UNSUPPORTED: '当前 DWS CLI 不支持群消息监听命令，请检查 Connector 的 CLI 版本。',
  DWS_MONITOR_ALREADY_ACTIVE: '这个钉钉群已经有一个实时监听连接。',
  CONNECTOR_AUTHORIZATION_NOT_FOUND: '这次授权流程已过期，请重新开始。',
  CONNECTOR_IDENTITY_READBACK_FAILED: '钉钉授权未能确认账号身份，请重试。',
  DWS_AUTHORIZATION_EXPIRED: '钉钉授权已过期，请重新开始。',
  DWS_AUTHORIZATION_FAILED: '钉钉授权失败，请检查组织是否允许 DWS CLI 登录。',
  DWS_AUTHORIZATION_START_TIMEOUT: '钉钉授权页面启动超时，请重试。',
  DWS_DOC_AUTHORIZATION_REQUIRED: '钉钉账号当前没有可用的文档授权，请重新连接或检查文档权限。',
  DWS_DOC_NAME_INVALID: '钉钉文档标题无效。',
  DWS_DOC_CONTENT_INVALID: '钉钉文档内容无效。',
  DWS_DOC_CONTENT_TOO_LARGE: '钉钉文档内容超过 512 KiB 限制。',
  DWS_DOC_NODE_INVALID: '钉钉文档 ID 或链接无效。',
  DWS_DOC_LOCATION_INVALID: '创建文档时只能指定一个目标文件夹或知识库。',
  DWS_DOC_QUERY_INVALID: '请输入有效的钉钉文档搜索词。',
  DWS_DOC_LIMIT_INVALID: '文档搜索条数必须在 1 到 30 之间。',
  DWS_DOC_SEARCH_FAILED: '钉钉文档搜索结果不完整或无法验证。',
  DWS_DOC_READBACK_FAILED: '无法验证钉钉文档的读取结果。',
  DWS_DOC_READBACK_MISMATCH: '钉钉返回的文档与请求目标不一致。',
  DWS_DOC_OPERATION_UNVERIFIED: '钉钉未返回可验证的文档写入结果。',
  DWS_DOC_OPERATION_FAILED: '钉钉文档操作失败。',
  DWS_DOC_OPERATION_MISMATCH: '钉钉确认的文档与请求目标不一致。',
  DWS_DOC_PARTIAL_SUCCESS: '钉钉文档操作只完成了一部分。请先检查文档状态，不要直接重试。',
  DWS_DOC_COMMIT_UNKNOWN: '钉钉文档写入结果暂时无法确认。请先按标题或内容搜索核对，不要直接重试。',
  DWS_DOC_RETRYABLE_FAILURE: '钉钉文档操作未能完成。请确认当前状态后再发起新的操作。',
  DWS_DOC_CONFIRMATION_REQUIRED: '修改钉钉文档前需要明确确认。',
  DWS_DOC_UPDATE_COMMAND_INVALID: '钉钉文档更新方式无效。',
  DWS_DOC_REQUEST_ID_INVALID: '钉钉文档写入缺少有效的幂等请求 ID。',
  DWS_DOC_REQUEST_CONFLICT: '同一个请求 ID 被用于不同的文档内容，请先核对操作结果。',
  DWS_DOC_OPERATION_STORAGE_FAILED: '钉钉文档操作记录无法安全保存，写入已停止。',
  DWS_CALENDAR_RANGE_INVALID: '日程查询时间范围无效；请提供带时区的 ISO 时间，范围最多 31 天。',
  DWS_CALENDAR_CURSOR_INVALID: '日程分页游标无效。',
  DWS_CALENDAR_LIST_FAILED: '钉钉日历没有返回可验证的日程列表。',
};

export class DingTalkService {
  private readonly gatewayUrl: URL | null;
  private readonly serviceToken: string;
  private readonly ticketSecret: string;
  private readonly e2eMock: boolean;
  private readonly publicOrigin: string;
  private readonly basePath: string;
  private readonly mockAccounts = new Map<string, { state: string; accountName?: string; organizationName?: string; corpId?: string; expiresAt?: string }>();
  private readonly mockAuthorizations = new Map<string, DingTalkAuthorization & { owner: string; testOnly: true }>();
  private readonly mockDocuments = new Map<string, Map<string, { nodeId: string; name: string; content: string; url: string }>>();
  private readonly mockDocumentOperations = new Map<string, { fingerprint: string; result: Record<string, unknown> }>();

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.serviceToken = env.DINGTALK_CONNECTOR_SERVICE_TOKEN?.trim() || '';
    this.ticketSecret = env.DINGTALK_CONNECTOR_TICKET_SECRET?.trim() || '';
    this.gatewayUrl = parseGatewayUrl(env.DINGTALK_CONNECTOR_GATEWAY_URL);
    this.e2eMock = env.NODE_ENV === 'test' && env.DOTS_E2E_AUTH === '1' && env.DOTS_E2E_DINGTALK === '1';
    this.publicOrigin = env.DOTS_PUBLIC_ORIGIN?.trim() || '';
    this.basePath = env.DOTS_BASE_PATH?.trim() || '';
  }

  configured() {
    return this.e2eMock || Boolean(this.gatewayUrl && this.serviceToken.length >= 32 && this.ticketSecret.length >= 32);
  }

  isE2eMock() { return this.e2eMock; }

  agentDocumentBridge(tenantId: string, userId: string, taskId: string, instruction: string): DingTalkAgentBridge | null {
    if (!this.configured() || (!this.ticketSecret && !this.e2eMock)) return null;
    return createDingTalkAgentBridge({
      tenantId, userId, taskId, instruction, publicOrigin: this.publicOrigin, basePath: this.basePath,
      secret: this.ticketSecret || 'dots-e2e-only-dingtalk-agent-grant-secret-32-bytes',
    });
  }

  agentCalendarBridge(tenantId: string, userId: string, taskId: string, instruction: string): DingTalkCalendarAgentBridge | null {
    if (!this.configured() || (!this.ticketSecret && !this.e2eMock)) return null;
    return createDingTalkCalendarAgentBridge({
      tenantId, userId, taskId, instruction, publicOrigin: this.publicOrigin, basePath: this.basePath,
      secret: this.ticketSecret || 'dots-e2e-only-dingtalk-agent-grant-secret-32-bytes',
    });
  }

  verifyAgentDocumentGrant(token: string): DingTalkAgentGrant | null {
    if (!this.configured()) return null;
    return verifyDingTalkAgentGrant(token, this.ticketSecret || (this.e2eMock ? 'dots-e2e-only-dingtalk-agent-grant-secret-32-bytes' : ''));
  }

  verifyAgentCalendarGrant(token: string): DingTalkCalendarAgentGrant | null {
    if (!this.configured()) return null;
    return verifyDingTalkCalendarAgentGrant(token, this.ticketSecret || (this.e2eMock ? 'dots-e2e-only-dingtalk-agent-grant-secret-32-bytes' : ''));
  }

  async runAgentCalendarOperation(grant: DingTalkCalendarAgentGrant, input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('钉钉 Agent 日历请求无效');
    const body = input as Record<string, unknown>;
    if (body.action !== 'list' || !grant.actions.includes('list')) throw new Error('当前任务没有此钉钉日历操作权限');
    const session: AuthSession = {
      tokenHash: '',
      user: { id: grant.userId, email: '', name: '' },
      tenant: { id: grant.tenantId, name: '', role: 'member', kind: 'workspace' },
      expiresAt: new Date(grant.expiresAt * 1000).toISOString(),
    };
    const range = validateCalendarQuery(body);
    if (this.e2eMock) {
      requireMockDingTalkIdentity(this.mockAccounts, session);
      return { events: [], count: 0, complete: true, start: range.start, end: range.end, testOnly: true };
    }
    this.requireConfigured();
    try { return await this.call(session, '/v1/calendar/events', 'POST', range); }
    catch (error) { throw serviceError(error); }
  }

  async runAgentDocumentOperation(grant: DingTalkAgentGrant, input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('钉钉 Agent 请求无效');
    const body = input as Record<string, unknown>;
    const operation = String(body.action || '');
    if (!grant.actions.includes(operation as 'search' | 'fetch' | 'create')) throw new Error('当前任务没有此钉钉文档操作权限');
    const session: AuthSession = {
      tokenHash: '',
      user: { id: grant.userId, email: '', name: '' },
      tenant: { id: grant.tenantId, name: '', role: 'member', kind: 'workspace' },
      expiresAt: new Date(grant.expiresAt * 1000).toISOString(),
    };
    if (operation === 'search') return this.searchDocuments(session, { query: String(body.query || ''), limit: typeof body.limit === 'number' ? body.limit : undefined });
    if (operation === 'fetch') return this.fetchDocument(session, { node: String(body.node || '') });
    if (operation === 'create') {
      const name = String(body.name || '');
      const content = String(body.content || '');
      return this.createDocument(session, {
        requestId: deterministicDingTalkCreateRequestId(grant.taskId, this.ticketSecret || 'dots-e2e-only-dingtalk-agent-grant-secret-32-bytes'),
        name, content, confirmed: true,
        ...(typeof body.folder === 'string' ? { folder: body.folder } : {}),
        ...(typeof body.workspace === 'string' ? { workspace: body.workspace } : {}),
      });
    }
    throw new Error('当前任务没有此钉钉文档操作权限');
  }

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

  async listGroups(session: AuthSession, cursor = '0', pageLimit = 50): Promise<DingTalkGroupList> {
    const cleanCursor = String(cursor || '0');
    if (cleanCursor.length > 200 || !Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 50) throw new Error('DWS_GROUP_LIST_LIMIT_INVALID');
    if (this.e2eMock) {
      if (this.mockAccounts.get(ownerKey(session))?.state !== 'identity-verified') throw new Error(publicErrors.DWS_PROFILE_NOT_AUTHENTICATED);
      return {
        groups: [{ conversationId: 'e2e-incident-alerts', name: '系统监控告警群' }],
        complete: true, hasMore: false, failureCount: 0,
      };
    }
    this.requireConfigured();
    try { return await this.call(session, '/v1/groups/list', 'POST', { cursor: cleanCursor, pageLimit }); }
    catch (error) { throw serviceError(error); }
  }

  async searchDocuments(session: AuthSession, input: { query: string; limit?: number }) {
    if (this.e2eMock) {
      requireMockDingTalkIdentity(this.mockAccounts, session);
      const query = String(input.query || '').trim();
      const limit = input.limit ?? 10;
      if (!query || query.length > 500) throw new Error(publicErrors.DWS_DOC_QUERY_INVALID);
      if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw new Error(publicErrors.DWS_DOC_LIMIT_INVALID);
      const documents = [...(this.mockDocuments.get(ownerKey(session))?.values() || [])]
        .filter(document => `${document.name}\n${document.content}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
        .slice(0, limit).map(({ nodeId, name, url }) => ({ nodeId, name, url }));
      return { documents, count: documents.length, hasMore: false };
    }
    this.requireConfigured();
    try { return await this.call(session, '/v1/docs/search', 'POST', input); }
    catch (error) { throw serviceError(error); }
  }

  async fetchDocument(session: AuthSession, input: { node: string }) {
    if (this.e2eMock) {
      requireMockDingTalkIdentity(this.mockAccounts, session);
      const document = this.mockDocuments.get(ownerKey(session))?.get(String(input.node || ''));
      if (!document) throw new Error(publicErrors.DWS_DOC_READBACK_FAILED);
      return { nodeId: document.nodeId, content: document.content };
    }
    this.requireConfigured();
    try { return await this.call(session, '/v1/docs/fetch', 'POST', input); }
    catch (error) { throw serviceError(error); }
  }

  async createDocument(session: AuthSession, input: { requestId: string; name: string; content: string; confirmed: boolean; folder?: string; workspace?: string }) {
    if (this.e2eMock) {
      requireMockDingTalkIdentity(this.mockAccounts, session);
      if (input.confirmed !== true) throw new Error(publicErrors.DWS_DOC_CONFIRMATION_REQUIRED);
      const validationError = validateMockDocumentWrite(input, true);
      if (validationError) throw new Error(publicErrors[validationError]);
      if (input.folder !== undefined && input.workspace !== undefined) throw new Error(publicErrors.DWS_DOC_LOCATION_INVALID);
      const owner = ownerKey(session);
      const fingerprint = createHmac('sha256', 'dots-e2e-document-test-only').update(JSON.stringify(['create', input.name.trim(), input.content, input.folder || '', input.workspace || ''])).digest('hex');
      const operationKey = `${owner}\0${input.requestId}`;
      const existing = this.mockDocumentOperations.get(operationKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error(publicErrors.DWS_DOC_REQUEST_CONFLICT);
        return existing.result;
      }
      const documents = this.mockDocuments.get(owner) || new Map();
      this.mockDocuments.set(owner, documents);
      const nodeId = `e2e-doc-${randomUUID()}`;
      const document = { nodeId, name: input.name.trim(), content: input.content, url: `https://alidocs.dingtalk.com/document/edit?docId=${nodeId}` };
      documents.set(nodeId, document);
      const result = { operation: 'create', nodeId, verified: true, url: document.url };
      this.mockDocumentOperations.set(operationKey, { fingerprint, result });
      return result;
    }
    this.requireConfigured();
    try { return await this.call(session, '/v1/docs/create', 'POST', input); }
    catch (error) { throw serviceError(error); }
  }

  async updateDocument(session: AuthSession, input: { requestId: string; node: string; command: 'append' | 'overwrite'; content: string; confirmed: boolean }) {
    if (this.e2eMock) {
      requireMockDingTalkIdentity(this.mockAccounts, session);
      if (input.confirmed !== true) throw new Error(publicErrors.DWS_DOC_CONFIRMATION_REQUIRED);
      const validationError = validateMockDocumentWrite(input);
      if (validationError) throw new Error(publicErrors[validationError]);
      if (!['append', 'overwrite'].includes(input.command)) throw new Error(publicErrors.DWS_DOC_UPDATE_COMMAND_INVALID);
      const owner = ownerKey(session);
      const document = this.mockDocuments.get(owner)?.get(String(input.node || ''));
      if (!document) throw new Error(publicErrors.DWS_DOC_READBACK_FAILED);
      const fingerprint = createHmac('sha256', 'dots-e2e-document-test-only').update(JSON.stringify(['update', input.node, input.command, input.content])).digest('hex');
      const operationKey = `${owner}\0${input.requestId}`;
      const existing = this.mockDocumentOperations.get(operationKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error(publicErrors.DWS_DOC_REQUEST_CONFLICT);
        return existing.result;
      }
      document.content = input.command === 'append' ? `${document.content}\n${input.content}` : input.content;
      const result = { operation: 'update', nodeId: document.nodeId, verified: true, url: document.url };
      this.mockDocumentOperations.set(operationKey, { fingerprint, result });
      return result;
    }
    this.requireConfigured();
    try { return await this.call(session, '/v1/docs/update', 'POST', input); }
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

function requireMockDingTalkIdentity(accounts: Map<string, { state: string }>, session: AuthSession) {
  if (accounts.get(ownerKey(session))?.state !== 'identity-verified') throw new Error(publicErrors.DWS_PROFILE_NOT_AUTHENTICATED);
}

function validateMockDocumentWrite(input: { requestId?: unknown; name?: unknown; content?: unknown }, requireName = false) {
  if (typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/i.test(input.requestId)) return 'DWS_DOC_REQUEST_ID_INVALID';
  if (requireName && typeof input.name !== 'string') return 'DWS_DOC_NAME_INVALID';
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 200)) return 'DWS_DOC_NAME_INVALID';
  if (typeof input.content !== 'string' || input.content.includes('\0')) return 'DWS_DOC_CONTENT_INVALID';
  if (Buffer.byteLength(input.content, 'utf8') > 512 * 1024) return 'DWS_DOC_CONTENT_TOO_LARGE';
  return null;
}

function validateCalendarQuery(body: Record<string, unknown>) {
  const now = Date.now();
  const hasStart = body.start !== undefined;
  const hasEnd = body.end !== undefined;
  if (hasStart !== hasEnd) throw new Error(publicErrors.DWS_CALENDAR_RANGE_INVALID);
  const start = hasStart ? parseCalendarTimestamp(body.start) : now;
  const end = hasEnd ? parseCalendarTimestamp(body.end) : now + 7 * 24 * 60 * 60 * 1000;
  if (end <= start || end - start > 31 * 24 * 60 * 60 * 1000) throw new Error(publicErrors.DWS_CALENDAR_RANGE_INVALID);
  const cursor = body.cursor === undefined ? '' : String(body.cursor);
  if (cursor.length > 2048 || cursor.includes('\0')) throw new Error(publicErrors.DWS_CALENDAR_CURSOR_INVALID);
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), ...(cursor ? { cursor } : {}) };
}

function parseCalendarTimestamp(value: unknown) {
  if (typeof value !== 'string' || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error(publicErrors.DWS_CALENDAR_RANGE_INVALID);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(publicErrors.DWS_CALENDAR_RANGE_INVALID);
  return parsed;
}

function assertAuthorizationId(value: string) {
  if (!/^[a-f0-9-]{36}$/i.test(value)) throw new Error(publicErrors.CONNECTOR_AUTHORIZATION_NOT_FOUND);
  return value;
}

function serviceError(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  return new Error(publicErrors[code] || publicErrors.DINGTALK_CONNECTOR_REQUEST_FAILED);
}
