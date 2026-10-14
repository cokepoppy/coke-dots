import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';
import { BrowserContextNotReadyError, getBrowserPage, waitForDefaultBrowserContext } from './browser-context.mjs';

const exec = promisify(execFile);
const token = String(process.env.LINUX_DESKTOP_WORKER_TOKEN || '');
const port = Number(process.env.COKE_DESKTOP_WORKER_PORT || 8082);
const resolution = String(process.env.COKE_DESKTOP_RESOLUTION || '1440x900').split('x').map(Number);
let owner = 'agent';
let browser;
let browserConnectPromise;
let pageInitialization;

if (!token) throw new Error('LINUX_DESKTOP_WORKER_TOKEN is required');

async function connectedBrowser() {
  if (browser && !browser.isConnected()) { browser = undefined; browserConnectPromise = undefined; }
  if (!browserConnectPromise) {
    browserConnectPromise = chromium.connectOverCDP('http://127.0.0.1:9222').then(connected => {
      browser = connected;
      connected.on('disconnected', () => {
        if (browser === connected) { browser = undefined; browserConnectPromise = undefined; }
      });
      return connected;
    }).catch(error => { browserConnectPromise = undefined; throw error; });
  }
  browser = await browserConnectPromise;
  return browser;
}

async function createPageWithContextRecovery() {
  const connected = await connectedBrowser();
  const context = await waitForDefaultBrowserContext(connected);
  try { return await getBrowserPage(context); }
  catch (error) {
    if (!(error instanceof BrowserContextNotReadyError)) throw error;
    process.stderr.write(`${JSON.stringify({ event: 'dots_browser_context_unavailable', at: new Date().toISOString(), recoveryAttempt: 1 })}\n`);
    browser = undefined;
    browserConnectPromise = undefined;
    await new Promise(resolve => setTimeout(resolve, 100));
    const reconnected = await connectedBrowser();
    const refreshedContext = await waitForDefaultBrowserContext(reconnected);
    return getBrowserPage(refreshedContext);
  }
}

async function page() {
  if (pageInitialization) return pageInitialization;
  const pending = createPageWithContextRecovery();
  pageInitialization = pending;
  try { return await pending; }
  finally { if (pageInitialization === pending) pageInitialization = undefined; }
}

function send(res, status, value, type = 'application/json; charset=utf-8') {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}

async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('request body is too large');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function screenshot() {
  const file = `/tmp/dots-screen-${crypto.randomUUID()}.png`;
  try {
    await exec('scrot', ['-o', file], { timeout: 5000 });
    return await fs.readFile(file);
  } finally { await fs.rm(file, { force: true }).catch(() => undefined); }
}

