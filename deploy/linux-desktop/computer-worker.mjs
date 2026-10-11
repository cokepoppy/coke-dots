import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import dns from 'node:dns/promises';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
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
    await exec('scrot', ['-p', '-o', file], { timeout: 5000 });
    return await fs.readFile(file);
  } finally { await fs.rm(file, { force: true }).catch(() => undefined); }
}

function isPublicAddress(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const octets = address.split('.').map(Number);
    const [a, b, c] = octets;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) || (a === 203 && b === 0 && c === 113));
  }
  if (version !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) return isPublicAddress(normalized.slice(7));
  return normalized !== '::' && normalized !== '::1' && !/^f[cd]/.test(normalized) &&
    !/^fe[89ab]/.test(normalized) && !/^ff/.test(normalized) &&
    !normalized.startsWith('2001:db8:') && !normalized.startsWith('2001:0:');
}

async function publicHttpsUrl(value) {
  let target;
  try { target = new URL(String(value || '')); } catch { throw new Error('Only public HTTPS pages are allowed'); }
  const host = target.hostname.toLowerCase().replace(/\.$/, '');
  if (target.protocol !== 'https:' || target.username || target.password || (target.port && target.port !== '443') ||
    !host.includes('.') || host === 'localhost' || /\.(?:localhost|local|internal|invalid|test|svc)$/.test(host) ||
    host === 'cluster.local' || host.endsWith('.cluster.local') || host.endsWith('.home.arpa')) {
    throw new Error('Only public HTTPS pages are allowed');
  }
  let addresses;
  try { addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true, verbatim: true }); }
  catch { throw new Error('The public page host could not be resolved'); }
  if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) throw new Error('Private or reserved network destinations are not allowed');
  target.hash = '';
  return target;
}

async function inspectAgentBrowserUi() {
  if (owner !== 'agent') throw new Error('The user currently controls this computer');
  const browserPage = await page();
  const target = await publicHttpsUrl(browserPage.url());
  if ((await browserPage.context().cookies(target.href)).length) throw new Error('Only public pages without an active login can be inspected');
  const result = await browserPage.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const links = [...document.querySelectorAll('a')].filter(visible).map(anchor => ({
      name: (anchor.getAttribute('aria-label') || anchor.innerText || anchor.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160),
      href: anchor.href,
      target: anchor.target,
      download: anchor.hasAttribute('download'),
    })).filter(link => link.name && link.href).slice(0, 40);
    return { url: location.href, title: document.title, text: document.body?.innerText || '', links };
  });
  return { url: target.href, title: String(result.title || '').slice(0, 300), text: String(result.text || '').trim().slice(0, 12000), links: result.links };
}

async function navigateAgentBrowserUi(input) {
  if (owner !== 'agent') throw new Error('The user currently controls this computer');
  const target = await publicHttpsUrl(input.url);
  const browserPage = await page();
  if ((await browserPage.context().cookies(target.href)).length) throw new Error('Only public pages without an active login can be opened');
  await browserPage.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
  if (owner !== 'agent') throw new Error('The user took control before the page finished opening');
  await publicHttpsUrl(browserPage.url());
  return inspectAgentBrowserUi();
}

