import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page, type Video } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { Entry } from '@napi-rs/keyring';
import { Store } from '../../src/server/store.ts';
import { desktopResourceIdentity } from '../../src/server/linux-desktop-computer.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const demosRoot = resolve(projectRoot, 'artifacts', 'demos');
const configuredOutput = process.env.DOTS_PROACTIVE_DEMO_OUTPUT_DIR?.trim();
const defaultOutput = `proactive-release-date-conflict-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const outputRoot = resolve(projectRoot, configuredOutput || join('artifacts', 'demos', defaultOutput));
const outputRelativePath = relative(demosRoot, outputRoot);
if (!outputRelativePath || outputRelativePath.startsWith('..') || isAbsolute(outputRelativePath)) {
  throw new Error('DOTS_PROACTIVE_DEMO_OUTPUT_DIR must name a new directory inside artifacts/demos.');
}
const videoFileName = 'proactive-release-date-cloud-computer.webp';
const videoOutput = join(outputRoot, videoFileName);
const sourceDraft = '请在我的 Dot Scratchpad 中起草一份内部发布公告页面，发布日期写 10 月 21 日。根据账号规则，先提交页面写入提案并等待我审批；批准前不要保存页面，也不要发送、发布或修改其他内容。请用中文说明草稿待审批。';
const sourceDecision = '发布团队今天确认发布日期改为 10 月 22 日。请仅在当前聊天中用一句中文回复确认这个决定；不要新建 Scratchpad 页面，不要写入 Dot 记忆，不要编辑或发送公告。';
const finding = '我发现发布团队把发布日期改为 10 月 22 日，但待审批的发布公告仍写着 10 月 21 日。要我更新这份草稿吗？我还没有修改或发送。';
const researchFixtureUrl = 'https://research-fixture.dots.test/launch';
const cloudFollowThroughInstruction = `我看到了你主动发现的发布日期冲突。请用 Dot 的云电脑打开 ${researchFixtureUrl}，查看公开发布说明并点击“展开发布时间”，核对完整发布时间是否与团队的新决定（10 月 22 日）一致。只读取网页，不修改、发送或发布任何内容；用中文告诉我你在云电脑里做了什么和核对结果。`;
const liveK3d = process.env.DOTS_PROACTIVE_DEMO_LIVE_KERNELS === '1';
const liveEngine = process.env.DOTS_PROACTIVE_DEMO_ENGINE?.trim() || 'dsh';
assert(['pi', 'dsh'].includes(liveEngine), 'DOTS_PROACTIVE_DEMO_ENGINE must be pi or dsh.');
const cluster = process.env.DOTS_K3D_CLUSTER || 'tp1121-sandbox-dev';
const tokenSecret = randomBytes(32).toString('base64url');
const keychainService = `com.cokepoppy.coke-dots.proactive-demo-${randomUUID()}`;
const tempRoot = await mkdtemp(join(tmpdir(), 'coke-dots-proactive-demo-'));
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
let tenantNamespaceCreated = false;
let liveModelConfig: { apiKey: string; baseUrl: string; model: string } | null = null;
let liveModelApiKey = '';
let liveModelName = '';
let runFailed = true;

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
          assert.match(user, /10\s*月\s*21\s*日/);
          assert.match(user, /10\s*月\s*22\s*日/);
          assert.match(user, /Do not browse, control a computer, read or modify files/);
          assert.doesNotMatch(JSON.stringify(payload.tools || []), /open_public_page|computer|write|send/i);
          decision = { status: 'done', message: finding, proactiveFinding: true };
        } else if (user.includes(sourceDraft)) {
          decision = { status: 'waiting', message: 'Draft ready for review. I have not sent or published it.' };
        } else if (user.includes(sourceDecision)) {
          decision = { status: 'done', message: 'The release decision moves launch to October 22.' };
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

async function configureLiveCloudKernel() {
  assert.equal(command(['kubectl', 'config', 'current-context']), `k3d-${cluster}`, 'The live proactive demo must use the explicitly selected Coke sandbox cluster.');
  command(['kubectl', 'get', 'nodes']);
  command(['docker', 'image', 'inspect', process.env.DOTS_LINUX_DESKTOP_IMAGE || 'coke-dots-linux-desktop:dev']);
  const sourceKeychainService = process.env.DOTS_KEYCHAIN_SERVICE?.trim() || 'com.cokepoppy.coke-dots';
  const sourceStore = new Store(resolve(process.env.DOTS_DATA_DIR || './data'));
  let modelBaseUrl = '';
  let model = '';
  try {
    modelBaseUrl = sourceStore.getSetting('sharedModelBaseUrl', 'legacy') || sourceStore.getSetting('modelBaseUrl', 'legacy') || '';
    model = sourceStore.getSetting('sharedModelName', 'legacy') || sourceStore.getSetting('modelName', 'legacy') || '';
  } finally { sourceStore.close(); }
  const apiKey = new Entry(sourceKeychainService, 'shared-model-api-key').getPassword()
    || new Entry(sourceKeychainService, 'tenant-legacy-model-api-key').getPassword() || '';
  assert(modelBaseUrl && model && apiKey, 'The live demo needs the Coke Dots shared model endpoint, model, and Keychain credential.');
  assert.equal(new URL(modelBaseUrl).protocol, 'https:', 'The live demo requires an HTTPS model endpoint.');
  liveModelConfig = { apiKey, baseUrl: modelBaseUrl, model };
  liveModelApiKey = apiKey;
  liveModelName = model;
  new Entry(keychainService, 'shared-model-api-key').setPassword(apiKey);
  const setupStore = new Store(dataDirectory);
  setupStore.setSetting('sharedModelBaseUrl', modelBaseUrl, 'legacy');
  setupStore.setSetting('sharedModelName', model, 'legacy');
  setupStore.setSetting('modelBaseUrl', modelBaseUrl, 'legacy');
  setupStore.setSetting('modelName', model, 'legacy');
  setupStore.close();
  console.log(`Live kernel preflight passed: K3D ${cluster}, shared model configured`);
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
      DOTS_E2E_COMPUTER_RESEARCH_FIXTURE_URL: liveK3d ? researchFixtureUrl : '',
      DOTS_E2E_DESKTOP_MEMORY_REQUEST: liveK3d ? process.env.DOTS_E2E_DESKTOP_MEMORY_REQUEST || '512Mi' : '',
      DOTS_E2E_AGENT_RUNTIME_MEMORY_REQUEST: liveK3d ? process.env.DOTS_E2E_AGENT_RUNTIME_MEMORY_REQUEST || '256Mi' : '',
      DOTS_ENV_FILE: emptyEnvFile,
      DOTS_DATA_DIR: dataDirectory,
      DOTS_KEYCHAIN_SERVICE: keychainService,
      DOTS_PORT: String(port),
      DOTS_MODEL_BASE_URL: liveK3d ? '' : modelBaseUrl,
      DOTS_MODEL_API_KEY: liveK3d ? '' : 'e2e-proactive-demo-only',
      DOTS_MODEL: liveK3d ? '' : 'proactive-demo-model',
      DOTS_PI_ENABLED: liveK3d && liveEngine === 'pi' ? '1' : '0',
      DOTS_COMPUTER_BACKEND: liveK3d ? 'linux-desktop' : '',
      DOTS_LINUX_DESKTOP_TOKEN_SECRET: liveK3d ? tokenSecret : '',
      DOTS_LINUX_DESKTOP_IMAGE: process.env.DOTS_LINUX_DESKTOP_IMAGE || 'coke-dots-linux-desktop:dev',
      DOTS_LINUX_DESKTOP_CONTROL_NAMESPACE: liveK3d ? cluster : '',
      DOTS_LINUX_DESKTOP_CHROME_NO_SANDBOX: process.env.DOTS_LINUX_DESKTOP_CHROME_NO_SANDBOX || (liveK3d ? '1' : ''),
      DOTS_DESKTOP_AGENT_ADAPTERS: liveK3d ? liveEngine : '',
      DOTS_AGENT_KERNELS_JSON: '',
      DOTS_DSH_BIN: '',
      DOTS_DSH_PROFILE: liveK3d && liveEngine === 'dsh' ? (process.env.DOTS_LIVE_DSH_PROFILE?.trim() || process.env.DOTS_DSH_PROFILE?.trim() || 'sdk') : '',
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

async function waitForTask(pageToWait: Page, selector: { instruction?: string; executionMode?: string; statuses: string[] }, timeout = liveK3d ? 180_000 : 30_000) {
  const deadline = Date.now() + timeout;
  let previousStatus = '';
  let lastMatches: { id: string; status: string; error: string | null }[] = [];
  while (Date.now() < deadline) {
    lastMatches = await pageToWait.evaluate(async ({ instruction, executionMode }) => {
      const state = await fetch('/api/state', { cache: 'no-store' }).then(response => response.json()) as { tasks: Record<string, unknown>[] };
      return state.tasks.filter(task =>
        (instruction === undefined || task.instruction === instruction)
        && (executionMode === undefined || task.executionMode === executionMode),
      ).map(task => ({ id: String(task.id || ''), status: String(task.status || ''), error: typeof task.error === 'string' ? task.error : null }));
    }, selector);
    const currentStatus = lastMatches.map(task => task.status).join(',') || 'not-created';
    if (currentStatus !== previousStatus) {
      console.log(`TASK STATUS ${selector.instruction?.slice(0, 48) || selector.executionMode}: ${currentStatus}`);
      previousStatus = currentStatus;
    }
    const terminal = lastMatches.find(task => selector.statuses.includes(task.status));
    if (terminal) {
      // Require the same terminal state in a second uncached API read. This
      // avoids recording a transient response as the final task outcome.
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
      const confirmed = await pageToWait.evaluate(async ({ instruction, executionMode }) => {
        const state = await fetch('/api/state', { cache: 'no-store' }).then(response => response.json()) as { tasks: Record<string, unknown>[] };
        return state.tasks.filter(task =>
          (instruction === undefined || task.instruction === instruction)
          && (executionMode === undefined || task.executionMode === executionMode),
        ).map(task => ({ id: String(task.id || ''), status: String(task.status || ''), error: typeof task.error === 'string' ? task.error : null }));
      }, selector);
      if (confirmed.some(task => task.id === terminal.id && task.status === terminal.status)) return;
      lastMatches = confirmed;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
  }
  throw new Error(`Task did not reach ${selector.statuses.join('/')} within ${timeout} ms. Last task states: ${JSON.stringify(lastMatches)}`);
}

assert.equal(existsSync(outputRoot), false, `Refusing to overwrite an existing proactive demo recording directory: ${outputRoot}`);
await mkdir(join(outputRoot, 'screenshots'), { recursive: true });
await writeFile(emptyEnvFile, '');
let modelBaseUrl = '';
const port = await reservePort();
baseUrl = `http://127.0.0.1:${port}`;

