import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { Duplex } from 'node:stream';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { PNG } from 'pngjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifacts = resolve(projectRoot, 'artifacts', 'e2e', `linux-cloud-computer-${stamp}`);
const tempRoot = await mkdtemp(join(tmpdir(), 'coke-dots-cloud-e2e-'));
const envFile = join(tempRoot, 'empty.env');
const dataDirectory = join(tempRoot, 'data');
const signingKey = 'coke-dots-linux-cloud-computer-e2e-signing-key';
const screen = makeScreen();
const machines = new Map<string, { owner: 'agent' | 'user'; url: string; title: string }>();
const workerTokens = new Map<string, string>();
const agentTokens = new Map<string, string>();
const agentCalls: Record<string, unknown>[] = [];
const agentTaskExecutions = new Map<string, Promise<{ status: string; message: string; sessionId: string }>>();
const agentExecutionCount = new Map<string, number>();
const browserActions: { hash: string; action: string }[] = [];
const remoteHttpPaths: string[] = [];
const remoteUpgradePaths: string[] = [];
const browserWebSocketEvents: string[] = [];
const remoteSocketEvents: string[] = [];
const remoteSockets = new Set<Duplex>();
let remoteServer: Server | null = null;
let appServer: ChildProcess | null = null;
let browser: Browser | null = null;
let page: Page | null = null;
let appPort = 0;
let remotePort = 0;
let baseUrl = '';
const logs: string[] = [];
const recoveryInstruction = 'E2E cloud task survives a control-plane restart';
let signalRecoveryStarted: () => void = () => undefined;
const recoveryStarted = new Promise<void>(resolvePromise => { signalRecoveryStarted = resolvePromise; });
let releaseRecovery: () => void = () => undefined;
const recoveryRelease = new Promise<void>(resolvePromise => { releaseRecovery = resolvePromise; });

await writeFile(envFile, '');
await mkdir(artifacts, { recursive: true });

