import { spawn } from 'node:child_process';
import { chmod, mkdir, realpath } from 'node:fs/promises';
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

async function safeTaskWorkspace(value, taskId) {
  const relativeTaskDirectory = path.posix.join('tasks', taskId);
  if (String(value || '') !== relativeTaskDirectory) throw new Error('task working directory must match its task id');
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const workspaceRoot = await realpath(workspace);
  const taskRoot = path.join(workspaceRoot, 'tasks');
  await mkdir(taskRoot, { recursive: true, mode: 0o700 });
  if (await realpath(taskRoot) !== taskRoot) throw new Error('task directory root must not be a symbolic link');
  const taskDirectory = path.join(taskRoot, taskId);
  await mkdir(taskDirectory, { recursive: true, mode: 0o700 });
  if (await realpath(taskDirectory) !== taskDirectory) throw new Error('task directory must not be a symbolic link');
  return taskDirectory;
}

function requireModelConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Shared Model API configuration is required for cloud Agent kernels');
  }
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim().replace(/\/$/, '') : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  let endpoint;
  try { endpoint = new URL(baseUrl); } catch { throw new Error('Shared Model API configuration is invalid for cloud Agent kernels'); }
  const localHttp = endpoint.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname);
  if (!apiKey || apiKey.length > 5000 || /[\r\n]/.test(apiKey) || !model || model.length > 120 || baseUrl.length > 2048
      || (!localHttp && endpoint.protocol !== 'https:') || endpoint.username || endpoint.password) {
    throw new Error('Shared Model API configuration is invalid for cloud Agent kernels');
  }
  return { apiKey, baseUrl, model };
}

function validateDingTalkDocumentsBridge(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.url !== 'string' || typeof value.token !== 'string' || value.token.length > 4096 || !value.token) {
    throw new Error('DingTalk document bridge configuration is invalid');
  }
  let url;
  try { url = new URL(value.url); } catch { throw new Error('DingTalk document bridge URL is invalid'); }
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if ((!localHttp && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/api/agent/dingtalk/documents')) {
    throw new Error('DingTalk document bridge URL is invalid');
  }
  if (!Array.isArray(value.actions) || !value.actions.length || value.actions.length > 3 || value.actions.some(action => !['search', 'fetch', 'create'].includes(action))) {
    throw new Error('DingTalk document bridge scope is invalid');
  }
  return { url: url.toString(), token: value.token, actions: [...new Set(value.actions)] };
}

function validateDingTalkCalendarBridge(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.url !== 'string' || typeof value.token !== 'string' || value.token.length > 4096 || !value.token) {
    throw new Error('DingTalk calendar bridge configuration is invalid');
  }
  let url;
  try { url = new URL(value.url); } catch { throw new Error('DingTalk calendar bridge URL is invalid'); }
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if ((!localHttp && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/api/agent/dingtalk/calendar')) {
    throw new Error('DingTalk calendar bridge URL is invalid');
  }
  if (!Array.isArray(value.actions) || !value.actions.length || value.actions.length > 2 || value.actions.some(action => !['list', 'create'].includes(action))) throw new Error('DingTalk calendar bridge scope is invalid');
  return { url: url.toString(), token: value.token, actions: [...new Set(value.actions)] };
}

