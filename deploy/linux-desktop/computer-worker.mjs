import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { createRendererHealthMonitor, RendererUnresponsiveError } from './renderer-health.mjs';

const exec = promisify(execFile);
const token = String(process.env.LINUX_DESKTOP_WORKER_TOKEN || '');
const port = Number(process.env.COKE_DESKTOP_WORKER_PORT || 8082);
const resolution = String(process.env.COKE_DESKTOP_RESOLUTION || '1440x900').split('x').map(Number);
let owner = 'agent';
let browser;
const rendererHealth = createRendererHealthMonitor();
const rendererUnresponsiveMessage = new RendererUnresponsiveError(3_000).message;
let rendererProbeFailures = 0;
let rendererRecovery = null;

if (!token) throw new Error('LINUX_DESKTOP_WORKER_TOKEN is required');

async function page() {
  if (browser && !browser.isConnected()) browser = undefined;
  if (!browser) browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  return context.pages()[0] || context.newPage();
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
        browser = undefined;
        rendererHealth.reset();
        rendererProbeFailures = 0;
        try {
          const browserPage = await page();
          await rendererHealth.run(() => browserPage.evaluate(() => document.readyState));
          process.stdout.write(`Chromium renderer recovered with process ${nextPid}\n`);
          return;
        } catch {
          browser = undefined;
          rendererHealth.reset();
        }
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
    }
    throw new Error('Chromium did not recover within 45 seconds');
  })().catch(error => {
    process.stderr.write(`Chromium renderer recovery failed: ${error instanceof Error ? error.message : String(error)}\n`);
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
      if (!await rendererResponds()) return send(res, 503, { ok: false, error: rendererUnresponsiveMessage });
      try {
        await exec('xdpyinfo', ['-display', process.env.DISPLAY || ':1'], { timeout: 1500 });
        const agent = await fetch(`http://127.0.0.1:${process.env.DOTS_AGENT_RUNTIME_PORT || 8083}/healthz`, { signal: AbortSignal.timeout(1500) });
        if (!agent.ok) return send(res, 503, { ok: false });
        return send(res, 200, { ok: true });
      } catch { return send(res, 503, { ok: false }); }
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
      const state = await rendererHealth.run(async () => {
        const browserPage = await page();
        return { ready: true, owner, url: browserPage.url(), title: await browserPage.title() };
      });
      return send(res, 200, state);
    }
    if (req.method === 'GET' && pathname === '/v1/screenshot') return send(res, 200, await screenshot(), 'image/png');
    if (req.method === 'POST' && pathname === '/v1/commands') return send(res, 200, await command(await body(req)));
    return send(res, 404, { error: 'not found' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'computer command failed';
    const status = error instanceof RendererUnresponsiveError ? 503 : 400;
    return send(res, status, { error: message.slice(0, 240) });
  }
}).listen(port, '0.0.0.0', () => process.stdout.write(`Dots desktop worker listening on ${port}\n`));
