import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const distRoot = join(projectRoot, 'dist');
const basePath = '/dots-demo';
const artifactRoot = resolve(process.env.DOTS_E2E_ARTIFACTS || join(projectRoot, 'artifacts', 'e2e', `base-path-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const tempRoot = await mkdtemp(join(tmpdir(), 'coke-dots-base-path-'));
const dataDir = join(tempRoot, 'data');
const envFile = join(tempRoot, 'empty.env');
const browserPath = process.env.DOTS_CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let backend: ChildProcess | null = null;
let proxy: Server | null = null;
let browser: Browser | null = null;
let page: Page | null = null;
const requests: string[] = [];
const pageErrors: string[] = [];

await mkdir(artifactRoot, { recursive: true });
await writeFile(envFile, '');

async function reservePort() {
  const server = createNetServer();
  await new Promise<void>((resolvePromise, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function waitForBackend(url: string) {
  const deadline = Date.now() + 20_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`backend returned HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw lastError instanceof Error ? lastError : new Error('Timed out waiting for the test backend');
}

function contentType(path: string) {
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' } as Record<string, string>)[extname(path)] || 'application/octet-stream';
}

async function main() {
  const backendPort = await reservePort();
  const frontendPort = 5173;
  backend = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DOTS_ENV_FILE: envFile,
      DOTS_DATA_DIR: dataDir,
      DOTS_PORT: String(backendPort),
      DOTS_E2E_AUTH: '1',
      DOTS_VOICE_PROVIDER: 'volcengine',
      DOTS_VOLCENGINE_API_KEY: 'e2e-seedduplex-secret',
      GOOGLE_CLIENT_ID: 'coke-dots-base-path-e2e.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'coke-dots-base-path-e2e-secret',
      DOTS_COMPUTER_BACKEND: 'mock',
    },
    stdio: 'ignore',
  });
  await waitForBackend(`http://127.0.0.1:${backendPort}/api/auth/config`);

  proxy = createHttpServer((incoming, outgoing) => {
    const incomingUrl = new URL(incoming.url || '/', `http://127.0.0.1:${frontendPort}`);
    if (incomingUrl.pathname.startsWith(`${basePath}/api/`)) {
      const upstream = httpRequest({
        hostname: '127.0.0.1', port: backendPort, method: incoming.method,
        path: `${incomingUrl.pathname.slice(basePath.length)}${incomingUrl.search}`,
        headers: { ...incoming.headers, host: `127.0.0.1:${frontendPort}` },
      }, response => {
        outgoing.writeHead(response.statusCode || 502, response.headers);
        response.pipe(outgoing);
      });
      upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      incoming.pipe(upstream);
      return;
    }

    const relative = incomingUrl.pathname === `${basePath}/` || incomingUrl.pathname === basePath
      ? 'index.html'
      : incomingUrl.pathname.startsWith(`${basePath}/`)
        ? incomingUrl.pathname.slice(basePath.length + 1)
        : null;
    if (!relative) { outgoing.writeHead(404); outgoing.end('Not found'); return; }
    const filePath = resolve(distRoot, relative);
    if (!filePath.startsWith(`${distRoot}${sep}`) && filePath !== join(distRoot, 'index.html')) { outgoing.writeHead(400); outgoing.end(); return; }
    createReadStream(filePath)
      .once('error', () => { if (!outgoing.headersSent) outgoing.writeHead(404); outgoing.end('Not found'); })
      .once('open', () => { outgoing.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': 'no-store' }); })
      .pipe(outgoing);
  });
  await new Promise<void>((resolvePromise, reject) => proxy!.once('error', reject).listen(frontendPort, '127.0.0.1', resolvePromise));

  const baseUrl = `http://127.0.0.1:${frontendPort}${basePath}/`;
  browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  page = await context.newPage();
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === new URL(baseUrl).origin) requests.push(`${request.method()} ${url.pathname}`);
  });
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '让你的个人代理持续推进工作' }).waitFor({ state: 'visible' });
  assert.equal(await page.getByText('需要配置 Google OAuth').count(), 0, 'OAuth configuration must load from the prefixed API path');
  const googleLogin = page.getByRole('link', { name: '使用 Google 登录' });
  await googleLogin.waitFor({ state: 'visible' });
  assert.equal(new URL(await googleLogin.getAttribute('href') || '', baseUrl).pathname, `${basePath}/api/auth/google/start`);
  const googleLoginBounds = await googleLogin.boundingBox();
  assert(googleLoginBounds && googleLoginBounds.height >= 48 && googleLoginBounds.x >= 0 && googleLoginBounds.x + googleLoginBounds.width <= 390,
    'The real Google login action must be visible and touch-sized on a phone viewport');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    'The mobile Google login page must not overflow horizontally');
  await page.screenshot({ path: join(artifactRoot, 'base-path-login.png'), fullPage: true });

  let googleAuthorizeUrl = '';
  await page.route(`**${basePath}/api/auth/google/start`, async route => {
    const response = await route.fetch({ maxRedirects: 0 });
    assert.equal(response.status(), 302, 'The Google OAuth start route must return an authorization redirect');
    googleAuthorizeUrl = response.headers().location || '';
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<main><h1>Mock OAuth redirect captured</h1></main>' });
  });
  await googleLogin.click();
  await page.getByRole('heading', { name: 'Mock OAuth redirect captured' }).waitFor({ state: 'visible' });
  assert(googleAuthorizeUrl, 'The mobile Google button must reach the Google authorization redirect');
  const authorization = new URL(googleAuthorizeUrl);
  assert.equal(authorization.origin, 'https://accounts.google.com');
  assert.equal(authorization.searchParams.get('client_id'), 'coke-dots-base-path-e2e.apps.googleusercontent.com');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256', 'The OAuth redirect must retain PKCE');
  assert(authorization.searchParams.get('state'), 'The OAuth redirect must include a per-flow state token');
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  await page.getByTestId('e2e-sign-in').click();
  await page.getByTestId('app-shell').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    'The authenticated Coke Dots shell must load on mobile without horizontal overflow');
  await page.screenshot({ path: join(artifactRoot, 'base-path-mobile-authenticated-app.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '你的 dot', exact: true }).click();
  await page.getByTestId('computer-choice').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Continue' }).click();
  const onboardingStatus = await page.evaluate(async () => (await fetch('/dots-demo/api/profile', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ onboardingComplete: true }) })).status);
  assert.equal(onboardingStatus, 200, 'The E2E tenant should finish onboarding before checking the composer default');
  const fixtureTask = await page.evaluate(async () => {
    const response = await fetch('/dots-demo/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction: 'E2E scheduled fixture for Pi default', engine: 'pi', scheduleMinutes: 60 }) });
    return { status: response.status, body: await response.json() as { title?: string } };
  });
  assert.equal(fixtureTask.status, 201, 'A future-only fixture should make the chat composer available without running an Agent task');
  await page.getByRole('button', { name: /E2E scheduled fixture for Pi default/ }).click();
  await page.getByTestId('engine-select').waitFor({ state: 'visible' });
  assert.equal(await page.getByTestId('engine-select').inputValue(), 'pi', 'The public demo build must default to the Pi Agent kernel');
  const eventDeadline = Date.now() + 5_000;
  while (!requests.some(item => item === 'GET /dots-demo/api/events') && Date.now() < eventDeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  assert(requests.includes('GET /dots-demo/api/events'), 'The authenticated live event stream must use the prefixed API path');
  const providerResponse = await page.evaluate(async () => {
    const response = await fetch('/dots-demo/api/voice/provider');
    return { status: response.status, body: await response.json() };
  });
  assert.equal(providerResponse.status, 200, 'The voice provider API must resolve through the base path');
  assert.deepEqual(providerResponse.body, { provider: 'volcengine', configured: true, model: 'doubao-seedduplex-3.0' }, 'The prefixed API must report the configured Doubao SeedDuplex provider without exposing its API key');
  await page.screenshot({ path: join(artifactRoot, 'base-path-authenticated-app.png'), fullPage: true });

  const apiRequests = requests.filter(item => item.includes('/api/'));
  assert(apiRequests.length >= 5, `Expected authenticated API traffic, received: ${apiRequests.join(', ')}`);
  assert(apiRequests.every(item => item.includes(`${basePath}/api/`)), `A browser API request escaped the base path: ${apiRequests.join(', ')}`);
  assert.deepEqual(pageErrors, [], `Browser errors: ${pageErrors.join('; ')}`);
  console.log(JSON.stringify({ result: 'passed', baseUrl, apiRequests, pageErrors, screenshots: ['base-path-login.png', 'base-path-mobile-authenticated-app.png', 'base-path-authenticated-app.png'], artifactRoot }, null, 2));
  await context.close();
}

try {
  await main();
} finally {
  const browserInstance = browser as unknown as Browser | undefined;
  await browserInstance?.close().catch(() => undefined);
  const proxyServer = proxy as unknown as Server | undefined;
  if (proxyServer?.listening) await new Promise<void>(resolvePromise => proxyServer.close(() => resolvePromise()));
  const backendProcess = backend as unknown as ChildProcess | undefined;
  if (backendProcess?.exitCode === null) {
    backendProcess.kill('SIGTERM');
    await new Promise<void>(resolvePromise => {
      const timer = setTimeout(() => { backendProcess.kill('SIGKILL'); resolvePromise(); }, 3000);
      backendProcess.once('exit', () => { clearTimeout(timer); resolvePromise(); });
    });
  }
  await rm(tempRoot, { recursive: true, force: true });
}