const workspace = path.resolve(process.env.DOTS_AGENT_WORKSPACE || '/workspace');
const artifactTaskId = /^[a-f0-9-]{36}$/i;
const maxArtifactBytes = 25 * 1024 * 1024;
const maxArtifactCount = 100;
const artifactTypes = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.wasm': 'application/wasm',
}));
const previewTypes = new Set(['text/html', 'text/css', 'text/javascript', 'application/json', 'text/markdown', 'text/plain', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);

async function artifactRoot(taskId) {
  if (!artifactTaskId.test(taskId)) throw new Error('invalid task id');
  const workspaceRoot = await fs.realpath(workspace);
  const taskRoot = path.join(workspaceRoot, 'tasks');
  const base = await fs.realpath(taskRoot);
  if (base !== taskRoot) throw new Error('task directory root is not a workspace directory');
  const expectedRoot = path.join(base, taskId);
  const root = await fs.realpath(expectedRoot);
  if (root !== expectedRoot) throw new Error('task directory is not isolated to this task');
  return root;
}

function artifactMediaType(filePath) {
  return artifactTypes.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

async function listArtifacts(taskId) {
  let root;
  try { root = await artifactRoot(taskId); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const artifacts = [];
  const pending = [root];
  while (pending.length && artifacts.length < maxArtifactCount) {
    const directory = pending.pop();
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { pending.push(absolute); continue; }
      if (!entry.isFile()) continue;
      const real = await fs.realpath(absolute);
      if (!real.startsWith(`${root}${path.sep}`)) continue;
      const stats = await fs.stat(real);
      if (!stats.isFile() || stats.size > maxArtifactBytes) continue;
      const relative = path.relative(root, real).split(path.sep).join('/');
      const mediaType = artifactMediaType(real).split(';', 1)[0];
      artifacts.push({ path: relative, name: path.basename(real), mediaType, size: stats.size, previewable: previewTypes.has(mediaType) });
      if (artifacts.length >= maxArtifactCount) break;
    }
  }
  return artifacts.sort((a, b) => a.path.localeCompare(b.path));
}

async function readArtifact(taskId, relativePath) {
  const resolved = await resolveArtifact(taskId, relativePath);
  return { bytes: await fs.readFile(resolved.real), mediaType: resolved.mediaType, name: path.basename(resolved.real), previewable: previewTypes.has(resolved.mediaType.split(';', 1)[0]) };
}

async function resolveArtifact(taskId, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.length > 500 || relativePath.includes('\\') || path.posix.isAbsolute(relativePath)
      || relativePath.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('invalid artifact path');
  const root = await artifactRoot(taskId);
  const real = await fs.realpath(path.resolve(root, ...relativePath.split('/')));
  if (!real.startsWith(`${root}${path.sep}`)) throw new Error('artifact is outside the task directory');
  const stats = await fs.stat(real);
  if (!stats.isFile() || stats.size > maxArtifactBytes) throw new Error('artifact is not available for preview');
  const mediaType = artifactMediaType(real);
  return { real, mediaType };
}

async function command(input) {
  const action = String(input.action || '');
  const actor = input.actor === 'user' ? 'user' : 'agent';
  if (actor !== owner && action !== 'open') throw new Error(owner === 'user' ? 'The user currently controls this computer' : 'The agent currently controls this computer');
  if (action === 'open') {
    const browserPage = await page();
    const dotName = String(input.dotName || 'Dot').slice(0, 80);
    await browserPage.title().catch(() => '');
    return { ready: true };
  }
  if (action === 'open-artifact') {
    if (actor !== 'user') throw new Error('Only a user can open a task artifact in the cloud browser');
    const resolved = await resolveArtifact(String(input.taskId || ''), String(input.path || ''));
    if (!resolved.mediaType.startsWith('text/html')) throw new Error('Only HTML task files can open in the cloud browser');
    await (await page()).goto(pathToFileURL(resolved.real).href, { waitUntil: 'domcontentloaded', timeout: 15000 });
  } else if (action === 'navigate') {
    const url = new URL(String(input.url || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only credential-free HTTP and HTTPS URLs are allowed');
    await (await page()).goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } else if (action === 'click') {
    const x = Number(input.x); const y = Number(input.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > resolution[0] || y > resolution[1]) throw new Error('Click coordinates are outside the desktop');
    await exec('xdotool', ['mousemove', String(Math.round(x)), String(Math.round(y)), 'click', '1'], { timeout: 5000 });
  } else if (action === 'type') {
    const text = String(input.text || '');
    if (text.length > 2000) throw new Error('Input is too long');
    await exec('xdotool', ['type', '--clearmodifiers', '--delay', '1', '--', text], { timeout: 15000 });
  } else if (action === 'press') {
    const names = { Enter: 'Return', Tab: 'Tab', Escape: 'Escape', Backspace: 'BackSpace', Delete: 'Delete', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', PageUp: 'Page_Up', PageDown: 'Page_Down', Home: 'Home', End: 'End', Space: 'space' };
    const key = names[String(input.key)];
    if (!key) throw new Error('Unsupported desktop key');
    await exec('xdotool', ['key', key], { timeout: 5000 });
  } else throw new Error('Unsupported desktop command');
  const browserPage = await page().catch(() => null);
  return { ready: true, url: browserPage?.url() || '', title: await browserPage?.title().catch(() => '') || '' };
}

http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && pathname === '/healthz') return send(res, 200, { ok: true });
    if (req.method === 'GET' && pathname === '/readyz') {
      try {
        await page();
        await exec('xdpyinfo', ['-display', process.env.DISPLAY || ':1'], { timeout: 1500 });
        const agent = await fetch(`http://127.0.0.1:${process.env.DOTS_AGENT_RUNTIME_PORT || 8083}/healthz`, { signal: AbortSignal.timeout(1500) });
        if (!agent.ok) return send(res, 503, { ok: false });
        return send(res, 200, { ok: true });
      } catch (error) {
        const contextUnavailable = error instanceof BrowserContextNotReadyError;
        return send(res, 503, { ok: false, ...(contextUnavailable ? { code: error.code, error: error.message } : {}) });
      }
    }
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: 'worker token is required' });
    if (req.method === 'GET' && pathname === '/v1/artifacts') {
      const taskId = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('taskId') || '';
      return send(res, 200, { artifacts: await listArtifacts(taskId) });
    }
    if (req.method === 'GET' && pathname === '/v1/artifact') {
      const query = new URL(req.url || '/', 'http://127.0.0.1').searchParams;
      const artifact = await readArtifact(query.get('taskId') || '', query.get('path') || '');
      const safeName = encodeURIComponent(artifact.name);
      res.writeHead(200, {
        'content-type': artifact.mediaType, 'content-length': artifact.bytes.length, 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'x-dots-artifact-name': safeName, 'x-dots-artifact-previewable': String(artifact.previewable),
      });
      res.end(artifact.bytes);
      return;
    }
    if (req.method === 'GET' && pathname === '/v1/control') return send(res, 200, { owner });
    if (req.method === 'POST' && pathname === '/v1/control') {
      const input = await body(req);
      if (input.owner !== 'agent' && input.owner !== 'user') return send(res, 400, { error: 'invalid control owner' });
      owner = input.owner;
      if (owner === 'user') {
        await fetch(`http://127.0.0.1:${process.env.DOTS_AGENT_RUNTIME_PORT || 8083}/v1/tasks/pause`, {
          method: 'POST', headers: { authorization: `Bearer ${process.env.DOTS_AGENT_RUNTIME_TOKEN}` }, signal: AbortSignal.timeout(1500),
        }).catch(() => undefined);
      }
      return send(res, 200, { owner });
    }
    if (req.method === 'GET' && pathname === '/v1/state') {
      const browserPage = await page();
      return send(res, 200, { ready: true, owner, url: browserPage.url(), title: await browserPage.title().catch(() => '') });
    }
    if (req.method === 'GET' && pathname === '/v1/screenshot') return send(res, 200, await screenshot(), 'image/png');
    if (req.method === 'POST' && pathname === '/v1/commands') return send(res, 200, await command(await body(req)));
    return send(res, 404, { error: 'not found' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'computer command failed';
    const contextUnavailable = error instanceof BrowserContextNotReadyError;
    return send(res, contextUnavailable ? 503 : 400, { error: message.slice(0, 240), ...(contextUnavailable ? { code: error.code } : {}) });
  }
}).listen(port, '0.0.0.0', () => process.stdout.write(`Dots desktop worker listening on ${port}\n`));
