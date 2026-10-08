import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve, join, extname, dirname } from 'node:path';
import { lstat, readFile, rm } from 'node:fs/promises';
import { Store } from './store.ts';
import { Worker } from './worker.ts';
import { WatchRunner, validateWatchUrl } from './watch.ts';
import { adapters } from './adapters.ts';
import { isReasoningEffort, type ActionRuleMode, type DotAppearance, type Engine, type ScheduleSpec } from '../shared/types.ts';
import { isDotAppearance } from '../shared/avatar.ts';
import { nextScheduleOccurrence, scheduleForTask, validateScheduleSpec } from '../shared/scheduling.ts';
import { effectiveModelConfig, hasSharedModelKey, loadModelSettings, loadSharedModelSettings, migrateWorkspaceModelToShared, publicModelSettings, saveSharedModelKey, setSharedModelMetadata } from './model-settings.ts';
import { ComputerManager, type ComputerRuntime } from './computer.ts';
import { configuredDesktopAgentEngines, LinuxDesktopComputer } from './linux-desktop-computer.ts';
import { AuthService } from './auth.ts';
import { SlackService } from './slack.ts';
import { TeamsService } from './teams.ts';
import { existsSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

const envFile = resolve(process.env.DOTS_ENV_FILE || '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const port = Number(process.env.DOTS_PORT || 4317);
const host = '127.0.0.1';
const basePath = normalizeBasePath(process.env.DOTS_BASE_PATH || '');
const publicHost = process.env.DOTS_PUBLIC_HOST?.trim().toLowerCase() || '';
const trustedProxyToken = process.env.DOTS_TRUSTED_PROXY_TOKEN || '';
const dataDirectory = resolve(process.env.DOTS_DATA_DIR || './data');
const store = new Store(dataDirectory);
function initializeModelSettings() {
  loadModelSettings(store.getSetting('modelBaseUrl', 'legacy'), store.getSetting('modelName', 'legacy'), 'legacy');
  for (const tenant of store.modelSettingsTenants()) loadModelSettings(tenant.baseUrl, tenant.model, tenant.tenantId);
  const legacyProfile = { tenantId: 'legacy', baseUrl: store.getSetting('modelBaseUrl', 'legacy') || '', model: store.getSetting('modelName', 'legacy') || '' };
  const existingProfiles = [{ ...legacyProfile, ownerUserId: null as string | null }, ...store.modelSettingsTenants()];
  if (!hasSharedModelKey()) {
    for (const profile of existingProfiles) {
      if (!profile.model || !migrateWorkspaceModelToShared(profile.tenantId, profile.baseUrl, profile.model)) continue;
      store.setSetting('sharedModelBaseUrl', profile.baseUrl, 'legacy');
      store.setSetting('sharedModelName', profile.model, 'legacy');
      if (profile.ownerUserId) store.setSetting('sharedModelAdminUserId', profile.ownerUserId, 'legacy');
      break;
    }
  }
  loadSharedModelSettings(
    store.getSetting('sharedModelBaseUrl', 'legacy') || store.getSetting('modelBaseUrl', 'legacy'),
    store.getSetting('sharedModelName', 'legacy') || store.getSetting('modelName', 'legacy'),
  );
}
initializeModelSettings();
const auth = new AuthService(store, port);
const slack = new SlackService(store, port);
const teams = new TeamsService(store);
const computers = new Map<string, ComputerRuntime>();
const novncStreams = new Map<string, Set<Duplex>>();
const clients = new Map<ServerResponse, string>();
const configuredDesktopEngines = () => configuredDesktopAgentEngines() as Engine[];
const remoteFor = (tenantId: string) => effectiveModelConfig(tenantId) ? configuredDesktopEngines() : [];
const availableFor = (tenantId: string) => {
  const remote = remoteFor(tenantId);
  const localKernelFallbacks = process.env.DOTS_COMPUTER_BACKEND === 'linux-desktop' ? new Set<Engine>(['pi', 'dsh']) : new Set<Engine>();
  return [...new Set([...(Object.keys(adapters) as Engine[]).filter(id => !localKernelFallbacks.has(id) && adapters[id].available(tenantId)), ...remote])];
};

function snapshot(tenantId: string, userId?: string) {
  loadSharedModelSettings(
    store.getSetting('sharedModelBaseUrl', 'legacy') || store.getSetting('modelBaseUrl', 'legacy'),
    store.getSetting('sharedModelName', 'legacy') || store.getSetting('modelName', 'legacy'),
  );
  loadModelSettings(store.getSetting('modelBaseUrl', tenantId), store.getSetting('modelName', tenantId), tenantId);
  const available = availableFor(tenantId);
  return store.snapshot(available.includes('model'), available, {
    ...publicModelSettings(tenantId),
    ...(userId ? { canManage: store.canManageInstanceModel(userId, tenantId) } : {}),
  }, tenantId, remoteFor(tenantId));
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
    try { client.write(`data: ${JSON.stringify(snapshot(session.tenant.id, session.user.id))}\n\n`); }
    catch { client.end(); clients.delete(client); }
  }
}

const sessionHeartbeat = setInterval(() => {
  for (const [client, tokenHash] of clients) {
    if (!store.getSession(tokenHash)) { client.end(); clients.delete(client); }
    else client.write(': keep-alive\n\n');
  }
}, 30_000);

const worker = new Worker(store, publish, join(dataDirectory, 'workspaces'), undefined, computerFor);
const watchRunner = new WatchRunner(store, publish, e2eWatchFetcher());

async function tenantRuntimeDirectoriesForReset(tenantId: string) {
  if (!/^(legacy|[a-f0-9-]{36})$/i.test(tenantId)) throw new Error('工作区 ID 无效，无法清理运行目录');
  const targets: string[] = [];
  for (const directoryName of ['tenants', 'workspaces']) {
    const parent = join(dataDirectory, directoryName);
    let parentInfo;
    try { parentInfo = await lstat(parent); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) throw new Error('Dot 运行目录不是受管目录，已停止重置');
    const target = join(parent, tenantId);
    if (dirname(target) !== parent) throw new Error('Dot 运行目录超出工作区，已停止重置');
    let targetInfo;
    try { targetInfo = await lstat(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory()) throw new Error('Dot 运行目录类型异常，已停止重置');
    targets.push(target);
  }
  return targets;
}

async function clearTenantRuntimeDirectories(targets: string[]) {
  for (const target of targets) {
    let targetInfo;
    try { targetInfo = await lstat(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory()) throw new Error('Dot 运行目录类型异常，已停止重置');
    await rm(target, { recursive: true, force: true });
  }
}

function e2eWatchFetcher(): typeof fetch {
  const configured = process.env.DOTS_E2E_WATCH_PROVIDER_URL?.trim();
  if (process.env.NODE_ENV !== 'test' || process.env.DOTS_E2E_AUTH !== '1' || !configured) return fetch;
  try {
    const provider = new URL(configured);
    if (provider.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(provider.hostname) || provider.username || provider.password || provider.pathname !== '/' || provider.search || provider.hash) return fetch;
    return (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('x-dots-e2e-source-url', String(input));
      return fetch(provider, { ...init, headers });
    };
  } catch { return fetch; }
}

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  const url = new URL(req.url || '/', `http://${host}:${port}`);
  const path = routePath(url.pathname);
  if (path === null) return reply(res, 404, { error: 'Not found' });
  if (path === '/slack/events' && req.method === 'POST') {
    let rawBody: Buffer;
    try { rawBody = await readBytes(req, 128 * 1024); }
    catch { return reply(res, 413, { error: 'Slack event body is too large' }); }
    const timestamp = typeof req.headers['x-slack-request-timestamp'] === 'string' ? req.headers['x-slack-request-timestamp'] : '';
    const signature = typeof req.headers['x-slack-signature'] === 'string' ? req.headers['x-slack-signature'] : '';
    const result = slack.acceptEvent(rawBody, timestamp, signature);
    if (result.taskCreated) void worker.tick();
    return reply(res, result.status, result.body);
  }
  if (path === '/teams/messages' && req.method === 'POST') {
    let rawBody: Buffer;
    try { rawBody = await readBytes(req, 128 * 1024); }
    catch { return reply(res, 413, { error: 'Microsoft Teams activity body is too large' }); }
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const result = await teams.acceptActivity(rawBody, authorization);
    if (result.taskCreated) void worker.tick();
    return reply(res, result.status, result.body);
  }
  if (!isLocalRequest(req, path)) return reply(res, 403, { error: 'Local access only' });

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
  if (path === '/api/e2e/teams/activity' && req.method === 'POST' && auth.e2eAuthAvailable()) {
    let rawBody: Buffer;
    try { rawBody = await readBytes(req, 128 * 1024); }
    catch { return reply(res, 413, { error: 'Microsoft Teams activity body is too large' }); }
    const result = teams.acceptE2EActivity(rawBody);
    if (result.taskCreated) void worker.tick();
    return reply(res, result.status, result.body);
  }
  if (path === '/api/slack' && req.method === 'GET') return reply(res, 200, slack.snapshot(session.tenant.id));
  if (path === '/api/slack/channels' && req.method === 'GET') {
    const result = await slack.publicChannels(session.tenant.id, url.searchParams.get('teamId') || '', session);
    return result.status === 200 ? reply(res, 200, { channels: result.value }) : reply(res, result.status, { error: result.error });
  }
  if (path === '/api/slack/monitors' && req.method === 'POST') {
    const body = await readJson(req);
    const teamId = String(body.teamId || '');
    const channelId = String(body.channelId || '');
    const instructions = String(body.instructions || '').trim();
    if (!/^[A-Z0-9]{2,32}$/.test(teamId) || !/^[A-Z0-9]{2,32}$/.test(channelId) || instructions.length < 3 || instructions.length > 1000) {
      return reply(res, 400, { error: '请指定 Slack 工作区、公共频道和 3–1000 字的关注条件' });
    }
    const channelResult = await slack.publicChannels(session.tenant.id, teamId, session);
    if (!channelResult.value) return reply(res, channelResult.status, { error: channelResult.error || 'Slack public channels are unavailable' });
    const channel = channelResult.value.find(item => item.id === channelId);
    if (!channel) return reply(res, 400, { error: '请选择当前工作区中可见的公共频道' });
    try {
      const monitor = store.createSlackEventMonitor({ tenantId: session.tenant.id, teamId, channelId, channelName: channel.name, instructions });
      publish();
      return reply(res, 201, monitor);
    } catch (error) { return reply(res, 400, { error: error instanceof Error ? error.message : '无法创建 Slack 事件监控' }); }
  }
  const slackMonitorMatch = path.match(/^\/api\/slack\/monitors\/([a-f0-9-]{36})$/i);
  if (slackMonitorMatch && req.method === 'PATCH') {
    const body = await readJson(req);
    const action = body.action;
    if (action !== 'pause' && action !== 'resume') return reply(res, 400, { error: 'Invalid Slack monitor action' });
    if (!['owner', 'admin'].includes(session.tenant.role)) return reply(res, 403, { error: '只有工作区所有者或管理员可以管理 Slack 事件监控' });
    const monitor = store.updateSlackEventMonitor(slackMonitorMatch[1], session.tenant.id, action);
    if (!monitor) return reply(res, 404, { error: 'Slack event monitor not found' });
    publish();
    return reply(res, 200, monitor);
  }
  if (path === '/api/teams' && req.method === 'GET') return reply(res, 200, teams.snapshot(session));
  if (path === '/api/teams/link-code' && req.method === 'POST') {
    const result = teams.createLinkCode(session);
    return result.status === 200 ? reply(res, 200, result.value) : reply(res, result.status, { error: result.error });
  }
  if (path === '/api/slack/oauth/start' && req.method === 'GET') return slack.begin(req, res, session);
  if (path === '/api/slack/contact' && req.method === 'POST') {
    const body = await readJson(req);
    const result = slack.setContactWorkspace(session, String(body.teamId || ''));
    return result.status === 200 ? reply(res, 200, result.value) : reply(res, result.status, { error: result.error });
  }
  if (worker.isWorkspaceResetting(session.tenant.id) && req.method !== 'GET' && req.method !== 'HEAD' && path !== '/api/dot/reset') {
    return reply(res, 409, { error: 'Dot 正在重置，请稍后重试' });
  }

  try {
    if (path === '/api/dot/reset' && req.method === 'POST') {
      const body = await readJson(req);
      if (body.confirm !== true) return reply(res, 400, { error: '请在确认窗口中确认重置 Dot' });
      if (worker.isWorkspaceResetting(session.tenant.id)) return reply(res, 409, { error: 'Dot 正在重置，请稍后重试' });
      const eligibility = store.personalDotResetEligibility(session.tenant.id, session.user.id);
      if (eligibility !== 'ok') {
        const response = eligibility === 'shared'
          ? { status: 409, error: '当前 Dot 所在工作区有多位成员；为保护共享数据，不能从这里重置。' }
          : eligibility === 'not-found'
            ? { status: 404, error: '找不到当前 Dot' }
            : { status: 403, error: '只有个人工作区所有者可以重置 Dot' };
        return reply(res, response.status, { error: response.error });
      }
      const tenantId = session.tenant.id;
      await Promise.all([worker.beginWorkspaceReset(tenantId), watchRunner.beginWorkspaceReset(tenantId)]);
      try {
        // Validate every local path before deleting the separately managed cloud computer.
        const runtimeDirectories = await tenantRuntimeDirectoriesForReset(tenantId);
        const computer = computers.get(tenantId);
        if (computer?.reset) await computer.reset();
        else await computer?.close();
        computers.delete(tenantId);
        slack.clearTenant(tenantId);
        teams.clearTenant(tenantId);
        await clearTenantRuntimeDirectories(runtimeDirectories);
        const reset = store.resetPersonalDot(tenantId, session.user.id);
        if (reset !== 'ok') return reply(res, 409, { error: 'Dot 工作区状态已改变，请刷新页面后重试。' });
        publish();
        return reply(res, 200, { ok: true });
      } finally {
        worker.endWorkspaceReset(tenantId);
        watchRunner.endWorkspaceReset(tenantId);
      }
    }
    if (path === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'Cache-Control': 'no-store' });
      clients.set(res, session.tokenHash);
      res.write(`data: ${JSON.stringify(snapshot(session.tenant.id, session.user.id))}\n\n`);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (path === '/api/state' && req.method === 'GET') return reply(res, 200, snapshot(session.tenant.id, session.user.id));
    if (path === '/api/voice-calls' && req.method === 'GET') return reply(res, 200, store.voiceCalls(session.tenant.id, session.user.id));
    if (path === '/api/activity' && req.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') || 50);
      const beforeValue = url.searchParams.get('before');
      const before = beforeValue === null ? null : Number(beforeValue);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (before !== null && (!Number.isSafeInteger(before) || before < 1))) {
        return reply(res, 400, { error: 'Invalid activity page' });
      }
      return reply(res, 200, store.activityPage(session.tenant.id, before, limit));
    }
    if (path === '/api/action-rule' && req.method === 'GET') return reply(res, 200, store.personalActionRule(session.user.id));
    if (path === '/api/memories' && req.method === 'GET') return reply(res, 200, store.tenantMemories(session.tenant.id));
    if (path === '/api/dot-memories' && req.method === 'GET') return reply(res, 200, store.personalDotMemories(session.user.id));
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

    const body = req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT' ? await readJson(req) : {};
    if (path === '/api/dot-control' && req.method === 'PATCH') {
      if (!['owner', 'admin'].includes(session.tenant.role)) return reply(res, 403, { error: '只有工作区所有者或管理员可以更改 Dot 状态' });
      if (typeof body.paused !== 'boolean') return reply(res, 400, { error: 'Invalid Dot pause state' });
      if (body.paused) {
        worker.pauseWorkspace(session.tenant.id);
        watchRunner.pauseWorkspace(session.tenant.id);
      } else {
        worker.resumeWorkspace(session.tenant.id);
      }
      publish();
      if (!body.paused) { void worker.tick(); void watchRunner.tick(); }
      return reply(res, 200, { dotPaused: store.isDotPaused(session.tenant.id) });
    }
    if (path === '/api/voice-calls' && req.method === 'POST') {
      return reply(res, 201, store.createVoiceCall(session.tenant.id, session.user.id));
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
      try {
        const rule = store.savePersonalActionRule(session.user.id, String(body.instruction || ''), String(body.mode || '') as ActionRuleMode);
        publish();
        return reply(res, 200, rule);
      } catch (error) { return reply(res, 400, { error: error instanceof Error ? error.message : '无法保存权限规则' }); }
    }
    if (path === '/api/action-rule' && req.method === 'DELETE') {
      store.deletePersonalActionRule(session.user.id);
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
    if (path === '/api/dot-memories' && req.method === 'POST') {
      const note = String(body.note || '').trim();
      if (!note || note.length > 1000) return reply(res, 400, { error: 'Dot 个人记忆需为 1–1000 个字符' });
      try { return reply(res, 201, store.addPersonalDotMemory(session.user.id, note)); }
      catch (error) { return reply(res, 400, { error: error instanceof Error ? error.message : '无法保存 Dot 个人记忆' }); }
    }
    const dotMemoryMatch = path.match(/^\/api\/dot-memories\/([a-f0-9-]+)$/i);
    if (dotMemoryMatch && req.method === 'PATCH') {
      const note = String(body.note || '').trim();
      if (!note || note.length > 1000) return reply(res, 400, { error: 'Dot 个人记忆需为 1–1000 个字符' });
      try {
        const memory = store.updatePersonalDotMemory(session.user.id, dotMemoryMatch[1], note);
        return memory ? reply(res, 200, memory) : reply(res, 404, { error: 'Dot 个人记忆不存在' });
      } catch (error) { return reply(res, 400, { error: error instanceof Error ? error.message : '无法保存 Dot 个人记忆' }); }
    }
    if (dotMemoryMatch && req.method === 'DELETE') {
      const deleted = store.deletePersonalDotMemory(session.user.id, dotMemoryMatch[1]);
      return deleted ? reply(res, 200, { ok: true }) : reply(res, 404, { error: 'Dot 个人记忆不存在' });
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
    if (path.startsWith('/api/computer/novnc/')) {
      if (req.method !== 'GET' || !computer.novncTarget) return reply(res, 404, { error: 'Not found' });
      if ((await computer.state()).owner !== 'user') return reply(res, 403, { error: '请先接管电脑再打开交互画面' });
      return proxyNoVnc(req, res, computer);
    }
    if (path === '/api/computer' && req.method === 'GET') {
      const state = await computer.state();
      if (state.backend === 'linux-desktop' && state.ready && state.url === 'about:blank') {
        const dotName = store.getProfile(session.tenant.id).name;
        if (state.title !== `Welcome back, ${dotName}`) return reply(res, 200, await computer.open(dotName));
      }
      return reply(res, 200, state);
    }
    if (path === '/api/computer/screenshot' && req.method === 'GET') {
      const bytes = await computer.screenshot();
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(bytes);
      return;
    }
    if (path === '/api/computer/open' && req.method === 'POST') return reply(res, 200, await computer.open(store.getProfile(session.tenant.id).name));
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
      const engine = String(body.engine || 'model') as Engine;
      if (!(engine in adapters)) return reply(res, 400, { error: 'Invalid engine' });
      if (engine === 'claude') return reply(res, 400, { error: 'Claude Code 暂未支持；可选择 Pi 或 DeepSeek Harness。' });
      const remoteEngineAvailable = configuredDesktopEngines().includes(engine) && Boolean(effectiveModelConfig(session.tenant.id));
      if (engine !== 'model' && !adapters[engine].available(session.tenant.id) && !remoteEngineAvailable) {
        return reply(res, 400, { error: '当前 Coke Dots 实例未启用此 Agent 内核，请检查实例级模型 API 配置和内核安装。' });
      }
      const reasoningEffort = body.reasoningEffort === undefined ? store.getSetting('reasoningEffort', session.tenant.id) || 'high' : body.reasoningEffort;
      if (!isReasoningEffort(reasoningEffort)) return reply(res, 400, { error: 'Invalid reasoning effort' });
      const attachmentIds = body.attachmentIds === undefined ? [] : body.attachmentIds;
      if (!Array.isArray(attachmentIds) || attachmentIds.length > 5 || attachmentIds.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) || new Set(attachmentIds).size !== attachmentIds.length) {
        return reply(res, 400, { error: '附件列表无效' });
      }
      const now = new Date();
      const firstRunAt = scheduleSpec && scheduleSpec.frequency !== 'interval' ? nextScheduleOccurrence(scheduleSpec, now) : now.toISOString();
      if (scheduleSpec && !firstRunAt) return reply(res, 400, { error: 'No future run falls on or before the schedule end date' });
      let task;
      try { task = store.createTask(instruction, minutes, engine, session.tenant.id, scheduleSpec, firstRunAt, attachmentIds, session.user.id, 'standard', reasoningEffort); }
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
      if (body.desktopNotifications !== undefined) {
        if (typeof body.desktopNotifications !== 'boolean') return reply(res, 400, { error: 'Invalid notification preference' });
        store.setSetting('desktopNotifications', String(body.desktopNotifications), session.tenant.id);
      }
      if (body.reasoningEffort !== undefined) {
        if (!isReasoningEffort(body.reasoningEffort)) return reply(res, 400, { error: 'Invalid reasoning effort' });
        store.setSetting('reasoningEffort', body.reasoningEffort, session.tenant.id);
      }
      if (body.desktopNotifications === undefined && body.reasoningEffort === undefined) return reply(res, 400, { error: 'No preference supplied' });
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
      if (!store.canManageInstanceModel(session.user.id, session.tenant.id)) return reply(res, 403, { error: '只有实例模型管理员可以修改共享模型 API 凭据' });
      const baseUrl = String(body.baseUrl || '').trim().replace(/\/$/, '');
      const model = String(body.model || '').trim();
      const apiKey = String(body.apiKey || '').trim();
      let parsed: URL;
      try { parsed = new URL(baseUrl); } catch { return reply(res, 400, { error: '模型地址无效' }); }
      const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
      if ((!localHttp && parsed.protocol !== 'https:') || parsed.username || parsed.password || !model || model.length > 120 || apiKey.length > 5000) return reply(res, 400, { error: '模型配置无效' });
      if (!store.claimInstanceModelManager(session.user.id, session.tenant.id)) return reply(res, 403, { error: '只有实例模型管理员可以修改共享模型 API 凭据' });
      if (apiKey) {
        saveSharedModelKey(apiKey);
      }
      store.setSetting('sharedModelBaseUrl', baseUrl, 'legacy');
      store.setSetting('sharedModelName', model, 'legacy');
      setSharedModelMetadata(baseUrl, model);
      publish();
      return reply(res, 200, publicModelSettings(session.tenant.id));
    }
    const approvalMatch = path.match(/^\/api\/tasks\/([a-f0-9-]+)\/approval$/);
    if (approvalMatch && req.method === 'GET') {
      if (!store.getTask(approvalMatch[1], session.tenant.id)) return reply(res, 404, { error: 'Task not found' });
      const approval = store.pageActionApproval(session.tenant.id, approvalMatch[1]);
      return reply(res, 200, approval ? { ...approval, canDecide: store.canResolvePageActionApproval(session.tenant.id, approvalMatch[1], session.user.id) } : null);
    }
    if (approvalMatch && req.method === 'POST') {
      const task = store.getTask(approvalMatch[1], session.tenant.id);
      if (!task) return reply(res, 404, { error: 'Task not found' });
      const decision = String(body.decision || '');
      if (decision !== 'approve' && decision !== 'decline') return reply(res, 400, { error: 'Invalid approval decision' });
      const result = store.resolvePageActionApproval(session.tenant.id, task.id, session.user.id, decision);
      if (result === 'forbidden') return reply(res, 403, { error: '只有发起这项工作的人可以处理待批准操作' });
      if (!result) return reply(res, 404, { error: 'No pending Scratchpad approval' });
      publish();
      if (result.approval.resumeStatus === 'scheduled') void worker.tick();
      return reply(res, 200, result);
    }
    const signInMatch = path.match(/^\/api\/tasks\/([a-f0-9-]+)\/sign-in(?:\/(submit|cancel|continue))?$/i);
    if (signInMatch) {
      const task = store.getTask(signInMatch[1], session.tenant.id);
      if (!task) return reply(res, 404, { error: 'Task not found' });
      const action = signInMatch[2] || '';
      if (req.method === 'GET' && !action) return reply(res, 200, store.websiteSignInRequest(session.tenant.id, task.id));
      if (req.method === 'POST' && action === 'cancel') {
        const signIn = store.cancelWebsiteSignInRequest(session.tenant.id, task.id);
        if (!signIn) return reply(res, 404, { error: 'No pending website sign-in request' });
        publish();
        return reply(res, 200, { signIn });
      }
      if (req.method === 'POST' && action === 'submit') {
        const signIn = store.websiteSignInRequest(session.tenant.id, task.id);
        if (!signIn || signIn.status !== 'pending' || task.status !== 'waiting') return reply(res, 409, { error: 'No pending website sign-in request' });
        if (process.env.DOTS_COMPUTER_BACKEND !== 'linux-desktop' && store.getSetting('localComputerEnabled', session.tenant.id) === 'false') return reply(res, 403, { error: '当前工作区尚未授权 Dot 使用本机 Chrome 工作区' });
        const identifier = typeof body.identifier === 'string' ? body.identifier : '';
        const password = typeof body.password === 'string' ? body.password : '';
        const computer = computerFor(session.tenant.id);
        if (!computer.fillWebsiteSignIn) return reply(res, 503, { error: '当前电脑暂不支持私密登录表单，请接管电脑手动登录。' });
        try {
          await computer.fillWebsiteSignIn(signIn.url, identifier, password);
        } catch (error) {
          const message = error instanceof Error ? error.message : '无法在电脑中填写登录表单';
          const redacted = [identifier, password].filter(Boolean).reduce((value, secret) => value.replaceAll(secret, '[redacted]'), message);
          return reply(res, 400, { error: redacted.slice(0, 240) });
        }
        const updated = store.markWebsiteSignInSubmitted(session.tenant.id, task.id);
        if (!updated) {
          await Promise.resolve(computer.returnControl()).catch(() => undefined);
          return reply(res, 409, { error: '这项工作已发生变化；为保护凭据，电脑已清除表单并交还 Dot。' });
        }
        publish();
        return reply(res, 200, { signIn: updated, computer: await computer.state() });
      }
      if (req.method === 'POST' && action === 'continue') {
        const signIn = store.websiteSignInRequest(session.tenant.id, task.id);
        if (!signIn || !['pending', 'submitted'].includes(signIn.status)) return reply(res, 409, { error: '没有可继续的网站登录请求' });
        const computer = computerFor(session.tenant.id);
        const computerState = await computer.state();
        if (!computerState.ready) return reply(res, 409, { error: '请先打开电脑并完成网站登录。' });
        if (computerState.owner === 'user') return reply(res, 409, { error: '请先在电脑页面完成登录并交还电脑。' });
        const updated = store.continueWebsiteSignInTask(session.tenant.id, task.id);
        if (!updated) return reply(res, 409, { error: '这项工作已发生变化，无法继续。' });
        publish(); void worker.tick();
        return reply(res, 200, { task: updated });
      }
      return reply(res, 404, { error: 'Not found' });
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
      else if (action === 'cancelSchedule') {
        store.forgetDotPausedTask(session.tenant.id, old.id);
        store.updateTask(old.id, { scheduleMinutes: null, scheduleSpec: null, status: 'paused', nextRunAt: null }, session.tenant.id);
      }
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
    return reply(res, error instanceof SyntaxError ? 400 : 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

function isLocalRequest(req: IncomingMessage, path: string) {
  const remote = req.socket.remoteAddress;
  const hostname = req.headers.host?.split(':')[0]?.toLowerCase();
  const origin = req.headers.origin;
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const localHost = hostname === '127.0.0.1' || hostname === 'localhost';
  const proxyToken = req.headers['x-dots-proxy-token'];
  const trustedProxy = Boolean(trustedProxyToken && typeof proxyToken === 'string' && safeEqual(proxyToken, trustedProxyToken));
  const forwarded = Boolean(publicHost && trustedProxy && hostname === publicHost);
  const oauthCallback = req.method === 'GET' && path === '/auth/google/callback' && origin === 'https://accounts.google.com';
  const slackCallback = req.method === 'GET' && path === '/auth/slack/callback' && ['https://slack.com', 'https://slack-gov.com'].includes(origin || '');
  const allowedOrigin = !origin || isAllowedOrigin(origin) || oauthCallback || slackCallback;
  return loopback && (localHost || forwarded) && allowedOrigin;
}

function validMutationOrigin(req: IncomingMessage) {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method || '')) return true;
  if (!req.headers.origin) return false;
  return isAllowedOrigin(req.headers.origin);
}

function isAllowedOrigin(value: string) {
  try {
    const origin = new URL(value);
    const allowedPorts = new Set(['5173', String(port)]);
    const isLocal = origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname) && allowedPorts.has(origin.port);
    const publicOrigin = process.env.DOTS_PUBLIC_ORIGIN?.trim().replace(/\/$/, '');
    return (isLocal || Boolean(publicOrigin && origin.origin === publicOrigin)) && origin.origin === value;
  } catch { return false; }
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
  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : null;
}

function safeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk.toString();
    if (raw.length > 32_000) throw new Error('Request too large');
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

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (req.method !== 'GET') return reply(res, 405, { error: 'Method not allowed' });
  if (pathname.includes('..')) return reply(res, 404, { error: 'Not found' });
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = join(resolve('./dist'), relative);
  try {
    const bytes = await readFile(file);
    const extension = extname(file);
    const type = extension === '.html' ? 'text/html; charset=utf-8'
      : extension === '.js' ? 'text/javascript; charset=utf-8'
        : extension === '.css' ? 'text/css; charset=utf-8'
          : extension === '.webp' ? 'image/webp'
            : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(bytes);
  } catch { reply(res, 404, { error: 'Not found' }); }
}

