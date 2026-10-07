import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { PNG } from 'pngjs';
import { desktopResourceIdentity } from '../../src/server/linux-desktop-computer.ts';
import { compareRasters, cropRaster, resizeRaster } from '../../src/shared/reference-visual.ts';

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
      DOTS_KEYCHAIN_SERVICE: `com.cokepoppy.coke-dots.e2e-k3d-${randomUUID()}`,
      DOTS_COMPUTER_BACKEND: 'linux-desktop', DOTS_LINUX_DESKTOP_TOKEN_SECRET: tokenSecret,
      DOTS_LINUX_DESKTOP_IMAGE: process.env.DOTS_LINUX_DESKTOP_IMAGE || 'coke-dots-linux-desktop:dev',
      DOTS_LINUX_DESKTOP_CONTROL_NAMESPACE: process.env.DOTS_LINUX_DESKTOP_CONTROL_NAMESPACE || cluster,
      DOTS_LINUX_DESKTOP_CHROME_NO_SANDBOX: process.env.DOTS_LINUX_DESKTOP_CHROME_NO_SANDBOX || '1',
      DOTS_LINUX_DESKTOP_TEST_WORKER_URL: '', DOTS_LINUX_DESKTOP_TEST_NOVNC_URL: '', DOTS_LINUX_DESKTOP_TEST_AGENT_URL: '',
      DOTS_DESKTOP_AGENT_ADAPTERS: 'dsh',
      DOTS_AGENT_KERNELS_JSON: JSON.stringify({ dsh: { command: 'node', args: ['-e', agentAdapterSource] } }),
      GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', DOTS_MODEL_BASE_URL: '', DOTS_MODEL_API_KEY: '', DOTS_MODEL: '', DOTS_PI_ENABLED: '0', DOTS_DSH_BIN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { logs.push(String(chunk)); if (logs.length > 120) logs.splice(0, logs.length - 120); });
  child.on('exit', (code, signal) => logs.push(`Coke Dots service exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`));
  child.on('error', error => logs.push(`Coke Dots service process error: ${error.message}`));
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
  const profileStatus = await target.evaluate(async () => (await fetch('/api/profile', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Roger', setupComplete: true, onboardingComplete: true }) })).status);
  assert.equal(profileStatus, 200, 'The reference tenant must use the Dot name shown in the YouTube frame');
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
  assert.equal(state.title, 'Welcome back, Roger', 'The tenant Dot name must appear on the video-observed welcome screen');
  const screenshot = Buffer.from(await page.evaluate(async () => Array.from(new Uint8Array(await (await fetch('/api/computer/screenshot')).arrayBuffer()))));
  await writeFile(join(artifacts, '01-api-screenshot.png'), screenshot);
  const frame = PNG.sync.read(screenshot);
  assert.deepEqual([frame.width, frame.height], [1440, 1080]);
  const videoFramePath = resolve(projectRoot, 'research/frames/john-aspinall-v2-0444-dot-control-replay.png');
  if (existsSync(videoFramePath)) {
    const comparisonConfig = JSON.parse(await readFile(resolve(projectRoot, 'research/comparisons/cloud-computer-v2-0444.json'), 'utf8')) as {
      referenceRect: { x: number; y: number; width: number; height: number };
      threshold: number;
    };
    const videoFrame = PNG.sync.read(await readFile(videoFramePath));
    const videoDesktop = cropRaster(videoFrame, comparisonConfig.referenceRect);
    const alignedReference = resizeRaster(videoDesktop, frame.width, frame.height);
    const referenceComparison = compareRasters(alignedReference, frame, comparisonConfig.threshold);
    assert(
      referenceComparison.meanAbsoluteError < 8 && referenceComparison.changedPixelRatio < 0.1,
      `The Debian welcome screen must stay close to the 04:44 video frame (MAE ${referenceComparison.meanAbsoluteError.toFixed(2)}, changed ${((referenceComparison.changedPixelRatio) * 100).toFixed(2)}%)`,
    );
    await writeFile(join(artifacts, '01-video-reference-comparison.json'), `${JSON.stringify({ source: 'john-aspinall-v2 04:44', ...referenceComparison }, null, 2)}\n`);
    console.log(`Video-frame comparison passed (MAE ${referenceComparison.meanAbsoluteError.toFixed(2)}, changed ${((referenceComparison.changedPixelRatio) * 100).toFixed(2)}%)`);
  } else {
    console.log('Video-frame pixel comparison skipped because the ignored source frame is not present');
  }
  const sample = (x: number, y: number) => {
    const offset = (frame.width * y + x) * 4;
    return [...frame.data.subarray(offset, offset + 3)];
  };
  const topEdge = sample(720, 10);
  assert(topEdge[0] > 220 && topEdge[1] > 100 && topEdge[1] < 190 && topEdge[2] < 170, `The Dots desktop must show coral wallpaper to the top edge without an XFCE panel; saw ${topEdge}`);
  const browserChromeTop = sample(720, 70);
  assert(browserChromeTop[0] > 220 && browserChromeTop[1] > 100 && browserChromeTop[1] < 190 && browserChromeTop[2] < 170, `The source frame has no OS titlebar above Chromium; saw ${browserChromeTop}`);
  const wallpaper = sample(20, 20);
  assert(wallpaper[0] > 220 && wallpaper[1] > 100 && wallpaper[1] < 190 && wallpaper[2] < 170, `The desktop margin must show the coral reference wallpaper; saw ${wallpaper}`);
  const wallpaperGlow = sample(20, 600);
  const wallpaperFarEdge = sample(1395, 600);
  assert(wallpaperGlow[1] > 185 && wallpaperGlow[1] > wallpaperFarEdge[1] + 20, `The source desktop has a pale coral glow across its left middle; saw left=${wallpaperGlow}, right=${wallpaperFarEdge}`);
  let chromeWarningTextPixels = 0;
  for (let y = 205; y <= 217; y++) for (let x = 250; x <= 1190; x++) {
    const offset = (frame.width * y + x) * 4;
    if (frame.data[offset] < 160 && frame.data[offset + 1] < 160 && frame.data[offset + 2] < 160) chromeWarningTextPixels++;
  }
  assert(chromeWarningTextPixels < 100, `The Chromium --no-sandbox startup banner must not cover the observed welcome-screen layout (found ${chromeWarningTextPixels} dark banner pixels)`);
  const browserChrome = sample(100, 100);
  assert(browserChrome[0] > 225 && browserChrome[1] > 140 && browserChrome[1] < 215 && browserChrome[2] < 190, `The browser window must use the sampled coral theme at the measured inset; saw ${browserChrome}`);
  const dock = sample(620, 1020);
  assert(dock[0] > 220 && dock[1] > 140 && dock[1] < 210 && dock[2] < 190, `The centered launcher dock must keep the source's pale coral fill; saw ${dock}`);
  let blueFolderPixels = 0;
  for (let y = 1010; y <= 1050; y++) for (let x = 770; x <= 815; x++) {
    const offset = (frame.width * y + x) * 4;
    const [red, green, blue] = frame.data.subarray(offset, offset + 3);
    if (blue > red + 20 && blue > green - 20 && blue > 120) blueFolderPixels++;
  }
  assert(blueFolderPixels > 250, `The third dock icon should match the blue folder visible in the 04:42 source frame; found ${blueFolderPixels} blue pixels`);
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
  const takeoverOutline = await page.getByTestId('linux-desktop-stage').evaluate(element => {
    const style = getComputedStyle(element);
    return { color: style.outlineColor, style: style.outlineStyle, width: style.outlineWidth, offset: style.outlineOffset };
  });
  assert.deepEqual(takeoverOutline, { color: 'rgb(236, 139, 63)', style: 'solid', width: '4px', offset: '-4px' }, 'The complete user-owned desktop stage must carry the video-observed orange outline');
  const userGroupCenter = (userControl.x + returnControl.x + returnControl.width) / 2;
  assert(Math.abs(userGroupCenter - (takenOverStage.x + takenOverStage.width / 2)) < 4, 'The takeover/return controls must stay centered when ownership changes');
  const vncCanvas = page.frameLocator('[data-testid="linux-desktop-view"]').locator('canvas').first();
  await vncCanvas.waitFor({ state: 'visible', timeout: 60_000 });
  assert.equal(await page.frameLocator('[data-testid="linux-desktop-view"]').locator('#top_bar').evaluate(element => getComputedStyle(element).display), 'none', 'The real takeover view must hide the noVNC demo toolbar like the observed Dots desktop');
  const canvasSize = await vncCanvas.evaluate(element => ({ width: (element as HTMLCanvasElement).width, height: (element as HTMLCanvasElement).height }));
  assert.deepEqual(canvasSize, { width: 1440, height: 1080 }, 'The live noVNC canvas must match the remote desktop resolution');
  let takeoverCanvasPng: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let takeoverContinuity: ReturnType<typeof compareRasters> | null = null;
  const canvasDeadline = Date.now() + 30_000;
  while (Date.now() < canvasDeadline) {
    takeoverCanvasPng = await vncCanvas.screenshot();
    const takeoverCanvas = PNG.sync.read(takeoverCanvasPng);
    takeoverContinuity = compareRasters(resizeRaster(frame, takeoverCanvas.width, takeoverCanvas.height), takeoverCanvas, 32);
    if (takeoverContinuity.meanAbsoluteError < 2.5 && takeoverContinuity.changedPixelRatio < 0.04) break;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
  }
  await writeFile(join(artifacts, '02-novnc-canvas.png'), takeoverCanvasPng);
  assert(takeoverContinuity, 'The noVNC canvas must return a desktop frame after takeover');
  assert(
    takeoverContinuity.meanAbsoluteError < 2.5 && takeoverContinuity.changedPixelRatio < 0.04,
    `Taking over must keep the current remote page visible (last MAE ${takeoverContinuity.meanAbsoluteError.toFixed(2)}, changed ${((takeoverContinuity.changedPixelRatio) * 100).toFixed(2)}%)`,
  );
  await writeFile(join(artifacts, '02-takeover-continuity.json'), `${JSON.stringify(takeoverContinuity, null, 2)}\n`);
  console.log(`Remote page continuity after takeover passed (MAE ${takeoverContinuity.meanAbsoluteError.toFixed(2)}, changed ${((takeoverContinuity.changedPixelRatio) * 100).toFixed(2)}%)`);
  await page.screenshot({ path: join(artifacts, '02-user-takeover.png'), fullPage: true });
  const stageCapture = await page.getByTestId('linux-desktop-stage').screenshot({ path: join(artifacts, '02-user-takeover-stage.png') });
  const stageImage = PNG.sync.read(stageCapture);
  const takeoverFramePath = resolve(projectRoot, 'research/frames/john-aspinall-v2-0450-user-control-replay.png');
  if (existsSync(takeoverFramePath)) {
    const comparisonConfig = JSON.parse(await readFile(resolve(projectRoot, 'research/comparisons/cloud-computer-v2-0450.json'), 'utf8')) as {
      referenceRect: { x: number; y: number; width: number; height: number };
      threshold: number;
    };
    const takeoverFrame = PNG.sync.read(await readFile(takeoverFramePath));
    const takeoverReference = cropRaster(takeoverFrame, comparisonConfig.referenceRect);
    const alignedTakeoverReference = resizeRaster(takeoverReference, stageImage.width, stageImage.height);
    const takeoverReferenceComparison = compareRasters(alignedTakeoverReference, stageImage, comparisonConfig.threshold);
    assert(
      takeoverReferenceComparison.meanAbsoluteError < 8 && takeoverReferenceComparison.changedPixelRatio < 0.1,
      `The takeover desktop must stay close to the 04:50 video frame (MAE ${takeoverReferenceComparison.meanAbsoluteError.toFixed(2)}, changed ${((takeoverReferenceComparison.changedPixelRatio) * 100).toFixed(2)}%)`,
    );
    await writeFile(join(artifacts, '02-video-user-control-comparison.json'), `${JSON.stringify({ source: 'john-aspinall-v2 04:50', ...takeoverReferenceComparison }, null, 2)}\n`);
    console.log(`Takeover-frame comparison passed (MAE ${takeoverReferenceComparison.meanAbsoluteError.toFixed(2)}, changed ${((takeoverReferenceComparison.changedPixelRatio) * 100).toFixed(2)}%)`);
  } else {
    console.log('Takeover-frame comparison skipped because the ignored local source frame is not present');
  }
  let orangeTakeoverPixels = 0;
  for (let offset = 0; offset < stageImage.data.length; offset += 4) {
    const [red, green, blue] = stageImage.data.subarray(offset, offset + 3);
    if (Math.abs(red - 236) <= 2 && Math.abs(green - 139) <= 2 && Math.abs(blue - 63) <= 2) orangeTakeoverPixels++;
  }
  assert(orangeTakeoverPixels > 3000, `The source video shows a visible orange screen frame during user takeover; screenshot contained ${orangeTakeoverPixels} matching pixels`);
  console.log('Live noVNC canvas connected at 1440x1080');

  const canvasBounds = await vncCanvas.boundingBox();
  assert(canvasBounds, 'The live noVNC canvas must have a visible pointer target');
  const omniboxPosition = { x: canvasBounds.width * (740 / 1440), y: canvasBounds.height * (160 / 1080) };
  // The reference desktop shows Chromium's address bar at x=740, y=160 in its
  // 1440x1080 screen. Click and type through noVNC. Do not use Control+L: the
  // video shows a pointer click, and browser-level shortcuts can be captured
  // by the host browser instead of the remote desktop. Send Return through the
  // authenticated runtime input API after the address field is visibly filled.
  await vncCanvas.click({ position: omniboxPosition });
  await vncCanvas.pressSequentially('http://127.0.0.1:8082/healthz', { delay: 15 });
  const beforeSubmit = Buffer.from(await page.evaluate(async () => Array.from(new Uint8Array(await (await fetch('/api/computer/screenshot')).arrayBuffer()))));
  await writeFile(join(artifacts, '02b-before-navigation-submit.png'), beforeSubmit);
  const appBaseUrl = `http://127.0.0.1:${appPort}`;
  const submitResponse = await page.request.post(`${appBaseUrl}/api/computer/press`, {
    headers: { origin: appBaseUrl, 'content-type': 'application/json' },
    data: { key: 'Enter' },
  });
  const submit = { status: submitResponse.status(), body: await submitResponse.json().catch(() => ({})) as Record<string, unknown> };
  assert.equal(submit.status, 200, `The tenant desktop must accept an Enter event on the focused address bar: ${JSON.stringify(submit.body)}`);
  const expectedRemoteUrl = 'http://127.0.0.1:8082/healthz';
  let changedPagePixels = 0;
  let browserState: { url?: string; title?: string } = {};
  const readRemoteNavigation = async () => {
    browserState = await page!.evaluate(async () => await (await fetch('/api/computer')).json()) as { url?: string; title?: string };
    const remoteScreenshot = Buffer.from(await page!.evaluate(async () => Array.from(new Uint8Array(await (await fetch('/api/computer/screenshot')).arrayBuffer()))));
    const afterNavigation = PNG.sync.read(remoteScreenshot);
    changedPagePixels = 0;
    for (let y = 190; y < 970; y += 2) for (let x = 100; x < 1340; x += 2) {
      const offset = (frame.width * y + x) * 4;
      if (Math.abs(frame.data[offset] - afterNavigation.data[offset]) + Math.abs(frame.data[offset + 1] - afterNavigation.data[offset + 1]) + Math.abs(frame.data[offset + 2] - afterNavigation.data[offset + 2]) > 48) changedPagePixels++;
    }
    return remoteScreenshot;
  };
  const waitForVisibleNavigation = async (durationMs: number) => {
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      const remoteScreenshot = await readRemoteNavigation();
      if (browserState.url === expectedRemoteUrl && changedPagePixels > 2_000) {
        await writeFile(join(artifacts, '03-remote-browser-navigation.png'), remoteScreenshot);
        return true;
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
    }
    return false;
  };
  const visibleNavigation = await waitForVisibleNavigation(20_000);
  assert.equal(browserState.url, expectedRemoteUrl, 'The remote Chromium address bar must navigate to the tenant-local health page');
  assert(visibleNavigation, `The remote browser page must visibly change after submission; only ${changedPagePixels} sampled page pixels changed`);
  await page.getByRole('button', { name: 'Return control' }).click();
  await page.getByRole('status').filter({ hasText: 'Roger has control' }).waitFor({ state: 'visible' });
  await page.screenshot({ path: join(artifacts, '04-agent-control-restored.png'), fullPage: true });
  console.log('Real noVNC address-bar click/text entry, runtime Enter submission, visible navigation, and control hand-back passed');

  command(['kubectl', '-n', namespace, 'delete', 'pod', desktopPod, '--wait=true', '--timeout=90s']);
  command(['kubectl', '-n', namespace, 'wait', '--for=condition=Ready', 'pod', '-l', 'app=desktop', '--timeout=120s']);
  const restartedPod = command(['kubectl', '-n', namespace, 'get', 'pod', '-l', 'app=desktop', '-o', 'jsonpath={.items[0].metadata.name}']);
  assert.notEqual(restartedPod, desktopPod, 'Kubernetes must replace the deleted tenant desktop Pod');
  assert.equal(command(['kubectl', '-n', namespace, 'exec', restartedPod, '--', 'cat', workspacePath]), runtimeTaskId, 'The tenant workspace artifact must survive a desktop Pod restart');
  console.log('Tenant Agent artifact survived recreation of the Debian 13 desktop Pod');
  console.log(JSON.stringify({ result: 'passed', cluster, namespace, evidence: ['real Debian 13 Trixie desktop Pod with Node.js 22', '1440x1080 coral desktop screenshot', 'live noVNC canvas and WebSocket', 'noVNC address-bar click/text entry, runtime Enter, and visible navigation', 'takeover and return', 'live Agent adapter execution without runtime-token exposure', 'workspace artifact survives Pod recreation'], artifacts }, null, 2));
} catch (error) {
  const health = await fetch(`http://127.0.0.1:${appPort}/api/health`).then(response => `HTTP ${response.status}`).catch(failure => `unreachable: ${failure instanceof Error ? failure.message : String(failure)}`);
  logs.push(`Failure diagnostics: appServerExit=${appServer?.exitCode ?? 'running'} health=${health} page=${page?.url() ?? 'unavailable'}`);
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
