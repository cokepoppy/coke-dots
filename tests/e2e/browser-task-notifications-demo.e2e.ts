import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page, type Video } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const demosRoot = resolve(projectRoot, 'artifacts/demos');
const outputRoot = resolve(projectRoot, process.env.DOTS_BROWSER_NOTIFICATION_DEMO_OUTPUT_DIR || `artifacts/demos/browser-task-notifications-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const outputRelativePath = relative(demosRoot, outputRoot);
assert(outputRelativePath && !outputRelativePath.startsWith('..') && !isAbsolute(outputRelativePath), 'Demo output must be a new directory inside artifacts/demos.');
assert.equal(existsSync(outputRoot), false, `Refusing to overwrite an existing demo recording: ${outputRoot}`);

const scenarioPrompt = '帮我做一次本周发布准备检查：整理发布文案、图片素材、负责人三项状态，用中文总结。完成后提醒我；只汇总，不发送消息、不修改文件。';
const scenarioResult = '本周发布准备情况：\n\n• 发布文案：已完成\n• 图片素材：待最终确认\n• 负责人：林珂\n\n我只做了汇总，没有发送消息或修改文件。';
const videoFileName = 'browser-task-notifications.webp';
const videoOutput = join(outputRoot, videoFileName);
const tempRoot = await mkdtemp(join(tmpdir(), 'coke-dots-browser-notification-demo-'));
const dataDirectory = join(tempRoot, 'data');
const emptyEnvFile = join(tempRoot, 'empty.env');
const chromePath = [process.env.DOTS_CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find(path => path && existsSync(path));
const keychainService = `com.cokepoppy.coke-dots.browser-notification-demo-${randomUUID()}`;
const modelErrors: string[] = [];
const serverLogs: string[] = [];
let server: ChildProcess | null = null;
let modelServer: Server | null = null;
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let pageVideo: Video | null = null;
let baseUrl = '';
let modelCalls = 0;
let recordingStartedAt = 0;
const readablePausePointsSeconds: number[] = [];

function createHashFor(value: Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function markReadablePause() {
  readablePausePointsSeconds.push(Number(((Date.now() - recordingStartedAt) / 1000).toFixed(2)));
}

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
    if (request.method === 'GET' && request.url === '/browser-task-notifications.webp') {
      void readFile(videoOutput).then(bytes => {
        response.writeHead(200, { 'content-type': 'image/webp', 'cache-control': 'no-store' });
        response.end(bytes);
      }).catch(error => {
        modelErrors.push(error instanceof Error ? error.message : String(error));
        response.writeHead(500).end();
      });
      return;
    }
    if (request.method === 'GET' && request.url === '/playback') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end('<!doctype html><meta charset="utf-8"><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#eee}img{width:min(1152px,100vw);height:auto}</style><img id="demo" src="/browser-task-notifications.webp">');
      return;
    }
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      try {
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/v1/chat/completions');
        const payload = JSON.parse(raw) as { messages?: { role: string; content?: unknown }[] };
        const userMessage = String(payload.messages?.find(message => message.role === 'user')?.content || '');
        assert.match(userMessage, /本周发布准备检查/);
        assert.match(userMessage, /只汇总，不发送消息、不修改文件/);
        modelCalls++;
        // Leave a visible working state long enough for the demonstration to explain the flow.
        setTimeout(() => {
          if (response.destroyed) return;
          response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ status: 'done', message: scenarioResult }) } }] }));
        }, 2_700);
      } catch (error) {
        modelErrors.push(error instanceof Error ? error.message : String(error));
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Browser notification demo model fixture failed' }));
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
      DOTS_KEYCHAIN_SERVICE: keychainService,
      DOTS_PORT: String(port),
      DOTS_MODEL_BASE_URL: modelBaseUrl,
      DOTS_MODEL_API_KEY: 'local-browser-notification-demo-fixture',
      DOTS_MODEL: 'browser-notification-demo-model',
      DOTS_PI_ENABLED: '0',
      DOTS_AGENT_KERNELS_JSON: '',
      DOTS_DSH_BIN: '',
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

async function waitForTask(instruction: string, statuses: string[], timeoutMs = 20_000) {
  assert(page);
  const deadline = Date.now() + timeoutMs;
  let last: { id: string; instruction: string; status: string; result: string | null; error: string | null } | null = null;
  let terminalStatus = '';
  while (Date.now() < deadline) {
    last = await page.evaluate(async goal => {
      const state = await fetch('/api/state', { cache: 'no-store' }).then(response => response.json()) as { tasks: { id: string; instruction: string; status: string; result: string | null; error: string | null }[] };
      return state.tasks.find(task => task.instruction === goal) || null;
    }, instruction);
    if (last && statuses.includes(last.status) && last.status === terminalStatus) return last;
    terminalStatus = last && statuses.includes(last.status) ? last.status : '';
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
  }
  throw new Error(`Task did not remain in ${statuses.join('/')} until confirmed. Last state: ${JSON.stringify(last)}`);
}

try {
  assert(chromePath, 'Chrome was not found; set DOTS_CHROME_BIN.');
  await mkdir(join(outputRoot, 'screenshots'), { recursive: true });
  await writeFile(emptyEnvFile, '');
  const port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const modelBaseUrl = await startModel();
  await startServer(port, modelBaseUrl);
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, recordVideo: { dir: outputRoot, size: { width: 1440, height: 1000 } } });
  await context.addInitScript(`(() => {
    const records = [];
    let permission = 'default';
    const badge = document.createElement('div');
    badge.textContent = '演示模式 · 标签页在后台';
    badge.style.cssText = 'position:fixed;z-index:2147483000;top:12px;right:18px;padding:7px 11px;border:1px solid #d8d3dd;border-radius:999px;background:#fff;color:#605b67;font:12px -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 2px 10px #00000012';
    function DemoNotification(title, options = {}) {
      this.title = title;
      this.body = options.body || '';
      this.tag = options.tag || '';
      this._onclick = null;
      const card = document.createElement('button');
      card.type = 'button';
      card.setAttribute('aria-label', '浏览器通知预览：' + title + '，' + this.body);
      card.style.cssText = 'position:fixed;z-index:2147483647;right:24px;bottom:24px;width:370px;padding:17px 19px;border:1px solid #e7e3ea;border-radius:16px;background:#fff;color:#25232a;text-align:left;box-shadow:0 12px 40px #17132128;font:14px -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer;animation:dots-demo-notice-in .24s ease-out';
      card.innerHTML = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;color:#77717e;font-size:11px"><span style="display:grid;place-items:center;width:20px;height:20px;border-radius:6px;background:#f0eafa;color:#8061ad;font-weight:700">D</span><span>浏览器通知 · 演示预览</span><span style="margin-left:auto">现在</span></div><div style="font-weight:650;margin-bottom:5px"></div><div style="color:#6c6871;line-height:1.45"></div>';
      card.children[1].textContent = title;
      card.children[2].textContent = this.body;
      card.addEventListener('click', () => this._onclick?.(new Event('click')));
      this.element = card;
      this.close = () => card.remove();
      records.push(this);
      document.body.appendChild(card);
    }
    Object.defineProperty(DemoNotification.prototype, 'onclick', { get() { return this._onclick; }, set(value) { this._onclick = value; } });
    Object.defineProperty(DemoNotification, 'permission', { get() { return permission; } });
    Object.defineProperty(DemoNotification, 'requestPermission', { value: async () => { permission = 'granted'; return permission; } });
    Object.defineProperty(window, 'Notification', { configurable: true, value: DemoNotification });
    Object.defineProperty(window, '__dotsDemoNotifications', { configurable: true, value: records });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.addEventListener('DOMContentLoaded', () => {
      document.head.insertAdjacentHTML('beforeend', '<style>@keyframes dots-demo-notice-in{from{transform:translateY(12px);opacity:0}to{transform:translateY(0);opacity:1}}</style>');
      document.body.appendChild(badge);
    });
  })()`);
  page = await context.newPage();
  pageVideo = page.video();
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));

  recordingStartedAt = Date.now();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#e2e-email').fill('notification-demo@example.test');
  const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10_000 });
  await page.getByTestId('e2e-sign-in').click();
  await navigation;
  await page.getByTestId('app-shell').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true');
  await page.screenshot({ path: join(outputRoot, 'screenshots/00-ready.png') });

  await page.locator('.profile-link').click();
  await page.getByRole('heading', { name: '你的 dot', exact: true }).waitFor({ state: 'visible' });
  const preference = page.getByLabel('浏览器通知方式');
  assert.equal(await preference.inputValue(), 'never');
  await preference.selectOption('background');
  await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('select[aria-label="浏览器通知方式"]')?.value === 'background');
  assert.equal(await page.evaluate(() => (window as unknown as { Notification: { permission: string } }).Notification.permission), 'granted');
  await page.screenshot({ path: join(outputRoot, 'screenshots/01-background-notifications-enabled.png') });
  markReadablePause();
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1_600));

  await page.getByRole('button', { name: '新聊天', exact: true }).click();
  await page.getByTestId('task-composer').fill(scenarioPrompt);
  await page.locator('button.send').click();
  await page.locator('.timeline .message.user p').filter({ hasText: '本周发布准备检查' }).waitFor({ state: 'visible' });
  const task = await page.evaluate(async instruction => {
    const state = await fetch('/api/state', { cache: 'no-store' }).then(response => response.json()) as { tasks: { id: string; instruction: string; status: string }[] };
    return state.tasks.find(item => item.instruction === instruction) || null;
  }, scenarioPrompt);
  assert(task, 'The Chinese demo task was not created.');
  const working = await page.waitForFunction(async goal => {
    const state = await fetch('/api/state', { cache: 'no-store' }).then(response => response.json()) as { tasks: { instruction: string; status: string }[] };
    return state.tasks.some(item => item.instruction === goal && ['queued', 'working'].includes(item.status));
  }, scenarioPrompt, { timeout: 10_000 });
  assert(working, 'The task should visibly start before returning its result.');
  await page.getByRole('button', { name: 'Activity', exact: true }).first().click();
  await page.getByRole('heading', { name: 'Activity', exact: true }).waitFor({ state: 'visible' });
  await page.getByTestId(`task-card-${task.id}`).waitFor({ state: 'visible' });
  await page.screenshot({ path: join(outputRoot, 'screenshots/02-task-running.png') });
  markReadablePause();
  await new Promise(resolvePromise => setTimeout(resolvePromise, 1_200));

  const finished = await waitForTask(scenarioPrompt, ['done', 'failed']);
  assert.equal(finished?.status, 'done', `The demo task failed: ${finished?.error || '(no error)'}`);
  assert.equal(finished?.result, scenarioResult);
  assert.equal(modelCalls, 1, 'The demo should execute one actual Coke Dots task through its Model API adapter.');
  assert.deepEqual(modelErrors, []);
  await page.getByLabel(/浏览器通知预览/).waitFor({ state: 'visible' });
  const notification = await page.evaluate(() => {
    const item = (window as unknown as { __dotsDemoNotifications: { title: string; body: string; tag: string; onclick: ((event: Event) => void) | null }[] }).__dotsDemoNotifications.at(-1);
    return item ? { title: item.title, body: item.body, tag: item.tag, hasClickHandler: typeof item.onclick === 'function' } : null;
  });
  assert.deepEqual(notification && { title: notification.title, body: notification.body, hasClickHandler: notification.hasClickHandler }, { title: 'Dot', body: '有一项工作已完成。', hasClickHandler: true });
  assert.match(notification?.tag || '', /^coke-dots:/);
  assert.doesNotMatch(JSON.stringify(notification), /图片素材|负责人|scenarioPrompt/);
  await page.screenshot({ path: join(outputRoot, 'screenshots/03-background-completion-notification.png') });
  markReadablePause();
  await new Promise(resolvePromise => setTimeout(resolvePromise, 2_200));

  await page.getByLabel(/浏览器通知预览/).click();
  await page.locator('.timeline .message.user p').filter({ hasText: '本周发布准备检查' }).waitFor({ state: 'visible' });
  await page.locator('.timeline .message.dot p').filter({ hasText: '图片素材：待最终确认' }).waitFor({ state: 'visible' });
  await page.screenshot({ path: join(outputRoot, 'screenshots/04-notification-opens-task-result.png') });
  markReadablePause();
  await new Promise(resolvePromise => setTimeout(resolvePromise, 2_400));

  assert.deepEqual(browserErrors, [], `Chrome reported a page error: ${browserErrors.join('; ')}`);
  assert.deepEqual(modelErrors, []);
  const report = {
    scenario: 'A user assigns a read-only weekly launch readiness summary, switches to Work, receives a background completion alert, then opens the originating task from the alert.',
    locale: 'Chinese user prompt and Chinese task result',
    evidence: 'Chrome E2E against the Coke Dots Model API adapter and a deterministic local fixture. The notification card is a visible recorder mock of the browser Notification API; the E2E proves the app invokes that API, chooses safe generic copy, and binds click-through to the originating task. Native macOS notification presentation and Google OAuth are not exercised by this local demo.',
    recording: videoFileName,
    sourceRecording: 'Playwright Chrome video, converted to animated WebP at 1x active UI speed',
    viewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
    browserNotificationMode: 'background',
    readablePausePointsSeconds,
    readablePauseDurationSeconds: 2.5,
    task: { instruction: scenarioPrompt, result: scenarioResult, status: finished.status },
    notification: { title: notification?.title, body: notification?.body, containsTaskPromptOrResult: false, clickOpensTask: true },
    providerCalls: modelCalls,
    checks: { browserErrors: browserErrors.length, modelFixtureErrors: modelErrors.length, passed: true },
    screenshots: ['screenshots/00-ready.png', 'screenshots/01-background-notifications-enabled.png', 'screenshots/02-task-running.png', 'screenshots/03-background-completion-notification.png', 'screenshots/04-notification-opens-task-result.png'],
  };
  await context.close();
  context = null;
  const recording = pageVideo ? await pageVideo.path() : '';
  assert(recording && existsSync(recording), 'Chrome did not produce the browser notification demo WebM.');
  const sourceRecording = join(outputRoot, 'browser-task-notifications-source.webm');
  await copyFile(recording, sourceRecording);
  const converter = join(projectRoot, 'scripts/convert-demo-video-to-webp.mjs');
  execFileSync(process.execPath, [converter, sourceRecording, videoOutput, '2', '1', readablePausePointsSeconds.join(','), '2.5'], { cwd: projectRoot, stdio: 'inherit' });
  const decoded = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=codec_name,width,height,nb_read_frames', '-of', 'json', videoOutput], { encoding: 'utf8' })) as { streams: { codec_name: string; width: number; height: number; nb_read_frames: string }[] };
  const metadata = await sharp(videoOutput, { animated: true }).metadata();
  assert.equal(decoded.streams[0]?.codec_name, 'webp_anim');
  assert(Number(decoded.streams[0]?.nb_read_frames) > 200, 'WebP has too few decoded frames to be a complete UI recording.');
  assert.equal(Number(decoded.streams[0]?.nb_read_frames), metadata.pages, 'Every animated frame must decode.');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', videoOutput, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const playbackPage = await browser!.newPage({ viewport: { width: 1200, height: 900 } });
  await playbackPage.goto(`${modelBaseUrl.replace(/\/v1$/, '')}/playback`, { waitUntil: 'domcontentloaded' });
  const playbackImage = playbackPage.locator('#demo');
  await playbackImage.evaluate(element => (element as HTMLImageElement).decode());
  assert.equal(await playbackImage.evaluate(element => (element as HTMLImageElement).naturalWidth), decoded.streams[0]?.width);
  assert.equal(await playbackImage.evaluate(element => (element as HTMLImageElement).naturalHeight), decoded.streams[0]?.height);
  const browserPlaybackFrameHashes: string[] = [];
  for (let index = 0; index < 6; index++) {
    await playbackPage.waitForTimeout(index === 0 ? 100 : 2_000);
    browserPlaybackFrameHashes.push(createHashFor(await playbackPage.screenshot()));
  }
  const uniquePlaybackFrames = new Set(browserPlaybackFrameHashes).size;
  assert(uniquePlaybackFrames >= 4, `Chrome should display changing frames across the animated WebP; saw ${uniquePlaybackFrames} unique samples.`);
  await playbackPage.close();
  Object.assign(report, { browserPlayback: { decoded: true, sampledFrames: browserPlaybackFrameHashes.length, uniqueFrames: uniquePlaybackFrames, changingFramesVerified: true } });
  await writeFile(join(outputRoot, 'manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Browser notification demo directory: ${outputRoot}`);
  console.log(`Animated WebP: ${videoOutput} (${decoded.streams[0]?.nb_read_frames} frames, ${decoded.streams[0]?.width}x${decoded.streams[0]?.height})`);
} finally {
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  if (server) await stopServer().catch(() => undefined);
  const activeModelServer = modelServer as Server | null;
  if (activeModelServer?.listening) await new Promise<void>(resolvePromise => activeModelServer.close(() => resolvePromise()));
  await rm(tempRoot, { recursive: true, force: true });
}