function validateDingTalkSecretaryBridge(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.url !== 'string' || typeof value.token !== 'string' || value.token.length > 4096 || !value.token) throw new Error('DingTalk secretary bridge configuration is invalid');
  let url;
  try { url = new URL(value.url); } catch { throw new Error('DingTalk secretary bridge URL is invalid'); }
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if ((!localHttp && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/api/agent/dingtalk/secretary')) throw new Error('DingTalk secretary bridge URL is invalid');
  if (!Array.isArray(value.actions) || !value.actions.length || value.actions.length > 2 || value.actions.some(action => !['todo-create', 'cokeclaw-send'].includes(action))) throw new Error('DingTalk secretary bridge scope is invalid');
  return { url: url.toString(), token: value.token, actions: [...new Set(value.actions)] };
}

function redactSecret(value, secret) {
  if (typeof value === 'string') return secret ? value.split(secret).join('[redacted]') : value;
  if (Array.isArray(value)) return value.map(item => redactSecret(item, secret));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSecret(item, secret)]));
  return value;
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
  if (!['pi', 'dsh'].includes(engine)) throw new Error(`Agent kernel '${engine}' needs an installed adapter`);
  const adapter = configured[engine];
  if (!adapter) throw new Error(`Agent kernel '${engine}' is enabled but no adapter is installed in this image`);
  const taskId = String(input.taskId || '');
  if (!/^[a-f0-9-]{8,64}$/i.test(taskId)) throw new Error('Task id is invalid');
  const prompt = String(input.prompt || '').trim();
  if (!prompt || prompt.length > 20_000) throw new Error('Task prompt must contain 1–20000 characters');
  if (requestSignal?.aborted) throw new Error('Agent task was cancelled');
  const modelConfig = requireModelConfig(input.modelConfig);
  const dingtalkDocumentsBridge = validateDingTalkDocumentsBridge(input.dingtalkDocumentsBridge);
  const dingtalkCalendarBridge = validateDingTalkCalendarBridge(input.dingtalkCalendarBridge);
  const dingtalkSecretaryBridge = validateDingTalkSecretaryBridge(input.dingtalkSecretaryBridge);
  if (await controlOwner() !== 'agent') return { taskId, status: 'waiting', pausedForControl: true, message: '电脑目前由你控制。我已暂停这项工作；交还电脑后点击“继续”即可恢复。', engine, sessionId: typeof input.sessionId === 'string' ? input.sessionId : null };

  const cwd = await safeTaskWorkspace(input.cwd, taskId);
  if (requestSignal?.aborted) throw new Error('Agent task was cancelled');
  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DOTS_INCIDENT_GITHUB_SSH_AUTH_SOCK)/i.test(key)));
  delete childEnv.SSH_AUTH_SOCK;
  delete childEnv.GIT_SSH_COMMAND;
  let incidentCredentialSocket = null;
  if (input.incidentRemediation === true) {
    if (engine !== 'pi') throw new Error('Incident remediation is available only to Pi');
    incidentCredentialSocket = await enableIncidentGitAccess(childEnv);
  } else if (process.env.DOTS_INCIDENT_GITHUB_CREDENTIAL_SOCKET) {
    await chmod(process.env.DOTS_INCIDENT_GITHUB_CREDENTIAL_SOCKET, 0).catch(() => undefined);
  }
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
    modelConfig,
    computer: {
      baseUrl: `http://127.0.0.1:${workerPort}`,
      workerToken: process.env.LINUX_DESKTOP_WORKER_TOKEN,
      actions: ['navigate', 'click', 'type', 'screenshot'],
    },
    ...(dingtalkDocumentsBridge ? { dingtalkDocumentsBridge } : {}),
    ...(dingtalkCalendarBridge ? { dingtalkCalendarBridge } : {}),
    ...(dingtalkSecretaryBridge ? { dingtalkSecretaryBridge } : {}),
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
    if (slot.interruptedByUser) return { taskId, status: 'waiting', pausedForControl: true, message: '我已暂停当前操作，因为你正在接管电脑。交还电脑后，请告诉我继续。', engine, sessionId: typeof input.sessionId === 'string' ? input.sessionId : null };
    if (code !== 0) throw new Error(`Agent adapter exited with code ${code}`);
    let result;
    try {
      result = redactSecret(JSON.parse(stdout), modelConfig.apiKey);
      if (dingtalkDocumentsBridge) result = redactSecret(result, dingtalkDocumentsBridge.token);
      if (dingtalkCalendarBridge) result = redactSecret(result, dingtalkCalendarBridge.token);
      if (dingtalkSecretaryBridge) result = redactSecret(result, dingtalkSecretaryBridge.token);
    } catch { throw new Error('Agent adapter must return a JSON decision'); }
    if (!['done', 'waiting', 'scheduled', 'delegating'].includes(result.status) || typeof result.message !== 'string' || !result.message.trim()) throw new Error('Agent adapter returned an invalid decision');
    return { taskId, ...result, engine, message: result.message.slice(0, 20_000), sessionId: typeof result.sessionId === 'string' ? result.sessionId : null };
  } finally {
    clearTimeout(timer); clearInterval(controlPoll);
    requestSignal?.removeEventListener('abort', onRequestAbort);
    if (incidentCredentialSocket) await chmod(incidentCredentialSocket, 0).catch(() => undefined);
    slot.child = null; slot.abort = null;
  }
}

async function enableIncidentGitAccess(childEnv) {
  const socket = process.env.DOTS_INCIDENT_GITHUB_CREDENTIAL_SOCKET || '';
  if (!socket) throw new Error('Incident repository credentials are not mounted for this tenant');
  await chmod(socket, 0o600);
  childEnv.DOTS_INCIDENT_GITHUB_CREDENTIAL_SOCKET = socket;
  childEnv.GIT_TERMINAL_PROMPT = '0';
  childEnv.GIT_CONFIG_COUNT = '3';
  childEnv.GIT_CONFIG_KEY_0 = 'credential.helper';
  childEnv.GIT_CONFIG_VALUE_0 = '';
  childEnv.GIT_CONFIG_KEY_1 = 'credential.helper';
  childEnv.GIT_CONFIG_VALUE_1 = '/opt/coke-dots/incident-git-credential-helper.mjs';
  childEnv.GIT_CONFIG_KEY_2 = 'credential.useHttpPath';
  childEnv.GIT_CONFIG_VALUE_2 = 'true';
  return socket;
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
