import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Entry } from '@napi-rs/keyring';
import { chromium, type Browser, type BrowserContext, type Page, type Video } from 'playwright-core';
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { desktopResourceIdentity } from '../../src/server/linux-desktop-computer.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceDraft = '请先起草一份新品发布公告，发布时间写 10 月 21 日。先保持草稿状态，等我审批后再发送。';
const sourceDecision = '发布团队今天确认发布时间改为 10 月 22 日。请用中文总结这项决定。';
const finding = '我发现一处需要你决定的冲突：最新决定将发布时间改为 10 月 22 日，但待审批的公告草稿仍写着 10 月 21 日。要我更新草稿吗？我没有修改或发送。';
const cloudComputerInstruction = '请在你的云电脑里打开 https://example.com，检查页面显示什么，再找到页面中的信息链接（例如 Learn more 或 More information）。如果链接在屏幕下方，先让它出现在可见区域，再通过云电脑实际点击。完成后用中文告诉我打开了什么，以及点击后出现了什么。只浏览公开网页，不登录、不输入或提交内容、不下载、不修改文件。';
const tempRoot = await mkdtemp(join(tmpdir(), 'coke-dots-proactive-demo-'));
const livePi = process.env.DOTS_PROACTIVE_DEMO_LIVE_PI === '1';
const cloudComputerUiDemo = process.env.DOTS_CLOUD_COMPUTER_UI_DEMO === '1';
const cluster = process.env.DOTS_K3D_CLUSTER || 'tp1121-sandbox-dev';
const tokenSecret = randomBytes(32).toString('base64url');
const keychainService = `com.cokepoppy.coke-dots.proactive-demo-${randomUUID()}`;
const outputName = cloudComputerUiDemo ? 'cloud-computer-ui-demo' : livePi ? 'proactive-cross-task-review-cloud-pi' : 'proactive-cross-task-review';
const outputRoot = join(projectRoot, 'artifacts', 'demos', outputName);
const videoOutput = join(outputRoot, `${outputName}.webp`);
const dataDirectory = join(tempRoot, 'data');
const emptyEnvFile = join(tempRoot, 'empty.env');
const chromePath = [process.env.DOTS_CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find(path => path && existsSync(path));
const serverLogs: string[] = [];
const modelRequests: { system: string; user: string; tools: unknown[] }[] = [];
const mockErrors: string[] = [];
let server: ChildProcess | null = null;
let modelServer: Server | null = null;
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let pageVideo: Video | null = null;
let baseUrl = '';
let tenantNamespace = '';
let tenantNamespaceIdentityHash = '';
let liveModelConfig: { apiKey: string; baseUrl: string; model: string } | null = null;
let liveModelApiKey = '';
let liveModelName = '';
let liveWaitIntervals: { startMs: number; endMs: number }[] = [];
let recordingEpoch = 0;

async function reservePort() {
  const listener = createNetServer();
  await new Promise<void>((resolvePromise, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolvePromise));
  const address = listener.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolvePromise, reject) => listener.close(error => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function startModel() {
  modelServer = createHttpServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      try {
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/v1/chat/completions');
        const payload = JSON.parse(raw) as { messages?: { role: string; content?: unknown }[]; tools?: unknown[] };
        const system = String(payload.messages?.find(message => message.role === 'system')?.content || '');
        const user = String(payload.messages?.find(message => message.role === 'user')?.content || '');
        modelRequests.push({ system, user, tools: payload.tools || [] });
        let decision: Record<string, unknown>;
        const isProactiveResearch = system.includes('Proactive research constraints') || user.includes('Proactive research constraints');
        if (isProactiveResearch) {
          assert.match(user, /10 月 21 日/);
          assert.match(user, /10 月 22 日/);
          assert.match(user, /Do not browse, control a computer, read or modify files/);
          assert.doesNotMatch(JSON.stringify(payload.tools || []), /open_public_page|computer|write|send/i);
          decision = { status: 'done', message: finding, proactiveFinding: true };
        } else if (user.includes(sourceDraft)) {
          decision = { status: 'waiting', message: '公告草稿已准备好，目前仍待审批；我没有发送或发布。' };
        } else if (user.includes(sourceDecision)) {
          decision = { status: 'done', message: '发布团队已确认发布时间改为 10 月 22 日。' };
        } else {
          throw new Error(`Unexpected model request: ${user.slice(-500)}`);
        }
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(decision) } }] }));
      } catch (error) {
        mockErrors.push(error instanceof Error ? error.message : String(error));
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Proactive demo model fixture failed' }));
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) => modelServer!.once('error', reject).listen(0, '127.0.0.1', resolvePromise));
  const address = modelServer.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/v1`;
}

function command(args: string[]) {
  const result = spawnSync(args[0], args.slice(1), { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`${args[0]} ${args[1]} failed (${result.status ?? 'signal'}): ${(result.stderr || result.stdout).slice(-1200)}`);
  return result.stdout.trim();
}

function loadSharedModelConfig() {
  const candidates = [
    process.env.DOTS_PROACTIVE_DEMO_SOURCE_DATA,
    process.env.DOTS_DATA_DIR,
    join(homedir(), 'Library', 'Application Support', 'Coke Dots Demo', 'data'),
    join(homedir(), 'Library', 'Application Support', 'Electron', 'data'),
    resolve(projectRoot, 'data'),
  ].filter((value): value is string => Boolean(value));
  let modelBaseUrl = '';
  let model = '';
  for (const directory of [...new Set(candidates)]) {
    const databasePath = join(directory, 'dots.db');
    if (!existsSync(databasePath)) continue;
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(databasePath, { readOnly: true });
      const appSettings = database.prepare("SELECT key, value FROM app_settings WHERE key IN ('modelBaseUrl', 'modelName')").all() as { key: string; value: string }[];
      let tenantSettings: { key: string; value: string }[] = [];
      try { tenantSettings = database.prepare("SELECT key, value FROM tenant_settings WHERE tenant_id = 'legacy' AND key IN ('sharedModelBaseUrl', 'sharedModelName', 'modelBaseUrl', 'modelName')").all() as { key: string; value: string }[]; } catch { /* Old stores may not have this table. */ }
      const settings = new Map([...appSettings, ...tenantSettings].map(row => [row.key, row.value]));
      modelBaseUrl = settings.get('sharedModelBaseUrl') || settings.get('modelBaseUrl') || '';
      model = settings.get('sharedModelName') || settings.get('modelName') || '';
      if (modelBaseUrl && model) break;
    } finally { database?.close(); }
  }
  const sourceKeychainService = process.env.DOTS_KEYCHAIN_SERVICE?.trim() || 'com.cokepoppy.coke-dots';
  const apiKey = new Entry(sourceKeychainService, 'shared-model-api-key').getPassword() || '';
  assert(modelBaseUrl && model && apiKey, 'Live Pi E2E needs the shared model endpoint, name, and Keychain key.');
  assert.equal(new URL(modelBaseUrl).protocol, 'https:', 'Live Pi E2E requires an HTTPS model endpoint.');
  liveModelConfig = { apiKey, baseUrl: modelBaseUrl.replace(/\/$/, ''), model };
  liveModelApiKey = apiKey;
  liveModelName = model;
  return liveModelConfig;
}

async function configureLivePi() {
  assert.equal(command(['kubectl', 'config', 'current-context']), `k3d-${cluster}`, 'Live Pi E2E must use the selected Coke sandbox cluster.');
  command(['kubectl', 'get', 'nodes']);
  const image = process.env.DOTS_LINUX_DESKTOP_IMAGE?.trim();
  assert(image, 'Set DOTS_LINUX_DESKTOP_IMAGE to the newly built, pinned Linux desktop image.');
  command(['docker', 'image', 'inspect', image]);
  const config = loadSharedModelConfig();
  console.log(`Live Pi preflight passed: ${cluster}; shared model is configured (${config.model}).`);
}

function captureServerOutput(child: ChildProcess) {
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => {
    serverLogs.push(String(chunk));
    if (serverLogs.length > 200) serverLogs.splice(0, serverLogs.length - 200);
  });
}

async function startServer(port: number, modelBaseUrl: string) {
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
      DOTS_MODEL_BASE_URL: livePi ? liveModelConfig!.baseUrl : modelBaseUrl,
      DOTS_MODEL_API_KEY: livePi ? liveModelConfig!.apiKey : 'e2e-proactive-demo-only',
      DOTS_MODEL: livePi ? liveModelConfig!.model : 'proactive-demo-model',
      DOTS_PI_ENABLED: '0',
      DOTS_COMPUTER_BACKEND: livePi ? 'linux-desktop' : '',
      DOTS_LINUX_DESKTOP_TOKEN_SECRET: livePi ? tokenSecret : '',
      DOTS_LINUX_DESKTOP_IMAGE: process.env.DOTS_LINUX_DESKTOP_IMAGE || '',
      DOTS_LINUX_DESKTOP_CONTROL_NAMESPACE: livePi ? cluster : '',
      DOTS_LINUX_DESKTOP_CHROME_NO_SANDBOX: livePi ? '1' : '',
      DOTS_DESKTOP_AGENT_ADAPTERS: livePi ? 'pi' : '',
      DOTS_AGENT_KERNELS_JSON: livePi ? JSON.stringify({ pi: { command: 'node', args: ['/opt/coke-dots/pi-adapter.mjs'] } }) : '',
      DOTS_PI_ADAPTER_TEST_DIAGNOSTICS: livePi ? '1' : '',
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
  if (server.exitCode === null) {
    server.kill('SIGKILL');
    await exited;
  }
}

async function signIn(pageToSignIn: Page) {
  await pageToSignIn.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await pageToSignIn.locator('#e2e-email').fill('demo@example.test');
  const navigation = pageToSignIn.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10_000 });
  await pageToSignIn.getByTestId('e2e-sign-in').click();
  await navigation;
  await pageToSignIn.getByTestId('app-shell').waitFor({ state: 'visible' });
  await pageToSignIn.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true');
  assert.equal(await pageToSignIn.locator('.composer-bottom select').inputValue(), 'model');
}

async function submitTask(pageToSubmit: Page, instruction: string) {
  await pageToSubmit.getByTestId('task-composer').fill(instruction);
  await pageToSubmit.locator('button.send').click();
  await pageToSubmit.locator('.timeline .message.user p').filter({ hasText: instruction }).waitFor({ state: 'visible', timeout: 10_000 });
}

async function waitForTask(pageToWait: Page, predicate: string, timeoutMs = livePi ? 180_000 : 30_000) {
  const check = new Function('task', `return (${predicate})`) as (task: Record<string, unknown>) => boolean;
  const activeSince = new Map<string, number>();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await pageToWait.evaluate(async () => await fetch('/api/state', { cache: 'no-store' }).then(response => response.json())) as { tasks: Record<string, unknown>[] };
    const scenarioTasks = state.tasks.filter(task => task.instruction === sourceDraft || task.instruction === sourceDecision || task.instruction === cloudComputerInstruction || task.executionMode === 'proactive-research');
    for (const task of scenarioTasks) {
      const id = String(task.id || '');
      if (!id) continue;
      if (task.status === 'working' && !activeSince.has(id)) activeSince.set(id, Date.now());
      if (task.status !== 'working' && activeSince.has(id)) {
        const start = activeSince.get(id)!;
        liveWaitIntervals.push({ startMs: Math.max(0, start - recordingEpoch), endMs: Math.max(0, Date.now() - recordingEpoch) });
        activeSince.delete(id);
      }
    }
    if (scenarioTasks.some(check)) return;
    await pageToWait.waitForTimeout(300);
  }
  throw new Error(`Task predicate did not match within ${timeoutMs} ms: ${predicate}`);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(join(outputRoot, 'screenshots'), { recursive: true });
await writeFile(emptyEnvFile, '');
let modelBaseUrl = '';
const port = await reservePort();
baseUrl = `http://127.0.0.1:${port}`;

