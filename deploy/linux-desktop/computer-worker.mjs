import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';
import { BrowserContextNotReadyError, getBrowserPage, waitForDefaultBrowserContext } from './browser-context.mjs';
import { createRendererHealthMonitor, RendererUnresponsiveError } from './renderer-health.mjs';

const exec = promisify(execFile);
const token = String(process.env.LINUX_DESKTOP_WORKER_TOKEN || '');
const port = Number(process.env.COKE_DESKTOP_WORKER_PORT || 8082);
const resolution = String(process.env.COKE_DESKTOP_RESOLUTION || '1440x900').split('x').map(Number);
let owner = 'agent';
let browser;
let browserConnectPromise;
let pageInitialization;
const rendererTimeoutMs = 3_000;
const rendererHealth = createRendererHealthMonitor(rendererTimeoutMs);
let rendererProbeFailures = 0;
let rendererRecovery = null;

if (!token) throw new Error('LINUX_DESKTOP_WORKER_TOKEN is required');

async function connectedBrowser() {
  if (browser && !browser.isConnected()) { browser = undefined; browserConnectPromise = undefined; }
  if (!browserConnectPromise) {
    browserConnectPromise = chromium.connectOverCDP('http://127.0.0.1:9222').then(connected => {
      browser = connected;
      connected.on('disconnected', () => {
        if (browser === connected) {
          browser = undefined;
          browserConnectPromise = undefined;
          pageInitialization = undefined;
        }
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

async function rendererResponds() {
  const ok = await rendererHealth.check(async () => {
    const browserPage = await page();
    const readyState = await browserPage.evaluate(() => document.readyState);
    if (typeof readyState !== 'string') throw new Error('Chromium page did not return its document state');
  });
  if (ok) {
    rendererProbeFailures = 0;
    return true;
  }
  rendererProbeFailures += 1;
  if (rendererHealth.unresponsive || rendererProbeFailures >= 3) {
    rendererHealth.fail();
    void recoverChromium();
  }
  return false;
}

function clearBrowserHandles() {
  browser = undefined;
  browserConnectPromise = undefined;
  pageInitialization = undefined;
}

async function recoverChromium() {
  if (rendererRecovery) return rendererRecovery;
  rendererRecovery = (async () => {
    const previousPid = (await fs.readFile('/tmp/dots-chrome.pid', 'utf8')).trim();
    if (!/^\d+$/.test(previousPid)) throw new Error('Chromium supervisor PID is unavailable');
    process.kill(process.ppid, 'SIGUSR1');

    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const nextPid = (await fs.readFile('/tmp/dots-chrome.pid', 'utf8').catch(() => '')).trim();
      if (/^\d+$/.test(nextPid) && nextPid !== previousPid) {
        clearBrowserHandles();
        rendererHealth.reset();
        rendererProbeFailures = 0;
        try {
          const browserPage = await page();
          await rendererHealth.run(() => browserPage.evaluate(() => document.readyState));
          process.stdout.write(`${JSON.stringify({ event: 'dots_chromium_renderer_recovered', at: new Date().toISOString() })}\n`);
          return;
        } catch {
          clearBrowserHandles();
          rendererHealth.reset();
        }
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
    }
    throw new Error('Chromium did not recover within 45 seconds');
  })().catch(error => {
    const message = error instanceof Error ? error.message : 'unknown recovery error';
    process.stderr.write(`${JSON.stringify({ event: 'dots_chromium_renderer_recovery_failed', at: new Date().toISOString(), message: message.slice(0, 180) })}\n`);
  }).finally(() => { rendererRecovery = null; });
  return rendererRecovery;
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
    return rendererHealth.run(async () => {
      const browserPage = await page();
      await browserPage.title();
      return { ready: true };
    });
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
  return {
    ready: true,
    url: browserPage?.url() || '',
    title: browserPage ? await rendererHealth.run(() => browserPage.title()) : '',
  };
}

function safePageUrl(value) {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}

function browserLocator(browserPage, input) {
  const target = typeof input.target === 'string' ? input.target.trim() : '';
  const by = String(input.by || '');
  if (!target || target.length > 500) throw new Error('A visible browser control target is required');
  if (by === 'role') {
    const role = String(input.role || '');
    const roles = new Set(['alert', 'button', 'checkbox', 'combobox', 'dialog', 'heading', 'link', 'listbox', 'menuitem', 'option', 'radio', 'searchbox', 'slider', 'spinbutton', 'tab', 'textbox']);
    if (!roles.has(role)) throw new Error('Unsupported accessible role');
    return browserPage.getByRole(role, { name: target, exact: true });
  }
  if (by === 'text') return browserPage.getByText(target, { exact: true });
  if (by === 'label') return browserPage.getByLabel(target, { exact: true });
  if (by === 'placeholder') return browserPage.getByPlaceholder(target, { exact: true });
  if (by === 'css') return browserPage.locator(target);
  throw new Error('A supported browser locator type is required');
}

async function agentBrowserAction(input) {
  if (owner !== 'agent') throw new Error('The user currently controls this computer');
  const action = String(input.action || '');
  const browserPage = await page();
  return rendererHealth.run(async () => {
    if (owner !== 'agent') throw new Error('The user currently controls this computer');
    if (action === 'inspect') {
      const snapshot = await browserPage.evaluate(() => {
        const visible = element => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const controls = Array.from(document.querySelectorAll('button,a,input,textarea,select,[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="combobox"]'))
          .filter(visible)
          .slice(0, 120)
          .map(element => {
            const labels = Array.from(element.labels || []).map(label => label.innerText).filter(Boolean);
            const name = element.getAttribute('aria-label') || labels.join(' ').trim() || element.innerText?.trim() || element.getAttribute('title') || element.getAttribute('placeholder') || element.getAttribute('name') || '';
            const tag = element.tagName.toLowerCase();
            return {
              role: element.getAttribute('role') || ({ button: 'button', a: 'link', input: element.getAttribute('type') === 'checkbox' ? 'checkbox' : element.getAttribute('type') === 'radio' ? 'radio' : 'textbox', textarea: 'textbox', select: 'combobox' }[tag] || tag),
              name: String(name).replace(/\s+/g, ' ').slice(0, 160),
              type: tag === 'input' ? element.getAttribute('type') || 'text' : tag,
              placeholder: element.getAttribute('placeholder') || undefined,
              disabled: Boolean(element.disabled),
            };
          });
        return {
          title: document.title.slice(0, 300),
          text: (document.body?.innerText || '').slice(0, 12_000),
          controls,
        };
      });
      return { ready: true, action, url: safePageUrl(browserPage.url()), title: snapshot.title, text: snapshot.text, controls: snapshot.controls };
    }

    if (action === 'navigate') {
      const url = new URL(String(input.url || ''));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) throw new Error('Only credential-free HTTP and HTTPS URLs are allowed');
      if (owner !== 'agent') throw new Error('The user currently controls this computer');
      await browserPage.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } else if (action === 'open_artifact') {
      const taskId = String(input.taskId || '');
      if (!/^[a-f0-9-]{36}$/i.test(taskId)) throw new Error('Task id is invalid');
      const resolved = await resolveArtifact(taskId, String(input.path || ''));
      if (!resolved.mediaType.startsWith('text/html')) throw new Error('Only HTML task files can open in the cloud browser');
      if (owner !== 'agent') throw new Error('The user currently controls this computer');
      await browserPage.goto(pathToFileURL(resolved.real).href, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    } else if (['click', 'fill', 'select', 'check', 'uncheck', 'press'].includes(action)) {
      const locator = browserLocator(browserPage, input);
      const count = await locator.count();
      if (count !== 1) throw new Error(`Browser target matched ${count} controls; inspect the page and choose a unique label or selector`);
      if (owner !== 'agent') throw new Error('The user currently controls this computer');
      if (action === 'click') await locator.click({ timeout: 10_000 });
      else if (action === 'fill') {
        const value = String(input.value ?? '');
        if (value.length > 10_000) throw new Error('Browser input is too long');
        await locator.fill(value, { timeout: 10_000 });
      } else if (action === 'select') {
        const value = String(input.value ?? '');
        if (!value || value.length > 256) throw new Error('Select value is invalid');
        await locator.selectOption(value, { timeout: 10_000 });
      } else if (action === 'check') await locator.check({ timeout: 10_000 });
      else if (action === 'uncheck') await locator.uncheck({ timeout: 10_000 });
      else {
        const key = String(input.key || '');
        const allowedKeys = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space', 'Control+A', 'Meta+A']);
        if (!allowedKeys.has(key)) throw new Error('Unsupported browser key');
        await locator.press(key, { timeout: 10_000 });
      }
    } else throw new Error('Unsupported Agent browser action');

    const title = await browserPage.title();
    return { ready: true, action, url: safePageUrl(browserPage.url()), title: title.slice(0, 300) };
  });
}

http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && pathname === '/healthz') return send(res, 200, { ok: true });
    if (req.method === 'GET' && pathname === '/readyz') {
      try {
        if (!await rendererResponds()) return send(res, 503, { ok: false, code: 'DOTS_RENDERER_UNRESPONSIVE', error: '云电脑里的 Chromium 页面无响应，系统正在自动恢复' });
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
      const state = await rendererHealth.run(async () => {
        const browserPage = await page();
        return { ready: true, owner, url: browserPage.url(), title: await browserPage.title() };
      });
      return send(res, 200, state);
    }
    if (req.method === 'GET' && pathname === '/v1/screenshot') return send(res, 200, await screenshot(), 'image/png');
    if (req.method === 'POST' && pathname === '/v1/commands') return send(res, 200, await command(await body(req)));
    if (req.method === 'POST' && pathname === '/v1/browser') return send(res, 200, await agentBrowserAction(await body(req)));
    return send(res, 404, { error: 'not found' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'computer command failed';
    const contextUnavailable = error instanceof BrowserContextNotReadyError;
    const rendererUnresponsive = error instanceof RendererUnresponsiveError;
    if (rendererUnresponsive) {
      rendererHealth.fail();
      void recoverChromium();
    }
    return send(res, contextUnavailable || rendererUnresponsive ? 503 : 400, {
      error: message.slice(0, 240),
      ...(contextUnavailable || rendererUnresponsive ? { code: error.code } : {}),
    });
  }
}).listen(port, '0.0.0.0', () => process.stdout.write(`Dots desktop worker listening on ${port}\n`));
