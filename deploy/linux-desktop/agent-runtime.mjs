import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';

const token = String(process.env.DOTS_AGENT_RUNTIME_TOKEN || '');
const port = Number(process.env.DOTS_AGENT_RUNTIME_PORT || 8083);
const workerPort = Number(process.env.LINUX_DESKTOP_WORKER_PORT || 8082);
const workspace = path.resolve(process.env.DOTS_AGENT_WORKSPACE || '/workspace');
const allowedEngines = new Set(String(process.env.DOTS_DESKTOP_AGENT_ADAPTERS || '').split(',').map(value => value.trim()).filter(value => ['pi', 'dsh'].includes(value)));
const configured = parseAdapterConfig(process.env.DOTS_AGENT_KERNELS_JSON || '{}');
let active = null;
const queue = [];

if (!token) throw new Error('DOTS_AGENT_RUNTIME_TOKEN is required');

function parseAdapterConfig(raw) {
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DOTS_AGENT_KERNELS_JSON must be an object');
  const supported = {};
  for (const [engine, adapter] of Object.entries(value)) {
    if (!['pi', 'dsh'].includes(engine)) continue;
    if (!adapter || typeof adapter !== 'object' || typeof adapter.command !== 'string' || !Array.isArray(adapter.args) || adapter.args.some(arg => typeof arg !== 'string')) {
      throw new Error(`Invalid kernel adapter config for ${engine}`);
    }
    supported[engine] = adapter;
  }
  return supported;
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
  if (input.executionMode !== undefined && !['standard', 'read-only', 'proactive-research'].includes(input.executionMode)) throw new Error('Agent execution mode is invalid');
  const executionMode = input.executionMode === 'proactive-research' ? 'proactive-research' : input.executionMode === 'read-only' ? 'read-only' : 'standard';
  if (!allowedEngines.has(engine)) throw new Error(`Agent kernel '${engine}' is not enabled for this workspace`);
  if (!['pi', 'dsh'].includes(engine)) throw new Error(`Agent kernel '${engine}' needs an installed adapter`);
  const adapter = configured[engine];
  if (!adapter) throw new Error(`Agent kernel '${engine}' is enabled but no adapter is installed in this image`);
  const modelConfig = engine === 'pi' ? validateModelConfig(input.modelConfig) : null;
  const taskId = String(input.taskId || '');
  if (!/^[a-f0-9-]{8,64}$/i.test(taskId)) throw new Error('Task id is invalid');
  const prompt = String(input.prompt || '').trim();
  if (!prompt || prompt.length > 20_000) throw new Error('Task prompt must contain 1–20000 characters');
  if (requestSignal?.aborted) throw new Error('Agent task was cancelled');
  if (executionMode !== 'proactive-research' && await controlOwner() !== 'agent') return { taskId, status: 'waiting', message: '电脑目前由你控制。交还电脑后，请告诉我继续。', engine, sessionId: typeof input.sessionId === 'string' ? input.sessionId : null };

  const cwd = safeWorkspace(executionMode === 'proactive-research' ? `reviews/${taskId}` : input.cwd);
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  if (requestSignal?.aborted) throw new Error('Agent task was cancelled');
  const computerUiBridge = engine === 'pi' && executionMode !== 'proactive-research' && process.env.LINUX_DESKTOP_WORKER_TOKEN
    ? await startComputerUiBridge()
    : null;
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['DOTS_AGENT_RUNTIME_TOKEN', 'LINUX_DESKTOP_WORKER_TOKEN'].includes(key)));
  const child = spawn(adapter.command, adapter.args, { cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
  const abort = new AbortController();
  slot.child = child;
  slot.abort = abort;
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-500_000); });
  child.stderr.on('data', chunk => {
    if (process.env.DOTS_PI_ADAPTER_TEST_DIAGNOSTICS === '1' && engine === 'pi') stderr = (stderr + chunk.toString()).slice(-4000);
  });
  child.stdin.end(JSON.stringify({
    engine, prompt, cwd, taskId, executionMode,
    ...(modelConfig ? { modelConfig } : {}),
    ... (executionMode === 'proactive-research' ? {} : { workspace }),
    sessionId: typeof input.sessionId === 'string' ? input.sessionId : null,
    ...(computerUiBridge ? { computer: { computerUiUrl: computerUiBridge.url, computerUiToken: computerUiBridge.token } } : {}),
  }));
  const timer = setTimeout(() => child.kill('SIGTERM'), 14 * 60_000);
  const controlPoll = executionMode === 'proactive-research' ? undefined : setInterval(() => { void controlOwner().then(owner => { if (owner === 'user') pauseActive(); }).catch(() => child.kill('SIGTERM')); }, 500);
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
    if (code !== 0) {
      const diagnostic = process.env.DOTS_PI_ADAPTER_TEST_DIAGNOSTICS === '1' && engine === 'pi' && stderr.trim()
        ? `: ${redactDiagnostic(stderr, modelConfig).slice(-1200)}`
        : '';
      throw new Error(`Agent adapter exited with code ${code}${diagnostic}`);
    }
    let result;
    try { result = JSON.parse(stdout); } catch { throw new Error('Agent adapter must return a JSON decision'); }
    if (!['done', 'waiting', 'scheduled', 'delegating'].includes(result.status) || typeof result.message !== 'string' || !result.message.trim()) throw new Error('Agent adapter returned an invalid decision');
    if (executionMode === 'proactive-research' && (result.status !== 'done' || typeof result.proactiveFinding !== 'boolean' || result.pageAction !== undefined || result.delegations !== undefined || result.nextMinutes !== undefined)) throw new Error('Proactive research adapter returned an invalid or actionable decision');
    if (executionMode !== 'proactive-research' && result.proactiveFinding !== undefined) throw new Error('Standard Agent adapter must not return a proactive research finding');
    if (result.notifyUser !== undefined && typeof result.notifyUser !== 'boolean') throw new Error('Agent adapter returned an invalid notification preference');
    return {
      taskId, ...result, engine, message: result.message.slice(0, 20_000), sessionId: typeof result.sessionId === 'string' ? result.sessionId : null,
      ...(computerUiBridge ? { computerUiAudit: computerUiBridge.audit() } : {}),
    };
  } finally {
    clearTimeout(timer); clearInterval(controlPoll);
    requestSignal?.removeEventListener('abort', onRequestAbort);
    await computerUiBridge?.close();
    slot.child = null; slot.abort = null;
  }
}

