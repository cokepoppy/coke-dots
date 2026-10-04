import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { Store } from './store.ts';
import { Worker, modelConfig } from './worker.ts';
import { WatchRunner, validateWatchUrl } from './watch.ts';

const port = Number(process.env.DOTS_PORT || 4317);
const host = '127.0.0.1';
const store = new Store(resolve(process.env.DOTS_DATA_DIR || './data'));
const clients = new Set<ServerResponse>();
const publish = () => {
  const payload = `data: ${JSON.stringify(store.snapshot(Boolean(modelConfig())))}\n\n`;
  for (const client of clients) client.write(payload);
};
const worker = new Worker(store, publish);
const watchRunner = new WatchRunner(store, publish);

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  if (!req.url?.startsWith('/api/')) return reply(res, 404, { error: 'Not found' });
  if (!isLocalRequest(req)) return reply(res, 403, { error: 'Local access only' });
  const path = new URL(req.url, `http://${host}:${port}`).pathname;
  if (path === '/api/health' && req.method === 'GET') return reply(res, 200, { ok: true });
  if (path === '/api/state' && req.method === 'GET') return reply(res, 200, store.snapshot(Boolean(modelConfig())));
  if (path === '/api/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'Cache-Control': 'no-store' });
    clients.add(res);
    res.write(`data: ${JSON.stringify(store.snapshot(Boolean(modelConfig())))}\n\n`);
    req.on('close', () => clients.delete(res));
    return;
  }
  try {
    const body = req.method === 'POST' || req.method === 'PATCH' ? await readJson(req) : {};
    if (path === '/api/tasks' && req.method === 'POST') {
      const instruction = String(body.instruction || '').trim();
      if (!instruction || instruction.length > 10000) return reply(res, 400, { error: 'Instruction must contain 1–10000 characters' });
      const minutes = body.scheduleMinutes == null ? null : Number(body.scheduleMinutes);
      if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080)) return reply(res, 400, { error: 'Invalid schedule' });
      const task = store.createTask(instruction, minutes);
      publish();
      void worker.tick();
      return reply(res, 201, task);
    }
    if (path === '/api/watches' && req.method === 'POST') {
      const intervalMinutes = Number(body.intervalMinutes);
      if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 10080) return reply(res, 400, { error: '检查间隔需为 5–10080 分钟' });
      const url = validateWatchUrl(String(body.url || ''));
      const watch = store.createWatch(url, intervalMinutes);
      publish();
      void watchRunner.tick();
      return reply(res, 201, watch);
    }
    const watchMatch = path.match(/^\/api\/watches\/([a-f0-9-]+)$/);
    if (watchMatch && req.method === 'PATCH') {
      const watch = store.getWatch(watchMatch[1]);
      if (!watch) return reply(res, 404, { error: 'Watch not found' });
      if (body.action === 'pause') store.updateWatch(watch.id, { status: 'paused', nextCheckAt: null });
      else if (body.action === 'resume') store.updateWatch(watch.id, { status: 'active', nextCheckAt: new Date().toISOString(), error: null });
      else return reply(res, 400, { error: 'Invalid action' });
      publish();
      void watchRunner.tick();
      return reply(res, 200, store.getWatch(watch.id));
    }
    if (path === '/api/profile' && req.method === 'PATCH') {
      const name = String(body.name || '').trim().slice(0, 40);
      const shape = String(body.shape || 'circle');
      const color = String(body.color || '#ba9af7');
      if (!name || !['circle', 'square', 'triangle'].includes(shape) || !/^#[0-9a-fA-F]{6}$/.test(color)) return reply(res, 400, { error: 'Invalid profile' });
      store.setProfile(name, shape, color);
      publish();
      return reply(res, 200, store.snapshot(Boolean(modelConfig())).profile);
    }
    const match = path.match(/^\/api\/tasks\/([a-f0-9-]+)$/);
    if (match && req.method === 'PATCH') {
      const old = store.getTask(match[1]);
      if (!old) return reply(res, 404, { error: 'Task not found' });
      const action = String(body.action || '');
      if (action === 'pause') store.updateTask(old.id, { status: 'paused', nextRunAt: null });
      else if (action === 'resume' || action === 'retry') store.updateTask(old.id, { status: 'queued', nextRunAt: new Date().toISOString(), error: null });
      else if (action === 'cancelSchedule') store.updateTask(old.id, { scheduleMinutes: null, status: 'paused', nextRunAt: null });
      else if (action === 'redirect') {
        const instruction = String(body.instruction || '').trim();
        if (!instruction || instruction.length > 10000) return reply(res, 400, { error: 'Invalid instruction' });
        store.updateTask(old.id, { instruction, status: 'queued', nextRunAt: new Date().toISOString() });
        store.addEntry('user', instruction, old.id);
      } else if (action === 'priority') {
        const priority = Number(body.priority);
        if (!Number.isInteger(priority) || priority < -10 || priority > 10) return reply(res, 400, { error: 'Invalid priority' });
        store.updateTask(old.id, { priority });
      } else return reply(res, 400, { error: 'Invalid action' });
      store.addEntry('system', `任务操作：${action}`, old.id);
      publish();
      void worker.tick();
      return reply(res, 200, store.getTask(old.id));
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
  return (remote === '127.0.0.1' || remote === '::1') &&
    (hostname === '127.0.0.1' || hostname === 'localhost') &&
    (!origin || /^http:\/\/(127\.0\.0\.1|localhost):(5173|4317)$/.test(origin));
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

server.listen(port, host, () => {
  console.log(`Coke Dots service listening on http://${host}:${port}`);
  worker.start();
  watchRunner.start();
});

const shutdown = () => {
  worker.stop();
  watchRunner.stop();
  server.close();
  store.close();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
