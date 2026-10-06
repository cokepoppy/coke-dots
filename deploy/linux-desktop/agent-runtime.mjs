import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const token = String(process.env.DOTS_AGENT_RUNTIME_TOKEN || '');
const port = Number(process.env.DOTS_AGENT_RUNTIME_PORT || 8083);
const workerPort = Number(process.env.LINUX_DESKTOP_WORKER_PORT || 8082);
const workspace = path.resolve(process.env.DOTS_AGENT_WORKSPACE || '/workspace');
const runtimeStateDirectory = path.join(workspace, '.coke-dots', 'agent-runtime');
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
  if (res.destroyed || res.writableEnded) return;
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

function taskFingerprint(input) {
  const normalizedPrompt = String(input.prompt || '').replace(/\nCurrent time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, '\nCurrent time: <stable-run-time>');
  return createHash('sha256').update(JSON.stringify({
    taskId: String(input.taskId || ''), executionId: String(input.executionId || input.taskId || ''), engine: String(input.engine || ''), prompt: normalizedPrompt,
    sessionId: typeof input.sessionId === 'string' ? input.sessionId : null, cwd: String(input.cwd || '.'),
  })).digest('hex');
}

function resultFile(taskId) {
  const fileName = createHash('sha256').update(taskId).digest('hex');
  return path.join(runtimeStateDirectory, `${fileName}.json`);
}

async function cachedResult(input) {
  let saved;
  try { saved = JSON.parse(await readFile(resultFile(String(input.taskId)), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw new Error('Agent recovery record could not be read'); }
  if (saved?.fingerprint !== taskFingerprint(input) || !saved.result || typeof saved.result !== 'object') return null;
  const result = saved.result;
  if (!['done', 'waiting', 'scheduled', 'delegating'].includes(result.status) || typeof result.message !== 'string' || !result.message.trim()) return null;
  return result;
}

async function persistResult(input, result) {
  await mkdir(runtimeStateDirectory, { recursive: true, mode: 0o700 });
  const target = resultFile(String(input.taskId));
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ fingerprint: taskFingerprint(input), result }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

function enqueueKernel(input) {
  return new Promise((resolve, reject) => {
    const entry = { input, resolve, reject };
    queue.push(entry);
    void drainQueue();
  });
}

const inFlight = new Map();
function runKernel(input) {
  const taskId = String(input.taskId || '');
  const fingerprint = taskFingerprint(input);
  const existing = inFlight.get(taskId);
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new Error('This task is already running with different instructions');
    return existing.promise;
  }
  const promise = enqueueKernel(input).finally(() => {
    if (inFlight.get(taskId)?.promise === promise) inFlight.delete(taskId);
  });
  inFlight.set(taskId, { fingerprint, promise });
  return promise;
}

async function drainQueue() {
  if (active || !queue.length) return;
  const entry = queue.shift();
  const slot = { taskId: String(entry.input.taskId || ''), child: null, abort: null, interruptedByUser: false, stoppedByUser: false, persistResult: true };
  active = slot;
  try {
    const result = await executeKernel(entry.input, slot);
    if (slot.persistResult) await persistResult(entry.input, result);
    entry.resolve(result);
  }
  catch (error) { entry.reject(error); }
  finally {
    active = null;
    void drainQueue();
  }
}

async function executeKernel(input, slot) {
  const engine = String(input.engine || '');
  if (!allowedEngines.has(engine)) throw new Error(`Agent kernel '${engine}' is not enabled for this workspace`);
  if (!['claude', 'pi', 'dsh'].includes(engine)) throw new Error(`Agent kernel '${engine}' needs an installed adapter`);
  const adapter = configured[engine];
  if (!adapter) throw new Error(`Agent kernel '${engine}' is enabled but no adapter is installed in this image`);
  const taskId = String(input.taskId || '');
  if (!/^[a-f0-9-]{8,64}$/i.test(taskId)) throw new Error('Task id is invalid');
  const executionId = String(input.executionId || taskId);
  if (!executionId || executionId.length > 256) throw new Error('Task execution id is invalid');
  const prompt = String(input.prompt || '').trim();
  if (!prompt || prompt.length > 20_000) throw new Error('Task prompt must contain 1–20000 characters');
  const cached = await cachedResult(input);
  if (cached) return cached;
  const interruptedAfterCache = interruptionDecision(input, slot);
  if (interruptedAfterCache) return interruptedAfterCache;
  const owner = await controlOwner();
  const interruptedAfterControlCheck = interruptionDecision(input, slot);
  if (interruptedAfterControlCheck) return interruptedAfterControlCheck;
  if (owner !== 'agent') {
    slot.persistResult = false;
    return { taskId, status: 'waiting', message: '电脑目前由你控制。交还电脑后，请告诉我继续。', engine, sessionId: typeof input.sessionId === 'string' ? input.sessionId : null };
  }

  const cwd = safeWorkspace(input.cwd);
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const interruptedAfterWorkspace = interruptionDecision(input, slot);
  if (interruptedAfterWorkspace) return interruptedAfterWorkspace;
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'DOTS_AGENT_RUNTIME_TOKEN'));
  const child = spawn(adapter.command, adapter.args, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
  const abort = new AbortController();
  slot.child = child;
  slot.abort = abort;
  let stdout = '';
  child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-500_000); });
  child.stderr.on('data', () => undefined);
  child.stdin.end(JSON.stringify({
    engine, prompt, cwd, workspace, taskId, executionId,
    sessionId: typeof input.sessionId === 'string' ? input.sessionId : null,
    computer: {
      baseUrl: `http://127.0.0.1:${workerPort}`,
      workerToken: process.env.LINUX_DESKTOP_WORKER_TOKEN,
      actions: ['navigate', 'click', 'type', 'screenshot'],
    },
  }));
  const timer = setTimeout(() => child.kill('SIGTERM'), 14 * 60_000);
  const controlPoll = setInterval(() => { void controlOwner().then(owner => { if (owner === 'user') pauseActive(); }).catch(() => child.kill('SIGTERM')); }, 500);
  abort.signal.addEventListener('abort', () => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2000).unref(); }, { once: true });
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', value => resolve(value ?? 1));
    });
    if (slot.stoppedByUser) throw new Error('Agent task was stopped by the user');
    if (slot.interruptedByUser) {
      slot.persistResult = false;
      return { taskId, status: 'waiting', message: '我已暂停当前操作，因为你正在接管电脑。交还电脑后，请告诉我继续。', engine, sessionId: typeof input.sessionId === 'string' ? input.sessionId : null };
    }
    if (code !== 0) throw new Error(`Agent adapter exited with code ${code}`);
    let result;
    try { result = JSON.parse(stdout); } catch { throw new Error('Agent adapter must return a JSON decision'); }
    if (!['done', 'waiting', 'scheduled', 'delegating'].includes(result.status) || typeof result.message !== 'string' || !result.message.trim()) throw new Error('Agent adapter returned an invalid decision');
    return { taskId, ...result, engine, message: result.message.slice(0, 20_000), sessionId: typeof result.sessionId === 'string' ? result.sessionId : null };
  } finally {
    clearTimeout(timer); clearInterval(controlPoll);
    slot.child = null; slot.abort = null;
  }
}