function makeScreen() {
  const png = new PNG({ width: 1440, height: 1080 });
  for (let y = 0; y < png.height; y += 1) for (let x = 0; x < png.width; x += 1) {
    const offset = (png.width * y + x) << 2;
    png.data[offset] = 215 + (x % 28);
    png.data[offset + 1] = 221 + (y % 20);
    png.data[offset + 2] = 232;
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}

async function freePort() {
  const server = createNetServer();
  await new Promise<void>((resolvePromise, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function delay(milliseconds: number) {
  await new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error('Timed out waiting for the cloud computer E2E condition');
}

async function waitForAsyncPredicate(
  page: Page,
  predicate: (arg: any) => boolean | Promise<boolean>,
  arg?: any,
  options: { timeout?: number } = {},
) {
  await waitFor(() => page.evaluate(predicate, arg), options.timeout ?? 30_000);
}

function content(res: import('node:http').ServerResponse, status: number, type: string, value: Buffer | string) {
  if (res.destroyed || res.writableEnded) return;
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  res.writeHead(status, { 'content-type': type, 'content-length': bytes.length, 'cache-control': 'no-store' });
  res.end(bytes);
}

async function readJson(req: import('node:http').IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function ensureMachine(hash: string) {
  let machine = machines.get(hash);
  if (!machine) { machine = { owner: 'agent', url: 'https://example.test/', title: `Debian cloud computer ${hash.slice(0, 6)}` }; machines.set(hash, machine); }
  return machine;
}

async function startRemote() {
  remoteServer = createHttpServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
      remoteHttpPaths.push(`${req.method} ${requestUrl.pathname}`);
      const [hash, service, ...pathParts] = requestUrl.pathname.split('/').filter(Boolean);
      if (!hash || !service) return content(res, 404, 'text/plain', 'missing route');
      const route = `/${pathParts.join('/')}`;
      const machine = ensureMachine(hash);
      if (service === 'novnc' && req.method === 'GET' && route === '/vnc_lite.html') {
        const html = `<!doctype html><html><head><title>Mock noVNC</title></head><body><div id="top_bar">Mock viewer toolbar</div><div id="screen"><main id="mock-vnc" data-state="loading">Mock Debian VNC desktop</main></div><script>const ws=new WebSocket('ws://'+location.host+'/api/computer/novnc/websockify');ws.onopen=()=>document.querySelector('#mock-vnc').dataset.state='connected';ws.onerror=()=>document.querySelector('#mock-vnc').dataset.state='error';</script></body></html>`;
        return content(res, 200, 'text/html; charset=utf-8', html);
      }
      if (service === 'worker') {
        const token = String(req.headers.authorization || '');
        workerTokens.set(hash, token);
        if (!token.startsWith('Bearer ')) return content(res, 401, 'application/json', JSON.stringify({ error: 'missing worker token' }));
        if (route === '/v1/state' && req.method === 'GET') return content(res, 200, 'application/json', JSON.stringify({ ready: true, owner: machine.owner, url: machine.url, title: machine.title }));
        if (route === '/v1/control' && req.method === 'GET') return content(res, 200, 'application/json', JSON.stringify({ owner: machine.owner }));
        if (route === '/v1/control' && req.method === 'POST') { const body = await readJson(req); machine.owner = body.owner; return content(res, 200, 'application/json', JSON.stringify({ owner: machine.owner })); }
        if (route === '/v1/screenshot' && req.method === 'GET') return content(res, 200, 'image/png', screen);
        if (route === '/v1/commands' && req.method === 'POST') {
          const body = await readJson(req);
          browserActions.push({ hash, action: String(body.action || '') });
          if (body.action === 'navigate') { machine.url = String(body.url); machine.title = `Visited ${new URL(machine.url).hostname}`; }
          return content(res, 200, 'application/json', JSON.stringify({ ready: true }));
        }
      }
      if (service === 'agent') {
        const token = String(req.headers.authorization || '');
        agentTokens.set(hash, token);
        if (!token.startsWith('Bearer ')) return content(res, 401, 'application/json', JSON.stringify({ error: 'missing agent token' }));
        if (route === '/v1/tasks/run' && req.method === 'POST') {
          const body = await readJson(req);
          agentCalls.push(body);
          const taskId = String(body.taskId || '');
          const executionId = String(body.executionId || taskId);
          const key = `${hash}:${executionId}`;
          let execution = agentTaskExecutions.get(key);
          if (!execution) {
            agentExecutionCount.set(key, (agentExecutionCount.get(key) || 0) + 1);
            execution = (async () => {
              if (String(body.prompt || '').includes(recoveryInstruction)) {
                signalRecoveryStarted?.();
                await recoveryRelease;
              }
              return { status: 'done', message: `Cloud task completed in ${body.engine}`, sessionId: 'cloud-session-1' };
            })();
            agentTaskExecutions.set(key, execution);
          }
          return content(res, 200, 'application/json', JSON.stringify(await execution));
        }
      }
      content(res, 404, 'text/plain', 'not found');
    } catch {
      if (!res.headersSent) content(res, 500, 'text/plain', 'mock runtime failure');
      else res.destroy();
    }
  });
  remoteServer.on('upgrade', (req, socket) => {
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    remoteUpgradePaths.push(pathname);
    if (!/^[a-f0-9]{32}\/novnc\/websockify$/.test(pathname.slice(1))) { socket.destroy(); return; }
    const key = String(req.headers['sec-websocket-key'] || '');
    remoteSockets.add(socket);
    remoteSocketEvents.push(`request:${JSON.stringify({ hasKey: Boolean(key), host: req.headers.host, connection: req.headers.connection, upgrade: req.headers.upgrade })}`);
    socket.once('close', () => { remoteSockets.delete(socket); remoteSocketEvents.push('close'); });
    socket.once('error', error => remoteSocketEvents.push(`error:${error.message}`));
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    const written = socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    remoteSocketEvents.push(`response:${written}`);
    socket.on('data', () => undefined);
  });
  await new Promise<void>(resolvePromise => remoteServer!.listen(0, '127.0.0.1', resolvePromise));
  const address = remoteServer.address();
  assert(address && typeof address !== 'string');
  remotePort = address.port;
}

async function startApp() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test', DOTS_E2E_AUTH: '1', DOTS_ENV_FILE: envFile, DOTS_DATA_DIR: dataDirectory, DOTS_PORT: String(appPort),
      DOTS_KEYCHAIN_SERVICE: `com.cokepoppy.coke-dots.e2e-cloud-${randomUUID()}`,
      DOTS_COMPUTER_BACKEND: 'linux-desktop', DOTS_LINUX_DESKTOP_TOKEN_SECRET: signingKey,
      DOTS_LINUX_DESKTOP_TEST_WORKER_URL: `http://127.0.0.1:${remotePort}/{tenantHash}/worker/`,
      DOTS_LINUX_DESKTOP_TEST_NOVNC_URL: `http://127.0.0.1:${remotePort}/{tenantHash}/novnc/`,
      DOTS_LINUX_DESKTOP_TEST_AGENT_URL: `http://127.0.0.1:${remotePort}/{tenantHash}/agent/`,
      DOTS_DESKTOP_AGENT_ADAPTERS: 'dsh',
      DOTS_AGENT_KERNELS_JSON: JSON.stringify({ dsh: { command: 'node', args: ['/tmp/dots-dsh-adapter.mjs'] } }),
      GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', DOTS_MODEL_BASE_URL: 'https://api.deepseek.com', DOTS_MODEL_API_KEY: 'cloud-e2e-shared-api-key', DOTS_MODEL: 'deepseek-flash', DOTS_PI_ENABLED: '0', DOTS_DSH_BIN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { logs.push(String(chunk)); if (logs.length > 150) logs.splice(0, logs.length - 150); });
  const health = `http://127.0.0.1:${appPort}/api/health`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Cloud computer E2E service exited early (${child.exitCode}).\n${logs.join('')}`);
    try { if ((await fetch(health)).ok) return child; } catch { /* wait for listen */ }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  child.kill('SIGKILL');
  throw new Error(`Cloud computer E2E service did not start.\n${logs.join('')}`);
}

async function stopApp(child: ChildProcess | null) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>(resolvePromise => child.once('exit', () => resolvePromise()));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(5000)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function restartApp() {
  await stopApp(appServer);
  appServer = await startApp();
}

async function signIn(target: Page, email: string) {
  await target.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await target.locator('#e2e-email').fill(email);
  const navigation = target.waitForNavigation({ waitUntil: 'domcontentloaded' });
  await target.getByTestId('e2e-sign-in').click();
  await navigation;
  await target.getByTestId('app-shell').waitFor({ state: 'visible' });
  await target.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true');
  const onboarding = await target.evaluate(async () => {
    const response = await fetch('/api/profile', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupComplete: true, onboardingComplete: true }) });
    return response.status;
  });
  assert.equal(onboarding, 200, 'Complete first-run Dot setup for the isolated computer flow');
}

async function chooseComputer(target: Page) {
  await target.getByRole('button', { name: '电脑', exact: true }).click();
  await target.getByRole('status').filter({ hasText: 'Dot has control' }).waitFor({ state: 'visible', timeout: 20_000 });
  await target.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>('img[alt="Linux 云桌面画面"]');
    return Boolean(image?.complete && image.naturalWidth === 1440 && image.naturalHeight === 1080);
  }, null, { timeout: 20_000 });
}

try {
  await startRemote();
  appPort = await freePort();
  baseUrl = `http://127.0.0.1:${appPort}`;
  appServer = await startApp();
  browser = await chromium.launch({ executablePath: process.env.DOTS_CHROME_BIN || findChrome(), headless: true });
  const alphaContext = await browser.newContext({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 });
  page = await alphaContext.newPage();
  page.on('websocket', socket => {
    browserWebSocketEvents.push(`open:${socket.url()}`);
    socket.on('socketerror', error => browserWebSocketEvents.push(`error:${error}`));
    socket.on('close', () => browserWebSocketEvents.push(`close:${socket.url()}`));
  });

  await signIn(page, 'cloud-alpha@example.test');
  const engineState = await page.evaluate(async () => await (await fetch('/api/state')).json()) as { availableEngines: string[]; remoteEngines: string[] };
  const availableEngines = engineState.availableEngines;
  assert(availableEngines.includes('dsh'), 'The cloud workspace should expose its configured DeepSeek Harness adapter');
  assert(engineState.remoteEngines.includes('dsh'), 'The cloud workspace should identify DeepSeek Harness as running in its cloud computer');
  assert.equal(availableEngines.includes('claude'), false, 'Claude Code must remain unavailable in the cloud workspace UI and API');
  await page.evaluate(async () => {
    const response = await fetch('/api/computer-access', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ localComputer: false }) });
    if (!response.ok) throw new Error(`Could not disable local computer access: ${response.status}`);
  });

  await page.getByRole('button', { name: '电脑', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Dot has control' }).waitFor({ state: 'visible', timeout: 20_000 });
  await page.getByTestId('linux-desktop-stage').waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>('img[alt="Linux 云桌面画面"]');
    return Boolean(image?.complete && image.naturalWidth === 1440 && image.naturalHeight === 1080);
  }, null, { timeout: 20_000 });
  assert.equal(await page.locator('[data-testid="computer-access-disabled"]').count(), 0, 'Turning off local Chrome access must leave the tenant’s cloud computer available');
  const alphaHash = [...machines.keys()][0];
  assert(alphaHash, 'Opening cloud computer did not resolve a tenant runtime');
  assert.equal(workerTokens.get(alphaHash)?.startsWith('Bearer '), true);
  await page.screenshot({ path: join(artifacts, '01-agent-view.png') });

  await page.getByRole('button', { name: 'Take over' }).click();
  const vncFrame = page.getByTestId('linux-desktop-view');
  await vncFrame.waitFor({ state: 'visible' });
  const takeoverOutline = await page.getByTestId('linux-desktop-stage').evaluate(element => {
    const style = getComputedStyle(element);
    return { color: style.outlineColor, style: style.outlineStyle, width: style.outlineWidth, offset: style.outlineOffset };
  });
  assert.deepEqual(takeoverOutline, { color: 'rgb(236, 139, 63)', style: 'solid', width: '4px', offset: '-4px' }, 'Take over must outline the complete cloud desktop stage');
  const viewerToolbarDisplay = await page.frameLocator('[data-testid="linux-desktop-view"]').locator('#top_bar').evaluate(element => getComputedStyle(element).display);
  assert.equal(viewerToolbarDisplay, 'none', 'The source video shows the desktop canvas without the noVNC example toolbar');
  const viewerStyle = await page.frameLocator('[data-testid="linux-desktop-view"]').locator('style[data-coke-dots-viewer]').textContent();
  assert.match(viewerStyle || '', /#screen\{flex:1;min-height:0;width:100%/);
  try {
    await page.waitForFunction(() => {
      const frame = document.querySelector<HTMLIFrameElement>('[data-testid="linux-desktop-view"]');
      return frame?.contentDocument?.querySelector('#mock-vnc')?.getAttribute('data-state') === 'connected';
    }, null, { timeout: 15_000 });
  } catch (error) {
    const frameState = await page.locator('[data-testid="linux-desktop-view"]').evaluate(element => {
      const frame = element as HTMLIFrameElement;
      return { src: frame.src, readyState: frame.contentDocument?.readyState, body: frame.contentDocument?.body?.innerText, state: frame.contentDocument?.querySelector('#mock-vnc')?.getAttribute('data-state') };
    }).catch(() => null);
    throw new Error(`Mock noVNC WebSocket did not connect: ${JSON.stringify({ frameState, remoteHttpPaths, remoteUpgradePaths, browserWebSocketEvents, remoteSocketEvents })}; ${error instanceof Error ? error.message : String(error)}`);
  }
  const browserControl = await page.evaluate(async () => {
    const statuses: number[] = [];
    for (const [path, body] of [
      ['/api/computer/navigate', { url: 'https://example.test/cloud-e2e' }],
      ['/api/computer/click', { x: 320, y: 240 }],
      ['/api/computer/type', { text: 'cloud browser E2E' }],
    ] as const) {
      const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      statuses.push(response.status);
    }
    return statuses;
  });
  assert.deepEqual(browserControl, [200, 200, 200], 'Takeover must enable authenticated remote browser input');
  assert.deepEqual(browserActions.filter(entry => entry.hash === alphaHash).map(entry => entry.action).slice(-3), ['navigate', 'click', 'type']);
  assert.equal(machines.get(alphaHash)?.url, 'https://example.test/cloud-e2e');
  await page.screenshot({ path: join(artifacts, '02-user-takeover.png') });

  await page.getByRole('button', { name: 'Return control' }).click();
  await page.getByRole('status').filter({ hasText: 'Dot has control' }).waitFor({ state: 'visible' });
  await page.locator('img[alt="Linux 云桌面画面"]').waitFor({ state: 'visible' });

  const created = await page.evaluate(async () => {
    const response = await fetch('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction: 'E2E cloud Agent task', engine: 'dsh' }) });
    return { status: response.status, task: await response.json() as { id: string } };
  });
  assert.equal(created.status, 201);
  await waitForAsyncPredicate(page, async id => {
    const response = await fetch('/api/state');
    const state = await response.json() as { tasks: { id: string; status: string }[] };
    return state.tasks.find(task => task.id === id)?.status === 'done';
  }, created.task.id, { timeout: 20_000 });
  const debugState = await page.evaluate(async () => await fetch('/api/state').then(response => response.json()) as { availableEngines: string[]; tasks: { id: string; engine: string; status: string; result: string | null; error: string | null }[] });
  assert.equal(agentCalls.length, 1, `Expected one remote Agent dispatch; created=${JSON.stringify(created)}, state=${JSON.stringify(debugState.tasks.find(task => task.id === created.task.id))}, engines=${JSON.stringify(debugState.availableEngines)}, calls=${JSON.stringify(agentCalls)}, remotePaths=${JSON.stringify(remoteHttpPaths.slice(-40))}, logs=${logs.join('')}`);
  assert.equal(agentCalls[0].engine, 'dsh');
  assert.equal(agentCalls[0].cwd, `tasks/${created.task.id}`);
  assert.equal('computer' in agentCalls[0], false, 'The host must not forward a raw browser Worker token to the cloud Agent runtime');
  await page.screenshot({ path: join(artifacts, '03-agent-task-done.png') });

  await page.getByRole('button', { name: '你的 dot', exact: true }).click();
  await page.locator('.composer-bottom select').selectOption('dsh');
  assert.equal(await page.locator('small.hint').textContent(), '任务由 Dot 的云电脑运行。', 'The composer must identify the actual remote execution location');
  await page.getByTestId('task-composer').fill(recoveryInstruction);
  await page.locator('button.send').click();
  await Promise.race([recoveryStarted, delay(20_000).then(() => { throw new Error('Chrome-created recovery task never reached the cloud Agent runtime'); })]);
  const recoveryTask = await page.evaluate(async instruction => {
    const state = await fetch('/api/state').then(response => response.json()) as { tasks: { id: string; instruction: string; status: string }[] };
    return state.tasks.find(task => task.instruction === instruction) || null;
  }, recoveryInstruction);
  assert(recoveryTask, 'The Chrome composer click must create the recovery task');
  assert.equal(recoveryTask.status, 'working');

  await restartApp();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId('app-shell').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true');
  await waitForAsyncPredicate(page, async id => {
    const response = await fetch('/api/state');
    const state = await response.json() as { tasks: { id: string; status: string }[] };
    return state.tasks.find(task => task.id === id)?.status === 'working';
  }, recoveryTask.id);
  await waitFor(() => agentCalls.filter(call => call.taskId === recoveryTask.id).length === 2, 15_000);
  const recoveryExecutionId = String(agentCalls.find(call => call.taskId === recoveryTask.id)?.executionId || '');
  assert(recoveryExecutionId, 'The cloud Agent dispatch must carry a durable execution identity');
  const recoveryKey = `${alphaHash}:${recoveryExecutionId}`;
  assert.equal(agentExecutionCount.get(recoveryKey), 1, 'A recovered dispatch must attach to the original cloud Agent execution');
  releaseRecovery();
  await page.getByRole('button', { name: 'Activity' }).click();
  const recoveredCard = page.locator('.task-card').filter({ hasText: recoveryInstruction });
  await recoveredCard.locator('.pill.done').waitFor({ state: 'visible', timeout: 20_000 });
  assert.equal(agentExecutionCount.get(recoveryKey), 1, 'The cloud Agent task must execute once across the Coke Dots service restart');
  await page.screenshot({ path: join(artifacts, '03b-agent-task-recovered-after-control-plane-restart.png') });

  const betaContext = await browser.newContext({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 });
  const betaPage = await betaContext.newPage();
  await signIn(betaPage, 'cloud-beta@example.test');
  await chooseComputer(betaPage);
  const betaHash = [...machines.keys()].find(hash => hash !== alphaHash);
  assert(betaHash, 'Second tenant did not receive its own desktop identity');
  assert.notEqual(workerTokens.get(alphaHash), workerTokens.get(betaHash), 'Tenant browser worker bearer tokens were shared');
  const betaTask = await betaPage.evaluate(async () => {
    const response = await fetch('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction: 'Beta cloud Agent E2E task', engine: 'dsh' }) });
    return await response.json() as { id: string };
  });
  await waitForAsyncPredicate(betaPage, async id => {
    const state = await fetch('/api/state').then(response => response.json()) as { tasks: { id: string; status: string }[] };
    return state.tasks.find(task => task.id === id)?.status === 'done';
  }, betaTask.id, { timeout: 20_000 });
  assert.notEqual(agentTokens.get(alphaHash), agentTokens.get(betaHash), 'Tenant Agent runtime bearer tokens were shared');
  assert.notEqual(machines.get(alphaHash), machines.get(betaHash), 'Tenants shared one desktop state object');
  await betaPage.screenshot({ path: join(artifacts, '04-beta-isolated-desktop.png') });
  await betaContext.close();
  await alphaContext.close();
  console.log(JSON.stringify({ result: 'passed', checks: ['cloud screenshot', 'local permission independence', 'authenticated noVNC WebSocket proxy', 'takeover browser navigation/click/type', 'return control', 'remote Agent kernel dispatch', 'Chrome-created task recovers after control-plane restart without duplicate execution', 'tenant token and runtime separation'], artifacts }, null, 2));
} catch (error) {
  if (page) await page.screenshot({ path: join(artifacts, 'failure.png'), fullPage: true }).catch(() => undefined);
  throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.join('')}`);
} finally {
  releaseRecovery();
  await page?.context().close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await stopApp(appServer);
  for (const socket of remoteSockets) socket.destroy();
  await new Promise<void>(resolvePromise => remoteServer?.close(() => resolvePromise()) || resolvePromise());
  await rm(tempRoot, { recursive: true, force: true });
}

function findChrome() {
  const candidates = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  const candidate = candidates.find(existsSync);
  if (!candidate) throw new Error('Chrome not found; set DOTS_CHROME_BIN.');
  return candidate;
}
