import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
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
const agentAdapterSource = "const fs=require('node:fs');let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const task=JSON.parse(input);fs.writeFileSync('runtime-persistence.txt',task.taskId);console.log(JSON.stringify({status:'done',message:'Adapter completed: '+task.prompt+'; runtime token visible to child: '+Boolean(process.env.DOTS_AGENT_RUNTIME_TOKEN)}))})";
let appServer: ChildProcess | null = null;
let agentPortForward: ChildProcess | null = null;
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
      DOTS_DESKTOP_AGENT_ADAPTERS: 'dsh',
      DOTS_AGENT_KERNELS_JSON: JSON.stringify({ dsh: { command: 'node', args: ['-e', agentAdapterSource] } }),
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
  const workspace = await target.evaluate(async name => {
    const response = await fetch('/api/tenants', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    return { status: response.status, body: await response.json() as { id?: string } };
  }, `K3D cloud E2E ${randomUUID()}`);
  assert.equal(workspace.status, 201, 'Create a disposable tenant workspace for the live K3D desktop');
  await target.reload({ waitUntil: 'domcontentloaded' });
  await target.getByTestId('app-shell').waitFor({ state: 'visible' });
  await target.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true');
  const tenantId = await target.getByTestId('app-shell').getAttribute('data-tenant-id');
  assert(tenantId, 'The signed-in workspace must expose its verified tenant ID to the E2E harness');
  assert.equal(tenantId, workspace.body.id, 'The E2E session must use the unique workspace it just created');
  return tenantId;
}