try {
  assert(chromePath, 'Chrome was not found; set DOTS_CHROME_BIN.');
  if (liveK3d) await configureLiveCloudKernel();
  else modelBaseUrl = await startModel();
  await startServer(port, modelBaseUrl);
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, recordVideo: { dir: outputRoot, size: { width: 1440, height: 1000 } } });
  page = await context.newPage();
  pageVideo = page.video();
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));

  await signIn(page);
  console.log('STEP signed in');
  if (liveK3d) {
    const workspace = await page.evaluate(async name => {
      const response = await fetch('/api/tenants', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
      return { status: response.status, body: await response.json() as { id?: string } };
    }, `Proactive demo ${randomUUID()}`);
    assert.equal(workspace.status, 201, 'Create a disposable tenant workspace for the cloud-kernel demonstration.');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('app-shell').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true');
    await page.getByRole('button', { name: '新聊天', exact: true }).click();
    await page.getByTestId('chat-home').waitFor({ state: 'visible' });
    console.log('STEP opened New chat from the first-run workspace');
    const tenantId = await page.getByTestId('app-shell').getAttribute('data-tenant-id');
    assert(tenantId, 'The live E2E browser must be signed into an isolated tenant.');
    assert.equal(tenantId, workspace.body.id, 'The live E2E session must use the disposable workspace it just created.');
    tenantNamespace = desktopResourceIdentity(tenantId).namespace;
    const existingNamespace = spawnSync('kubectl', ['get', 'namespace', tenantNamespace, '-o', 'name'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    assert.notEqual(existingNamespace.status, 0, `Refusing to reuse pre-existing tenant desktop namespace ${tenantNamespace}`);
    assert.match(existingNamespace.stderr, /NotFound/i, `Could not safely verify new namespace ${tenantNamespace}: ${(existingNamespace.stderr || existingNamespace.stdout).slice(-800)}`);
    tenantNamespaceCreated = true;
    await page.locator('.composer-bottom select').selectOption(liveEngine);
    const engines = await page.evaluate(async () => await (await fetch('/api/state')).json()) as { availableEngines: string[]; remoteEngines: string[] };
    assert(engines.availableEngines.includes(liveEngine) && engines.remoteEngines.includes(liveEngine), `${liveEngine} must be available and marked as a remote cloud-computer kernel.`);
    const approvalRule = await page.evaluate(async () => {
      const response = await fetch('/api/action-rule', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instruction: 'For internal announcement drafts, prepare a private Scratchpad page but wait for my approval before saving. Never send or publish it.',
          mode: 'ask-before',
        }),
      });
      return { status: response.status, body: await response.json() as { mode?: string } };
    });
    assert.equal(approvalRule.status, 200, 'The disposable demo account should install its approval-before-write rule.');
    assert.equal(approvalRule.body.mode, 'ask-before');
    console.log(`STEP selected ${liveEngine} for tenant cloud computer ${tenantNamespace}`);
  }
  await new Promise(resolvePromise => setTimeout(resolvePromise, 900));
  await page.screenshot({ path: join(outputRoot, 'screenshots', '00-dot-ready.png') });

  const draftInstruction = sourceDraft;
  await submitTask(page, draftInstruction);
  console.log('STEP waiting for the launch draft task to reach a stable review state');
  await waitForTask(page, { instruction: draftInstruction, statuses: ['waiting', 'failed', 'done'] });
  if (!liveK3d) await page.locator('.timeline .message.dot p').filter({ hasText: 'Draft ready for review' }).waitFor({ state: 'visible' });
  const waitingSnapshot = await page.evaluate(async instruction => {
    const state = await (await fetch('/api/state')).json() as {
      tasks: { id: string; instruction: string; status: string }[];
      entries: { taskId: string | null; kind: string; body: string }[];
    };
    const task = state.tasks.find(row => row.instruction === instruction);
    return { task, replies: task ? state.entries.filter(entry => entry.taskId === task.id && entry.kind === 'dot').map(entry => entry.body) : [] };
  }, draftInstruction);
  assert.equal(waitingSnapshot.task?.status, 'waiting', 'The launch draft must remain open for approval.');
  if (liveK3d) assert.match(waitingSnapshot.replies.at(-1) || '', /[\u3400-\u9fff]/, 'Pi must reply in Chinese to the Chinese draft request.');
  if (liveK3d) {
    const pendingApproval = await page.evaluate(async taskId => {
      const response = await fetch(`/api/tasks/${taskId}/approval`, { cache: 'no-store' });
      return { status: response.status, body: await response.json() as { status?: string; action?: { action?: string; title?: string; content?: string } } | null };
    }, waitingSnapshot.task!.id);
    assert.equal(pendingApproval.status, 200);
    assert.equal(pendingApproval.body?.status, 'pending', 'The Pi task must leave a real Scratchpad write proposal pending for user approval.');
    assert.equal(pendingApproval.body?.action?.action, 'create');
    assert.match(pendingApproval.body?.action?.title || '', /内部发布公告/);
    assert.match(pendingApproval.body?.action?.content || '', /10\s*月\s*21\s*日/);
  }
  assert.equal(await page.evaluate(async () => await fetch('/api/pages').then(response => response.json()).then((pages: unknown[]) => pages.length)), 0, 'The draft must remain a proposal until the user approves the page write.');
  await page.screenshot({ path: join(outputRoot, 'screenshots', '01-launch-draft-waiting.png') });
  console.log('STEP open launch draft is waiting');
  await new Promise(resolvePromise => setTimeout(resolvePromise, 2_500));

  await page.getByRole('button', { name: '新聊天', exact: true }).click();
  console.log('STEP opened a fresh chat');
  const decisionInstruction = sourceDecision;
  await submitTask(page, decisionInstruction);
  console.log('STEP submitted the new release decision');
  if (!liveK3d) await page.locator('.timeline .message.dot p').filter({ hasText: 'The release decision moves launch to October 22.' }).waitFor({ state: 'visible' });
  await waitForTask(page, { instruction: decisionInstruction, statuses: ['done', 'failed'] });
  const decisionStatus = await page.evaluate(async instruction => {
    const state = await (await fetch('/api/state')).json() as { tasks: { instruction: string; status: string }[] };
    return state.tasks.find(task => task.instruction === instruction)?.status;
  }, decisionInstruction);
  assert.equal(decisionStatus, 'done', 'The new release decision must complete successfully.');
  await new Promise(resolvePromise => setTimeout(resolvePromise, 2_500));

  await waitForTask(page, { executionMode: 'proactive-research', statuses: ['done', 'failed'] }, liveK3d ? 240_000 : 30_000);
  console.log('STEP proactive review found the conflicting dates');
  const state = await page.evaluate(async () => await (await fetch('/api/state')).json()) as {
    tasks: { id: string; instruction: string; status: string; executionMode: string; engine: string; result: string | null }[];
    entries: { taskId: string | null; kind: string; body: string }[];
  };
  const draftTask = state.tasks.find(task => task.instruction === draftInstruction);
  const decisionTask = state.tasks.find(task => task.instruction === decisionInstruction);
  const reviewTask = state.tasks.find(task => task.executionMode === 'proactive-research');
  assert.equal(draftTask?.status, 'waiting', 'The original draft must remain open for approval');
  assert.equal(decisionTask?.status, 'done');
  if (liveK3d) assert.match(decisionTask?.result || '', /[\u3400-\u9fff]/, 'Pi must record the new release decision in Chinese.');
  assert(reviewTask, 'The completed work should trigger an autonomous context review');
  assert.equal(reviewTask.status, 'done', `The proactive review failed: ${reviewTask.result || '(no result)'}`);
  if (liveK3d) {
    assert.equal(draftTask.engine, liveEngine, 'The open draft task must use the selected cloud kernel.');
    assert.equal(decisionTask.engine, liveEngine, 'The release decision task must use the selected cloud kernel.');
    assert.equal(reviewTask.engine, liveEngine, 'The autonomous review must use the same cloud kernel.');
  }
  assert.match(reviewTask.result || '', /10\s*月\s*22\s*日.*10\s*月\s*21\s*日|10\s*月\s*21\s*日.*10\s*月\s*22\s*日/);
  if (liveK3d) assert.match(reviewTask.result || '', /[\u3400-\u9fff]/, 'Pi must report its proactive finding in Chinese.');
  assert.equal(await page.evaluate(async () => await fetch('/api/pages').then(response => response.json()).then((pages: unknown[]) => pages.length)), 0, 'The proactive review must not write a Scratchpad page');
  assert.equal(await page.evaluate(async () => await fetch('/api/dot-memories').then(response => response.json()).then((notes: unknown[]) => notes.length)), 0, 'The proactive review must not write personal Dot memory');
  if (!liveK3d) assert.equal(modelRequests.filter(request => request.user.includes('Proactive research constraints')).length, 1);

  if (liveK3d) {
    const pod = command(['kubectl', '-n', tenantNamespace, 'get', 'pod', '-l', 'app=desktop', '-o', 'jsonpath={.items[0].metadata.name}']);
    assert(pod, 'The proactive tasks must provision this tenant cloud computer.');
    assert.equal(command(['kubectl', '-n', tenantNamespace, 'exec', pod, '-c', 'agent-runtime', '--', 'id', '-u']), '1001');
    const osRelease = command(['kubectl', '-n', tenantNamespace, 'exec', pod, '--', 'cat', '/etc/os-release']);
    assert.match(osRelease, /^ID=debian$/m);
    assert.match(osRelease, /^VERSION_ID="13"$/m);
    if (liveEngine === 'dsh') assert.match(command(['kubectl', '-n', tenantNamespace, 'exec', pod, '-c', 'agent-runtime', '--', '/usr/local/bin/dsh', '--version']), /\d+\.\d+/);
    else assert.equal(command(['kubectl', '-n', tenantNamespace, 'exec', pod, '-c', 'agent-runtime', '--', 'sh', '-lc', "cd /opt/coke-dots && node --input-type=module -e \"await import('@mariozechner/pi-coding-agent'); console.log('pi-sdk-ok')\""]), 'pi-sdk-ok');
    const sessionFiles = command(['kubectl', '-n', tenantNamespace, 'exec', pod, '-c', 'agent-runtime', '--', 'find', `/workspace/tasks/${reviewTask.id}/.coke-dots-agent-runtime`, '-type', 'f', '-printf', '%P\\n']);
    assert(sessionFiles, `The proactive ${liveEngine} session must persist inside the tenant cloud-computer workspace.`);
    if (liveEngine === 'pi') assert.match(sessionFiles, /pi-sessions/, 'Pi session history must live in the Debian cloud computer workspace.');
    assert(liveModelConfig, 'The shared model profile must be loaded for the live cloud kernel.');
    console.log(`STEP verified ${liveEngine} task session inside Debian 13 tenant computer ${tenantNamespace}`);
  }

  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  const proactiveCard = page.getByTestId(`task-card-${reviewTask.id}`);
  await proactiveCard.waitFor({ state: 'visible' });
  await proactiveCard.getByText('Dot 主动研究 · 只读', { exact: true }).waitFor({ state: 'visible' });
  const visibleFinding = liveK3d ? reviewTask.result || '' : finding;
  await proactiveCard.getByText(visibleFinding, { exact: true }).waitFor({ state: 'visible' });
  const activityFinding = page.getByTestId('activity-feed').getByTestId('activity-entry').filter({ hasText: visibleFinding });
  await activityFinding.waitFor({ state: 'visible' });
  await page.screenshot({ path: join(outputRoot, 'screenshots', '02-proactive-finding-in-activity.png') });
  await new Promise(resolvePromise => setTimeout(resolvePromise, 2_500));

  await proactiveCard.getByRole('button', { name: /查看详情/ }).click();
  await page.locator('.timeline .message.dot p').filter({ hasText: visibleFinding }).waitFor({ state: 'visible' });
  await page.screenshot({ path: join(outputRoot, 'screenshots', '03-proactive-finding-detail.png') });
  await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000));

  if (liveK3d) {
    await page.getByRole('button', { name: '新聊天', exact: true }).click();
    await page.getByTestId('chat-home').waitFor({ state: 'visible' });
    const kernelPicker = page.locator('.composer-bottom select');
    await kernelPicker.selectOption(liveEngine);
    assert.equal(await kernelPicker.inputValue(), liveEngine, 'The follow-through task must explicitly use the selected cloud Agent kernel.');
    await page.screenshot({ path: join(outputRoot, 'screenshots', '04-follow-through-ready.png') });

    await submitTask(page, cloudFollowThroughInstruction);
    const followThroughCreated = await page.evaluate(async instruction => {
      const state = await (await fetch('/api/state', { cache: 'no-store' })).json() as {
        tasks: { id: string; instruction: string; status: string; executionMode: string; engine: string }[];
      };
      return state.tasks.find(task => task.instruction === instruction) || null;
    }, cloudFollowThroughInstruction);
    assert(followThroughCreated, 'The explicitly assigned follow-through task must be created from the chat composer.');
    assert.equal(followThroughCreated.executionMode, 'standard', 'The computer task must be a separate user-authorized task, not part of proactive review.');
    assert.equal(followThroughCreated.engine, liveEngine);
    await writeFile(join(outputRoot, '05-follow-through-task-created.json'), `${JSON.stringify({ taskId: followThroughCreated.id, engine: liveEngine, executionMode: followThroughCreated.executionMode, instruction: cloudFollowThroughInstruction }, null, 2)}\n`);

    await page.getByRole('button', { name: '电脑', exact: true }).click();
    await page.getByTestId('linux-desktop-stage').waitFor({ state: 'visible', timeout: 30_000 });
    const beforeComputer = await page.evaluate(async () => {
      const stateResponse = await fetch('/api/computer', { cache: 'no-store' });
      const screenshotResponse = await fetch('/api/computer/screenshot', { cache: 'no-store' });
      const state = await stateResponse.json() as { url?: string; title?: string; owner?: string; backend?: string };
      return {
        state: { status: stateResponse.status, ...state },
        screenshotStatus: screenshotResponse.status,
        screenshot: Array.from(new Uint8Array(await screenshotResponse.arrayBuffer())),
      };
    });
    assert.equal(beforeComputer.state.status, 200, 'The tenant cloud computer must be visible before Agent follow-through.');
    assert.equal(beforeComputer.screenshotStatus, 200);
    await writeFile(join(outputRoot, '06-cloud-computer-before-task.png'), Buffer.from(beforeComputer.screenshot));
    await page.screenshot({ path: join(outputRoot, 'screenshots', '06-cloud-computer-before-task.png') });
    console.log('STEP watching the tenant cloud computer while Pi performs the user-authorized follow-through');

    await waitForTask(page, { instruction: cloudFollowThroughInstruction, statuses: ['done', 'failed'] }, 300_000);
    const followThroughState = await page.evaluate(async instruction => {
      const state = await (await fetch('/api/state', { cache: 'no-store' })).json() as {
        tasks: { id: string; instruction: string; status: string; executionMode: string; engine: string; result: string | null; error: string | null }[];
      };
      const task = state.tasks.find(row => row.instruction === instruction) || null;
      return { task };
    }, cloudFollowThroughInstruction);
    const followThroughTask = followThroughState.task;
    assert.equal(followThroughTask?.status, 'done', `The Pi cloud-computer follow-through failed: ${followThroughTask?.error || followThroughTask?.result || '(no result)'}`);
    assert.equal(followThroughTask?.executionMode, 'standard');
    assert.equal(followThroughTask?.engine, liveEngine);
    assert.match(followThroughTask?.result || '', /[\u3400-\u9fff]/, 'The follow-through result must be in Chinese.');
    assert.match(followThroughTask?.result || '', /10\s*月\s*22\s*日/);
    assert.match(followThroughTask?.result || '', /云电脑/);

    const finalComputer = await page.evaluate(async () => {
      const stateResponse = await fetch('/api/computer', { cache: 'no-store' });
      const screenshotResponse = await fetch('/api/computer/screenshot', { cache: 'no-store' });
      const state = await stateResponse.json() as { url?: string; title?: string; owner?: string; backend?: string };
      return {
        state: { status: stateResponse.status, ...state },
        screenshotStatus: screenshotResponse.status,
        screenshot: Array.from(new Uint8Array(await screenshotResponse.arrayBuffer())),
      };
    });
    assert.equal(finalComputer.state.status, 200);
    assert.equal(finalComputer.screenshotStatus, 200);
    assert.equal(finalComputer.state.url, researchFixtureUrl, `The tenant computer must remain on the requested public page: ${JSON.stringify(finalComputer.state)}`);
    const beforeHash = createHash('sha256').update(Buffer.from(beforeComputer.screenshot)).digest('hex');
    const afterHash = createHash('sha256').update(Buffer.from(finalComputer.screenshot)).digest('hex');
    assert.notEqual(afterHash, beforeHash, 'The displayed cloud-computer screen must change as Pi opens and inspects the page.');
    await writeFile(join(outputRoot, '07-cloud-computer-after-task.png'), Buffer.from(finalComputer.screenshot));
    await page.screenshot({ path: join(outputRoot, 'screenshots', '07-cloud-computer-after-task.png') });
    await new Promise(resolvePromise => setTimeout(resolvePromise, 3_000));

    const activity = await page.evaluate(async () => await (await fetch('/api/activity?limit=100', { cache: 'no-store' })).json()) as {
      entries: { taskId: string | null; body: string }[];
    };
    const computerActions = activity.entries.filter(entry => entry.taskId === followThroughTask.id).map(entry => entry.body);
    assert(computerActions.some(body => body.includes('打开了云电脑中的公开网页')), `Activity must record cloud-browser navigation: ${computerActions.join(' | ')}`);
    assert(computerActions.some(body => body.includes('点击了云电脑公开网页中的安全控件')), `Activity must record the safe page click: ${computerActions.join(' | ')}`);
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    const activityFeed = page.getByTestId('activity-feed');
    await activityFeed.waitFor({ state: 'visible' });
    await activityFeed.getByTestId('activity-entry').filter({ hasText: '点击了云电脑公开网页中的安全控件' }).first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.screenshot({ path: join(outputRoot, 'screenshots', '08-cloud-computer-actions-in-activity.png') });
    await new Promise(resolvePromise => setTimeout(resolvePromise, 3_000));
    console.log('STEP Pi opened and clicked the cloud browser page; Chinese result and Activity actions verified');
  }

  assert.deepEqual(browserErrors, [], `Browser runtime errors: ${browserErrors.join('; ')}`);
  assert.deepEqual(mockErrors, [], `Model fixture errors: ${mockErrors.join('; ')}`);
  if (!liveK3d) {
    assert.equal(modelRequests.length, 3, `Expected draft, decision and autonomous review calls; received ${modelRequests.length}`);
    assert.match(modelRequests[2].user, /10\s*月\s*21\s*日/);
    assert.match(modelRequests[2].user, /10\s*月\s*22\s*日/);
  }

  runFailed = false;
  console.log(`Proactive demo E2E passed: ${baseUrl}`);
} finally {
  let taskDiagnostics: unknown = null;
  if (liveK3d && page) {
    try {
      taskDiagnostics = await page.evaluate(async () => {
        const state = await (await fetch('/api/state')).json() as { tasks: { id: string; title: string; instruction: string; status: string; engine: string; executionMode: string; error: string | null; result: string | null }[] };
        return state.tasks.map(({ id, title, instruction, status, engine, executionMode, error, result }) => ({ id, title, instruction, status, engine, executionMode, error, result }));
      });
    } catch { /* Retain the original E2E result if the browser has already closed. */ }
  }
  await context?.close().catch(() => undefined);
  context = null;
  await browser?.close().catch(() => undefined);
  browser = null;
  await stopServer();
  if (modelServer) await new Promise<void>(resolvePromise => modelServer!.close(() => resolvePromise()));
  const secret = liveModelApiKey;
  await writeFile(join(outputRoot, 'server.log'), secret ? serverLogs.join('').replaceAll(secret, '[REDACTED]') : serverLogs.join(''));
  await writeFile(join(outputRoot, 'e2e-debug.json'), JSON.stringify({ mode: liveK3d ? `live-${liveEngine}-in-debian-k3d` : 'deterministic-local-model-fixture', result: runFailed ? 'failed' : 'passed', mockErrors, fixtureModelCalls: liveK3d ? undefined : modelRequests.length, liveEngine: liveK3d ? liveEngine : undefined, liveProviderModel: liveK3d ? liveModelName : undefined, proactiveReviewSeen: liveK3d ? undefined : modelRequests.some(request => request.user.includes('Proactive research constraints')), tenantNamespace: liveK3d ? tenantNamespace : undefined, tasks: taskDiagnostics }, null, 2).replace(secret || '\u0000', '[REDACTED]') + '\n');
  const preserveFailedNamespace = liveK3d && runFailed && process.env.DOTS_PROACTIVE_DEMO_KEEP_FAILED_NAMESPACE === '1';
  if (tenantNamespace && tenantNamespaceCreated && !preserveFailedNamespace) spawnSync('kubectl', ['delete', 'namespace', tenantNamespace, '--wait=true', '--timeout=120s'], { cwd: projectRoot, stdio: 'ignore' });
  else if (preserveFailedNamespace) console.log(`Preserved temporary K3D namespace for diagnosis: ${tenantNamespace}`);
  if (liveK3d) { try { new Entry(keychainService, 'shared-model-api-key').deletePassword(); } catch { /* No credential was written if the live preflight failed. */ } }
  await rm(tempRoot, { recursive: true, force: true });
}

