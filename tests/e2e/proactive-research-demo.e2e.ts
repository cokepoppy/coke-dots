import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page, type Video } from 'playwright-core';
import { execFileSync } from 'node:child_process';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outputRoot = join(projectRoot, 'artifacts', 'demos', 'proactive-release-date-conflict');
const videoOutput = join(outputRoot, 'proactive-release-date-conflict.webp');
const sourceDraft = 'Draft the launch announcement using October 21 as the launch date. Keep it open and wait for approval before sending.';
const sourceDecision = 'The release team confirmed today that launch moves to October 22. Summarize the decision for me.';
const finding = 'I noticed the release decision moves launch to October 22, while the open launch announcement still says October 21. Would you like me to update that draft? I have not changed or sent it.';
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
          assert.match(user, /October 21/);
          assert.match(user, /October 22/);
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
      DOTS_KEYCHAIN_SERVICE: `com.cokepoppy.coke-dots.proactive-demo-${randomUUID()}`,
      DOTS_PORT: String(port),
      DOTS_MODEL_BASE_URL: modelBaseUrl,
      DOTS_MODEL_API_KEY: 'e2e-proactive-demo-only',
      DOTS_MODEL: 'proactive-demo-model',
      DOTS_PI_ENABLED: '0',
      DOTS_COMPUTER_BACKEND: '',
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

async function waitForTask(pageToWait: Page, predicate: string) {
  await pageToWait.waitForFunction(async expression => {
    const state = await fetch('/api/state').then(response => response.json()) as { tasks: Record<string, unknown>[] };
    const check = new Function('task', `return (${expression})`) as (task: Record<string, unknown>) => boolean;
    return state.tasks.some(check);
  }, predicate, { timeout: 30_000 });
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(join(outputRoot, 'screenshots'), { recursive: true });
await writeFile(emptyEnvFile, '');
const modelBaseUrl = await startModel();
const port = await reservePort();
baseUrl = `http://127.0.0.1:${port}`;

try {
  assert(chromePath, 'Chrome was not found; set DOTS_CHROME_BIN.');
  await startServer(port, modelBaseUrl);
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, recordVideo: { dir: outputRoot, size: { width: 1440, height: 1000 } } });
  page = await context.newPage();
  pageVideo = page.video();
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));

  await signIn(page);
  console.log('STEP signed in');
  await new Promise(resolvePromise => setTimeout(resolvePromise, 900));
  await page.screenshot({ path: join(outputRoot, 'screenshots', '00-dot-ready.png') });

  await submitTask(page, sourceDraft);
  await waitForTask(page, `task.instruction === ${JSON.stringify(sourceDraft)} && task.status === 'waiting'`);
  await page.locator('.timeline .message.dot p').filter({ hasText: 'Draft ready for review' }).waitFor({ state: 'visible' });
  await page.screenshot({ path: join(outputRoot, 'screenshots', '01-launch-draft-waiting.png') });
  console.log('STEP open launch draft is waiting');
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1_800));

  await page.getByRole('button', { name: '新聊天', exact: true }).click();
  console.log('STEP opened a fresh chat');
  await submitTask(page, sourceDecision);
  console.log('STEP submitted the new release decision');
  await page.locator('.timeline .message.dot p').filter({ hasText: 'The release decision moves launch to October 22.' }).waitFor({ state: 'visible' });
  await waitForTask(page, `task.instruction === ${JSON.stringify(sourceDecision)} && task.status === 'done'`);
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1_800));

  await waitForTask(page, `task.executionMode === 'proactive-research' && task.status === 'done' && String(task.result || '').includes('October 21')`);
  console.log('STEP proactive review found the conflicting dates');
  const state = await page.evaluate(async () => await (await fetch('/api/state')).json()) as {
    tasks: { id: string; instruction: string; status: string; executionMode: string; result: string | null }[];
  };
  const draftTask = state.tasks.find(task => task.instruction === sourceDraft);
  const decisionTask = state.tasks.find(task => task.instruction === sourceDecision);
  const reviewTask = state.tasks.find(task => task.executionMode === 'proactive-research' && task.result?.includes('October 21'));
  assert.equal(draftTask?.status, 'waiting', 'The original draft must remain open for approval');
  assert.equal(decisionTask?.status, 'done');
  assert(reviewTask, 'The completed work should trigger an autonomous context review');
  assert.match(reviewTask.result || '', /October 22.*October 21|October 21.*October 22/);
  assert.equal(await page.evaluate(async () => await fetch('/api/pages').then(response => response.json()).then((pages: unknown[]) => pages.length)), 0, 'The proactive review must not write a Scratchpad page');
  assert.equal(await page.evaluate(async () => await fetch('/api/dot-memories').then(response => response.json()).then((notes: unknown[]) => notes.length)), 0, 'The proactive review must not write personal Dot memory');
  assert.equal(modelRequests.filter(request => request.user.includes('Proactive research constraints')).length, 1);

  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  const proactiveCard = page.getByTestId(`task-card-${reviewTask.id}`);
  await proactiveCard.waitFor({ state: 'visible' });
  await proactiveCard.getByText('Dot 主动研究 · 只读', { exact: true }).waitFor({ state: 'visible' });
  await proactiveCard.getByText(finding, { exact: true }).waitFor({ state: 'visible' });
  const activityFinding = page.getByTestId('activity-feed').getByTestId('activity-entry').filter({ hasText: finding });
  await activityFinding.waitFor({ state: 'visible' });
  await page.screenshot({ path: join(outputRoot, 'screenshots', '02-proactive-finding-in-activity.png') });
  await new Promise(resolvePromise => setTimeout(resolvePromise, 2_500));

  await proactiveCard.getByRole('button', { name: /查看详情/ }).click();
  await page.locator('.timeline .message.dot p').filter({ hasText: finding }).waitFor({ state: 'visible' });
  await page.screenshot({ path: join(outputRoot, 'screenshots', '03-proactive-finding-detail.png') });
  await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000));
  assert.deepEqual(browserErrors, [], `Browser runtime errors: ${browserErrors.join('; ')}`);
  assert.deepEqual(mockErrors, [], `Model fixture errors: ${mockErrors.join('; ')}`);
  assert.equal(modelRequests.length, 3, `Expected draft, decision and autonomous review calls; received ${modelRequests.length}`);
  assert.match(modelRequests[2].user, /October 21/);
  assert.match(modelRequests[2].user, /October 22/);

  console.log(`Proactive demo E2E passed: ${baseUrl}`);
} finally {
  await context?.close().catch(() => undefined);
  context = null;
  await browser?.close().catch(() => undefined);
  browser = null;
  await stopServer();
  if (modelServer) await new Promise<void>(resolvePromise => modelServer!.close(() => resolvePromise()));
  await writeFile(join(outputRoot, 'server.log'), serverLogs.join(''));
  await writeFile(join(outputRoot, 'e2e-debug.json'), JSON.stringify({ mockErrors, modelCalls: modelRequests.length, proactiveReviewSeen: modelRequests.some(request => request.user.includes('Proactive research constraints')) }, null, 2) + '\n');
  await rm(tempRoot, { recursive: true, force: true });
}

