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
const tetrisHtml = '<!doctype html><html lang="zh"><meta charset="utf-8"><body><main id="demo-artifact">俄罗斯方块预览</main></body></html>';
const agentAdapterSource = `const fs=require('node:fs');let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const task=JSON.parse(input);const key='k3d-e2e-shared-model-key';const keyInEnv=Object.values(process.env).includes(key)||Boolean(process.env.DOTS_AGENT_RUNTIME_TOKEN)||Boolean(process.env.LINUX_DESKTOP_WORKER_TOKEN);fs.writeFileSync('runtime-persistence.txt',task.taskId);fs.writeFileSync('tetris.html',${JSON.stringify(tetrisHtml)});console.log(JSON.stringify({status:'done',message:'Adapter completed: '+task.prompt+'; shared model config received: '+Boolean(task.modelConfig?.apiKey===key&&task.modelConfig?.baseUrl==='https://api.example.test/v1'&&task.modelConfig?.model==='k3d-e2e-model')+'; model key in child environment: '+keyInEnv}))})`;
const k3dModelConfig = { apiKey: 'k3d-e2e-shared-model-key', baseUrl: 'https://api.example.test/v1', model: 'k3d-e2e-model' };
let appServer: ChildProcess | null = null;
let agentPortForward: ChildProcess | null = null;
let workerPortForward: ChildProcess | null = null;
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

