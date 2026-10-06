import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const token = String(process.env.DOTS_AGENT_RUNTIME_TOKEN || '');
const port = Number(process.env.DOTS_AGENT_RUNTIME_PORT || 8083);
const workerPort = Number(process.env.LINUX_DESKTOP_WORKER_PORT || 8082);
const workspace = path.resolve(process.env.DOTS_AGENT_WORKSPACE || '/workspace');
const allowedEngines = new Set(String(process.env.DOTS_DESKTOP_AGENT_ADAPTERS || '').split(',').map(value => value.trim()).filter(Boolean));
const configured = parseAdapterConfig(process.env.DOTS_AGENT_KERNELS_JSON || '{}');
let active = null;
const queue = [];

if (!token) throw new Error('DOTS_AGENT_RUNTIME_TOKEN is required');

function parseAdapterConfig(raw) {
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DOTS_AGENT_KERNELS_JSON must be an object');
  for (const [engine, adapter] of Object.entries(value)) {
    if (!['claude', 'pi', 'dsh'].includes(engine) || !adapter || typeof adapter !== 'object' || typeof adapter.command !== 'string' || !Array.isArray(adapter.args) || adapter.args.some(arg => typeof arg !== 'string')) {
      throw new Error(`Invalid kernel adapter config for ${engine}`);
    }
  }
  return value;
}

function send(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 128 * 1024) throw new Error('request body is too large'); chunks.push(chunk); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function controlOwner() {
  const response = await fetch(`http://127.0.0.1:${workerPort}/v1/control`, { headers: { authorization: `Bearer ${process.env.LINUX_DESKTOP_WORKER_TOKEN}` }, signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error('desktop control state is unavailable');
  return (await response.json()).owner;
}

function safeWorkspace(value) {
  const target = path.resolve(workspace, String(value || '.'));
  if (target !== workspace && !target.startsWith(`${workspace}${path.sep}`)) throw new Error('task directory is outside the desktop workspace');
  return target;
}

function runKernel(input, requestSignal) {
  return new Promise((resolve, reject) => {
    if (requestSignal?.aborted) return reject(new Error('Agent task was cancelled'));
    const entry = { input, requestSignal, resolve, reject, onAbort: null };
    entry.onAbort = () => {
      const index = queue.indexOf(entry);
      if (index < 0) return;
      queue.splice(index, 1);
      reject(new Error('Agent task was cancelled'));
    };
    requestSignal?.addEventListener('abort', entry.onAbort, { once: true });
    queue.push(entry);
    void drainQueue();
  });
}

async function drainQueue() {
  if (active || !queue.length) return;
  const entry = queue.shift();
  const slot = { taskId: String(entry.input.taskId || ''), child: null, abort: null, interruptedByUser: false };
  active = slot;
  try { entry.resolve(await executeKernel(entry.input, entry.requestSignal, slot)); }
  catch (error) { entry.reject(error); }
  finally {
    entry.requestSignal?.removeEventListener('abort', entry.onAbort);
    active = null;
    void drainQueue();
  }
}

async function executeKernel(input, requestSignal, slot) {
  const engine = String(input.engine || '');
  if (!allowedEngines.has(engine)) throw new Error(`Agent kernel '${engine}' is not enabled for this workspace`);
  if (!['claude', 'pi', 'dsh'].includes(engine)) throw new Error(`Agent kernel '${engine}' needs an installed adapter`);
  const adapter = configured[engine];
  if (!adapter) throw new Error(`Agent kernel '${engine}' is enabled but no adapter is installed in this image`);
  const taskId = String(input.taskId || '');
  if (!/^[a-f0-9-]{8,64}$/i.test(taskId)) throw new Error('Task id is invalid');
  const prompt = String(input.prompt || '').trim();
  if (!prompt || prompt.length > 20_000) throw new Error('Task prompt must contain 1–20000 characters');
  if (requestSignal?.aborted) throw new Error('Agent task was cancelled');
  if (await controlOwner() !== 'agent') return { taskId, status: 'waiting', message: '电脑目前由你控制。交还电脑后，请告诉我继续。', engine, sessionId: typeof input.sessionId === 'string' ? input.sessionId : null };

  const cwd = safeWorkspace(input.cwd);
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  if (requestSignal?.aborted) throw new Error('Agent task was cancelled');
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'DOTS_AGENT_RUNTIME_TOKEN'));
  const child = spawn(adapter.command, adapter.args, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
  const abort = new AbortController();
  slot.child = child;
  slot.abort = abort;
  let stdout = '';
  child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-500_000); });
  child.stderr.on('data', () => undefined);
  child.stdin.end(JSON.stringify({
    engine, prompt, cwd, workspace, taskId,
    sessionId: typeof input.sessionId === 'string' ? input.sessionId : null,
    computer: {
      baseUrl: `http://127.0.0.1:${workerPort}`,
      workerToken: process.env.LINUX_DESKTOP_WORKER_TOKEN,
      actions: ['navigate', 'click', 'type', 'screenshot'],
    },
  }));
  const timer = setTimeout(() => child.kill('SIGTERM'), 14 * 60_000);
  const controlPoll = setInterval(() => { void controlOwner().then(owner => { if (owner === 'user') pauseActive(); }).catch(() => child.kill('SIGTERM')); }, 500);
  const onRequestAbort = () => abort.abort();
  requestSignal?.addEventListener('abort', onRequestAbort, { once: true });
  abort.signal.addEventListener('abort', () => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2000).unref(); }, { once: true });
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', value => resolve(value ?? 1));
    });
    if (requestSignal?.aborted) throw new Error('Agent task was cancelled');
    if (slot.interruptedByUser) return { taskId, status: 'waiting', message: '我已暂停当前操作，因为你正在接管电脑。交还电脑后，请告诉我继续。', engine, sessionId: typeof input.sessionId === 'string' ? input.sessionId : null };
    if (code !== 0) throw new Error(`Agent adapter exited with code ${code}`);
    let result;
    try { result = JSON.parse(stdout); } catch { throw new Error('Agent adapter must return a JSON decision'); }
    if (!['done', 'waiting', 'scheduled', 'delegating'].includes(result.status) || typeof result.message !== 'string' || !result.message.trim()) throw new Error('Agent adapter returned an invalid decision');
    return { taskId, ...result, engine, message: result.message.slice(0, 20_000), sessionId: typeof result.sessionId === 'string' ? result.sessionId : null };
  } finally {
    clearTimeout(timer); clearInterval(controlPoll);
    requestSignal?.removeEventListener('abort', onRequestAbort);
    slot.child = null; slot.abort = null;
  }
}