async function clickAgentInformationLink(input) {
  if (owner !== 'agent') throw new Error('The user currently controls this computer');
  const name = String(input.name || '').trim();
  if (!name || name.length > 160 || !/more information|learn more|read more|view details|documentation|了解更多|查看详情|官方文档|更多信息/i.test(name)) {
    throw new Error('Only a visible information link can be clicked');
  }
  const browserPage = await page();
  const before = await publicHttpsUrl(browserPage.url());
  if ((await browserPage.context().cookies(before.href)).length) throw new Error('Only public pages without an active login can be used');
  const link = browserPage.getByRole('link', { name, exact: true });
  if (await link.count() !== 1 || !(await link.isVisible())) throw new Error('The requested visible information link was not found exactly once');
  await link.evaluate(element => element.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' }));
  await browserPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const attributes = await link.evaluate(element => ({ href: element.href, target: element.target, download: element.hasAttribute('download') }));
  const destination = await publicHttpsUrl(attributes.href);
  if (attributes.target && attributes.target !== '_self' || attributes.download) throw new Error('New-window links and downloads are not allowed');
  const bounds = await link.boundingBox();
  if (!bounds) throw new Error('The information link is no longer visible');
  const windowIds = (await exec('xdotool', ['search', '--onlyvisible', '--class', 'chromium'], { timeout: 5000 })).stdout.trim().split(/\s+/).filter(Boolean);
  const windows = await Promise.all(windowIds.map(async id => {
    try {
      const geometry = (await exec('xdotool', ['getwindowgeometry', '--shell', id], { timeout: 5000 })).stdout;
      const read = (key) => Number(geometry.match(new RegExp(`^${key}=(\\d+)$`, 'm'))?.[1]);
      return { id, x: read('X'), y: read('Y'), width: read('WIDTH'), height: read('HEIGHT') };
    } catch { return null; }
  }));
  const desktopWindow = windows.filter(window => window && window.width >= 400 && window.height >= 300).sort((left, right) => right.width * right.height - left.width * left.height)[0];
  if (!desktopWindow) throw new Error('The Chromium desktop window could not be located');
  const chromeHeight = await browserPage.evaluate(() => window.outerHeight - window.innerHeight);
  const x = Math.round(desktopWindow.x + bounds.x + bounds.width / 2);
  const y = Math.round(desktopWindow.y + chromeHeight + bounds.y + bounds.height / 2);
  if (x < 0 || y < 0 || x > resolution[0] || y > resolution[1]) throw new Error('The information link is outside the visible desktop');
  await exec('xdotool', ['mousemove', String(x), String(y)], { timeout: 5000 });
  await new Promise(resolve => setTimeout(resolve, 180));
  await exec('xdotool', ['click', '1'], { timeout: 5000 });
  await browserPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => undefined);
  if (owner !== 'agent') throw new Error('The user took control during the browser click');
  const after = await publicHttpsUrl(browserPage.url());
  if (after.href !== destination.href) {
    throw new Error(`The browser did not open the inspected information link (actual ${after.href}; expected ${destination.href}; click ${x},${y}; window ${desktopWindow.x},${desktopWindow.y} ${desktopWindow.width}x${desktopWindow.height}; link ${JSON.stringify({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height })})`);
  }
  return { ...await inspectAgentBrowserUi(), click: { name, x, y, window: { x: desktopWindow.x, y: desktopWindow.y, width: desktopWindow.width, height: desktopWindow.height }, destination: destination.href } };
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
  if (action === 'navigate') {
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
    if (req.method === 'POST' && pathname === '/v1/agent-ui/inspect') {
      const input = await body(req);
      if (Object.keys(input).length) return send(res, 400, { error: 'The UI inspect request does not accept parameters' });
      return send(res, 200, await inspectAgentBrowserUi());
    }
    if (req.method === 'POST' && pathname === '/v1/agent-ui/navigate') {
      const input = await body(req);
      if (Object.keys(input).some(key => key !== 'url') || typeof input.url !== 'string' || input.url.length > 2048) return send(res, 400, { error: 'The public page URL is invalid' });
      return send(res, 200, await navigateAgentBrowserUi(input));
    }
    if (req.method === 'POST' && pathname === '/v1/agent-ui/click-information-link') {
      const input = await body(req);
      if (Object.keys(input).some(key => key !== 'name') || typeof input.name !== 'string') return send(res, 400, { error: 'The UI click target is invalid' });
      return send(res, 200, await clickAgentInformationLink(input));
    }
    if (req.method === 'POST' && pathname === '/v1/commands') return send(res, 200, await command(await body(req)));
    return send(res, 404, { error: 'not found' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'computer command failed';
    const contextUnavailable = error instanceof BrowserContextNotReadyError;
    return send(res, contextUnavailable ? 503 : 400, { error: message.slice(0, 240), ...(contextUnavailable ? { code: error.code } : {}) });
  }
}).listen(port, '0.0.0.0', () => process.stdout.write(`Dots desktop worker listening on ${port}\n`));
