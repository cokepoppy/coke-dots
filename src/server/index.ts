import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve, join, extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Store } from './store.ts';
import { Worker } from './worker.ts';
import { WatchRunner, validateWatchUrl } from './watch.ts';
import { adapters } from './adapters.ts';
import type { Engine, ScheduleSpec } from '../shared/types.ts';
import { nextScheduleOccurrence, validateScheduleSpec } from '../shared/scheduling.ts';
import { loadModelSettings, publicModelSettings, saveModelKey, setModelMetadata } from './model-settings.ts';
import { ComputerManager } from './computer.ts';
import { AuthService } from './auth.ts';
import { existsSync } from 'node:fs';

const envFile = resolve(process.env.DOTS_ENV_FILE || '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const port = Number(process.env.DOTS_PORT || 4317);
const host = '127.0.0.1';
const dataDirectory = resolve(process.env.DOTS_DATA_DIR || './data');
const store = new Store(dataDirectory);
const auth = new AuthService(store, port);
const computers = new Map<string, ComputerManager>();
const clients = new Map<ServerResponse, string>();
const availableFor = (tenantId: string) => (Object.keys(adapters) as Engine[]).filter(id => adapters[id].available(tenantId));

function snapshot(tenantId: string) {
  loadModelSettings(store.getSetting('modelBaseUrl', tenantId), store.getSetting('modelName', tenantId), tenantId);
  const available = availableFor(tenantId);
  return store.snapshot(available.includes('model'), available, publicModelSettings(tenantId), tenantId);
}

function computerFor(tenantId: string) {
  let computer = computers.get(tenantId);
  if (!computer) {
    computer = new ComputerManager(join(dataDirectory, 'tenants', tenantId, 'computer'));
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

const worker = new Worker(store, publish, join(dataDirectory, 'workspaces'));
const watchRunner = new WatchRunner(store, publish);

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  if (!isLocalRequest(req)) return reply(res, 403, { error: 'Local access only' });
  const url = new URL(req.url || '/', `http://${host}:${port}`);
  const path = url.pathname;

  if (path === '/auth/google/callback' && req.method === 'GET') return auth.finish(req, res, url);
  if (!path.startsWith('/api/')) return serveStatic(req, res);
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

  try {
    if (path === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'Cache-Control': 'no-store' });
      clients.set(res, session.tokenHash);
      res.write(`data: ${JSON.stringify(snapshot(session.tenant.id))}\n\n`);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (path === '/api/state' && req.method === 'GET') return reply(res, 200, snapshot(session.tenant.id));
    if (path === '/api/activity' && req.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') || 50);
      const beforeValue = url.searchParams.get('before');
      const before = beforeValue === null ? null : Number(beforeValue);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (before !== null && (!Number.isSafeInteger(before) || before < 1))) {
        return reply(res, 400, { error: 'Invalid activity page' });
      }
      return reply(res, 200, store.activityPage(session.tenant.id, before, limit));
    }
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

    const body = req.method === 'POST' || req.method === 'PATCH' ? await readJson(req) : {};
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

    const computer = computerFor(session.tenant.id);
    if (path === '/api/computer' && req.method === 'GET') return reply(res, 200, await computer.state());
    if (path === '/api/computer/screenshot' && req.method === 'GET') {
      const bytes = await computer.screenshot();
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(bytes);
      return;
    }
    if (path === '/api/computer/open' && req.method === 'POST') return reply(res, 200, await computer.open());
    if (path === '/api/computer/take-over' && req.method === 'POST') { computer.takeOver(); return reply(res, 200, await computer.state()); }
    if (path === '/api/computer/return-control' && req.method === 'POST') { computer.returnControl(); return reply(res, 200, await computer.state()); }
    if (path === '/api/computer/navigate' && req.method === 'POST') return reply(res, 200, await computer.navigate(String(body.url || '')));
    if (path === '/api/computer/click' && req.method === 'POST') return reply(res, 200, await computer.click(Number(body.x), Number(body.y)));
    if (path === '/api/computer/type' && req.method === 'POST') return reply(res, 200, await computer.type(String(body.text || '')));

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
      const now = new Date();
      const firstRunAt = scheduleSpec && scheduleSpec.frequency !== 'interval' ? nextScheduleOccurrence(scheduleSpec, now) : now.toISOString();
      if (scheduleSpec && !firstRunAt) return reply(res, 400, { error: 'No future run falls on or before the schedule end date' });
      const task = store.createTask(instruction, minutes, engine, session.tenant.id, scheduleSpec, firstRunAt);
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
      const name = String(body.name || '').trim().slice(0, 40);
      const shape = String(body.shape || 'circle');
      const color = String(body.color || '#ba9af7');
      if (!name || !['circle', 'square', 'triangle'].includes(shape) || !/^#[0-9a-fA-F]{6}$/.test(color)) return reply(res, 400, { error: 'Invalid profile' });
      store.setProfile(name, shape, color, session.tenant.id);
      publish();
      return reply(res, 200, snapshot(session.tenant.id).profile);
    }
    if (path === '/api/preferences' && req.method === 'PATCH') {
      if (typeof body.desktopNotifications !== 'boolean') return reply(res, 400, { error: 'Invalid notification preference' });
      store.setSetting('desktopNotifications', String(body.desktopNotifications), session.tenant.id);
      publish();
      return reply(res, 200, snapshot(session.tenant.id).preferences);
    }
    if (path === '/api/model-settings' && req.method === 'PATCH') {
      const baseUrl = String(body.baseUrl || '').trim().replace(/\/$/, '');
      const model = String(body.model || '').trim();
      const apiKey = String(body.apiKey || '').trim();
      let parsed: URL;
      try { parsed = new URL(baseUrl); } catch { return reply(res, 400, { error: '模型地址无效' }); }
      const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
      if ((!localHttp && parsed.protocol !== 'https:') || parsed.username || parsed.password || !model || model.length > 120 || apiKey.length > 5000) return reply(res, 400, { error: '模型配置无效' });
      if (apiKey) saveModelKey(apiKey, session.tenant.id);
      store.setSetting('modelBaseUrl', baseUrl, session.tenant.id);
      store.setSetting('modelName', model, session.tenant.id);
      setModelMetadata(baseUrl, model, session.tenant.id);
      publish();
      return reply(res, 200, publicModelSettings(session.tenant.id));
    }
    const taskMatch = path.match(/^\/api\/tasks\/([a-f0-9-]+)$/);
    if (taskMatch && req.method === 'PATCH') {
      const old = store.getTask(taskMatch[1], session.tenant.id);
      if (!old) return reply(res, 404, { error: 'Task not found' });
      const action = String(body.action || '');
      if (action === 'pause') store.updateTask(old.id, { status: 'paused', nextRunAt: null }, session.tenant.id);
      else if (action === 'resume' || action === 'retry') store.updateTask(old.id, { status: 'queued', nextRunAt: new Date().toISOString(), error: null }, session.tenant.id);
      else if (action === 'cancelSchedule') store.updateTask(old.id, { scheduleMinutes: null, scheduleSpec: null, status: 'paused', nextRunAt: null }, session.tenant.id);
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

function isLocalRequest(req: IncomingMessage) {
  const remote = req.socket.remoteAddress;
  const hostname = req.headers.host?.split(':')[0];
  const origin = req.headers.origin;
  const oauthCallback = req.method === 'GET' && req.url?.split('?')[0] === '/auth/google/callback' && origin === 'https://accounts.google.com';
  const allowedOrigin = !origin || isAllowedLocalOrigin(origin) || oauthCallback;
  return (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') &&
    (hostname === '127.0.0.1' || hostname === 'localhost') &&
    allowedOrigin;
}

function validMutationOrigin(req: IncomingMessage) {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method || '')) return true;
  if (!req.headers.origin) return false;
  return isAllowedLocalOrigin(req.headers.origin);
}

function isAllowedLocalOrigin(value: string) {
  try {
    const origin = new URL(value);
    const allowedPorts = new Set(['5173', String(port)]);
    return origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname) && allowedPorts.has(origin.port) && origin.origin === value;
  } catch { return false; }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk.toString();
    if (raw.length > 32_000) throw new Error('Request too large');
  }
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

function reply(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'GET') return reply(res, 405, { error: 'Method not allowed' });
  const pathname = new URL(req.url || '/', `http://${host}:${port}`).pathname;
  if (pathname.includes('..')) return reply(res, 404, { error: 'Not found' });
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = join(resolve('./dist'), relative);
  try {
    const bytes = await readFile(file);
    const type = extname(file) === '.html' ? 'text/html; charset=utf-8' : extname(file) === '.js' ? 'text/javascript; charset=utf-8' : extname(file) === '.css' ? 'text/css; charset=utf-8' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(bytes);
  } catch { reply(res, 404, { error: 'Not found' }); }
}

server.listen(port, host, () => {
  console.log(`Coke Dots service listening on http://${host}:${port}`);
  worker.start();
  watchRunner.start();
});

const shutdown = () => {
  clearInterval(sessionHeartbeat);
  worker.stop();
  watchRunner.stop();
  for (const client of clients.keys()) client.end();
  clients.clear();
  server.close(() => store.close());
  for (const computer of computers.values()) void computer.close();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
