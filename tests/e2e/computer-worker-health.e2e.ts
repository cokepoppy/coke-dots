import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workerSourcePath = join(projectRoot, 'deploy/linux-desktop/computer-worker.mjs');
const chromePath = [
  process.env.DOTS_CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find(path => path && existsSync(path));
if (!chromePath) throw new Error('Chrome was not found. Set DOTS_CHROME_BIN to a local Chrome executable.');

async function freePort() {
  const server = createNetServer();
  await new Promise<void>((resolvePromise, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error('Timed out waiting for the computer worker health endpoint');
}

async function stop(child: ChildProcess | null) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch { child.kill('SIGTERM'); }
  await Promise.race([
    new Promise<void>(resolvePromise => child.once('exit', () => resolvePromise())),
    new Promise<void>(resolvePromise => setTimeout(resolvePromise, 1200)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { child.kill('SIGKILL'); }
  }
}

const tempRoot = await mkdtemp(join(tmpdir(), 'coke-dots-worker-health-'));
const runtimeRoot = await mkdtemp(join(projectRoot, '.dots-worker-health-'));
const runtimeWorkerDir = join(runtimeRoot, 'deploy/linux-desktop');
await mkdir(runtimeWorkerDir, { recursive: true });
await Promise.all([
  copyFile(workerSourcePath, join(runtimeWorkerDir, 'computer-worker.mjs')),
  copyFile(join(projectRoot, 'src/server/computer-home.mjs'), join(runtimeWorkerDir, 'computer-home.mjs')),
  copyFile(join(projectRoot, 'src/shared/public-web-policy.mjs'), join(runtimeWorkerDir, 'public-web-policy.mjs')),
]);
const workerPath = join(runtimeWorkerDir, 'computer-worker.mjs');
const cdpPort = await freePort();
const workerPort = await freePort();
const cdpUrl = `http://127.0.0.1:${cdpPort}`;
const workerUrl = `http://127.0.0.1:${workerPort}`;
const token = 'coke-dots-worker-health-e2e-token';
const chromeArgs = [
  '--headless=new', '--disable-gpu', '--disable-dev-shm-usage',
  '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${join(tempRoot, 'chrome-profile')}`, 'about:blank',
];
if (process.platform === 'linux') chromeArgs.unshift('--no-sandbox');
let chrome: ChildProcess | null = null;
let worker: ChildProcess | null = null;
let browser: Browser | null = null;
let chromeOutput = '';
let workerOutput = '';

try {
  worker = spawn(process.execPath, [workerPath], {
    cwd: projectRoot,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      LINUX_DESKTOP_WORKER_TOKEN: token,
      COKE_DESKTOP_WORKER_PORT: String(workerPort),
      COKE_DESKTOP_CHROME_DEBUG_URL: cdpUrl,
      COKE_DESKTOP_HEALTH_DIAGNOSTICS: '1',
    },
  });
  for (const stream of [worker.stdout, worker.stderr]) stream?.on('data', chunk => { workerOutput = `${workerOutput}${chunk.toString()}`.slice(-6000); });
  await waitFor(async () => (await fetch(`${workerUrl}/healthz`).catch(() => null))?.status === 200, 15_000);
  assert.equal((await fetch(`${workerUrl}/browserz`)).status, 503, 'The worker should report not ready before Chrome starts');

  chrome = spawn(chromePath, chromeArgs, { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [chrome.stdout, chrome.stderr]) stream?.on('data', chunk => { chromeOutput = `${chromeOutput}${chunk.toString()}`.slice(-6000); });
  await waitFor(async () => {
    const response = await fetch(`${cdpUrl}/json/version`).catch(() => null);
    return response?.ok === true;
  }, 15_000);

  let lastHealthResponse = 'no response yet';
  try {
    await waitFor(async () => {
      const response = await fetch(`${workerUrl}/browserz`).catch(() => null);
      lastHealthResponse = response ? `HTTP ${response.status} ${await response.text()}` : 'connection refused';
      return response?.status === 200;
    }, 15_000);
  } catch (error) {
    const childState = `worker exit=${worker.exitCode} signal=${worker.signalCode}; chrome exit=${chrome.exitCode} signal=${chrome.signalCode}`;
    let cdpStatus = 'unavailable';
    try { cdpStatus = `HTTP ${(await fetch(`${cdpUrl}/json/version`)).status}`; } catch {}
    throw new Error(`${error instanceof Error ? error.message : String(error)}; ${childState}; worker ${lastHealthResponse}; CDP ${cdpStatus}; worker output: ${workerOutput.slice(-2500)}; chrome output: ${chromeOutput.slice(-1500)}`);
  }

  browser = await chromium.connectOverCDP(cdpUrl);
  const page = browser.contexts()[0]?.pages()[0];
  assert(page, 'Chrome did not expose a page to the worker');
  const initialState = await fetch(`${workerUrl}/v1/state`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(initialState.status, 200, 'A responsive Chromium renderer should be healthy');
  const initial = await initialState.json() as { ready: boolean; owner: string; url: string; title: string };
  assert.equal(initial.ready, true);
  assert.equal(initial.owner, 'agent');
  assert.equal(initial.url, 'about:blank');
  assert.equal(initial.title, 'Welcome back, Dot');

  await page.evaluate(() => { window.setTimeout(() => { while (true) { /* simulate an unresponsive renderer */ } }, 250); return 'armed'; });
  await new Promise(resolvePromise => setTimeout(resolvePromise, 350));
  const probeStartedAt = Date.now();
  const unhealthy = await fetch(`${workerUrl}/browserz`, { signal: AbortSignal.timeout(8_000) });
  assert.equal(unhealthy.status, 503, 'A hung Chromium renderer must fail the liveness probe');
  assert.ok(Date.now() - probeStartedAt < 7_000, 'The worker must bound its browser responsiveness check');

  const nextState = await fetch(`${workerUrl}/v1/state`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1_000) });
  assert.equal(nextState.status, 503, 'State reads should fail quickly after the worker detects an unresponsive renderer');
  assert.equal((await fetch(`${workerUrl}/healthz`)).status, 200, 'The HTTP worker process remains alive for Kubernetes to observe and recycle');
  console.log('Computer worker health E2E passed: Chrome renderer hang is detected, bounded, and reported to Kubernetes.');
} finally {
  if (browser) void browser.close().catch(() => undefined);
  await stop(worker);
  await stop(chrome);
  await rm(tempRoot, { recursive: true, force: true });
  await rm(runtimeRoot, { recursive: true, force: true });
}