const recording = pageVideo ? await pageVideo.path().catch(() => '') : '';
assert(recording && existsSync(recording), 'Chrome did not produce the demo WebM recording');
const converter = join(projectRoot, 'scripts', 'convert-demo-video-to-webp.mjs');
execFileSync(process.execPath, [converter, recording, videoOutput, '3', '1'], { cwd: projectRoot, stdio: 'inherit' });
await writeFile(join(outputRoot, 'manifest.json'), JSON.stringify({
  scenario: liveK3d
    ? 'Dot proactively detects a release-date conflict without writing, then after explicit user instruction Pi opens the tenant cloud computer, clicks the public page disclosure, verifies the date, and reports in Chinese.'
    : 'An open launch draft says October 21; a later release decision says October 22. Dot detects and reports the conflict without editing or sending anything.',
  reference: 'https://learn.chatgpt.com/docs/dots/tasks-and-memory',
  computerReference: 'https://learn.chatgpt.com/docs/dots/computers-and-apps',
  evidence: 'Official documentation supports proactive review of connected information and surfacing suggestions/questions; the exact UI shown is Coke Dots.',
  recording: videoFileName,
  sourceRecording: 'Playwright Chrome recording, converted to animated WebP',
  presentationPlayback: { activeUiActions: '1x (source speed)', readableWaitEdgeSeconds: 3, longStaticWaitsRemoved: true },
  viewport: { width: 1440, height: 1000 },
  screenshots: [
    'screenshots/00-dot-ready.png', 'screenshots/01-launch-draft-waiting.png',
    'screenshots/02-proactive-finding-in-activity.png', 'screenshots/03-proactive-finding-detail.png',
    ...(liveK3d ? ['screenshots/04-follow-through-ready.png', 'screenshots/06-cloud-computer-before-task.png', 'screenshots/07-cloud-computer-after-task.png', 'screenshots/08-cloud-computer-actions-in-activity.png'] : []),
  ],
  computerEvidence: liveK3d ? {
    screenshotBefore: '06-cloud-computer-before-task.png',
    screenshotAfter: '07-cloud-computer-after-task.png',
    assignedTask: '05-follow-through-task-created.json',
    instruction: cloudFollowThroughInstruction,
    observedActions: ['navigate to the public launch page', 'click 展开发布时间', 'verify 10 月 22 日 and report in Chinese'],
    proactiveReviewRemainsReadOnly: true,
  } : undefined,
  kernel: liveK3d ? `${liveEngine} running in the tenant-isolated Debian 13 cloud-computer Pod` : 'Local deterministic E2E model fixture',
  model: liveK3d ? liveModelName : 'Deterministic local E2E fixture; no live provider request',
  providerMode: liveK3d ? 'Live shared Model API credentials reused by this and other tenants' : 'Local deterministic fixture; no provider request',
  fixtureModelCalls: liveK3d ? undefined : modelRequests.length,
  result: 'passed',
}, null, 2) + '\n');

assert(existsSync(videoOutput), `Expected shareable animated WebP at ${videoOutput}`);
console.log(`Animated WebP: ${videoOutput}`);