try {
  assert(chromePath, 'Chrome was not found; set DOTS_CHROME_BIN.');
  assert(!cloudComputerUiDemo || livePi, 'The visible cloud-computer demo requires the real Pi kernel inside a tenant Debian computer.');
  if (livePi) await configureLivePi();
  else modelBaseUrl = await startModel();
  await startServer(port, modelBaseUrl);
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, recordVideo: { dir: outputRoot, size: { width: 1440, height: 1000 } } });
  recordingEpoch = Date.now();
  page = await context.newPage();
  pageVideo = page.video();
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));

  await signIn(page);
  console.log('步骤：已登录演示工作区');
  if (livePi) {
    const workspace = await page.evaluate(async name => {
      const response = await fetch('/api/tenants', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
      return { status: response.status, body: await response.json() as { id?: string } };
    }, `Pi 主动工作演示 ${randomUUID()}`);
    assert.equal(workspace.status, 201, 'Create a disposable tenant for the real Pi cloud computer run.');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('app-shell').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true');
    await page.getByRole('button', { name: '新聊天', exact: true }).click();
    await page.getByTestId('chat-home').waitFor({ state: 'visible' });
    const tenantId = await page.getByTestId('app-shell').getAttribute('data-tenant-id');
    assert(tenantId && workspace.body.id === tenantId, 'The E2E browser must use the disposable tenant it created.');
    const identity = desktopResourceIdentity(tenantId);
    tenantNamespace = identity.namespace;
    tenantNamespaceIdentityHash = identity.tenantHash;
    const existing = spawnSync('kubectl', ['get', 'namespace', tenantNamespace, '-o', 'name'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.notEqual(existing.status, 0, `Refusing to reuse pre-existing tenant namespace ${tenantNamespace}`);
    assert.match(existing.stderr, /NotFound/i, `Could not prove the tenant namespace is unused: ${(existing.stderr || existing.stdout).slice(-800)}`);
    await page.getByRole('button', { name: '你的 dot', exact: true }).click();
    await page.getByTestId('computer-choice').waitFor({ state: 'visible' });
    await page.getByRole('switch', { name: 'Your local computer' }).uncheck();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByTestId('dot-onboarding').waitFor({ state: 'visible' });
    await page.getByTestId('engine-select').waitFor({ state: 'visible' });
    await page.locator('.composer-bottom select').selectOption('pi');
    const engines = await page.evaluate(async () => await (await fetch('/api/state')).json()) as { availableEngines: string[] };
    assert(engines.availableEngines.includes('pi'), 'Pi must be selected as the tenant cloud-computer kernel.');
    console.log(`步骤：选择 Pi 云电脑内核，隔离租户 ${tenantNamespace}`);
  }
  if (cloudComputerUiDemo) {
    await page.screenshot({ path: join(outputRoot, 'screenshots', '00-dot-ready.png') });
    await submitTask(page, cloudComputerInstruction);
    console.log('步骤：用中文交代 Pi 在云电脑中查看公开网页并点击信息链接');
    await page.getByRole('button', { name: '电脑', exact: true }).click();
    const openComputer = page.getByRole('button', { name: '打开电脑', exact: true });
    if (await openComputer.count()) await openComputer.click();
    await page.getByTestId('computer-workspace').waitFor({ state: 'visible', timeout: 120_000 });
    await page.waitForFunction(async () => {
      const response = await fetch('/api/computer', { cache: 'no-store' });
      if (!response.ok) return false;
      const state = await response.json() as { ready?: boolean; backend?: string };
      return state.ready === true && state.backend === 'linux-desktop';
    }, undefined, { timeout: 120_000 });
    await page.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>('.computer-stage img');
      return Boolean(image?.complete && image.naturalWidth > 100);
    }, { timeout: 60_000 });
    await page.screenshot({ path: join(outputRoot, 'screenshots', '01-cloud-computer-running.png') });
    const startingComputerImage = await page.locator('.computer-stage img').getAttribute('src');
    await waitForTask(page, `task.instruction === ${JSON.stringify(cloudComputerInstruction)} && ['done','failed','waiting'].includes(task.status)`, 180_000);
    const liveState = await page.evaluate(async () => {
      const [computerResponse, stateResponse] = await Promise.all([fetch('/api/computer', { cache: 'no-store' }), fetch('/api/state', { cache: 'no-store' })]);
      return { computer: await computerResponse.json(), state: await stateResponse.json() };
    }) as {
      computer: { ready?: boolean; backend?: string; owner?: string; url?: string; title?: string };
      state: { tasks: { id: string; instruction: string; status: string; engine: string; result: string | null; error: string | null }[] };
    };
    const demoTask = liveState.state.tasks.find(task => task.instruction === cloudComputerInstruction);
    assert(demoTask, 'The browser-recorded cloud-computer task should persist in Activity.');
    assert.equal(demoTask.engine, 'pi');
    assert.equal(liveState.computer.backend, 'linux-desktop');
    assert.equal(liveState.computer.owner, 'agent', 'The cloud desktop must remain agent controlled during the demonstration.');
    await page.waitForFunction(initialSrc => {
      const image = document.querySelector<HTMLImageElement>('.computer-stage img');
      return Boolean(image?.complete && image.naturalWidth > 100 && image.getAttribute('src') !== initialSrc);
    }, startingComputerImage, { timeout: 20_000 }).catch(() => undefined);
    await page.screenshot({ path: join(outputRoot, 'screenshots', '02-cloud-browser-click-result.png') });
    const desktopScreenshot = Buffer.from(await page.evaluate(async () => Array.from(new Uint8Array(await (await fetch('/api/computer/screenshot', { cache: 'no-store' })).arrayBuffer()))));
    await writeFile(join(outputRoot, 'screenshots', '02-cloud-desktop-after-click.png'), desktopScreenshot);

    const namespace = JSON.parse(command(['kubectl', 'get', 'namespace', tenantNamespace, '-o', 'json'])) as { metadata?: { labels?: Record<string, string> } };
    assert.equal(namespace.metadata?.labels?.['coke-dots.io/managed-by'], 'coke-dots');
    assert.equal(namespace.metadata?.labels?.['coke-dots.io/tenant-hash'], tenantNamespaceIdentityHash);
    const pod = command(['kubectl', '-n', tenantNamespace, 'get', 'pod', '-l', 'app=desktop', '-o', 'jsonpath={.items[0].metadata.name}']);
    assert(pod, 'The browser interaction must have run inside the tenant Debian cloud computer.');
    const osRelease = command(['kubectl', '-n', tenantNamespace, 'exec', pod, '--', 'cat', '/etc/os-release']);
    assert.match(osRelease, /^ID=debian$/m);
    assert.match(osRelease, /^VERSION_ID="13"$/m);
    const sessionFiles = command(['kubectl', '-n', tenantNamespace, 'exec', pod, '--', 'find', `/workspace/tasks/${demoTask.id}/.coke-dots/pi-sessions`, '-type', 'f', '-printf', '%P\\n']);
    assert(sessionFiles, 'Pi session must persist inside the task directory on the tenant Debian computer.');
    const taskRuntimeHash = createHash('sha256').update(demoTask.id).digest('hex');
    const runtimeRecord = JSON.parse(command(['kubectl', '-n', tenantNamespace, 'exec', pod, '--', 'cat', `/workspace/.coke-dots-agent-runtime-state/${taskRuntimeHash}.json`])) as { result?: { computerUiAudit?: { inspections?: number; navigations?: number; informationClicks?: number; clickAttempts?: number; lastClick?: { name?: string; x?: number; y?: number; destination?: string } | null; lastClickError?: string | null } } };
    assert(runtimeRecord.result?.computerUiAudit, 'The runtime must persist its per-task cloud-computer interaction audit.');
    await writeFile(join(outputRoot, 'interaction-proof.json'), JSON.stringify({ taskStatus: demoTask.status, taskResult: demoTask.result, computer: liveState.computer, audit: runtimeRecord.result.computerUiAudit }, null, 2) + '\n');
    assert.equal(demoTask.status, 'done', `Pi cloud-computer task did not complete: ${demoTask.error || demoTask.result || ''}; audit=${JSON.stringify(runtimeRecord.result.computerUiAudit)}`);
    assert.match(demoTask.result || '', /[㐀-鿿]/, 'The Pi result must be in Chinese.');
    assert.match(demoTask.result || '', /example\.com|Example Domain|示例域名/i);
    assert((runtimeRecord.result.computerUiAudit.inspections || 0) >= 1, 'Pi must inspect the page before the action.');
    assert.equal(runtimeRecord.result.computerUiAudit.navigations, 1, 'The test must navigate once to the requested public page.');
    assert.equal(runtimeRecord.result.computerUiAudit.clickAttempts, 1, 'The demo must reach the information link with one accurate desktop click.');
    assert.equal(runtimeRecord.result.computerUiAudit.informationClicks, 1, 'The demonstration only passes after the visible information link was actually clicked by the cloud computer.');
    assert.equal(runtimeRecord.result.computerUiAudit.lastClickError, null, 'The successful computer action must not hide an earlier misclick.');
    const lastClick = runtimeRecord.result.computerUiAudit.lastClick;
    assert(lastClick && typeof lastClick.name === 'string' && typeof lastClick.destination === 'string' && typeof lastClick.x === 'number' && typeof lastClick.y === 'number', 'The runtime must record the clicked link and position.');
    assert(lastClick.x >= 0 && lastClick.x < 1440 && lastClick.y >= 0 && lastClick.y < 900, 'The audit must record a real click position inside the Debian desktop.');
    assert.match(lastClick.name, /learn more|more information/i, 'The click audit must identify the page information link.');
    assert.match(lastClick.destination, /^https:\/\/(?:www\.)?iana\.org\//, 'The click must follow the inspected public information link.');
    assert.match(liveState.computer.url || '', /^https:\/\/(?:www\.)?iana\.org\//, `The click should open the public information page; actual browser URL: ${liveState.computer.url}`);
    assert.doesNotMatch(demoTask.result || '', /无法点击|未能点击|点击失败|could not click|unable to click/i, 'The reply must not describe a failed click as completed work.');
    await writeFile(join(outputRoot, 'computer-ui-audit.json'), JSON.stringify(runtimeRecord.result.computerUiAudit, null, 2) + '\n');
    console.log(`步骤：Pi 已在 Debian 云电脑中点击 ${lastClick.name}（${lastClick.x}, ${lastClick.y}），浏览器停留在 ${liveState.computer.url}`);
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    const taskCard = page.getByTestId(`task-card-${demoTask.id}`);
    await taskCard.waitFor({ state: 'visible' });
    await taskCard.getByText(demoTask.result || '', { exact: true }).waitFor({ state: 'visible' });
    await page.screenshot({ path: join(outputRoot, 'screenshots', '03-computer-task-in-activity.png') });
    await page.waitForTimeout(2_500);
    await taskCard.getByRole('button', { name: /查看详情/ }).click();
    await page.locator('.timeline .message.dot p').filter({ hasText: demoTask.result || '' }).waitFor({ state: 'visible' });
    await page.screenshot({ path: join(outputRoot, 'screenshots', '04-computer-task-result-detail.png') });
    await page.waitForTimeout(2_000);
    assert.deepEqual(browserErrors, [], `Browser runtime errors: ${browserErrors.join('; ')}`);
    console.log(`Pi 云电脑 UI 演示端到端测试通过：${tenantNamespace}`);
  } else {
  await new Promise(resolvePromise => setTimeout(resolvePromise, 900));
  await page.screenshot({ path: join(outputRoot, 'screenshots', '00-dot-ready.png') });

  await submitTask(page, sourceDraft);
  await waitForTask(page, `task.instruction === ${JSON.stringify(sourceDraft)} && ['waiting','failed','done'].includes(task.status)`);
  const firstTaskState = await page.evaluate(async instruction => {
    const state = await fetch('/api/state').then(response => response.json()) as { tasks: { instruction: string; status: string; error: string | null }[] };
    return state.tasks.find(task => task.instruction === instruction);
  }, sourceDraft);
  assert.equal(firstTaskState?.status, 'waiting', `The announcement task must pause for approval: ${firstTaskState?.error || ''}`);
  if (!livePi) await page.locator('.timeline .message.dot p').filter({ hasText: '公告草稿已准备好，目前仍待审批' }).waitFor({ state: 'visible' });
  else assert.match(await page.locator('.timeline .message.dot p').last().innerText(), /[㐀-鿿]/, 'Pi must reply in Chinese.');
  await page.screenshot({ path: join(outputRoot, 'screenshots', '01-launch-draft-waiting.png') });
  console.log('步骤：公告草稿已提交，正在等待审批');
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1_800));

  await page.getByRole('button', { name: '新聊天', exact: true }).click();
  console.log('步骤：打开新对话');
  await submitTask(page, sourceDecision);
  console.log('步骤：提交新的发布时间决定');
  await waitForTask(page, `task.instruction === ${JSON.stringify(sourceDecision)} && ['done','failed'].includes(task.status)`);
  if (!livePi) await page.locator('.timeline .message.dot p').filter({ hasText: '发布团队已确认发布时间改为 10 月 22 日。' }).waitFor({ state: 'visible' });
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1_800));

  await waitForTask(page, `task.executionMode === 'proactive-research' && ['done','failed'].includes(task.status)` , livePi ? 240_000 : 30_000);
  console.log('步骤：Dot 主动发现了日期冲突');
  const state = await page.evaluate(async () => await (await fetch('/api/state')).json()) as {
    tasks: { id: string; instruction: string; status: string; engine: string; executionMode: string; result: string | null; error: string | null }[];
  };
  const draftTask = state.tasks.find(task => task.instruction === sourceDraft);
  const decisionTask = state.tasks.find(task => task.instruction === sourceDecision);
  const reviewTask = state.tasks.find(task => task.executionMode === 'proactive-research');
  assert.equal(draftTask?.status, 'waiting', 'The original draft must remain open for approval');
  assert.equal(decisionTask?.status, 'done', `The new release decision must complete: ${decisionTask?.error || ''}`);
  assert(reviewTask, 'The completed work should trigger an autonomous context review');
  assert.equal(reviewTask.status, 'done', `The proactive review failed: ${reviewTask.error || reviewTask.result || ''}`);
  assert.match(reviewTask.result || '', /10 月 22 日.*10 月 21 日|10 月 21 日.*10 月 22 日/);
  const displayedFinding = livePi ? reviewTask.result || '' : finding;
  if (livePi) {
    assert.equal(draftTask.engine, 'pi');
    assert.equal(decisionTask.engine, 'pi');
    assert.equal(reviewTask.engine, 'pi');
    assert.match(displayedFinding, /[㐀-鿿]/, 'Pi proactive review must report the finding in Chinese.');
    assert.doesNotMatch(displayedFinding, /星期[一二三四五六日天]/, 'Pi must not infer a weekday when the source only gives dates.');
    assert.match(displayedFinding, /用户决定|需要你|待你审批|授权|另行确认/, 'The proactive result must explain the approval decision needed.');
    assert.match(displayedFinding, /未.*修改|没有.*修改/);
    assert.match(displayedFinding, /未.*发送|没有.*发送/);
    const namespace = JSON.parse(command(['kubectl', 'get', 'namespace', tenantNamespace, '-o', 'json'])) as { metadata?: { labels?: Record<string, string> } };
    assert.equal(namespace.metadata?.labels?.['coke-dots.io/managed-by'], 'coke-dots');
    assert.equal(namespace.metadata?.labels?.['coke-dots.io/tenant-hash'], tenantNamespaceIdentityHash);
    const pod = command(['kubectl', '-n', tenantNamespace, 'get', 'pod', '-l', 'app=desktop', '-o', 'jsonpath={.items[0].metadata.name}']);
    assert(pod, 'The Pi task must have provisioned its isolated Debian cloud computer.');
    const osRelease = command(['kubectl', '-n', tenantNamespace, 'exec', pod, '--', 'cat', '/etc/os-release']);
    assert.match(osRelease, /^ID=debian$/m);
    assert.match(osRelease, /^VERSION_ID="13"$/m);
    assert.equal(command(['kubectl', '-n', tenantNamespace, 'exec', pod, '--', 'sh', '-lc', "cd /opt/coke-dots && node --input-type=module -e \"await import('@mariozechner/pi-coding-agent'); console.log('pi-sdk-ok')\""]), 'pi-sdk-ok');
    const sessionFiles = command(['kubectl', '-n', tenantNamespace, 'exec', pod, '--', 'find', `/workspace/reviews/${reviewTask.id}/.coke-dots/pi-sessions`, '-type', 'f', '-printf', '%P\\n']);
    assert(sessionFiles, 'The Pi proactive-review session must persist inside the tenant Debian computer.');
    console.log(`步骤：验证 Pi 在 Debian 13 云电脑内完成了主动审查并保存会话（${tenantNamespace}）`);
  }
  assert.equal(await page.evaluate(async () => await fetch('/api/pages').then(response => response.json()).then((pages: unknown[]) => pages.length)), 0, 'The proactive review must not write a Scratchpad page');
  assert.equal(await page.evaluate(async () => await fetch('/api/memories').then(response => response.json()).then((notes: unknown[]) => notes.length)), 0, 'The proactive review must not write personal Dot memory');
  if (!livePi) {
    assert.equal(modelRequests.filter(request => request.user.includes('Proactive research constraints')).length, 1);
    assert.equal(modelRequests.length, 3, `Expected draft, decision and autonomous review calls; received ${modelRequests.length}`);
    assert.match(modelRequests[2].user, /10 月 21 日/);
    assert.match(modelRequests[2].user, /10 月 22 日/);
  }

  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  const proactiveCard = page.getByTestId(`task-card-${reviewTask.id}`);
  await proactiveCard.waitFor({ state: 'visible' });
  await proactiveCard.getByText('Dot 主动研究 · 只读', { exact: true }).waitFor({ state: 'visible' });
  await proactiveCard.getByText(displayedFinding, { exact: true }).waitFor({ state: 'visible' });
  const activityFinding = page.getByTestId('activity-feed').getByTestId('activity-entry').filter({ hasText: displayedFinding });
  await activityFinding.waitFor({ state: 'visible' });
  await page.screenshot({ path: join(outputRoot, 'screenshots', '02-proactive-finding-in-activity.png') });
  await new Promise(resolvePromise => setTimeout(resolvePromise, 2_500));

  await proactiveCard.getByRole('button', { name: /查看详情/ }).click();
  await page.locator('.timeline .message.dot p').filter({ hasText: displayedFinding }).waitFor({ state: 'visible' });
  await page.screenshot({ path: join(outputRoot, 'screenshots', '03-proactive-finding-detail.png') });
  await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000));
  assert.deepEqual(browserErrors, [], `Browser runtime errors: ${browserErrors.join('; ')}`);
  assert.deepEqual(mockErrors, [], `Model fixture errors: ${mockErrors.join('; ')}`);
  if (!livePi) {
    assert.equal(modelRequests.length, 3, `Expected draft, decision and autonomous review calls; received ${modelRequests.length}`);
    assert.match(modelRequests[2].user, /10 月 21 日/);
    assert.match(modelRequests[2].user, /10 月 22 日/);
  }

  console.log(`${livePi ? 'Pi 云电脑' : '主动工作'}演示端到端测试通过：${baseUrl}`);
  }
} finally {
  await context?.close().catch(() => undefined);
  context = null;
  await browser?.close().catch(() => undefined);
  browser = null;
  await stopServer();
  if (modelServer) await new Promise<void>(resolvePromise => modelServer!.close(() => resolvePromise()));
  await writeFile(join(outputRoot, 'server.log'), liveModelApiKey ? serverLogs.join('').replaceAll(liveModelApiKey, '[REDACTED]') : serverLogs.join(''));
  await writeFile(join(outputRoot, 'e2e-debug.json'), JSON.stringify({ mode: livePi ? 'live-pi-in-debian-k3d' : 'deterministic-local-model-fixture', mockErrors, modelCalls: livePi ? undefined : modelRequests.length, model: livePi ? liveModelName : 'local-fixture', tenantNamespace: livePi ? tenantNamespace : undefined, proactiveReviewSeen: livePi ? undefined : modelRequests.some(request => request.user.includes('Proactive research constraints')) }, null, 2) + '\n');
  if (livePi && tenantNamespace && tenantNamespaceIdentityHash) {
    try {
      const current = JSON.parse(command(['kubectl', 'get', 'namespace', tenantNamespace, '-o', 'json'])) as { metadata?: { labels?: Record<string, string> } };
      if (current.metadata?.labels?.['coke-dots.io/managed-by'] === 'coke-dots' && current.metadata.labels['coke-dots.io/tenant-hash'] === tenantNamespaceIdentityHash) {
        spawnSync('kubectl', ['delete', 'namespace', tenantNamespace, '--wait=true', '--timeout=120s'], { cwd: projectRoot, stdio: 'ignore' });
      } else console.error(`Preserved ${tenantNamespace}: namespace ownership labels no longer match this test.`);
    } catch { /* Namespace creation may not have completed. */ }
  }
  await rm(tempRoot, { recursive: true, force: true });
}

