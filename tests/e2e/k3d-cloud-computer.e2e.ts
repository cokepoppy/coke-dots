import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { PNG } from 'pngjs';
import { desktopResourceIdentity } from '../../src/server/linux-desktop-computer.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cluster = process.env.DOTS_K3D_CLUSTER || 'tp1121-sandbox-dev';
let tenantId = '';
let namespace = '';
const tempRoot = await mkdtemp(join(tmpdir(), 'coke-dots-k3d-e2e-'));
const artifacts = resolve(projectRoot, 'artifacts', 'e2e', `k3d-cloud-computer-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const envFile = join(tempRoot, 'empty.env');
const dataDirectory = join(tempRoot, 'data');
const tokenSecret = randomBytes(32).toString('base64url');
let appServer: ChildProcess | null = null;
let browser: Browser | null = null;
let page: Page | null = null;
let appPort = 0;
let kubectlNamespaceCreated = false;
const logs: string[] = [];

function command(args: string[]) {
  const result = spawnSync(args[0], args.slice(1), { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`${args[0]} ${args[1]} failed (${result.status ?? 'signal'}): ${(result.stderr || result.stdout).slice(-1200)}`);
  return result.stdout.trim();
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function startApp(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test', DOTS_E2E_AUTH: '1', DOTS_ENV_FILE: envFile, DOTS_DATA_DIR: dataDirectory, DOTS_PORT: String(appPort),
      DOTS_COMPUTER_BACKEND: 'linux-desktop', DOTS_LINUX_DESKTOP_TOKEN_SECRET: tokenSecret,
      DOTS_LINUX_DESKTOP_IMAGE: process.env.DOTS_LINUX_DESKTOP_IMAGE || 'coke-dots-linux-desktop:dev',
      DOTS_LINUX_DESKTOP_CONTROL_NAMESPACE: process.env.DOTS_LINUX_DESKTOP_CONTROL_NAMESPACE || cluster,
      DOTS_LINUX_DESKTOP_CHROME_NO_SANDBOX: process.env.DOTS_LINUX_DESKTOP_CHROME_NO_SANDBOX || '1',
      DOTS_LINUX_DESKTOP_TEST_WORKER_URL: '', DOTS_LINUX_DESKTOP_TEST_NOVNC_URL: '', DOTS_LINUX_DESKTOP_TEST_AGENT_URL: '',
      DOTS_AGENT_KERNELS_JSON: '{}',
      GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', DOTS_MODEL_BASE_URL: '', DOTS_MODEL_API_KEY: '', DOTS_MODEL: '', DOTS_CLAUDE_BIN: '', DOTS_PI_ENABLED: '0', DOTS_DSH_BIN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { logs.push(String(chunk)); if (logs.length > 120) logs.splice(0, logs.length - 120); });
  const health = `http://127.0.0.1:${appPort}/api/health`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Coke Dots test service exited (${child.exitCode})\n${logs.join('')}`);
    try { if ((await fetch(health)).ok) return child; } catch { /* wait for bind */ }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  child.kill('SIGKILL');
  throw new Error(`Coke Dots test service did not start\n${logs.join('')}`);
}

async function signIn(target: Page): Promise<string> {
  const baseUrl = `http://127.0.0.1:${appPort}`;
  await target.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await target.locator('#e2e-email').fill('k3d-cloud-computer@example.test');
  const navigation = target.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await target.getByTestId('e2e-sign-in').click();
  await navigation;
  await target.getByTestId('app-shell').waitFor({ state: 'visible' });
  await target.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true');
  const status = await target.evaluate(async () => (await fetch('/api/profile', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupComplete: true, onboardingComplete: true }) })).status);
  assert.equal(status, 200);
  await target.reload({ waitUntil: 'domcontentloaded' });
  await target.getByTestId('app-shell').waitFor({ state: 'visible' });
  await target.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true');
  const tenantId = await target.getByTestId('app-shell').getAttribute('data-tenant-id');
  assert(tenantId, 'The signed-in workspace must expose its verified tenant ID to the E2E harness');
  return tenantId;
}