function assertNamespaceIsNew(name: string) {
  const result = spawnSync('kubectl', ['get', 'namespace', name, '-o', 'name'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status === 0) throw new Error(`Refusing to reuse pre-existing tenant desktop namespace ${name}`);
  assert.match(result.stderr, /NotFound/i, `Could not safely check tenant namespace ${name}: ${(result.stderr || result.stdout).slice(-800)}`);
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
  assertNamespaceIsNew(namespace);
  console.log('Test tenant signed in and first-run setup completed');

  kubectlNamespaceCreated = true;
  console.log(`Opening isolated Debian 13 desktop namespace ${namespace}`);
  console.log(`Computer navigation button count: ${await page.getByRole('button', { name: '电脑', exact: true }).count()}`);
  await page.getByRole('button', { name: '电脑', exact: true }).click({ timeout: 10_000 });
  console.log('Computer navigation clicked');
  const computerStatus = await page.evaluate(async () => {
    const response = await fetch('/api/computer');
    return { status: response.status, body: await response.json() as { error?: string; backend?: string; owner?: string } };
  });
  console.log(`Computer API returned HTTP ${computerStatus.status}${computerStatus.body.error ? ` (${computerStatus.body.error})` : ''}`);
  assert.equal(computerStatus.status, 200, 'The cloud computer API must connect to the tenant desktop');
  const desktopPod = command(['kubectl', '-n', namespace, 'get', 'pod', '-l', 'app=desktop', '-o', 'jsonpath={.items[0].metadata.name}']);
  assert(desktopPod, `The tenant namespace ${namespace} must contain its desktop Pod`);
  const osRelease = command(['kubectl', '-n', namespace, 'exec', desktopPod, '--', 'cat', '/etc/os-release']);
  assert.match(osRelease, /^ID=debian$/m, 'The running cloud computer must identify itself as Debian');
  assert.match(osRelease, /^VERSION_ID="13"$/m, 'The running cloud computer must be Debian 13');
  assert.match(osRelease, /^VERSION_CODENAME=trixie$/m, 'The running cloud computer must be Debian 13 Trixie');
  const nodeVersion = command(['kubectl', '-n', namespace, 'exec', desktopPod, '--', 'node', '--version']);
  assert.match(nodeVersion, /^v22\./, 'The desktop image must include the configured Node.js Agent runtime');
  console.log(`Verified live tenant desktop OS: Debian 13 Trixie (${nodeVersion})`);
  const remoteImage = page.locator('img[alt="Linux 云桌面画面"]');
  await remoteImage.waitFor({ state: 'visible', timeout: 240_000 });
  await page.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>('img[alt="Linux 云桌面画面"]');
    return Boolean(image?.complete && image.naturalWidth === 1440 && image.naturalHeight === 1080);
  }, null, { timeout: 60_000 });
  console.log('Debian 13 desktop Pod is ready and the screenshot is rendered');
  const state = await page.evaluate(async () => await (await fetch('/api/computer')).json()) as { backend: string; owner: string; title: string };
  assert.equal(state.backend, 'linux-desktop');
  assert.equal(state.owner, 'agent');
  assert.equal(state.title, 'Welcome back, Dot', 'The live Debian desktop must start on the video-observed Dot welcome screen');
  const screenshot = Buffer.from(await page.evaluate(async () => Array.from(new Uint8Array(await (await fetch('/api/computer/screenshot')).arrayBuffer()))));
  await writeFile(join(artifacts, '01-api-screenshot.png'), screenshot);
  const frame = PNG.sync.read(screenshot);
  assert.deepEqual([frame.width, frame.height], [1440, 1080]);
  const sample = (x: number, y: number) => {
    const offset = (frame.width * y + x) * 4;
    return [...frame.data.subarray(offset, offset + 3)];
  };
  const wallpaper = sample(20, 20);
  assert(wallpaper[0] > 220 && wallpaper[1] > 100 && wallpaper[1] < 190 && wallpaper[2] < 170, `The desktop margin must show the coral reference wallpaper; saw ${wallpaper}`);
  let chromeWarningTextPixels = 0;
  for (let y = 205; y <= 217; y++) for (let x = 250; x <= 1190; x++) {
    const offset = (frame.width * y + x) * 4;
    if (frame.data[offset] < 160 && frame.data[offset + 1] < 160 && frame.data[offset + 2] < 160) chromeWarningTextPixels++;
  }
  assert(chromeWarningTextPixels < 100, `The Chromium --no-sandbox startup banner must not cover the observed welcome-screen layout (found ${chromeWarningTextPixels} dark banner pixels)`);
  const browserChrome = sample(100, 100);
  assert(browserChrome[2] > 220 && browserChrome[1] > 200, `The browser window must sit inside the coral desktop at the measured inset; saw ${browserChrome}`);
  const dock = sample(720, 1020);
  assert(dock[0] > 230 && dock[1] > 210 && dock[2] > 200, `The centered launcher dock must appear along the desktop's bottom edge; saw ${dock}`);
  const samples = new Set<string>();
  for (let y = 40; y < frame.height; y += 97) for (let x = 40; x < frame.width; x += 113) {
    const offset = (frame.width * y + x) * 4;
    samples.add(`${frame.data[offset]},${frame.data[offset + 1]},${frame.data[offset + 2]}`);
  }
  assert(samples.size > 4, `The live K3D screenshot must contain a rendered desktop, not a blank placeholder (sampled ${samples.size} colors)`);
  const stage = await page.getByTestId('linux-desktop-stage').boundingBox();
  const ownerControl = await page.getByRole('status').boundingBox();
  const takeOverControl = await page.getByRole('button', { name: 'Take over' }).boundingBox();
  assert(stage && ownerControl && takeOverControl, 'The live computer canvas and both ownership controls must be visible');
  assert(Math.abs(stage.width / stage.height - 4 / 3) < 0.02, 'The cloud screen must preserve the observed 4:3 desktop shape');
  const controlGroupCenter = (ownerControl.x + takeOverControl.x + takeOverControl.width) / 2;
  assert(Math.abs(controlGroupCenter - (stage.x + stage.width / 2)) < 4, 'The observed owner status and takeover action must share the desktop centerline');
  await page.screenshot({ path: join(artifacts, '01-agent-desktop.png'), fullPage: true });

  const agentPort = await freePort();
  agentPortForward = spawn('kubectl', ['-n', namespace, 'port-forward', '--address', '127.0.0.1', 'svc/desktop', `${agentPort}:8083`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let portForwardOutput = '';
  agentPortForward.stdout?.on('data', chunk => { portForwardOutput += String(chunk); });
  agentPortForward.stderr?.on('data', chunk => { portForwardOutput += String(chunk); });
  const portForwardDeadline = Date.now() + 15_000;
  while (!portForwardOutput.includes(`127.0.0.1:${agentPort}`) && Date.now() < portForwardDeadline) {
    if (agentPortForward.exitCode !== null) throw new Error(`Agent runtime port-forward exited early: ${portForwardOutput}`);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  }
  assert(portForwardOutput.includes(`127.0.0.1:${agentPort}`), `Agent runtime port-forward did not become ready: ${portForwardOutput}`);
  const agentToken = createHmac('sha256', tokenSecret).update(`agent:${tenantId}`).digest('base64url');
  const runtimeTaskId = randomUUID();
  const runtimeResponse = await fetch(`http://127.0.0.1:${agentPort}/v1/tasks/run`, {
    method: 'POST',
    headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ engine: 'dsh', taskId: runtimeTaskId, prompt: 'real Debian 13 runtime smoke', sessionId: null, cwd: 'tasks/runtime-smoke' }),
  });
  const runtimeResult = await runtimeResponse.json() as { status?: string; message?: string; engine?: string };
  assert.equal(runtimeResponse.status, 200, `The live Agent runtime must execute its configured adapter: ${JSON.stringify(runtimeResult)}`);
  assert.equal(runtimeResult.status, 'done');
  assert.equal(runtimeResult.engine, 'dsh');
  assert.match(runtimeResult.message || '', /Adapter completed: real Debian 13 runtime smoke; runtime token visible to child: false/);
  const workspacePath = `/workspace/tasks/runtime-smoke/runtime-persistence.txt`;
  assert.equal(command(['kubectl', '-n', namespace, 'exec', desktopPod, '--', 'cat', workspacePath]), runtimeTaskId, 'The real Agent runtime must leave its task artifact in the tenant workspace PVC');
  agentPortForward.kill('SIGTERM');
  agentPortForward = null;
  console.log('Live Agent runtime executed its configured adapter and kept the runtime token out of the child process');

  await page.getByRole('button', { name: 'Take over' }).click();
  const userControl = await page.getByRole('status').filter({ hasText: 'You have control' }).boundingBox();
  const returnControl = await page.getByRole('button', { name: 'Return control' }).boundingBox();
  const takenOverStage = await page.getByTestId('linux-desktop-stage').boundingBox();
  assert(userControl && returnControl && takenOverStage, 'The live takeover row must remain visible with the desktop canvas');
  const userGroupCenter = (userControl.x + returnControl.x + returnControl.width) / 2;
  assert(Math.abs(userGroupCenter - (takenOverStage.x + takenOverStage.width / 2)) < 4, 'The takeover/return controls must stay centered when ownership changes');
  const vncCanvas = page.frameLocator('[data-testid="linux-desktop-view"]').locator('canvas').first();
  await vncCanvas.waitFor({ state: 'visible', timeout: 60_000 });
  const canvasSize = await vncCanvas.evaluate(element => ({ width: (element as HTMLCanvasElement).width, height: (element as HTMLCanvasElement).height }));
  assert.deepEqual(canvasSize, { width: 1440, height: 1080 }, 'The live noVNC canvas must match the remote desktop resolution');
  await vncCanvas.screenshot({ path: join(artifacts, '02-novnc-canvas.png') });
  console.log('Live noVNC canvas connected at 1440x1080');

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

  command(['kubectl', '-n', namespace, 'delete', 'pod', desktopPod, '--wait=true', '--timeout=90s']);
  command(['kubectl', '-n', namespace, 'wait', '--for=condition=Ready', 'pod', '-l', 'app=desktop', '--timeout=120s']);
  const restartedPod = command(['kubectl', '-n', namespace, 'get', 'pod', '-l', 'app=desktop', '-o', 'jsonpath={.items[0].metadata.name}']);
  assert.notEqual(restartedPod, desktopPod, 'Kubernetes must replace the deleted tenant desktop Pod');
  assert.equal(command(['kubectl', '-n', namespace, 'exec', restartedPod, '--', 'cat', workspacePath]), runtimeTaskId, 'The tenant workspace artifact must survive a desktop Pod restart');
  console.log('Tenant Agent artifact survived recreation of the Debian 13 desktop Pod');
  console.log(JSON.stringify({ result: 'passed', cluster, namespace, evidence: ['real Debian 13 Trixie desktop Pod with Node.js 22', '1440x1080 coral desktop screenshot', 'live noVNC canvas and WebSocket', 'browser navigate/click/type', 'takeover and return', 'live Agent adapter execution without runtime-token exposure', 'workspace artifact survives Pod recreation'], artifacts }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => undefined);
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.join('')}`);
} finally {
  agentPortForward?.kill('SIGTERM');
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