async function startComputerUiBridge() {
  const bridgeToken = randomBytes(32).toString('base64url');
  const workerToken = String(process.env.LINUX_DESKTOP_WORKER_TOKEN || '');
  if (!workerToken) throw new Error('Cloud computer UI is unavailable');
  const audit = { inspections: 0, navigations: 0, informationClicks: 0, clickAttempts: 0, lastClick: null, lastClickError: null };
  const routes = new Map([
    ['/inspect', { workerPath: '/v1/agent-ui/inspect', keys: [] }],
    ['/navigate', { workerPath: '/v1/agent-ui/navigate', keys: ['url'] }],
    ['/click-information-link', { workerPath: '/v1/agent-ui/click-information-link', keys: ['name'] }],
  ]);
  const server = http.createServer(async (req, res) => {
    try {
      const route = routes.get(req.url || '');
      if (req.method !== 'POST' || !route) return send(res, 404, { error: 'not found' });
      const authorization = String(req.headers.authorization || '');
      const actual = Buffer.from(authorization.startsWith('Bearer ') ? authorization.slice(7) : '');
      const expected = Buffer.from(bridgeToken);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return send(res, 401, { error: 'computer UI capability is invalid' });
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'content type must be JSON' });
      const body = await readJson(req);
      if (Object.keys(body).some(key => !route.keys.includes(key)) || route.keys.some(key => typeof body[key] !== 'string')) return send(res, 400, { error: 'computer UI request is invalid' });
      if ((route.keys.includes('url') && body.url.length > 2048) || (route.keys.includes('name') && body.name.length > 160)) return send(res, 400, { error: 'computer UI request is too long' });
      const response = await fetch(`http://127.0.0.1:${workerPort}${route.workerPath}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${workerToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      const value = await response.json().catch(() => ({}));
      if (req.url === '/click-information-link') audit.clickAttempts++;
      if (response.ok) {
        if (req.url === '/inspect') audit.inspections++;
        else if (req.url === '/navigate') { audit.navigations++; audit.inspections++; }
        else if (req.url === '/click-information-link') {
          audit.informationClicks++;
          audit.lastClickError = null;
          if (value.click && typeof value.click.name === 'string' && Number.isInteger(value.click.x) && Number.isInteger(value.click.y) && typeof value.click.destination === 'string') {
            audit.lastClick = { name: value.click.name, x: value.click.x, y: value.click.y, destination: value.click.destination };
          }
        }
      } else if (req.url === '/click-information-link') audit.lastClickError = typeof value.error === 'string' ? value.error.slice(0, 1000) : `HTTP ${response.status}`;
      return send(res, response.status, value);
    } catch (error) {
      return send(res, 502, { error: error instanceof Error ? error.message.slice(0, 300) : 'computer UI operation failed' });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start the computer UI bridge');
  return {
    url: `http://127.0.0.1:${address.port}`,
    token: bridgeToken,
    audit: () => ({ ...audit }),
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

function validateModelConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Pi needs the shared model API configuration');
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : '';
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw new Error('Pi shared model endpoint is invalid'); }
  if (!apiKey || apiKey.length > 4096 || /[\r\n\u0000]/.test(apiKey) || !model || model.length > 256 || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Pi shared model API configuration is invalid');
  }
  return { apiKey, model, baseUrl: baseUrl.replace(/\/$/, '') };
}

function redactDiagnostic(value, modelConfig) {
  let result = String(value || '');
  for (const secret of [modelConfig?.apiKey, process.env.DOTS_AGENT_RUNTIME_TOKEN, process.env.LINUX_DESKTOP_WORKER_TOKEN]) {
    if (secret) result = result.replaceAll(secret, '[REDACTED]');
  }
  return result;
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
