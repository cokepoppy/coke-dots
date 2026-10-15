import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve, join, extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Store } from './store.ts';
import { Worker } from './worker.ts';
import { WatchRunner, validateWatchUrl } from './watch.ts';
import { adapters } from './adapters.ts';
import { desktopAgentEngineIds } from './desktop-agent-kernels.ts';
import { isEngine, type ActionRuleMode, type DotAppearance, type Engine, type ScheduleSpec } from '../shared/types.ts';
import { isDotAppearance } from '../shared/avatar.ts';
import { nextScheduleOccurrence, scheduleForTask, validateScheduleSpec } from '../shared/scheduling.ts';
import { effectiveModelConfig, loadModelSettings, publicModelSettings, saveModelKey, setModelMetadata } from './model-settings.ts';
import { ComputerManager, type ComputerRuntime } from './computer.ts';
import { LinuxDesktopComputer } from './linux-desktop-computer.ts';
import { apiErrorResponse } from './computer-errors.ts';
import { createArtifactPreviewTicket, verifyArtifactPreviewTicket } from './artifact-preview-ticket.ts';
import { AuthService } from './auth.ts';
import { SlackService } from './slack.ts';
import { DingTalkService } from './dingtalk.ts';
import { DingTalkStreamService } from './dingtalk-stream.ts';
import { DingTalkMonitorSupervisor } from './dingtalk-monitor.ts';
import { negotiateQwenRealtime, VoiceProviderError, voiceProviderInfo } from './voice-provider.ts';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { bridgeVolcengineVoiceCall } from './volcengine-voice-gateway.ts';
import { isAllowedOrigin, isLocalRequest } from './request-boundary.ts';