const desktopImage = process.env.DOTS_LINUX_DESKTOP_IMAGE || `coke-dots-linux-desktop:sha-${command(['git', 'rev-parse', 'HEAD'])}`;

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
      DOTS_LINUX_DESKTOP_IMAGE: desktopImage,
      DOTS_LINUX_DESKTOP_CONTROL_NAMESPACE: process.env.DOTS_LINUX_DESKTOP_CONTROL_NAMESPACE || cluster,
      DOTS_LINUX_DESKTOP_CHROME_NO_SANDBOX: process.env.DOTS_LINUX_DESKTOP_CHROME_NO_SANDBOX || '1',
      DOTS_LINUX_DESKTOP_TEST_WORKER_URL: '', DOTS_LINUX_DESKTOP_TEST_NOVNC_URL: '', DOTS_LINUX_DESKTOP_TEST_AGENT_URL: '',
      DOTS_DESKTOP_AGENT_ADAPTERS: 'dsh',
      DOTS_AGENT_KERNELS_JSON: JSON.stringify({ dsh: { command: 'node', args: ['-e', agentAdapterSource] } }),
      GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', DOTS_MODEL_BASE_URL: k3dModelConfig.baseUrl, DOTS_MODEL_API_KEY: k3dModelConfig.apiKey, DOTS_MODEL: k3dModelConfig.model, DOTS_PI_ENABLED: '0', DOTS_DSH_BIN: '',
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
  command(['docker', 'image', 'inspect', desktopImage]);
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
  const expectedWorkerImage = desktopImage;
  const deployment = JSON.parse(command(['kubectl', '-n', namespace, 'get', 'deployment', 'desktop', '-o', 'json'])) as {
    metadata: { annotations?: Record<string, string> };
    spec: { template: { metadata: { annotations?: Record<string, string> }; spec: { containers: { image: string; imagePullPolicy: string }[] } } };
  };
  assert.equal(deployment.metadata.annotations?.['coke-dots.io/desktop-image'], expectedWorkerImage);
  assert.equal(deployment.spec.template.metadata.annotations?.['coke-dots.io/desktop-image'], expectedWorkerImage);
  assert.deepEqual(deployment.spec.template.spec.containers.map(container => ({ image: container.image, imagePullPolicy: container.imagePullPolicy })), [
    { image: expectedWorkerImage, imagePullPolicy: 'IfNotPresent' },
  ]);
  const runningImage = command(['kubectl', '-n', namespace, 'get', 'pod', desktopPod, '-o', 'jsonpath={.status.containerStatuses[0].imageID}']);
  assert.match(runningImage, /^sha256:/, 'Kubernetes must report the running immutable image identity');
  await writeFile(join(artifacts, 'cloud-computer-image.json'), `${JSON.stringify({ expectedWorkerImage, runningImage }, null, 2)}\n`);
  console.log(`Verified tenant desktop image ${expectedWorkerImage} (${runningImage})`);
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
    return Boolean(image?.complete && image.naturalWidth === 1440 && image.naturalHeight === 900);
  }, null, { timeout: 60_000 });
  console.log('Debian 13 desktop Pod is ready and the screenshot is rendered');
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
    body: JSON.stringify({ engine: 'dsh', taskId: runtimeTaskId, prompt: 'real Debian 13 runtime smoke', sessionId: null, cwd: `tasks/${runtimeTaskId}`, modelConfig: k3dModelConfig }),
  });
  const runtimeResult = await runtimeResponse.json() as { status?: string; message?: string; engine?: string };
  assert.equal(runtimeResponse.status, 200, `The live Agent runtime must execute its configured adapter: ${JSON.stringify(runtimeResult)}`);
  assert.equal(runtimeResult.status, 'done');
  assert.equal(runtimeResult.engine, 'dsh');
  assert.match(runtimeResult.message || '', /Adapter completed: real Debian 13 runtime smoke; shared model config received: true; model key in child environment: false/);
  const workspacePath = `/workspace/tasks/${runtimeTaskId}/runtime-persistence.txt`;
  assert.equal(command(['kubectl', '-n', namespace, 'exec', desktopPod, '--', 'cat', workspacePath]), runtimeTaskId, 'The real Agent runtime must leave its task artifact in the tenant workspace PVC');
  agentPortForward.kill('SIGTERM');
  agentPortForward = null;
  console.log('Live Agent runtime received the shared model profile over stdin and kept it and runtime tokens out of the adapter environment');

  const cloudInstruction = `通过云电脑 Agent 验证共享模型配置 ${randomUUID()}`;
  await page.getByRole('button', { name: '新聊天', exact: true }).click();
  await page.getByTestId('task-composer').waitFor({ state: 'visible' });
  const seedTask = await page.evaluate(async instruction => {
    const response = await fetch('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction, engine: 'dsh' }) });
    return { status: response.status, task: await response.json() as { id?: string; title?: string } };
  }, `打开聊天上下文 ${randomUUID()}`);
  assert.equal(seedTask.status, 201, 'Create a disposable cloud task to open the normal conversation composer');
  assert(seedTask.task.id && seedTask.task.title);
  await page.waitForFunction(async taskId => {
    const state = await fetch('/api/state').then(response => response.json()) as { tasks: { id: string; status: string }[] };
    return state.tasks.find(task => task.id === taskId)?.status === 'done';
  }, seedTask.task.id, { timeout: 120_000 });
  await page.locator('.task-links button').filter({ hasText: seedTask.task.title }).click();
  await page.getByTestId('engine-select').waitFor({ state: 'visible' });
  await page.getByTestId('engine-select').selectOption('dsh');
  await page.getByTestId('task-composer').fill(cloudInstruction);
  await page.locator('button.send').click();
  const cloudTask = await page.waitForFunction(async instruction => {
    const state = await fetch('/api/state').then(response => response.json()) as { tasks: { id: string; title: string; instruction: string; engine: string }[] };
    const task = state.tasks.find(item => item.instruction === instruction && item.engine === 'dsh');
    return task ? { id: task.id, title: task.title } : false;
  }, cloudInstruction, { timeout: 15_000 }).then(handle => handle.jsonValue()) as { id: string; title: string };
  const cloudTaskId = cloudTask.id;
  const cloudTaskDeadline = Date.now() + 180_000;
  let completedCloudTask: {
    task: { id: string; status: string; result: string | null; error: string | null } | undefined;
    dotEntries: string[];
  } | undefined;
  while (Date.now() < cloudTaskDeadline) {
    completedCloudTask = await page.evaluate(async taskId => {
      const state = await fetch('/api/state', { cache: 'no-store' }).then(response => response.json()) as {
        tasks: { id: string; status: string; result: string | null; error: string | null }[];
        entries: { taskId: string | null; kind: string; body: string }[];
      };
      return {
        task: state.tasks.find(task => task.id === taskId),
        dotEntries: state.entries.filter(entry => entry.taskId === taskId && entry.kind === 'dot').map(entry => entry.body),
      };
    }, cloudTaskId);
    if (completedCloudTask.task?.status === 'done') break;
    if (completedCloudTask.task?.status === 'failed') throw new Error(`Chrome-created cloud Agent task failed: ${JSON.stringify(completedCloudTask)}`);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
  }
  assert(completedCloudTask?.task?.status === 'done', `The Chrome-created cloud Agent task did not finish: ${JSON.stringify(completedCloudTask)}`);
  assert(completedCloudTask.task, 'The UI-created cloud task must remain visible in its tenant Activity');
  assert.match(completedCloudTask.task.result || '', /shared model config received: true; model key in child environment: false/, `Task result should persist the adapter response; task=${JSON.stringify(completedCloudTask.task)} entries=${JSON.stringify(completedCloudTask.dotEntries)}`);
  assert.deepEqual(completedCloudTask.dotEntries, [completedCloudTask.task.result], 'The visible Dot reply and persisted task result must match');
  assert.doesNotMatch(completedCloudTask.task.result || '', /k3d-e2e-shared-model-key/, 'The shared API key must not appear in the persisted task result');
  const cloudTaskArtifact = `/workspace/tasks/${cloudTaskId}/runtime-persistence.txt`;
  assert.equal(command(['kubectl', '-n', namespace, 'exec', desktopPod, '--', 'cat', cloudTaskArtifact]), cloudTaskId, 'The UI task must execute in the actual tenant Agent runtime and persist its artifact on that tenant PVC');
  console.log('Chrome-created cloud task completed through the host service, tenant Agent runtime, and Debian adapter');

  const workerPort = await freePort();
  workerPortForward = spawn('kubectl', ['-n', namespace, 'port-forward', '--address', '127.0.0.1', 'svc/desktop', `${workerPort}:8082`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let workerPortForwardOutput = '';
  workerPortForward.stdout?.on('data', chunk => { workerPortForwardOutput += String(chunk); });
  workerPortForward.stderr?.on('data', chunk => { workerPortForwardOutput += String(chunk); });
  const workerPortForwardDeadline = Date.now() + 15_000;
  while (!workerPortForwardOutput.includes(`127.0.0.1:${workerPort}`) && Date.now() < workerPortForwardDeadline) {
    if (workerPortForward.exitCode !== null) throw new Error(`Worker port-forward exited early: ${workerPortForwardOutput}`);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  }
  assert(workerPortForwardOutput.includes(`127.0.0.1:${workerPort}`), `Worker port-forward did not become ready: ${workerPortForwardOutput}`);
  const workerToken = createHmac('sha256', tokenSecret).update(`worker:${tenantId}`).digest('base64url');
  const workerBaseUrl = `http://127.0.0.1:${workerPort}`;
  const unauthorizedArtifacts = await fetch(`${workerBaseUrl}/v1/artifacts?taskId=${encodeURIComponent(cloudTaskId)}`);
  assert.equal(unauthorizedArtifacts.status, 401, 'The real tenant Worker must reject artifact listing without its worker token');
  const artifactListResponse = await fetch(`${workerBaseUrl}/v1/artifacts?taskId=${encodeURIComponent(cloudTaskId)}`, { headers: { authorization: `Bearer ${workerToken}` } });
  assert.equal(artifactListResponse.status, 200);
  const artifactList = await artifactListResponse.json() as { artifacts: { path: string; name: string; mediaType: string; size: number; previewable: boolean }[] };
  assert.deepEqual(artifactList.artifacts, [
    { path: 'runtime-persistence.txt', name: 'runtime-persistence.txt', mediaType: 'text/plain', size: Buffer.byteLength(cloudTaskId), previewable: true },
    { path: 'tetris.html', name: 'tetris.html', mediaType: 'text/html', size: Buffer.byteLength(tetrisHtml), previewable: true },
  ]);
  const artifactResponse = await fetch(`${workerBaseUrl}/v1/artifact?${new URLSearchParams({ taskId: cloudTaskId, path: 'tetris.html' })}`, { headers: { authorization: `Bearer ${workerToken}` } });
  assert.equal(artifactResponse.status, 200);
  assert.equal(artifactResponse.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(artifactResponse.headers.get('x-dots-artifact-previewable'), 'true');
  assert.equal(await artifactResponse.text(), tetrisHtml);
  console.log('The real tenant Worker authenticated and served the task-scoped HTML game artifact');

  const artifactCard = page.locator('[data-testid="task-artifact"][data-artifact-path="tetris.html"]');
  await artifactCard.waitFor({ state: 'visible', timeout: 30_000 });
  const preview = page.frameLocator('[data-testid="task-artifact-preview"]').locator('#demo-artifact');
  await preview.filter({ hasText: '俄罗斯方块预览' }).waitFor({ state: 'visible', timeout: 20_000 });
  assert.equal((await preview.textContent())?.trim(), '俄罗斯方块预览', 'The completed real cloud task must render its HTML artifact in the conversation');
  const downloadPromise = page.waitForEvent('download');
  await artifactCard.getByRole('link', { name: '下载' }).click();
  assert.equal((await downloadPromise).suggestedFilename(), 'tetris.html', 'The task file must be downloadable from its chat card');
  await artifactCard.getByTestId('open-artifact-in-computer').click();
  await page.locator('[data-testid="computer-workspace"]').waitFor({ state: 'visible', timeout: 20_000 });
  const openedArtifact = await page.waitForFunction(async taskId => {
    const response = await fetch('/api/computer', { cache: 'no-store' });
    if (!response.ok) return false;
    const state = await response.json() as { owner?: string; url?: string };
    return state.owner === 'user' && state.url === `file:///workspace/tasks/${taskId}/tetris.html` ? { owner: state.owner, url: state.url } : false;
  }, cloudTaskId, { timeout: 30_000 }).then(handle => handle.jsonValue()) as { owner: string; url: string };
  assert.deepEqual(openedArtifact, { owner: 'user', url: `file:///workspace/tasks/${cloudTaskId}/tetris.html` });
  await page.getByRole('button', { name: 'Return control' }).click();
  await page.getByRole('status').filter({ hasText: 'Dot has control' }).waitFor({ state: 'visible' });
  console.log('Chrome displayed the generated game, downloaded it, opened it in the real cloud browser, and returned control');

  await page.getByRole('button', { name: '电脑', exact: true }).click();
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

  const rendererHangScript = [
    "const targets = await fetch(\"http://127.0.0.1:9222/json/list\").then(response => response.json());",
    "const target = targets.find(entry => entry.type === \"page\");",
    "if (!target) throw new Error(\"No Chromium page target is available\");",
    "const socket = new WebSocket(target.webSocketDebuggerUrl);",
    "await new Promise((resolve, reject) => { socket.addEventListener(\"open\", resolve, { once: true }); socket.addEventListener(\"error\", reject, { once: true }); });",
    "socket.send(JSON.stringify({ id: 1, method: \"Runtime.evaluate\", params: { expression: \"while (true) {}\", awaitPromise: false } }));",
    "setTimeout(() => { socket.close(); process.exit(0); }, 150);",
  ].join('\n');
  const originalChromiumPid = command(['kubectl', '-n', namespace, 'exec', desktopPod, '-c', 'desktop', '--', 'cat', '/tmp/dots-chrome.pid']);
  command(['kubectl', '-n', namespace, 'exec', desktopPod, '-c', 'desktop', '--', 'node', '--input-type=module', '-e', rendererHangScript]);
  console.log('Injected a renderer-only hang into the disposable K3D tenant');

  const recoveryDeadline = Date.now() + 90_000;
  let currentChromiumPid = originalChromiumPid;
  let computerReady = false;
  while (Date.now() < recoveryDeadline) {
    currentChromiumPid = command(['kubectl', '-n', namespace, 'exec', desktopPod, '-c', 'desktop', '--', 'cat', '/tmp/dots-chrome.pid']);
    if (currentChromiumPid !== originalChromiumPid) {
      computerReady = await page.evaluate(async () => {
        try {
          const response = await fetch('/api/computer', { signal: AbortSignal.timeout(4_000) });
          if (!response.ok) return false;
          const result = await response.json() as { backend?: string };
          return result.backend === 'linux-desktop';
        } catch { return false; }
      });
      if (computerReady) break;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1000));
  }
  assert.notEqual(currentChromiumPid, originalChromiumPid, 'The desktop supervisor must restart only Chromium after a renderer hang');
  assert(computerReady, 'The cloud computer state API must recover after Chromium is relaunched');
  command(['kubectl', '-n', namespace, 'wait', '--for=condition=Ready', `pod/${desktopPod}`, '--timeout=120s']);
  const recoveredComputer = await page.evaluate(async () => {
    const response = await fetch('/api/computer');
    return { status: response.status, body: await response.json() as { backend?: string; error?: string } };
  });
  assert.equal(recoveredComputer.status, 200, `Cloud computer state must recover after the renderer restart: ${recoveredComputer.body.error || ''}`);
  assert.equal(recoveredComputer.body.backend, 'linux-desktop');
  assert.equal(command(['kubectl', '-n', namespace, 'exec', desktopPod, '-c', 'desktop', '--', 'cat', workspacePath]), runtimeTaskId, 'Renderer recovery must preserve the tenant workspace PVC');
  const podAfterRendererRecovery = JSON.parse(command(['kubectl', '-n', namespace, 'get', 'pod', desktopPod, '-o', 'json'])) as {
    status?: { containerStatuses?: { name: string; restartCount: number }[] };
  };
  const desktopContainerAfterRecovery = podAfterRendererRecovery.status?.containerStatuses?.find(container => container.name === 'desktop');
  assert.equal(desktopContainerAfterRecovery?.restartCount, 0, 'Renderer recovery must not restart the cloud-computer container or Agent runtime');
  const agentHealth = JSON.parse(command(['kubectl', '-n', namespace, 'exec', desktopPod, '-c', 'desktop', '--', 'node', '-e', "fetch('http://127.0.0.1:8083/healthz').then(async response => { console.log(JSON.stringify({ status: response.status, body: await response.json() })); process.exit(response.ok ? 0 : 1); })"])) as { status?: number; body?: { runtime?: string } };
  assert.equal(agentHealth.status, 200);
  assert.equal(agentHealth.body?.runtime, 'dots-agent-runtime', 'The Agent runtime must remain available during renderer recovery');
  console.log('Chromium renderer recovered in place; Agent runtime and tenant workspace remained available');

  command(['kubectl', '-n', namespace, 'delete', 'pod', desktopPod, '--wait=true', '--timeout=90s']);
  command(['kubectl', '-n', namespace, 'wait', '--for=condition=Ready', 'pod', '-l', 'app=desktop', '--timeout=120s']);
  const restartedPod = command(['kubectl', '-n', namespace, 'get', 'pod', '-l', 'app=desktop', '-o', 'jsonpath={.items[0].metadata.name}']);
  assert.notEqual(restartedPod, desktopPod, 'Kubernetes must replace the deleted tenant desktop Pod');
  assert.equal(command(['kubectl', '-n', namespace, 'exec', restartedPod, '--', 'cat', workspacePath]), runtimeTaskId, 'The tenant workspace artifact must survive a desktop Pod restart');
  console.log('Tenant Agent artifact survived recreation of the Debian 13 desktop Pod');
  console.log(JSON.stringify({ result: 'passed', cluster, namespace, evidence: ['real Debian 13 Trixie desktop Pod with Node.js 22', '1440x900 nonblank screenshot', 'live noVNC canvas and WebSocket', 'Chrome-created task routed through the host service to the tenant Agent runtime', 'shared Model API profile delivered to the adapter via stdin and excluded from its environment and task result', 'authenticated task artifact listing and read through the live Worker API', 'Chrome chat HTML preview, download, cloud-browser open, and return control', 'browser navigate/click/type', 'takeover and return', 'renderer hang triggered Chromium-only recovery', 'Agent runtime and tenant workspace remained available during renderer recovery', 'workspace artifact survives Pod recreation'], artifacts }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => undefined);
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.join('')}`);
} finally {
  agentPortForward?.kill('SIGTERM');
  workerPortForward?.kill('SIGTERM');
  await page?.context().close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  if (appServer && appServer.exitCode === null) {
    const exited = new Promise<void>(resolvePromise => appServer!.once('exit', () => resolvePromise()));
    appServer.kill('SIGTERM');
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const exitedGracefully = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>(resolvePromise => { exitTimer = setTimeout(() => resolvePromise(false), 5_000); }),
    ]);
    if (exitTimer) clearTimeout(exitTimer);
    if (!exitedGracefully && appServer.exitCode === null && appServer.signalCode === null) {
      appServer.kill('SIGKILL');
      await exited;
    }
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