const recording = pageVideo ? await pageVideo.path().catch(() => '') : '';
assert(recording && existsSync(recording), 'Chrome did not produce the demo WebM recording');
const converter = join(projectRoot, 'scripts', 'convert-demo-video-to-webp.mjs');
execFileSync(process.execPath, [converter, recording, videoOutput], { cwd: projectRoot, stdio: 'inherit' });
await writeFile(join(outputRoot, 'manifest.json'), JSON.stringify({
  scenario: 'An open launch draft says October 21; a later release decision says October 22. Dot detects and reports the conflict without editing or sending anything.',
  reference: 'https://learn.chatgpt.com/docs/dots/tasks-and-memory',
  evidence: 'Official documentation supports proactive review of connected information and surfacing suggestions/questions; the exact UI shown is Coke Dots.',
  recording: 'proactive-release-date-conflict.webp',
  sourceRecording: 'Playwright Chrome recording, converted to animated WebP',
  viewport: { width: 1440, height: 1000 },
  screenshots: ['screenshots/00-dot-ready.png', 'screenshots/01-launch-draft-waiting.png', 'screenshots/02-proactive-finding-in-activity.png', 'screenshots/03-proactive-finding-detail.png'],
  modelCalls: modelRequests.length,
  model: 'Deterministic local E2E fixture; no live provider request',
}, null, 2) + '\n');

assert(existsSync(videoOutput), `Expected shareable animated WebP at ${videoOutput}`);
console.log(`Animated WebP: ${videoOutput}`);