const envFile = resolve(process.env.DOTS_ENV_FILE || '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const port = Number(process.env.DOTS_PORT || 4317);
const host = '127.0.0.1';
const basePath = normalizeBasePath(process.env.DOTS_BASE_PATH || '');
const requestBoundary = {
  port,
  publicOrigin: process.env.DOTS_PUBLIC_ORIGIN,
  publicHost: process.env.DOTS_PUBLIC_HOST,
  trustedProxyToken: process.env.DOTS_TRUSTED_PROXY_TOKEN,
};
const dataDirectory = resolve(process.env.DOTS_DATA_DIR || './data');
const store = new Store(dataDirectory);
const priorModelAdminTenantId = store.getAppSetting('modelSettingsAdminTenantId');
const modelSettingsCandidates = store.modelSettingsCandidates();
const modelSettingsSource = modelSettingsCandidates.find(item => item.tenantId === priorModelAdminTenantId)
  || modelSettingsCandidates.find(item => item.tenantId === 'legacy')
  || modelSettingsCandidates.find(item => item.baseUrl || item.model);
if (modelSettingsSource) {
  if (!store.getAppSetting('modelBaseUrl') && modelSettingsSource.baseUrl) store.setAppSetting('modelBaseUrl', modelSettingsSource.baseUrl);
  if (!store.getAppSetting('modelName') && modelSettingsSource.model) store.setAppSetting('modelName', modelSettingsSource.model);
}
const auth = new AuthService(store, port);
const slack = new SlackService(store, port);
const dingtalk = new DingTalkService();
const computers = new Map<string, ComputerRuntime>();
const novncStreams = new Map<string, Set<Duplex>>();
const clients = new Map<ServerResponse, string>();
const volcVoiceWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
const configuredDesktopEngines = () => {
  if (process.env.DOTS_COMPUTER_BACKEND !== 'linux-desktop') return [] as Engine[];
  return desktopAgentEngineIds();
};
const availableFor = (tenantId: string) => [...new Set([...(Object.keys(adapters) as Engine[]).filter(id => adapters[id].available(tenantId)), ...(effectiveModelConfig(tenantId) ? configuredDesktopEngines() : [])])];

function snapshot(tenantId: string) {
  const adminTenantId = store.getAppSetting('modelSettingsAdminTenantId');
  loadModelSettings(store.getAppSetting('modelBaseUrl'), store.getAppSetting('modelName'), adminTenantId);
  const available = availableFor(tenantId);
  return store.snapshot(available.includes('model'), available, publicModelSettings(adminTenantId), tenantId, configuredDesktopEngines());
}

function computerFor(tenantId: string): ComputerRuntime {
  let computer = computers.get(tenantId);
  if (!computer) {
    computer = process.env.DOTS_COMPUTER_BACKEND === 'linux-desktop'
      ? new LinuxDesktopComputer(tenantId)
      : new ComputerManager(join(dataDirectory, 'tenants', tenantId, 'computer'));
    computers.set(tenantId, computer);
  }
  return computer;
}

function publish() {
  for (const [client, tokenHash] of clients) {
    const session = store.getSession(tokenHash);
    if (!session) { client.end(); clients.delete(client); continue; }
    try { client.write(`data: ${JSON.stringify(snapshot(session.tenant.id))}\n\n`); }
    catch { client.end(); clients.delete(client); }
  }
}

const sessionHeartbeat = setInterval(() => {
  for (const [client, tokenHash] of clients) {
    if (!store.getSession(tokenHash)) { client.end(); clients.delete(client); }
    else client.write(': keep-alive\n\n');
  }
}, 30_000);

const worker = new Worker(store, publish, join(dataDirectory, 'workspaces'), undefined, computerFor, dingtalk);
const watchRunner = new WatchRunner(store, publish);
const dingtalkStream = new DingTalkStreamService(message => {
  const result = store.ingestDingtalkMessage(message);
  if (result.tasks.length) { publish(); void worker.tick(); }
});
const dingtalkMonitor = new DingTalkMonitorSupervisor(store, dingtalk, () => { publish(); void worker.tick(); });

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  const url = new URL(req.url || '/', `http://${host}:${port}`);
  const path = routePath(url.pathname);
  if (path === '/api/agent/dingtalk/documents') {
    if (req.method !== 'POST') return reply(res, 405, { error: '方法不支持' });
    const authorization = req.headers.authorization || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const grant = dingtalk.verifyAgentDocumentGrant(token);
    if (!grant) return reply(res, 401, { error: 'Agent 钉钉文档授权无效或已过期' });
    const task = store.getTask(grant.taskId, grant.tenantId);
    if (!task || store.taskOwnerUserId(grant.taskId, grant.tenantId) !== grant.userId) return reply(res, 404, { error: '任务不存在' });
    if (task.status !== 'working') return reply(res, 409, { error: '任务已结束，钉钉文档授权已收回' });
    let body: Record<string, unknown>;
    try { body = await readJson(req, 600 * 1024); }
    catch (error) { return reply(res, 413, { error: error instanceof Error ? error.message : '请求体无效' }); }
    try { return reply(res, 200, { ok: true, data: await dingtalk.runAgentDocumentOperation(grant, body) }); }
    catch (error) { return reply(res, 400, { ok: false, error: error instanceof Error ? error.message : '钉钉文档操作失败' }); }
  }
  if (!isLocalRequest(req, path, requestBoundary)) return reply(res, 403, { error: 'Local access only' });

  if (path === '/auth/google/callback' && req.method === 'GET') return auth.finish(req, res, url);
  if (path === '/auth/slack/callback' && req.method === 'GET') return slack.finish(req, res, url, auth.session(req));
  if (!path.startsWith('/api/')) return serveStatic(req, res, path);
  if (path === '/api/health' && req.method === 'GET') return reply(res, 200, { ok: true });
  if (path === '/api/auth/config' && req.method === 'GET') return reply(res, 200, { googleConfigured: auth.configured(), e2eAuthAvailable: auth.e2eAuthAvailable() });
  if (path === '/api/auth/google/start' && req.method === 'GET') return auth.begin(req, res);
  if (path === '/api/auth/e2e/login' && req.method === 'POST' && auth.e2eAuthAvailable()) {
    if (!validMutationOrigin(req)) return reply(res, 403, { error: '请求来源无效' });
    const body = await readJson(req);
    return auth.e2eLogin(String(body.email || ''), res);
  }
  if (path === '/api/auth/desktop/poll' && req.method === 'POST') {
    if (!validMutationOrigin(req)) return reply(res, 403, { error: '请求来源无效' });
    const body = await readJson(req);
    return auth.pollDesktop(res, String(body.handoffToken || ''));
  }

  if (path === '/api/auth/me' && req.method === 'GET') {
    const session = auth.session(req);
    if (!session) return reply(res, 401, { error: '请先登录' });
    return reply(res, 200, { user: session.user, tenant: session.tenant, tenants: store.tenantsForUser(session.user.id) });
  }
  const sandboxArtifactPreview = path.match(/^\/api\/artifact-preview\/([a-f0-9-]{36})\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\/(.+)$/i);
  if (sandboxArtifactPreview && req.method === 'GET') {
    const [, taskId, ticket, rawPath] = sandboxArtifactPreview;
    const claims = verifyArtifactPreviewTicket(ticket);
    if (!claims || claims.taskId !== taskId) return reply(res, 404, { error: '文件预览已过期或不可用' });
    const activeSession = auth.session(req);
    if (activeSession && activeSession.tenant.id !== claims.tenantId) return reply(res, 404, { error: '文件预览已过期或不可用' });
    const task = store.getTask(taskId, claims.tenantId);
    if (!task) return reply(res, 404, { error: '文件预览已过期或不可用' });
    try {
      const artifactPath = rawPath.split('/').map(part => decodeURIComponent(part)).join('/');
      const artifact = await computerFor(claims.tenantId).readTaskArtifact?.(task.id, artifactPath);
      if (!artifact?.previewable) return reply(res, 404, { error: '文件预览已过期或不可用' });
      return writeTaskArtifact(res, artifact);
    } catch (error) {
      const failure = apiErrorResponse(error);
      return reply(res, failure.status, failure.body);
    }
  }
  if (path === '/api/auth/desktop/start' && req.method === 'GET') return auth.beginDesktop(req, res, url);
  if (path === '/api/auth/logout' && req.method === 'POST') {
    if (!validMutationOrigin(req)) return reply(res, 403, { error: '请求来源无效' });
    auth.logout(req, res);
    publish();
    return reply(res, 200, { ok: true });
  }

  const session = auth.session(req);
  if (!session) return reply(res, 401, { error: '请先使用 Google 登录' });
  if (!validMutationOrigin(req)) return reply(res, 403, { error: '请求来源无效' });

  if (path === '/api/slack' && req.method === 'GET') return reply(res, 200, slack.snapshot(session.tenant.id));
  if (path === '/api/slack/oauth/start' && req.method === 'GET') return slack.begin(req, res, session);
  if (path === '/api/slack/contact' && req.method === 'POST') {
    const body = await readJson(req);
    const result = slack.setContactWorkspace(session, String(body.teamId || ''));
    return result.status === 200 ? reply(res, 200, result.value) : reply(res, result.status, { error: result.error });
  }
  if (path === '/api/dingtalk' && req.method === 'GET') {
    try {
      const status = await dingtalk.status(session);
      if (status.account && typeof status.account === 'object') {
        const { corpId: _corpId, ...account } = status.account as Record<string, unknown>;
        return reply(res, 200, { ...status, account });
      }
      return reply(res, 200, status);
    }
    catch (error) { return reply(res, 503, { error: error instanceof Error ? error.message : '钉钉连接服务暂时不可用。' }); }
  }
  if (path === '/api/dingtalk/authorization/start' && req.method === 'POST') {
    try { return reply(res, 201, await dingtalk.startAuthorization(session)); }
    catch (error) { return reply(res, 503, { error: error instanceof Error ? error.message : '无法开始钉钉授权。' }); }
  }
  const dingtalkAuthorizationMatch = path.match(/^\/api\/dingtalk\/authorization\/([a-f0-9-]{36})$/i);
  if (dingtalkAuthorizationMatch && req.method === 'GET') {
    try { return reply(res, 200, await dingtalk.authorization(session, dingtalkAuthorizationMatch[1])); }
    catch (error) { return reply(res, 404, { error: error instanceof Error ? error.message : '钉钉授权流程不存在。' }); }
  }
  if (dingtalkAuthorizationMatch && req.method === 'DELETE') {
    try { return reply(res, 200, await dingtalk.cancelAuthorization(session, dingtalkAuthorizationMatch[1])); }
    catch (error) { return reply(res, 404, { error: error instanceof Error ? error.message : '钉钉授权流程不存在。' }); }
  }
  if (path === '/api/dingtalk/groups/search' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      return reply(res, 200, await dingtalk.searchGroups(session, String(body.query || ''), String(body.cursor || '0')));
    } catch (error) { return reply(res, 400, { error: error instanceof Error ? error.message : '钉钉群搜索失败。' }); }
  }
  if (path === '/api/dingtalk/groups/selected' && req.method === 'GET') {
    const selected = store.dingtalkGroupSelections(session.tenant.id, session.user.id)
      .map(item => ({ conversationId: item.conversationId, name: item.groupName }));
    return reply(res, 200, selected);
  }
  if (path === '/api/dingtalk/groups/selected' && req.method === 'PUT') {
    try {
      const account = await dingtalk.status(session);
      if (account.account.state !== 'identity-verified') return reply(res, 409, { error: '请先连接并确认钉钉账号，再选择监控群。' });
      const corpId = String(account.account.corpId || '').trim();
      if (!corpId) return reply(res, 409, { error: '无法确认钉钉组织，请断开账号并重新连接后重试。' });
      const body = await readJson(req);
      if (!Array.isArray(body.groups)) return reply(res, 400, { error: '群聊列表格式无效。' });
      const groups = body.groups.map((group: { conversationId?: unknown; name?: unknown }) => ({ conversationId: String(group?.conversationId || ''), name: String(group?.name || '') }));
      const saved = store.replaceDingtalkGroupSelections(session.tenant.id, session.user.id, groups, corpId)
        .map(item => ({ conversationId: item.conversationId, name: item.groupName }));
      return reply(res, 200, saved);
    } catch (error) { return reply(res, 400, { error: error instanceof Error ? error.message : '保存钉钉群选择失败。' }); }
  }
  if (path === '/api/dingtalk/monitors' && req.method === 'GET') {
    const streamStatus = dingtalkStream.status();
    const monitors = new Map(store.dingtalkGroupMonitors(session.tenant.id, session.user.id).map(item => [item.conversationId, item]));
    const piReady = dingtalk.isE2eMock() || (configuredDesktopEngines().includes('pi') && Boolean(effectiveModelConfig(store.getAppSetting('modelSettingsAdminTenantId') || undefined)));
    const groups = store.dingtalkGroupSelections(session.tenant.id, session.user.id).map(group => {
      const monitor = monitors.get(group.conversationId);
      const reason = !group.corpId ? '请重新保存此群选择，以确认所属钉钉组织。'
        : !piReady ? '云电脑 Pi 或实例共享模型尚未就绪。'
          : undefined;
      return { conversationId: group.conversationId, groupName: group.groupName, enabled: monitor?.enabled || false,
        keywords: monitor?.keywords || [],
        canEnable: Boolean(group.corpId) && piReady,
        listenerState: monitor?.enabled ? dingtalkMonitor.status(session.tenant.id, session.user.id, group.conversationId) : 'off', reason };
    });
    return reply(res, 200, { stream: streamStatus, groups });
  }
  if (path === '/api/dingtalk/monitors' && req.method === 'PUT') {
    try {
      const body = await readJson(req);
      const conversationId = String(body.conversationId || '');
      const enabled = body.enabled === true;
      if (!Array.isArray(body.keywords)) return reply(res, 400, { error: '请配置要关注的告警关键词。' });
      let corpId = '';
      if (enabled) {
        const status = await dingtalk.status(session);
        if (status.account.state !== 'identity-verified') return reply(res, 409, { error: '请先重新连接钉钉账号，再开启群监听。' });
        corpId = String(status.account.corpId || '').trim();
        const piReady = configuredDesktopEngines().includes('pi') && Boolean(effectiveModelConfig(store.getAppSetting('modelSettingsAdminTenantId') || undefined));
        if (!dingtalk.isE2eMock() && !piReady) return reply(res, 409, { error: '云电脑 Pi 或实例共享模型尚未就绪，暂时不能开启自动排障。' });
        if (!corpId) return reply(res, 409, { error: '无法确认钉钉组织，请重新连接钉钉账号。' });
      }
      const monitor = store.setDingtalkGroupMonitor(session.tenant.id, session.user.id, conversationId, enabled, corpId, body.keywords);
      void dingtalkMonitor.reconcile();
      return reply(res, 200, { conversationId: monitor.conversationId, enabled: monitor.enabled, keywords: monitor.keywords });
    } catch (error) { return reply(res, 400, { error: error instanceof Error ? error.message : '更新钉钉群监听失败。' }); }
  }
  const dingtalkDocumentRoute = path.match(/^\/api\/dingtalk\/docs\/(create|fetch|search|update)$/);
  if (dingtalkDocumentRoute && req.method === 'POST') {
    try {
      const body = await readJson(req, 600 * 1024);
      const result = dingtalkDocumentRoute[1] === 'create'
        ? await dingtalk.createDocument(session, body as { requestId: string; name: string; content: string; confirmed: boolean; folder?: string; workspace?: string })
        : dingtalkDocumentRoute[1] === 'fetch'
          ? await dingtalk.fetchDocument(session, body as { node: string })
          : dingtalkDocumentRoute[1] === 'search'
            ? await dingtalk.searchDocuments(session, body as { query: string; limit?: number })
            : await dingtalk.updateDocument(session, body as { requestId: string; node: string; command: 'append' | 'overwrite'; content: string; confirmed: boolean });
      return reply(res, 200, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : '钉钉文档操作失败。';
      const status = /写入结果暂时无法确认|只完成了一部分|请求 ID 被用于不同内容/.test(message) ? 409
        : /没有可用的文档授权/.test(message) ? 403
          : /超过 512 KiB/.test(message) ? 413
            : 400;
      return reply(res, status, { error: message });
    }
  }
  if (path === '/api/dingtalk/account' && req.method === 'DELETE') {
    try {
      const result = await dingtalk.disconnect(session);
      store.clearDingtalkGroupSelections(session.tenant.id, session.user.id);
      return reply(res, 200, result);
    } catch (error) { return reply(res, 503, { error: error instanceof Error ? error.message : '无法断开钉钉连接。' }); }
  }
  if (path === '/api/dingtalk/e2e/complete' && req.method === 'POST' && dingtalk.isE2eMock()) {
    try {
      const body = await readJson(req);
      return reply(res, 200, await dingtalk.saveTestAuthorization(session, String(body.id || '')));
    } catch (error) { return reply(res, 404, { error: error instanceof Error ? error.message : '模拟授权流程不存在。' }); }
  }
  if (path === '/api/dingtalk/e2e/stream-message' && req.method === 'POST' && dingtalk.isE2eMock()) {
    try {
      const body = await readJson(req);
      const text = String(body.text || '').trim();
      const messageId = String(body.messageId || '');
      if (!text || text.length > 6000 || !/^[A-Za-z0-9._:@/-]{1,128}$/.test(messageId)) return reply(res, 400, { error: '测试告警消息无效。' });
      const result = store.ingestDingtalkMessage({ corpId: 'e2e-corp', conversationId: String(body.conversationId || ''), messageId,
        senderId: 'e2e-sender', senderName: '测试告警机器人', text }, 'model');
      if (result.tasks.length) { publish(); void worker.tick(); }
      return reply(res, 200, { kind: result.kind, taskId: result.tasks.find(item => item.tenantId === session.tenant.id)?.taskId || null,
        testOnly: true, engine: 'model' });
    } catch (error) { return reply(res, 400, { error: error instanceof Error ? error.message : '测试告警注入失败。' }); }
  }

  try {
    if (path === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'Cache-Control': 'no-store' });
      clients.set(res, session.tokenHash);
      res.write(`data: ${JSON.stringify(snapshot(session.tenant.id))}\n\n`);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (path === '/api/state' && req.method === 'GET') return reply(res, 200, snapshot(session.tenant.id));
    if (path === '/api/voice-calls' && req.method === 'GET') return reply(res, 200, store.voiceCalls(session.tenant.id, session.user.id));
    if (path === '/api/voice/provider' && req.method === 'GET') return reply(res, 200, voiceProviderInfo());
    if (path === '/api/activity' && req.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') || 50);
      const beforeValue = url.searchParams.get('before');
      const before = beforeValue === null ? null : Number(beforeValue);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (before !== null && (!Number.isSafeInteger(before) || before < 1))) {
        return reply(res, 400, { error: 'Invalid activity page' });
      }
      return reply(res, 200, store.activityPage(session.tenant.id, before, limit));
    }
    if (path === '/api/action-rule' && req.method === 'GET') return reply(res, 200, store.tenantActionRule(session.tenant.id));
    if (path === '/api/memories' && req.method === 'GET') return reply(res, 200, store.tenantMemories(session.tenant.id));
    if (path === '/api/pages' && req.method === 'GET') return reply(res, 200, store.tenantPages(session.tenant.id));
    const pageMatch = path.match(/^\/api\/pages\/([a-f0-9-]+)$/);
    if (pageMatch && req.method === 'GET') {
      const page = store.tenantPage(session.tenant.id, pageMatch[1]);
      return page ? reply(res, 200, page) : reply(res, 404, { error: '页面不存在' });
    }
    if (path === '/api/auth/invitations' && req.method === 'GET') return reply(res, 200, store.pendingWorkspaceInvitations(session.user.email));
    const acceptInvitationMatch = path.match(/^\/api\/auth\/invitations\/([a-z0-9-]+)\/accept$/);
    if (acceptInvitationMatch && req.method === 'POST') {
      const tenant = store.acceptWorkspaceInvitation(acceptInvitationMatch[1], session.tokenHash, session.user.id, session.user.email);
      if (!tenant) return reply(res, 404, { error: '邀请不存在或已过期' });
      publish();
      const updated = auth.session(req)!;
      return reply(res, 200, { user: updated.user, tenant: updated.tenant, tenants: store.tenantsForUser(updated.user.id) });
    }

    if (path === '/api/attachments' && req.method === 'GET') return reply(res, 200, store.pendingAttachments(session.tenant.id, session.user.id));
    if (path === '/api/attachments' && req.method === 'POST') {
      const rawName = req.headers['x-attachment-name'];
      let name = '';
      try { name = decodeURIComponent(Array.isArray(rawName) ? rawName[0] || '' : rawName || ''); }
      catch { return reply(res, 400, { error: '附件文件名无效' }); }
      name = name.replaceAll('\\', '/').split('/').at(-1)?.replace(/[\x00-\x1f\x7f]/g, '').trim() || '';
      if (!name || name.length > 128) return reply(res, 400, { error: '附件文件名无效' });
      const mediaType = textAttachmentType(extname(name).toLowerCase());
      if (!mediaType) return reply(res, 415, { error: '暂时只支持纯文本、Markdown、CSV、JSON 和常见代码文件' });
      let content: Buffer;
      try { content = await readBytes(req, 256 * 1024); }
      catch (error) {
        if (error instanceof Error && error.message === 'ATTACHMENT_TOO_LARGE') return reply(res, 413, { error: '单个文本附件不能超过 256 KB' });
        throw error;
      }
      if (!content.length) return reply(res, 400, { error: '附件不能为空' });
      let decoded: string;
      try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(content); }
      catch { return reply(res, 415, { error: '附件必须是 UTF-8 文本文件' }); }
      if (decoded.includes('\0')) return reply(res, 415, { error: '附件必须是 UTF-8 文本文件' });
      try { return reply(res, 201, store.addPendingAttachment(session.tenant.id, session.user.id, name, mediaType, content)); }
      catch (error) { return reply(res, 400, { error: error instanceof Error ? error.message : '无法保存附件' }); }
    }
    const attachmentMatch = path.match(/^\/api\/attachments\/([a-f0-9-]+)$/i);
    if (attachmentMatch && req.method === 'DELETE') {
      const removed = store.deletePendingAttachment(session.tenant.id, session.user.id, attachmentMatch[1]);
      return removed ? reply(res, 200, { ok: true }) : reply(res, 404, { error: '待发送附件不存在' });
    }

    const realtimeVoiceMatch = path.match(/^\/api\/voice-calls\/([a-f0-9-]+)\/realtime-session$/);
    const voiceTurnMatch = path.match(/^\/api\/voice-calls\/([a-f0-9-]+)\/turns$/);
    const body = req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT'
      ? await readJson(req, realtimeVoiceMatch ? 100_000 : 32_000)
      : {};
    if (path === '/api/voice-calls' && req.method === 'POST') {
      return reply(res, 201, store.createVoiceCall(session.tenant.id, session.user.id));
    }
    if (realtimeVoiceMatch && req.method === 'POST') {
      const call = store.getVoiceCall(session.tenant.id, session.user.id, realtimeVoiceMatch[1]);
      if (!call || call.endedAt) return reply(res, 404, { error: 'Voice call not found or ended' });
      const provider = voiceProviderInfo();
      if (provider.provider !== 'qwen') return reply(res, 409, { error: '当前语音供应商不支持实时 WebRTC' });
      if (!provider.configured) return reply(res, 503, { error: 'Qwen 实时语音未配置，请联系服务管理员' });
      if (typeof body.sdp !== 'string') return reply(res, 400, { error: 'WebRTC offer SDP 缺失' });
      try {
        const answerSdp = await negotiateQwenRealtime(body.sdp);
        return reply(res, 200, { provider: 'qwen', model: provider.model, answerSdp });
      } catch (error) {
        if (error instanceof VoiceProviderError) return reply(res, error.status, { error: error.message });
        return reply(res, 502, { error: 'Qwen 实时语音协商失败' });
      }
    }
    if (voiceTurnMatch && req.method === 'POST') {
      const call = store.getVoiceCall(session.tenant.id, session.user.id, voiceTurnMatch[1]);
      if (!call) return reply(res, 404, { error: '语音通话不存在' });
      const turnId = typeof body.turnId === 'string' ? body.turnId : '';
      const transcript = typeof body.transcript === 'string' ? body.transcript : '';
      const waitingTaskId = body.waitingTaskId === undefined || body.waitingTaskId === null ? undefined : body.waitingTaskId;
      const requestedEngine = body.engine || 'model';
      if (typeof waitingTaskId !== 'undefined' && (typeof waitingTaskId !== 'string' || !/^[a-f0-9-]{36}$/i.test(waitingTaskId))) {
        return reply(res, 400, { error: '等待回复的任务 ID 无效' });
      }
      if (typeof requestedEngine !== 'string' || !isEngine(requestedEngine)) return reply(res, 400, { error: '任务内核无效' });
      if (!turnId || turnId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(turnId)) return reply(res, 400, { error: '语音轮次 ID 无效' });
      if (!transcript.trim() || transcript.trim().length > 5000) return reply(res, 400, { error: '语音内容需为 1–5000 个字符' });
      try {
        const result = store.submitVoiceTurn({
          tenantId: session.tenant.id, userId: session.user.id, callId: call.id, turnId,
          transcript, engine: requestedEngine, ...(waitingTaskId ? { waitingTaskId } : {}),
        });
        publish();
        void worker.tick();
        return reply(res, result.duplicate ? 200 : 201, result.task);
      } catch (error) {
        const message = error instanceof Error ? error.message : '无法创建语音任务';
        return reply(res, message === '语音通话已结束' ? 409 : 400, { error: message });
      }
    }
    const voiceCallMatch = path.match(/^\/api\/voice-calls\/([a-f0-9-]+)$/);
    if (voiceCallMatch && req.method === 'PATCH') {
      const durationSeconds = Number(body.durationSeconds);
      if (body.action !== 'end' || !Number.isSafeInteger(durationSeconds) || durationSeconds < 0 || durationSeconds > 86_400) {
        return reply(res, 400, { error: 'Invalid voice call end request' });
      }
      const call = store.endVoiceCall(session.tenant.id, session.user.id, voiceCallMatch[1], durationSeconds);
      return call ? reply(res, 200, call) : reply(res, 404, { error: 'Voice call not found' });
    }
    if (path === '/api/action-rule' && req.method === 'PUT') {
      if (!store.isWorkspaceAdmin(session.tenant.id, session.user.id)) return reply(res, 403, { error: '只有工作区所有者或管理员可以修改权限规则' });
      try {
        const rule = store.saveTenantActionRule(session.tenant.id, session.user.id, String(body.instruction || ''), String(body.mode || '') as ActionRuleMode);
        publish();
        return reply(res, 200, rule);
      } catch (error) { return reply(res, 400, { error: error instanceof Error ? error.message : '无法保存权限规则' }); }
    }
    if (path === '/api/action-rule' && req.method === 'DELETE') {
      const deleted = store.deleteTenantActionRule(session.tenant.id, session.user.id);
      if (deleted === 'forbidden') return reply(res, 403, { error: '只有工作区所有者或管理员可以修改权限规则' });
      publish();
      return reply(res, 200, { ok: true });
    }
    if (path === '/api/pages' && req.method === 'POST') {
      try {
        const page = store.createTenantPage(session.tenant.id, String(body.title || ''), String(body.content || ''), session.user.id);
        publish();
        return reply(res, 201, page);
      } catch (error) { return reply(res, 400, { error: error instanceof Error ? error.message : '无法创建页面' }); }
    }
    if (pageMatch && req.method === 'PATCH') {
      try {
        const page = store.updateTenantPage(session.tenant.id, pageMatch[1], String(body.title || ''), String(body.content || ''));
        if (!page) return reply(res, 404, { error: '页面不存在' });
        publish();
        return reply(res, 200, page);
      } catch (error) { return reply(res, 400, { error: error instanceof Error ? error.message : '无法保存页面' }); }
    }
    if (path === '/api/memories' && req.method === 'POST') {
      const note = String(body.note || '').trim();
      if (!note || note.length > 1000) return reply(res, 400, { error: '记忆内容需为 1–1000 个字符' });
      try { return reply(res, 201, store.addTenantMemory(session.tenant.id, session.user.id, note)); }
      catch (error) { return reply(res, 400, { error: error instanceof Error ? error.message : '无法保存记忆' }); }
    }
    const memoryMatch = path.match(/^\/api\/memories\/([a-f0-9-]+)$/);
    if (memoryMatch && req.method === 'PATCH') {
      const note = String(body.note || '').trim();
      if (!note || note.length > 1000) return reply(res, 400, { error: '记忆内容需为 1–1000 个字符' });
      try {
        const memory = store.updateTenantMemory(session.tenant.id, memoryMatch[1], session.user.id, note);
        if (memory === 'forbidden') return reply(res, 403, { error: '只能修改自己创建的记忆，或请工作区管理员处理' });
        if (!memory) return reply(res, 404, { error: '记忆不存在' });
        return reply(res, 200, memory);
      } catch (error) { return reply(res, 400, { error: error instanceof Error ? error.message : '无法保存记忆' }); }
    }
    if (memoryMatch && req.method === 'DELETE') {
      const deleted = store.deleteTenantMemory(session.tenant.id, memoryMatch[1], session.user.id);
      if (deleted === 'forbidden') return reply(res, 403, { error: '只能删除自己创建的记忆，或请工作区管理员处理' });
      if (!deleted) return reply(res, 404, { error: '记忆不存在' });
      return reply(res, 200, { ok: true });
    }
    if (path === '/api/auth/tenant' && req.method === 'POST') {
      const tenantId = String(body.tenantId || '');
      if (!store.selectSessionTenant(session.tokenHash, session.user.id, tenantId)) return reply(res, 403, { error: '你不是该工作区成员' });
      publish();
      const updated = auth.session(req)!;
      return reply(res, 200, { user: updated.user, tenant: updated.tenant, tenants: store.tenantsForUser(updated.user.id) });
    }
    if (path === '/api/tenants' && req.method === 'POST') {
      const name = String(body.name || '').trim();
      if (!name || name.length > 60) return reply(res, 400, { error: '工作区名称需为 1–60 个字符' });
      const tenant = store.createWorkspace(session.user.id, name);
      store.selectSessionTenant(session.tokenHash, session.user.id, tenant.id);
      publish();
      return reply(res, 201, tenant);
    }
    const memberMatch = path.match(/^\/api\/tenants\/([a-z0-9-]+)\/members$/);
    if (memberMatch && req.method === 'GET') {
      if (memberMatch[1] !== session.tenant.id) return reply(res, 403, { error: '请先切换到目标工作区' });
      return reply(res, 200, store.workspaceMembers(session.tenant.id));
    }
    if (memberMatch && req.method === 'POST') {
      if (memberMatch[1] !== session.tenant.id) return reply(res, 403, { error: '请先切换到目标工作区' });
      const email = String(body.email || '').trim().toLowerCase();
      const role = body.role === 'admin' ? 'admin' : 'member';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return reply(res, 400, { error: '邮箱地址无效' });
      const result = store.addWorkspaceMember(session.tenant.id, session.user.id, email, role);
      if (!result.ok) return reply(res, 404, { error: result.error });
      publish();
      if (result.kind === 'invitation') return reply(res, 201, { invited: true, invitation: result.invitation });
      return reply(res, 201, { invited: false, user: result.user, role });
    }
    const invitationListMatch = path.match(/^\/api\/tenants\/([a-z0-9-]+)\/invitations$/);
    if (invitationListMatch && req.method === 'GET') {
      if (invitationListMatch[1] !== session.tenant.id) return reply(res, 403, { error: '请先切换到目标工作区' });
      const invitations = store.workspaceInvitations(session.tenant.id, session.user.id);
      if (!invitations) return reply(res, 403, { error: '只有工作区所有者或管理员可以查看邀请' });
      return reply(res, 200, invitations);
    }
    const invitationMatch = path.match(/^\/api\/tenants\/([a-z0-9-]+)\/invitations\/(.+)$/);
    if (invitationMatch && req.method === 'DELETE') {
      if (invitationMatch[1] !== session.tenant.id) return reply(res, 403, { error: '请先切换到目标工作区' });
      let email = '';
      try { email = decodeURIComponent(invitationMatch[2]).trim().toLowerCase(); } catch { return reply(res, 400, { error: '邮箱地址无效' }); }
      const result = store.revokeWorkspaceInvitation(session.tenant.id, session.user.id, email);
      if (!result.ok) return reply(res, 403, { error: result.error });
      return reply(res, 200, { ok: true });
    }
    const removeMemberMatch = path.match(/^\/api\/tenants\/([a-z0-9-]+)\/members\/([a-f0-9-]+)$/);
    if (removeMemberMatch && req.method === 'DELETE') {
      if (removeMemberMatch[1] !== session.tenant.id) return reply(res, 403, { error: '请先切换到目标工作区' });
      const result = store.removeWorkspaceMember(session.tenant.id, session.user.id, removeMemberMatch[2]);
      if (!result.ok) return reply(res, 403, { error: result.error });
      publish();
      return reply(res, 200, { ok: true });
    }

    if (process.env.DOTS_COMPUTER_BACKEND !== 'linux-desktop' && (path === '/api/computer' || path.startsWith('/api/computer/')) && store.getSetting('localComputerEnabled', session.tenant.id) === 'false') {
      return reply(res, 403, { error: '当前工作区尚未授权 Dot 使用本机 Chrome 工作区' });
    }
    const computer = computerFor(session.tenant.id);
    const taskArtifactsMatch = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/artifacts$/i);
    if (taskArtifactsMatch && req.method === 'GET') {
      const task = store.getTask(taskArtifactsMatch[1], session.tenant.id);
      if (!task) return reply(res, 404, { error: '任务不存在' });
      const artifacts = await computer.listTaskArtifacts?.(task.id) || [];
      return reply(res, 200, { artifacts });
    }
    const taskArtifactPreviewUrlMatch = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/artifacts\/preview-url$/i);
    if (taskArtifactPreviewUrlMatch && req.method === 'GET') {
      const task = store.getTask(taskArtifactPreviewUrlMatch[1], session.tenant.id);
      if (!task) return reply(res, 404, { error: '任务不存在' });
      if (!computer.readTaskArtifact) return reply(res, 404, { error: '该运行环境暂不提供云电脑文件预览' });
      const artifactPath = url.searchParams.get('path') || '';
      const artifact = await computer.readTaskArtifact(task.id, artifactPath);
      if (!artifact.previewable) return reply(res, 415, { error: '该文件暂不支持预览' });
      const ticket = createArtifactPreviewTicket(session.tenant.id, task.id);
      const encodedPath = artifactPath.split('/').map(part => encodeURIComponent(part)).join('/');
      return reply(res, 200, { url: `/api/artifact-preview/${task.id}/${ticket}/${encodedPath}` });
    }
    const taskArtifactContentMatch = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/artifacts\/content$/i);
    if (taskArtifactContentMatch && req.method === 'GET') {
      const task = store.getTask(taskArtifactContentMatch[1], session.tenant.id);
      if (!task) return reply(res, 404, { error: '任务不存在' });
      if (!computer.readTaskArtifact) return reply(res, 404, { error: '该运行环境暂不提供云电脑文件预览' });
      const artifactPath = url.searchParams.get('path') || '';
      const artifact = await computer.readTaskArtifact(task.id, artifactPath);
      return writeTaskArtifact(res, artifact);
    }
    const taskArtifactFileMatch = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/artifacts\/file\/(.+)$/i);
    if (taskArtifactFileMatch && req.method === 'GET') {
      const task = store.getTask(taskArtifactFileMatch[1], session.tenant.id);
      if (!task) return reply(res, 404, { error: '任务不存在' });
      if (!computer.readTaskArtifact) return reply(res, 404, { error: '该运行环境暂不提供云电脑文件预览' });
      let artifactPath: string;
      try { artifactPath = taskArtifactFileMatch[2].split('/').map(part => decodeURIComponent(part)).join('/'); }
      catch { return reply(res, 400, { error: '文件路径无效' }); }
      const artifact = await computer.readTaskArtifact(task.id, artifactPath);
      return writeTaskArtifact(res, artifact);
    }
    const taskArtifactOpenMatch = path.match(/^\/api\/tasks\/([a-f0-9-]{36})\/artifacts\/open-in-computer$/i);
    if (taskArtifactOpenMatch && req.method === 'POST') {
      const task = store.getTask(taskArtifactOpenMatch[1], session.tenant.id);
      if (!task) return reply(res, 404, { error: '任务不存在' });
      if (!computer.openTaskArtifact) return reply(res, 404, { error: '该运行环境暂不支持在云电脑中打开文件' });
      return reply(res, 200, await computer.openTaskArtifact(task.id, String(body.path || '')));
    }
    if (path.startsWith('/api/computer/novnc/')) {
      if (req.method !== 'GET' || !computer.novncTarget) return reply(res, 404, { error: 'Not found' });
      if ((await computer.state()).owner !== 'user') return reply(res, 403, { error: '请先接管电脑再打开交互画面' });
      return proxyNoVnc(req, res, computer, path);
    }
    if (path === '/api/computer' && req.method === 'GET') return reply(res, 200, await computer.state());
    if (path === '/api/computer/screenshot' && req.method === 'GET') {
      const bytes = await computer.screenshot();
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(bytes);
      return;
    }
    if (path === '/api/computer/open' && req.method === 'POST') return reply(res, 200, await computer.open(String(body.dotName || 'Dot')));
    if (path === '/api/computer/take-over' && req.method === 'POST') { await computer.takeOver(); return reply(res, 200, await computer.state()); }
    if (path === '/api/computer/return-control' && req.method === 'POST') {
      await computer.returnControl();
      for (const socket of novncStreams.get(session.tenant.id) || []) socket.destroy();
      novncStreams.delete(session.tenant.id);
      return reply(res, 200, await computer.state());
    }
    if (path === '/api/computer/navigate' && req.method === 'POST') return reply(res, 200, await computer.navigate(String(body.url || '')));
    if (path === '/api/computer/click' && req.method === 'POST') return reply(res, 200, await computer.click(Number(body.x), Number(body.y)));
    if (path === '/api/computer/type' && req.method === 'POST') return reply(res, 200, await computer.type(String(body.text || '')));
    if (path === '/api/computer/press' && req.method === 'POST') return reply(res, 200, await computer.press(String(body.key || '')));

    if (path === '/api/tasks' && req.method === 'POST') {
      const instruction = String(body.instruction || '').trim();
      if (!instruction || instruction.length > 10000) return reply(res, 400, { error: 'Instruction must contain 1–10000 characters' });
      const requestedMinutes = body.scheduleMinutes == null ? null : Number(body.scheduleMinutes);
      if (requestedMinutes !== null && (!Number.isInteger(requestedMinutes) || requestedMinutes < 1 || requestedMinutes > 10080)) return reply(res, 400, { error: 'Invalid schedule' });
      let scheduleSpec: ScheduleSpec | null;
      try {
        scheduleSpec = body.scheduleSpec === undefined
          ? requestedMinutes === null ? null : validateScheduleSpec({ frequency: 'interval', intervalMinutes: requestedMinutes })
          : body.scheduleSpec === null ? null : validateScheduleSpec(body.scheduleSpec);
      } catch (error) { return reply(res, 400, { error: error instanceof Error ? error.message : 'Invalid schedule' }); }
      if (scheduleSpec?.frequency === 'interval' && requestedMinutes !== null && requestedMinutes !== scheduleSpec.intervalMinutes) return reply(res, 400, { error: 'Schedule interval does not match' });
      if (scheduleSpec && scheduleSpec.frequency !== 'interval' && requestedMinutes !== null) return reply(res, 400, { error: 'Use scheduleSpec for calendar schedules' });
      const minutes = scheduleSpec?.frequency === 'interval' ? scheduleSpec.intervalMinutes : null;
      const requestedEngine = body.engine || 'model';
      if (!isEngine(requestedEngine)) return reply(res, 400, { error: '不支持此内核。请选择模型 API、Pi 或 DeepSeek Harness。' });
      const engine = requestedEngine;
      const attachmentIds = body.attachmentIds === undefined ? [] : body.attachmentIds;
      if (!Array.isArray(attachmentIds) || attachmentIds.length > 5 || attachmentIds.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) || new Set(attachmentIds).size !== attachmentIds.length) {
        return reply(res, 400, { error: '附件列表无效' });
      }
      const now = new Date();
      const firstRunAt = scheduleSpec && scheduleSpec.frequency !== 'interval' ? nextScheduleOccurrence(scheduleSpec, now) : now.toISOString();
      if (scheduleSpec && !firstRunAt) return reply(res, 400, { error: 'No future run falls on or before the schedule end date' });
      let task;
      try { task = store.createTask(instruction, minutes, engine, session.tenant.id, scheduleSpec, firstRunAt, attachmentIds, session.user.id); }
      catch (error) { return reply(res, 400, { error: error instanceof Error ? error.message : '无法创建任务' }); }
      publish(); void worker.tick();
      return reply(res, 201, task);
    }
    if (path === '/api/watches' && req.method === 'POST') {
      const intervalMinutes = Number(body.intervalMinutes);
      if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 10080) return reply(res, 400, { error: '检查间隔需为 5–10080 分钟' });
      const url = validateWatchUrl(String(body.url || ''));
      const watch = store.createWatch(url, intervalMinutes, session.tenant.id);
      publish(); void watchRunner.tick();
      return reply(res, 201, watch);
    }
    const watchMatch = path.match(/^\/api\/watches\/([a-f0-9-]+)$/);
    if (watchMatch && req.method === 'PATCH') {
      const watch = store.getWatch(watchMatch[1], session.tenant.id);
      if (!watch) return reply(res, 404, { error: 'Watch not found' });
      if (body.action === 'pause') store.updateWatch(watch.id, { status: 'paused', nextCheckAt: null }, session.tenant.id);
      else if (body.action === 'resume') store.updateWatch(watch.id, { status: 'active', nextCheckAt: new Date().toISOString(), error: null }, session.tenant.id);
      else return reply(res, 400, { error: 'Invalid action' });
      publish(); void watchRunner.tick();
      return reply(res, 200, store.getWatch(watch.id, session.tenant.id));
    }
    if (path === '/api/profile' && req.method === 'PATCH') {
      const current = store.getProfile(session.tenant.id);
      if (body.setupComplete !== undefined && typeof body.setupComplete !== 'boolean') return reply(res, 400, { error: 'Invalid avatar setup state' });
      if (body.onboardingComplete !== undefined && typeof body.onboardingComplete !== 'boolean') return reply(res, 400, { error: 'Invalid onboarding state' });
      const name = body.name === undefined ? current.name : String(body.name).trim().slice(0, 40);
      const appearance: DotAppearance = {
        shape: body.shape === undefined ? current.shape : String(body.shape),
        color: body.color === undefined ? current.color : String(body.color),
        eyes: body.eyes === undefined ? current.eyes : String(body.eyes),
        glasses: body.glasses === undefined ? current.glasses : String(body.glasses),
        accessory: body.accessory === undefined ? current.accessory : String(body.accessory),
        character: body.character === undefined ? current.character : String(body.character),
        pet: body.pet === undefined ? current.pet : String(body.pet),
      };
      if (!name || !isDotAppearance(appearance)) return reply(res, 400, { error: 'Invalid profile' });
      store.setProfile(name, appearance.shape, appearance.color, session.tenant.id, appearance.eyes, appearance.glasses, appearance.accessory, appearance.character, appearance.pet, body.setupComplete === true, body.onboardingComplete === true);
      publish();
      return reply(res, 200, snapshot(session.tenant.id).profile);
    }
    if (path === '/api/preferences' && req.method === 'PATCH') {
      if (typeof body.desktopNotifications !== 'boolean') return reply(res, 400, { error: 'Invalid notification preference' });
      store.setSetting('desktopNotifications', String(body.desktopNotifications), session.tenant.id);
      publish();
      return reply(res, 200, snapshot(session.tenant.id).preferences);
    }
    if (path === '/api/computer-access' && req.method === 'PATCH') {
      if (!['owner', 'admin'].includes(session.tenant.role)) return reply(res, 403, { error: '只有工作区所有者或管理员可以修改电脑访问设置' });
      if (typeof body.localComputer !== 'boolean') return reply(res, 400, { error: 'Invalid computer access preference' });
      store.setSetting('localComputerEnabled', String(body.localComputer), session.tenant.id);
      store.setSetting('computerChoiceConfigured', 'true', session.tenant.id);
      publish();
      return reply(res, 200, snapshot(session.tenant.id).computerAccess);
    }
    if (path === '/api/model-settings' && req.method === 'PATCH') {
      const baseUrl = String(body.baseUrl || '').trim().replace(/\/$/, '');
      const model = String(body.model || '').trim();
      const apiKey = String(body.apiKey || '').trim();
      let parsed: URL;
      try { parsed = new URL(baseUrl); } catch { return reply(res, 400, { error: '模型地址无效' }); }
      const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
      if ((!localHttp && parsed.protocol !== 'https:') || parsed.username || parsed.password || !model || model.length > 120 || apiKey.length > 5000) return reply(res, 400, { error: '模型配置无效' });
      if (!['owner', 'admin'].includes(session.tenant.role)) return reply(res, 403, { error: '只有工作区所有者或管理员可以修改共享模型 API' });
      const configuredAdmin = store.getAppSetting('modelSettingsAdminTenantId');
      const adminTenantId = configuredAdmin || store.claimAppSetting('modelSettingsAdminTenantId', session.tenant.id);
      if (adminTenantId !== session.tenant.id) return reply(res, 403, { error: '只有模型配置管理员工作区可以修改共享模型 API' });
      if (apiKey) saveModelKey(apiKey);
      store.setAppSetting('modelBaseUrl', baseUrl);
      store.setAppSetting('modelName', model);
      setModelMetadata(baseUrl, model, adminTenantId);
      publish();
      return reply(res, 200, publicModelSettings(adminTenantId));
    }
    const approvalMatch = path.match(/^\/api\/tasks\/([a-f0-9-]+)\/approval$/);
    if (approvalMatch && req.method === 'GET') {
      if (!store.getTask(approvalMatch[1], session.tenant.id)) return reply(res, 404, { error: 'Task not found' });
      return reply(res, 200, store.pageActionApproval(session.tenant.id, approvalMatch[1]));
    }
    if (approvalMatch && req.method === 'POST') {
      const task = store.getTask(approvalMatch[1], session.tenant.id);
      if (!task) return reply(res, 404, { error: 'Task not found' });
      const decision = String(body.decision || '');
      if (decision !== 'approve' && decision !== 'decline') return reply(res, 400, { error: 'Invalid approval decision' });
      const result = store.resolvePageActionApproval(session.tenant.id, task.id, session.user.id, decision);
      if (!result) return reply(res, 404, { error: 'No pending Scratchpad approval' });
      publish();
      if (result.approval.resumeStatus === 'scheduled') void worker.tick();
      return reply(res, 200, result);
    }
    const taskMatch = path.match(/^\/api\/tasks\/([a-f0-9-]+)$/);
    if (taskMatch && req.method === 'PATCH') {
      const old = store.getTask(taskMatch[1], session.tenant.id);
      if (!old) return reply(res, 404, { error: 'Task not found' });
      const action = String(body.action || '');
      if (old.status === 'stopped') return reply(res, 409, { error: '这项工作已停止，不能继续或修改' });
      if (action === 'pause') {
        if (scheduleForTask(old.scheduleSpec, old.scheduleMinutes)) return reply(res, 409, { error: '周期任务请在 Scheduled 中结束，以保留后续运行。' });
        worker.pauseTask(old.id);
        store.updateTask(old.id, { status: 'paused', nextRunAt: null }, session.tenant.id);
      }
      else if (action === 'resume' || action === 'retry') {
        const children = old.parentTaskId ? [] : store.delegatedTasks(old.id, session.tenant.id);
        const waitingOnChildren = action === 'resume' && children.some(child => !['done', 'failed', 'stopped'].includes(child.status));
        store.updateTask(old.id, { status: waitingOnChildren ? 'delegating' : 'queued', nextRunAt: waitingOnChildren ? null : new Date().toISOString(), error: null }, session.tenant.id);
      }
      else if (action === 'cancelSchedule') store.updateTask(old.id, { scheduleMinutes: null, scheduleSpec: null, status: 'paused', nextRunAt: null }, session.tenant.id);
      else if (action === 'stop') {
        try {
          const stopped = store.stopTask(old.id, session.tenant.id, session.user.id);
          if (!stopped) return reply(res, 409, { error: '这项工作当前不能停止' });
          if (!old.parentTaskId) {
            for (const child of store.delegatedTasks(old.id, session.tenant.id)) {
              if (['done', 'failed', 'stopped'].includes(child.status)) continue;
              store.stopTask(child.id, session.tenant.id, session.user.id);
              worker.stopTask(child.id);
            }
          }
        } catch (error) { return reply(res, 409, { error: error instanceof Error ? error.message : '无法停止这项工作' }); }
        worker.stopTask(old.id);
      }
      else if (action === 'reply') {
        const message = String(body.message || '').trim();
        if (!message || message.length > 5000) return reply(res, 400, { error: 'Invalid task reply' });
        if (old.status !== 'waiting') return reply(res, 409, { error: 'Task is not waiting for a reply' });
        store.replyToTask(old.id, message, session.tenant.id);
      } else if (action === 'redirect') {
        const instruction = String(body.instruction || '').trim();
        if (!instruction || instruction.length > 10000) return reply(res, 400, { error: 'Invalid instruction' });
        store.updateTask(old.id, { instruction, status: 'queued', nextRunAt: new Date().toISOString() }, session.tenant.id);
        store.addEntry('user', instruction, old.id, session.tenant.id);
      } else if (action === 'priority') {
        const priority = Number(body.priority);
        if (!Number.isInteger(priority) || priority < -10 || priority > 10) return reply(res, 400, { error: 'Invalid priority' });
        store.updateTask(old.id, { priority }, session.tenant.id);
      } else return reply(res, 400, { error: 'Invalid action' });
      store.addEntry('system', `任务操作：${action}`, old.id, session.tenant.id);
      publish(); void worker.tick();
      return reply(res, 200, store.getTask(old.id, session.tenant.id));
    }
    return reply(res, 404, { error: 'Not found' });
  } catch (error) {
    const failure = apiErrorResponse(error);
    return reply(res, failure.status, failure.body);
  }
});