server.listen(port, host, () => {
  console.log(`Coke Dots service listening on http://${host}:${port}`);
  worker.start();
  watchRunner.start();
  slack.start();
  teams.start();
});

const shutdown = () => {
  clearInterval(sessionHeartbeat);
  worker.stop();
  watchRunner.stop();
  slack.stop();
  teams.stop();
  for (const client of clients.keys()) client.end();
  clients.clear();
  server.close(() => store.close());
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
      const prefix = '/api/computer/novnc/';
      if (!path?.startsWith(prefix) || !isLocalRequest(req, path) || !req.headers.origin || !isAllowedOrigin(req.headers.origin)) return client.destroy();
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

async function proxyNoVnc(req: IncomingMessage, res: ServerResponse, computer: ComputerRuntime) {
  const prefix = '/api/computer/novnc/';
  const current = new URL(req.url || '/', `http://${host}:${port}`);
  const pathname = routePath(current.pathname);
  if (!pathname?.startsWith(prefix)) return reply(res, 404, { error: 'Not found' });
  let suffix = pathname.slice(prefix.length);
  try { suffix = suffix.split('/').map(part => decodeURIComponent(part)).join('/'); }
  catch { return reply(res, 400, { error: 'Invalid noVNC path' }); }
  if (!suffix || suffix.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\'))) return reply(res, 404, { error: 'Not found' });
  const base = await computer.novncTarget?.();
  if (!base) return reply(res, 503, { error: 'Linux 云电脑连接尚未准备好' });
  try {
    const upstreamUrl = new URL(`${suffix}${current.search}`, base);
    const upstream = await fetch(upstreamUrl, { signal: AbortSignal.timeout(10_000), redirect: 'manual' });
    let bytes = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    if (upstream.ok && suffix === 'vnc_lite.html' && contentType.includes('text/html')) {
      const html = bytes.toString('utf8');
      const viewerStyle = `<style data-coke-dots-viewer>
        html,body{width:100%;height:100%;margin:0;overflow:hidden}
        #top_bar{display:none!important}
        #screen{flex:1;min-height:0;width:100%;overflow:hidden;background:#17191d}
      </style>`;
      bytes = Buffer.from(html.replace(/<\/head>/i, `${viewerStyle}</head>`));
    }
    res.writeHead(upstream.status, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'Content-Length': bytes.length,
    });
    res.end(bytes);
  } catch { reply(res, 502, { error: 'Linux 云电脑画面暂时不可用' }); }
}
