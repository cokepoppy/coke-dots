import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page, type Video } from 'playwright-core';
import { Entry } from '@napi-rs/keyring';
import { PNG } from 'pngjs';
import { execFileSync } from 'node:child_process';
import { Store } from '../../src/server/store.ts';
import { desktopResourceIdentity } from '../../src/server/linux-desktop-computer.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outputRoot = join(projectRoot, 'artifacts', 'demos', 'cloud-computer-proactive-activity');
const fixtureUrl = 'https://activity-fixture.dots.test/open';
const kickoffInstruction = '请用中文回复：云电脑已准备好。不要打开网页或执行其他操作。';
const taskInstruction = `每小时在你的 Debian 云电脑中检查这个公开活动页：${fixtureUrl}。先用 open_public_page 打开页面，再用 computer_ui 查看当前页面。如果有“AI 助手上手分享”且显示免费名额，请点击“查看活动详情”，读取活动日期和名额。只查看信息；不要报名、付款、登录、填写或提交表单。完成后用中文告诉我活动名称、日期、免费名额，并确认没有报名或付款；保留每小时检查。`;
const cluster = process.env.DOTS_K3D_CLUSTER || 'tp1121-sandbox-dev';
const imageName = process.env.DOTS_LINUX_DESKTOP_IMAGE || 'coke-dots-linux-desktop:cloud-ui-demo';
const tokenSecret = randomBytes(32).toString('base64url');
const keychainService = `com.cokepoppy.coke-dots.computer-demo-${randomUUID()}`;
const tempRoot = await mkdtemp(join(tmpdir(), 'coke-dots-computer-demo-'));
const recordingRoot = await mkdtemp(join(tmpdir(), 'coke-dots-computer-demo-webm-'));
const dataDirectory = join(tempRoot, 'data');
const emptyEnvFile = join(tempRoot, 'empty.env');
const chromePath = [process.env.DOTS_CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find(path => path && existsSync(path));
const serverLogs: string[] = [];
let server: ChildProcess | null = null;
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let pageVideo: Video | null = null;
let baseUrl = '';
let tenantId = '';
let tenantNamespace = '';
let tenantNamespaceCreated = false;
let liveModelName = '';
let liveModelApiKey = '';
let workerPortForward: ChildProcess | null = null;
let runFailed = true;
let uiEvidence: unknown = null;
let taskDiagnostics: unknown = null;
let recordingPath = '';
const computerApiResponses: { path: string; status: number; body?: unknown }[] = [];

async function reservePort() {
  const listener = createNetServer();
  await new Promise<void>((resolvePromise, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolvePromise));
  const address = listener.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolvePromise, reject) => listener.close(error => error ? reject(error) : resolvePromise()));
  return address.port;
}

function command(args: string[]) {
  const result = spawnSync(args[0], args.slice(1), { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`${args[0]} ${args[1]} failed (${result.status ?? 'signal'}): ${(result.stderr || result.stdout).slice(-1200)}`);
  return result.stdout.trim();
}

async function configureLivePi() {
  assert.equal(command(['kubectl', 'config', 'current-context']), `k3d-${cluster}`, 'The live demo must use the explicitly selected Coke sandbox cluster.');
  command(['kubectl', 'get', 'nodes']);
  command(['docker', 'image', 'inspect', imageName]);
  const sourceKeychainService = process.env.DOTS_KEYCHAIN_SERVICE?.trim() || 'com.cokepoppy.coke-dots';
  const sourceDataDirectory = resolve(process.env.DOTS_DATA_DIR || join(projectRoot, '..', 'coke-dots', 'data'));
  const sourceStore = new Store(sourceDataDirectory);
  let modelBaseUrl = '';
  let model = '';
  try {
    modelBaseUrl = sourceStore.getSetting('sharedModelBaseUrl', 'legacy') || sourceStore.getSetting('modelBaseUrl', 'legacy') || '';
    model = sourceStore.getSetting('sharedModelName', 'legacy') || sourceStore.getSetting('modelName', 'legacy') || '';
  } finally { sourceStore.close(); }
  const apiKey = new Entry(sourceKeychainService, 'shared-model-api-key').getPassword()
    || new Entry(sourceKeychainService, 'tenant-legacy-model-api-key').getPassword() || '';
  assert(modelBaseUrl && model && apiKey, 'The live demo needs the shared model endpoint, model, and Keychain credential.');
  assert.equal(new URL(modelBaseUrl).protocol, 'https:', 'The live demo requires an HTTPS model endpoint.');
  liveModelName = model;
  liveModelApiKey = apiKey;
  new Entry(keychainService, 'shared-model-api-key').setPassword(apiKey);
  const setupStore = new Store(dataDirectory);
  setupStore.setSetting('sharedModelBaseUrl', modelBaseUrl, 'legacy');
  setupStore.setSetting('sharedModelName', model, 'legacy');
  setupStore.setSetting('modelBaseUrl', modelBaseUrl, 'legacy');
  setupStore.setSetting('modelName', model, 'legacy');
  setupStore.close();
  console.log(`Live Pi preflight passed: K3D ${cluster}, shared model configured`);
}

function captureServerOutput(child: ChildProcess) {
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => {
    serverLogs.push(String(chunk));
    if (serverLogs.length > 200) serverLogs.splice(0, serverLogs.length - 200);
  });
}