function interruptTask(taskId, action) {
  const queuedIndex = queue.findIndex(entry => String(entry.input.taskId || '') === taskId);
  if (queuedIndex >= 0) {
    const [entry] = queue.splice(queuedIndex, 1);
    if (action === 'pause') entry.resolve({ taskId, status: 'waiting', message: '任务已暂停；交还电脑后可以继续。', engine: String(entry.input.engine || ''), sessionId: typeof entry.input.sessionId === 'string' ? entry.input.sessionId : null });
    else entry.reject(new Error('Agent task was stopped by the user'));
    return true;
  }
  if (!active || active.taskId !== taskId) return false;
  active.interruptedByUser = action === 'pause';
  active.stoppedByUser = action === 'stop';
  active.persistResult = false;
  active.abort?.abort();
  return true;
}

function interruptionDecision(input, slot) {
  const taskId = String(input.taskId || '');
  if (slot.stoppedByUser) throw new Error('Agent task was stopped by the user');
  if (!slot.interruptedByUser) return null;
  slot.persistResult = false;
  return { taskId, status: 'waiting', message: '我已暂停当前操作，因为你正在接管电脑。交还电脑后，请告诉我继续。', engine: String(input.engine || ''), sessionId: typeof input.sessionId === 'string' ? input.sessionId : null };
}

function pauseActive() {
  if (!active?.child) return;
  active.interruptedByUser = true;
  active.persistResult = false;
  active.abort?.abort();
}

http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && pathname === '/healthz') return send(res, 200, { ok: true, runtime: 'dots-agent-runtime', adapters: [...allowedEngines].filter(engine => Boolean(configured[engine])) });
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: 'Agent runtime token is required' });
    if (req.method === 'POST' && pathname === '/v1/tasks/run') {
      try { return send(res, 200, await runKernel(await readJson(req))); }
      catch (error) { return send(res, 400, { error: error instanceof Error ? error.message.slice(0, 500) : 'Agent task failed' }); }
    }
    if (req.method === 'POST' && pathname === '/v1/tasks/pause') {
      const body = await readJson(req);
      const paused = body.taskId ? interruptTask(String(body.taskId), 'pause') : (pauseActive(), Boolean(active?.child));
      return send(res, 200, { paused });
    }
    if (req.method === 'POST' && pathname === '/v1/tasks/stop') {
      const body = await readJson(req);
      const stopped = body.taskId ? interruptTask(String(body.taskId), 'stop') : Boolean(active && interruptTask(active.taskId, 'stop'));
      return send(res, 200, { stopped });
    }
    return send(res, 404, { error: 'not found' });
  } catch (error) { return send(res, 400, { error: error instanceof Error ? error.message.slice(0, 300) : 'request failed' }); }
}).listen(port, '0.0.0.0', () => process.stdout.write(`Dots Agent runtime listening on ${port}\n`));