function pauseActive() {
  if (!active?.child) return;
  active.interruptedByUser = true;
  active.abort?.abort();
}

http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && pathname === '/healthz') return send(res, 200, { ok: true, runtime: 'dots-agent-runtime', adapters: [...allowedEngines].filter(engine => Boolean(configured[engine])) });
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: 'Agent runtime token is required' });
    if (req.method === 'POST' && pathname === '/v1/tasks/run') {
      const requestAbort = new AbortController();
      res.once('close', () => { if (!res.writableEnded) requestAbort.abort(); });
      try { return send(res, 200, await runKernel(await readJson(req), requestAbort.signal)); }
      catch (error) { return send(res, 400, { error: error instanceof Error ? error.message.slice(0, 500) : 'Agent task failed' }); }
    }
    if (req.method === 'POST' && pathname === '/v1/tasks/pause') { pauseActive(); return send(res, 200, { paused: Boolean(active?.child) }); }
    if (req.method === 'POST' && pathname === '/v1/tasks/stop') {
      active?.abort?.abort();
      active?.child?.kill('SIGTERM');
      return send(res, 200, { stopped: Boolean(active) });
    }
    return send(res, 404, { error: 'not found' });
  } catch (error) { return send(res, 400, { error: error instanceof Error ? error.message.slice(0, 300) : 'request failed' }); }
}).listen(port, '0.0.0.0', () => process.stdout.write(`Dots Agent runtime listening on ${port}\n`));