async function startServer(port: number) {
  server = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DOTS_E2E_AUTH: '1',
      DOTS_ENV_FILE: emptyEnvFile,
      DOTS_DATA_DIR: dataDirectory,
      DOTS_KEYCHAIN_SERVICE: keychainService,
      DOTS_PORT: String(port),
      DOTS_MODEL_BASE_URL: '',
      DOTS_MODEL_API_KEY: '',
      DOTS_MODEL: '',
      DOTS_PI_ENABLED: '1',
      DOTS_COMPUTER_BACKEND: 'linux-desktop',
      DOTS_LINUX_DESKTOP_TOKEN_SECRET: tokenSecret,
      DOTS_LINUX_DESKTOP_IMAGE: imageName,
      DOTS_LINUX_DESKTOP_CONTROL_NAMESPACE: cluster,
      DOTS_LINUX_DESKTOP_CHROME_NO_SANDBOX: '1',
      DOTS_DESKTOP_AGENT_ADAPTERS: 'pi',
      DOTS_AGENT_KERNELS_JSON: '',
      DOTS_DSH_BIN: '',
      DOTS_E2E_COMPUTER_RESEARCH_FIXTURE_URL: 'https://research-fixture.dots.test/launch',
      DOTS_E2E_COMPUTER_UI_FIXTURE_URL: fixtureUrl,
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  captureServerOutput(server);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Coke Dots demo service exited (${server.exitCode}).\n${serverLogs.join('')}`);
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch { /* Wait for the listener. */ }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Coke Dots demo service did not become healthy.\n${serverLogs.join('')}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise<void>(resolvePromise => server!.once('exit', () => resolvePromise()));
  server.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolvePromise => setTimeout(resolvePromise, 5_000))]);
  if (server.exitCode === null) { server.kill('SIGKILL'); await exited; }
}

async function signIn(target: Page) {
  await target.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await target.locator('#e2e-email').fill('cloud-demo@example.test');
  const navigation = target.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10_000 });
  await target.getByTestId('e2e-sign-in').click();
  await navigation;
  await target.getByTestId('app-shell').waitFor({ state: 'visible' });
  await target.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true');
}

async function waitForTask(target: Page, instruction = taskInstruction, expectedStatus: 'done' | 'scheduled' = 'scheduled', timeout = 240_000) {
  const deadline = Date.now() + timeout;
  let last: Record<string, unknown> | null = null;
  let previous = '';
  while (Date.now() < deadline) {
    last = await target.evaluate(async instruction => {
      const state = await fetch('/api/state', { cache: 'no-store' }).then(response => response.json()) as { tasks: Record<string, unknown>[] };
      const task = state.tasks.find(item => item.instruction === instruction);
      return task || null;
    }, instruction);
    const status = String(last?.status || 'not-created');
    if (status !== previous) { console.log(`TASK STATUS: ${status}`); previous = status; }
    if (status === 'failed') throw new Error(`Pi cloud task failed: ${String(last?.error || last?.result || '(no error detail)')}`);
    if (status === expectedStatus && typeof last?.result === 'string' && last.result.trim()) return last;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
  }
  throw new Error(`Pi cloud task did not finish and reschedule. Last state: ${JSON.stringify(last)}`);
}

async function startWorkerPortForward() {
  const port = await reservePort();
  workerPortForward = spawn('kubectl', ['-n', tenantNamespace, 'port-forward', '--address', '127.0.0.1', 'svc/desktop', `${port}:8082`], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  workerPortForward.stdout?.on('data', chunk => { output += String(chunk); });
  workerPortForward.stderr?.on('data', chunk => { output += String(chunk); });
  const deadline = Date.now() + 20_000;
  while (!output.includes(`127.0.0.1:${port}`) && Date.now() < deadline) {
    if (workerPortForward.exitCode !== null) throw new Error(`Cloud computer worker port-forward exited early: ${output}`);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  assert(output.includes(`127.0.0.1:${port}`), `Cloud computer worker port-forward did not become ready: ${output}`);
  return `http://127.0.0.1:${port}`;
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(join(outputRoot, 'screenshots'), { recursive: true });
await writeFile(emptyEnvFile, '');
const port = await reservePort();
baseUrl = `http://127.0.0.1:${port}`;

try {
  assert.equal(process.env.DOTS_CLOUD_COMPUTER_DEMO_LIVE, '1');
  assert.equal(process.env.DOTS_CLOUD_COMPUTER_DEMO_ENGINE, 'pi');
  assert(chromePath, 'Chrome was not found; set DOTS_CHROME_BIN.');
  await configureLivePi();
  await startServer(port);
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, recordVideo: { dir: recordingRoot, size: { width: 1440, height: 1000 } } });
  page = await context.newPage();
  pageVideo = page.video();
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('response', async response => {
    const path = new URL(response.url()).pathname;
    if (!path.startsWith('/api/computer')) return;
    const body = await response.json().catch(() => undefined);
    computerApiResponses.push({ path, status: response.status(), body });
  });

  await signIn(page);
  await page.screenshot({ path: join(outputRoot, 'screenshots', '00-signed-in.png') });
  const workspace = await page.evaluate(async name => {
    const response = await fetch('/api/tenants', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    return { status: response.status, body: await response.json() as { id?: string } };
  }, `云电脑主动工作演示 ${randomUUID()}`);
  assert.equal(workspace.status, 201);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('app-shell').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true');
  await page.locator('.composer-bottom select').selectOption('pi');
  const engineState = await page.evaluate(async () => await (await fetch('/api/state')).json()) as { availableEngines: string[]; remoteEngines: string[] };
  assert(engineState.availableEngines.includes('pi') && engineState.remoteEngines.includes('pi'), 'Pi must be shown as an available cloud computer kernel.');
  await page.screenshot({ path: join(outputRoot, 'screenshots', '01-pi-selected.png') });
  await page.getByRole('button', { name: '你的 dot', exact: true }).click();
  const computerChoice = page.getByTestId('computer-choice');
  await computerChoice.getByRole('heading', { name: 'Choose where your dot can work' }).waitFor({ state: 'visible' });
  const localComputerToggle = computerChoice.getByRole('switch', { name: 'Your local computer' });
  if (await localComputerToggle.isChecked()) await localComputerToggle.uncheck();
  await computerChoice.getByRole('button', { name: 'Continue' }).click();
  await page.getByTestId('dot-onboarding').getByRole('heading', { name: 'Hey! I’m your dot' }).waitFor({ state: 'visible' });
  await page.screenshot({ path: join(outputRoot, 'screenshots', '01b-dot-cloud-computer-onboarding.png'), fullPage: true });
  tenantId = (await page.getByTestId('app-shell').getAttribute('data-tenant-id')) || '';
  assert(tenantId && tenantId === workspace.body.id, 'The browser must use the disposable tenant created for this demo.');
  tenantNamespace = desktopResourceIdentity(tenantId).namespace;
  const existingNamespace = spawnSync('kubectl', ['get', 'namespace', tenantNamespace, '-o', 'name'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.notEqual(existingNamespace.status, 0, `Refusing to reuse pre-existing tenant desktop namespace ${tenantNamespace}`);
  assert.match(existingNamespace.stderr, /NotFound/i, `Could not safely verify new namespace ${tenantNamespace}: ${(existingNamespace.stderr || existingNamespace.stdout).slice(-800)}`);
  tenantNamespaceCreated = true;

  await page.getByRole('button', { name: '电脑', exact: true }).click();
  const computerView = page.locator('[aria-label="Dot 的电脑"]');
  await computerView.waitFor({ state: 'visible' });
  const computerStateBeforeOpen = await page.evaluate(async () => {
    const response = await fetch('/api/computer', { cache: 'no-store' });
    return { status: response.status, body: await response.json().catch(() => null) as Record<string, unknown> | null };
  });
  console.log(`COMPUTER STATE: ${JSON.stringify(computerStateBeforeOpen)}`);
  assert.equal(computerStateBeforeOpen.body?.backend, 'linux-desktop', `The visible computer must be the tenant's Debian cloud computer: ${JSON.stringify(computerStateBeforeOpen)}`);
  const openComputer = page.getByRole('button', { name: '打开电脑', exact: true });
  if (await openComputer.count()) await openComputer.click();
  await page.getByTestId('computer-workspace').waitFor({ state: 'visible', timeout: 180_000 });
  await page.locator('img[alt="Linux 云桌面画面"]').waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const frame = document.querySelector<HTMLImageElement>('img[alt="Linux 云桌面画面"]');
    return Boolean(frame?.complete && frame.naturalWidth >= 1000 && frame.naturalHeight >= 700);
  }, { timeout: 90_000 });
  await page.screenshot({ path: join(outputRoot, 'screenshots', '02-cloud-computer-ready.png'), fullPage: true });
  console.log(`STEP cloud computer ready: ${tenantNamespace}`);

  await page.getByRole('button', { name: '新聊天', exact: true }).click();
  await page.getByTestId('chat-home').waitFor({ state: 'visible' });
  await page.getByTestId('task-composer').fill(kickoffInstruction);
  await page.locator('button.send').click();
  await page.locator('.timeline .message.user p').filter({ hasText: kickoffInstruction }).waitFor({ state: 'visible', timeout: 15_000 });
  const kickoffTask = await waitForTask(page, kickoffInstruction, 'done', 120_000);
  assert.match(String(kickoffTask.result), /[\u3400-\u9fff]/, 'The Pi cloud-computer kernel should return a Chinese response.');
  await page.screenshot({ path: join(outputRoot, 'screenshots', '02b-pi-cloud-kernel-ready.png'), fullPage: true });

  await page.locator('.timeline').waitFor({ state: 'visible' });
  await page.getByLabel('定期检查').waitFor({ state: 'visible' });
  await page.getByLabel('定期检查').check();
  await page.getByLabel('重复频率').selectOption('interval');
  await page.locator('input.minutes').fill('60');
  await page.getByTestId('task-composer').fill(taskInstruction);
  await page.screenshot({ path: join(outputRoot, 'screenshots', '03-chinese-scheduled-task.png'), fullPage: true });
  await page.locator('button.send').click();
  await page.locator('.timeline .message.user p').filter({ hasText: fixtureUrl }).waitFor({ state: 'visible', timeout: 15_000 });
  await page.locator('.timeline .pill.working').waitFor({ state: 'visible', timeout: 20_000 });
  await page.screenshot({ path: join(outputRoot, 'screenshots', '04-task-working.png'), fullPage: true });
  console.log('STEP submitted Chinese hourly monitoring task to Pi');

  await page.getByRole('button', { name: '电脑', exact: true }).click();
  await page.getByTestId('computer-workspace').waitFor({ state: 'visible' });
  const finalTask = await waitForTask(page);
  const resultText = String(finalTask.result || '');
  assert.match(resultText, /AI 助手上手分享/);
  assert.match(resultText, /10\s*月\s*14\s*日|2026/);
  assert.match(resultText, /2\s*个|两/);
  assert.match(resultText, /中文|没有报名|未报名|未付款|没有付款/);
  console.log('STEP Pi task completed in Chinese and kept its hourly schedule');

  const appComputer = await page.evaluate(async () => await (await fetch('/api/computer', { cache: 'no-store' })).json()) as { ready: boolean; owner: string; url: string; title: string };
  assert.equal(appComputer.ready, true);
  assert.equal(appComputer.owner, 'agent');
  assert.equal(appComputer.url, fixtureUrl, 'The Dot computer browser must be on the demonstration activity page.');
  assert.equal(appComputer.title, '公开活动机会 · 演示页面');
  const computerPng = Buffer.from(await page.evaluate(async () => Array.from(new Uint8Array(await (await fetch('/api/computer/screenshot', { cache: 'no-store' })).arrayBuffer()))));
  const remoteFrame = PNG.sync.read(computerPng);
  assert.equal(remoteFrame.width, 1440);
  assert.equal(remoteFrame.height, 1080);
  await writeFile(join(outputRoot, 'screenshots', '05-cloud-computer-after-click.png'), computerPng);
  await page.waitForFunction(() => {
    const frame = document.querySelector<HTMLImageElement>('img[alt="Linux 云桌面画面"]');
    return Boolean(frame?.complete && frame.naturalWidth > 1000);
  });
  await page.waitForTimeout(2_000);
  await page.screenshot({ path: join(outputRoot, 'screenshots', '06-computer-browser-in-dots.png'), fullPage: true });

  const workerBaseUrl = await startWorkerPortForward();
  const workerToken = createHmac('sha256', tokenSecret).update(`worker:${tenantId}`).digest('base64url');
  const inspectResponse = await fetch(`${workerBaseUrl}/v1/agent-ui/inspect`, {
    method: 'POST', headers: { authorization: `Bearer ${workerToken}`, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(inspectResponse.status, 200, 'The authenticated test audit should inspect the same remote browser page.');
  uiEvidence = await inspectResponse.json() as { url: string; title: string; text: string; buttons: { name: string }[] };
  assert.equal((uiEvidence as { url: string }).url, fixtureUrl);
  assert.match((uiEvidence as { text: string }).text, /活动详情/);
  assert.match((uiEvidence as { text: string }).text, /报名状态：尚未报名/);
  assert.match((uiEvidence as { text: string }).text, /当前可用名额：2 个/);
  assert.deepEqual(browserErrors, [], `Browser runtime errors: ${browserErrors.join('; ')}`);

  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  const taskTitle = '每小时在你的 Debian 云电脑中检查这个公开活动页';
  const card = page.locator('.task-card').filter({ hasText: taskTitle });
  await card.waitFor({ state: 'visible' });
  await card.getByText(resultText, { exact: true }).waitFor({ state: 'visible' });
  await page.screenshot({ path: join(outputRoot, 'screenshots', '07-chinese-result-in-activity.png'), fullPage: true });
  await page.waitForTimeout(2_000);
  await page.getByRole('button', { name: 'Scheduled', exact: true }).click();
  const scheduledItem = page.locator('.scheduled-item').filter({ hasText: taskTitle });
  await scheduledItem.waitFor({ state: 'visible' });
  await scheduledItem.click();
  const scheduledDetail = page.getByTestId('scheduled-detail');
  await scheduledDetail.getByText('Every 60 minutes', { exact: true }).waitFor({ state: 'visible' });
  await page.screenshot({ path: join(outputRoot, 'screenshots', '08-hourly-follow-up-scheduled.png'), fullPage: true });
  await page.waitForTimeout(2_500);

  runFailed = false;
  console.log(`Cloud computer proactive demo E2E passed: ${baseUrl}`);
} finally {
  if (pageVideo) recordingPath = await pageVideo.path().catch(() => '');
  if (runFailed && page) {
    await page.screenshot({ path: join(outputRoot, 'failure.png'), fullPage: true }).catch(() => undefined);
    taskDiagnostics = await page.evaluate(async () => {
      const response = await fetch('/api/state', { cache: 'no-store' });
      if (!response.ok) return null;
      const state = await response.json() as { tasks: { id: string; title: string; status: string; engine: string; executionMode: string; result: string | null; error: string | null }[] };
      return state.tasks.map(({ id, title, status, engine, executionMode, result, error }) => ({ id, title, status, engine, executionMode, result, error }));
    }).catch(() => null);
  }
  await context?.close().catch(() => undefined);
  context = null;
  await browser?.close().catch(() => undefined);
  browser = null;
  const activeWorkerPortForward = workerPortForward as ChildProcess | null;
  activeWorkerPortForward?.kill('SIGTERM');
  workerPortForward = null;
  await stopServer();
  const secret = liveModelApiKey;
  await writeFile(join(outputRoot, 'server.log'), secret ? serverLogs.join('').replaceAll(secret, '[REDACTED]') : serverLogs.join(''));
  await writeFile(join(outputRoot, 'e2e-debug.json'), JSON.stringify({ mode: 'live-pi-in-debian-13-cloud-computer', result: runFailed ? 'failed' : 'passed', cluster, namespace: tenantNamespace, providerModel: liveModelName, fixtureUrl, uiEvidence, tasks: taskDiagnostics, computerApiResponses, recording: recordingPath ? 'captured' : 'missing' }, null, 2).replace(secret || '\u0000', '[REDACTED]') + '\n');
  if (tenantNamespace && tenantNamespaceCreated) {
    const keepFailedNamespace = runFailed && process.env.DOTS_CLOUD_COMPUTER_DEMO_KEEP_FAILED_NAMESPACE === '1';
    if (keepFailedNamespace) console.log(`Preserved disposable namespace for diagnosis: ${tenantNamespace}`);
    else spawnSync('kubectl', ['delete', 'namespace', tenantNamespace, '--wait=true', '--timeout=120s'], { cwd: projectRoot, stdio: 'ignore' });
  }
  try { new Entry(keychainService, 'shared-model-api-key').deletePassword(); } catch { /* Nothing was stored if preflight failed. */ }
  await rm(tempRoot, { recursive: true, force: true });
}

assert(recordingPath && existsSync(recordingPath), 'Chrome did not produce the cloud computer demo recording');
execFileSync(process.execPath, [join(projectRoot, 'scripts', 'convert-demo-video-to-webp.mjs'), recordingPath, join(outputRoot, 'cloud-computer-proactive-activity.webp')], { cwd: projectRoot, stdio: 'inherit' });
await rm(recordingRoot, { recursive: true, force: true });
await writeFile(join(outputRoot, 'manifest.json'), JSON.stringify({
  scenario: 'Dot runs an hourly check, finds a free place in a public activity listing, opens its details in the Debian cloud computer, and reports the date and availability in Chinese. It stops before registration or payment.',
  reference: [
    'https://learn.chatgpt.com/docs/dots/tasks-and-memory',
    'https://learn.chatgpt.com/docs/dots/computers-and-apps',
    'https://learn.chatgpt.com/docs/dots/controls',
  ],
  productEvidence: 'Official docs describe recurring tasks and a dedicated cloud computer/browser. Proactive research itself is read-only; this recording uses a user-assigned recurring task with an explicit, limited information-view action.',
  fixtureDisclosure: 'The activity page and all availability data are synthetic E2E fixtures served only inside the test cloud browser. No real registration, account change, or payment occurs.',
  recording: 'cloud-computer-proactive-activity.webp',
  sourceRecording: 'Chrome E2E recording, converted to animated WebP',
  viewport: { width: 1440, height: 1000 },
  screenshots: [
    'screenshots/00-signed-in.png', 'screenshots/01-pi-selected.png', 'screenshots/01b-dot-cloud-computer-onboarding.png', 'screenshots/02-cloud-computer-ready.png',
    'screenshots/02b-pi-cloud-kernel-ready.png',
    'screenshots/03-chinese-scheduled-task.png', 'screenshots/04-task-working.png', 'screenshots/05-cloud-computer-after-click.png',
    'screenshots/06-computer-browser-in-dots.png', 'screenshots/07-chinese-result-in-activity.png', 'screenshots/08-hourly-follow-up-scheduled.png',
  ],
  kernel: 'Pi runs inside the tenant-isolated Debian 13 cloud computer; the Pi session is stored in that task workspace.',
  model: liveModelName,
  providerMode: 'Live shared Model API credentials reused across tenants',
  browserAction: 'Pi inspected the visible page and used xdotool to click the exact non-submit “查看活动详情” button through the cloud computer desktop.',
  resultLanguage: 'Chinese input and Chinese output',
  result: 'passed',
}, null, 2) + '\n');
assert(existsSync(join(outputRoot, 'cloud-computer-proactive-activity.webp')));
console.log(`Animated WebP: ${join(outputRoot, 'cloud-computer-proactive-activity.webp')}`);