try {
  const currentContext = command(['kubectl', 'config', 'current-context']);
  assert.equal(currentContext, `k3d-${cluster}`, 'The K3D smoke test must use the explicitly selected Coke sandbox cluster');
  command(['kubectl', 'get', 'nodes']);
  command(['docker', 'image', 'inspect', process.env.DOTS_LINUX_DESKTOP_IMAGE || 'coke-dots-linux-desktop:dev']);
  console.log(`K3D preflight passed: ${cluster}`);
  await mkdir(artifacts, { recursive: true });
  await writeFile(envFile, '');
  appPort = await freePort();
  appServer = await startApp();
  console.log(`Coke Dots test service ready: 127.0.0.1:${appPort}`);
  browser = await chromium.launch({ executablePath: process.env.DOTS_CHROME_BIN || findChrome(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  page.on('pageerror', error => logs.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') logs.push(`console: ${message.text()}`); });
  tenantId = await signIn(page);
  namespace = desktopResourceIdentity(tenantId).namespace;
  console.log('Test tenant signed in and first-run setup completed');

  kubectlNamespaceCreated = true;
  console.log(`Opening isolated Debian desktop namespace ${namespace}`);
  console.log(`Computer navigation button count: ${await page.getByRole('button', { name: '电脑', exact: true }).count()}`);
  await page.getByRole('button', { name: '电脑', exact: true }).click({ timeout: 10_000 });
  console.log('Computer navigation clicked');
  const computerStatus = await page.evaluate(async () => {
    const response = await fetch('/api/computer');
    return { status: response.status, body: await response.json() as { error?: string; backend?: string; owner?: string } };
  });
  console.log(`Computer API returned HTTP ${computerStatus.status}${computerStatus.body.error ? ` (${computerStatus.body.error})` : ''}`);
  assert.equal(computerStatus.status, 200, 'The cloud computer API must connect to the tenant desktop');
  const remoteImage = page.locator('img[alt="Linux 云桌面画面"]');
  await remoteImage.waitFor({ state: 'visible', timeout: 240_000 });
  await page.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>('img[alt="Linux 云桌面画面"]');
    return Boolean(image?.complete && image.naturalWidth === 1440 && image.naturalHeight === 900);
  }, null, { timeout: 60_000 });
  console.log('Debian desktop Pod is ready and the screenshot is rendered');
  const state = await page.evaluate(async () => await (await fetch('/api/computer')).json()) as { backend: string; owner: string; title: string };
  assert.equal(state.backend, 'linux-desktop');
  assert.equal(state.owner, 'agent');
  const screenshot = Buffer.from(await page.evaluate(async () => Array.from(new Uint8Array(await (await fetch('/api/computer/screenshot')).arrayBuffer()))));
  await writeFile(join(artifacts, '01-api-screenshot.png'), screenshot);
  const frame = PNG.sync.read(screenshot);
  assert.deepEqual([frame.width, frame.height], [1440, 900]);
  const samples = new Set<string>();
  for (let y = 40; y < frame.height; y += 97) for (let x = 40; x < frame.width; x += 113) {
    const offset = (frame.width * y + x) * 4;
    samples.add(`${frame.data[offset]},${frame.data[offset + 1]},${frame.data[offset + 2]}`);
  }
  assert(samples.size > 4, `The live K3D screenshot must contain a rendered desktop, not a blank placeholder (sampled ${samples.size} colors)`);
  await page.screenshot({ path: join(artifacts, '01-agent-desktop.png'), fullPage: true });

  await page.getByRole('button', { name: 'Take over' }).click();
  const vncCanvas = page.frameLocator('[data-testid="linux-desktop-view"]').locator('canvas').first();
  await vncCanvas.waitFor({ state: 'visible', timeout: 60_000 });
  const canvasSize = await vncCanvas.evaluate(element => ({ width: (element as HTMLCanvasElement).width, height: (element as HTMLCanvasElement).height }));
  assert.deepEqual(canvasSize, { width: 1440, height: 900 }, 'The live noVNC canvas must match the remote desktop resolution');
  await vncCanvas.screenshot({ path: join(artifacts, '02-novnc-canvas.png') });
  console.log('Live noVNC canvas connected at 1440x900');

  const actions = await page.evaluate(async () => {
    const results: { status: number; url?: string }[] = [];
    for (const [path, body] of [
      ['/api/computer/navigate', { url: 'http://127.0.0.1:8082/healthz' }],
      ['/api/computer/click', { x: 330, y: 280 }],
      ['/api/computer/type', { text: 'cloud computer E2E' }],
    ] as const) {
      const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json() as { url?: string };
      results.push({ status: response.status, ...(result.url ? { url: result.url } : {}) });
    }
    return results;
  });
  assert.deepEqual(actions.map(action => action.status), [200, 200, 200]);
  assert.equal(actions[0].url, 'http://127.0.0.1:8082/healthz');
  await page.getByRole('button', { name: 'Return control' }).click();
  await page.getByRole('status').filter({ hasText: 'Dot has control' }).waitFor({ state: 'visible' });
  await page.screenshot({ path: join(artifacts, '03-agent-control-restored.png'), fullPage: true });
  console.log('Real cloud-browser navigate/click/type and control hand-back passed');
  console.log(JSON.stringify({ result: 'passed', cluster, namespace, evidence: ['real Debian Bookworm desktop Pod', '1440x900 nonblank screenshot', 'live noVNC canvas and WebSocket', 'browser navigate/click/type', 'takeover and return'], artifacts }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => undefined);
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.join('')}`);
} finally {
  await page?.context().close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  if (appServer && appServer.exitCode === null) {
    appServer.kill('SIGTERM');
    await new Promise(resolvePromise => appServer!.once('exit', resolvePromise));
  }
  if (namespace && (kubectlNamespaceCreated || process.env.DOTS_K3D_CLEANUP_FAILED === '1')) {
    spawnSync('kubectl', ['delete', 'namespace', namespace, '--wait=true', '--timeout=120s'], { cwd: projectRoot, stdio: 'ignore' });
  }
  await rm(tempRoot, { recursive: true, force: true });
}

function findChrome() {
  const candidates = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  const candidate = candidates.find(existsSync);
  if (!candidate) throw new Error('Chrome not found; set DOTS_CHROME_BIN.');
  return candidate;
}