function validMutationOrigin(req: IncomingMessage) {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method || '')) return true;
  if (!req.headers.origin) return false;
  return isAllowedOrigin(req.headers.origin, requestBoundary);
}

function normalizeBasePath(value: string) {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) return '';
  if (!/^[a-zA-Z0-9/_-]+$/.test(trimmed) || trimmed.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('DOTS_BASE_PATH must be a safe URL path');
  }
  return `/${trimmed}`;
}

function routePath(pathname: string) {
  if (!basePath) return pathname;
  if (pathname === basePath || pathname === `${basePath}/`) return '/';
  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
}

async function readJson(req: IncomingMessage, maxBytes = 32_000): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk.toString();
    if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw new Error('Request too large');
  }
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

async function readBytes(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > limit) { tooLarge = true; chunks.length = 0; }
    else if (!tooLarge) chunks.push(bytes);
  }
  if (tooLarge) throw new Error('ATTACHMENT_TOO_LARGE');
  return Buffer.concat(chunks, size);
}

function textAttachmentType(extension: string): string | null {
  const types: Record<string, string> = {
    '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
    '.json': 'application/json', '.yaml': 'text/yaml', '.yml': 'text/yaml', '.xml': 'application/xml', '.html': 'text/html', '.htm': 'text/html',
    '.css': 'text/css', '.js': 'text/javascript', '.jsx': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/typescript',
    '.py': 'text/x-python', '.go': 'text/x-go', '.rs': 'text/x-rust', '.java': 'text/x-java', '.sql': 'text/x-sql', '.sh': 'text/x-shellscript',
    '.toml': 'text/toml', '.ini': 'text/plain', '.log': 'text/plain', '.c': 'text/x-c', '.h': 'text/x-c', '.cpp': 'text/x-c++', '.hpp': 'text/x-c++',
  };
  return types[extension] || null;
}