const recording = pageVideo ? await pageVideo.path().catch(() => '') : '';
assert(recording && existsSync(recording), 'Chrome did not produce the demo WebM recording');
const converter = join(projectRoot, 'scripts', 'convert-demo-video-to-webp.mjs');
const waitsPath = join(outputRoot, 'video-waits.json');
await writeFile(waitsPath, JSON.stringify(liveWaitIntervals, null, 2) + '\n');
execFileSync(process.execPath, [converter, recording, videoOutput, ...(livePi ? [waitsPath] : [])], { cwd: projectRoot, stdio: 'inherit' });
const playbackMetadata = await sharp(videoOutput, { animated: true }).metadata();
const playbackDuration = (playbackMetadata.delay || []).reduce((total, delay) => total + delay, 0) / 1000;
assert((playbackMetadata.pages || 0) >= 30 && Number.isFinite(playbackDuration) && playbackDuration >= 5, `WebP duration is invalid: ${JSON.stringify({ pages: playbackMetadata.pages, playbackDuration })}`);
const webpPlaybackBrowser = await chromium.launch({ executablePath: chromePath!, headless: true });
let webpPlayback: { samples: number; uniqueFrames: number };
try {
  const playbackPage = await webpPlaybackBrowser.newPage({ viewport: { width: 1200, height: 860 } });
  const webpData = await readFile(videoOutput);
  await playbackPage.setContent(`<img id="demo" style="max-width:100%;max-height:100%;object-fit:contain" src="data:image/webp;base64,${webpData.toString('base64')}">`);
  await playbackPage.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>('#demo');
    return Boolean(image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
  });
  const hashes: string[] = [];
  const samples = Math.min(40, Math.max(10, Math.ceil(playbackDuration)));
  const playbackStartedAt = Date.now();
  for (let sample = 0; sample < samples; sample++) {
    const targetMs = playbackDuration * 1000 * sample / (samples - 1);
    const remainingMs = targetMs - (Date.now() - playbackStartedAt);
    if (remainingMs > 0) await playbackPage.waitForTimeout(remainingMs);
    hashes.push(createHash('sha256').update(await playbackPage.locator('#demo').screenshot()).digest('hex'));
  }
  webpPlayback = { samples: hashes.length, uniqueFrames: new Set(hashes).size };
  assert(webpPlayback.uniqueFrames >= Math.min(7, samples), `Chrome playback did not show a complete changing animation: ${JSON.stringify(webpPlayback)}`);
  console.log(`Chrome 已验证 WebP 动画：${webpPlayback.samples} 个时间点，${webpPlayback.uniqueFrames} 个不同画面`);
} finally {
  await webpPlaybackBrowser.close();
}
await writeFile(join(outputRoot, 'manifest.json'), JSON.stringify({
  scenario: cloudComputerUiDemo ? cloudComputerInstruction : '待审批的公告草稿写着 10 月 21 日；新决定将发布时间改为 10 月 22 日。Dot 主动发现冲突并询问用户，没有修改或发送。',
  reference: cloudComputerUiDemo ? 'https://learn.chatgpt.com/docs/dots/computers-and-apps' : 'https://learn.chatgpt.com/docs/dots/tasks-and-memory',
  evidence: cloudComputerUiDemo ? 'Pi runs inside the tenant Debian cloud computer and navigates its visible browser, inspects a public page, and clicks one information link; the Chrome recording shows the UI and Activity result.' : 'Official documentation supports proactive review of connected information and surfacing suggestions/questions; the exact UI shown is Coke Dots.',
  recording: `${outputName}.webp`,
  sourceRecording: livePi ? 'Chrome browser E2E with Pi and the shared provider running inside the tenant Debian K3D computer' : 'Playwright Chrome recording using a deterministic local model fixture, converted to animated WebP',
  viewport: { width: 1440, height: 1000 },
  screenshots: cloudComputerUiDemo
    ? ['screenshots/00-dot-ready.png', 'screenshots/01-cloud-computer-running.png', 'screenshots/02-cloud-browser-click-result.png', 'screenshots/02-cloud-desktop-after-click.png', 'screenshots/03-computer-task-in-activity.png', 'screenshots/04-computer-task-result-detail.png']
    : ['screenshots/00-dot-ready.png', 'screenshots/01-launch-draft-waiting.png', 'screenshots/02-proactive-finding-in-activity.png', 'screenshots/03-proactive-finding-detail.png'],
  webp: { width: playbackMetadata.width, height: playbackMetadata.height, frames: playbackMetadata.pages, durationSeconds: playbackDuration },
  webpPlayback,
  ...(cloudComputerUiDemo ? { computerUiAudit: 'computer-ui-audit.json', interactionProof: 'interaction-proof.json' } : {}),
  modelCalls: livePi ? undefined : modelRequests.length,
  model: livePi ? `Pi in Debian; shared provider model ${liveModelName}` : 'Deterministic local E2E fixture; no live provider request',
  trimmedWaitIntervals: liveWaitIntervals,
}, null, 2) + '\n');

assert(existsSync(videoOutput), `Expected shareable animated WebP at ${videoOutput}`);
console.log(`演示 WebP：${videoOutput}`);