function reply(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function rejectUpgrade(socket: Duplex, status: number, message: string) {
  if (socket.destroyed || !socket.writable) return;
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function writeTaskArtifact(res: ServerResponse, artifact: { bytes: Buffer; mediaType: string; name: string; previewable: boolean }) {
  if (artifact.bytes.length > 25 * 1024 * 1024) return reply(res, 413, { error: '文件超过 25 MB，暂不支持预览' });
  const filename = artifact.name.replace(/[\r\n"\\]/g, '_').slice(0, 180) || 'artifact';
  const encodedFilename = encodeURIComponent(filename);
  res.writeHead(200, {
    'Content-Type': artifact.mediaType,
    'Content-Length': artifact.bytes.length,
    'Content-Disposition': `inline; filename="artifact"; filename*=UTF-8''${encodedFilename}`,
    'X-Content-Type-Options': 'nosniff',
    ...(artifact.previewable ? { 'Content-Security-Policy': "sandbox allow-scripts; default-src 'self' data: blob: https: http:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https: http:; style-src 'self' 'unsafe-inline' https: http:; img-src 'self' data: blob: https: http:; font-src 'self' data: https: http:; connect-src https: http: wss: ws:; media-src 'self' data: blob: https: http:; object-src 'none'; base-uri 'none'; form-action 'none'" } : {}),
    'Cache-Control': 'private, no-store',
  });
  res.end(artifact.bytes);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (req.method !== 'GET') return reply(res, 405, { error: 'Method not allowed' });
  if (pathname.includes('..')) return reply(res, 404, { error: 'Not found' });
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = join(resolve('./dist'), relative);
  try {
    const bytes = await readFile(file);
    const type = ({
      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon',
      '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.json': 'application/json; charset=utf-8',
    } as Record<string, string>)[extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(bytes);
  } catch { reply(res, 404, { error: 'Not found' }); }
}

server.listen(port, host, () => {
  console.log(`Coke Dots service listening on http://${host}:${port}`);
  dingtalkStream.start();
  dingtalkMonitor.start();
  worker.start();
  watchRunner.start();
});

const shutdown = () => {
  clearInterval(sessionHeartbeat);
  worker.stop();
  dingtalkMonitor.stop();
  dingtalkStream.stop();
  watchRunner.stop();
  for (const client of clients.keys()) client.end();
  clients.clear();
  server.close(() => store.close());
  volcVoiceWss.close();
  for (const computer of computers.values()) void computer.close();
  for (const sockets of novncStreams.values()) for (const socket of sockets) socket.destroy();
  novncStreams.clear();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.on('upgrade', (req, client, head) => {
  void (async () => {
    try {
      const requestUrl = new URL(req.url || '/', `http://${host}:${port}`);
      const path = routePath(requestUrl.pathname);
      const realtimeVoiceMatch = path.match(/^\/api\/voice-calls\/([a-f0-9-]+)\/volcengine-stream$/i);
      if (realtimeVoiceMatch) {
        const origin = req.headers.origin || '';
        if (!isLocalRequest(req, path, requestBoundary) || !isAllowedOrigin(origin, requestBoundary)) return rejectUpgrade(client, 403, 'Forbidden');
        const session = auth.session(req);
        if (!session) return rejectUpgrade(client, 401, 'Unauthorized');
        const call = store.getVoiceCall(session.tenant.id, session.user.id, realtimeVoiceMatch[1]);
        if (!call || call.endedAt) return rejectUpgrade(client, 404, 'Voice call not found');
        const provider = voiceProviderInfo();
        if (provider.provider !== 'volcengine') return rejectUpgrade(client, 409, 'Realtime voice provider unavailable');
        if (!provider.configured) return rejectUpgrade(client, 503, 'Volcengine voice is not configured');
        volcVoiceWss.handleUpgrade(req, client, head, ws => {
          const close = bridgeVolcengineVoiceCall(ws, snapshot(session.tenant.id).profile.name);
          ws.once('close', () => close());
        });
        return;
      }
      const prefix = '/api/computer/novnc/';
      if (!path.startsWith(prefix) || !isLocalRequest(req, path, requestBoundary) || !isAllowedOrigin(req.headers.origin || '', requestBoundary)) return client.destroy();
      const session = auth.session(req);
      if (!session || (process.env.DOTS_COMPUTER_BACKEND !== 'linux-desktop' && store.getSetting('localComputerEnabled', session.tenant.id) === 'false')) return client.destroy();
      const computer = computerFor(session.tenant.id);
      if (!computer.novncTarget || (await computer.state()).owner !== 'user') return client.destroy();
      const target = await computer.novncTarget();
      if (!target) return client.destroy();
      const upstream = createConnection({ host: target.hostname, port: Number(target.port || 80) });
      const set = novncStreams.get(session.tenant.id) || new Set<Duplex>();
      set.add(client); set.add(upstream); novncStreams.set(session.tenant.id, set);
      const discard = () => { set.delete(client); set.delete(upstream); if (!set.size) novncStreams.delete(session.tenant.id); };
      client.once('close', discard); upstream.once('close', discard);
      upstream.once('error', () => client.destroy());
      upstream.once('connect', () => {
        const subPath = `${target.pathname.replace(/\/$/, '')}${path.slice('/api/computer/novnc'.length) || '/'}`;
        const headers: string[] = [];
        for (let index = 0; index < req.rawHeaders.length; index += 2) {
          const key = req.rawHeaders[index];
          if (key.toLowerCase() === 'host') headers.push(`Host: ${target.host}`);
          else headers.push(`${key}: ${req.rawHeaders[index + 1]}`);
        }
        upstream.write(`GET ${subPath}${requestUrl.search} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
        if (head.length) upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
    } catch { client.destroy(); }
  })();
});

async function proxyNoVnc(req: IncomingMessage, res: ServerResponse, computer: ComputerRuntime, pathname: string) {
  const prefix = '/api/computer/novnc/';
  const current = new URL(req.url || '/', `http://${host}:${port}`);
  let suffix = pathname.slice(prefix.length);
  try { suffix = suffix.split('/').map(part => decodeURIComponent(part)).join('/'); }
  catch { return reply(res, 400, { error: 'Invalid noVNC path' }); }
  if (!suffix || suffix.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\'))) return reply(res, 404, { error: 'Not found' });
  const base = await computer.novncTarget?.();
  if (!base) return reply(res, 503, { error: 'Linux 云电脑连接尚未准备好' });
  try {
    const upstreamUrl = new URL(`${suffix}${current.search}`, base);
    const upstream = await fetch(upstreamUrl, { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Cache-Control': 'no-store',
      ...(upstream.headers.get('content-length') ? { 'Content-Length': upstream.headers.get('content-length')! } : {}),
    });
    res.end(bytes);
  } catch { reply(res, 502, { error: 'Linux 云电脑画面暂时不可用' }); }
}
