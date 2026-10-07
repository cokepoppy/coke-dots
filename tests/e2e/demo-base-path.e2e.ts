import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tempRoot = await mkdtemp(join(tmpdir(), 'coke-dots-demo-path-'));
const artifacts = resolve(projectRoot, 'artifacts', 'e2e', `demo-base-path-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const chromePath = [process.env.DOTS_CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find(path => path && existsSync(path));
const proxyToken = 'demo-path-e2e-proxy-token';
let server: ChildProcess | null = null;
let browser: Browser | null = null;

async function freePort() {
  const listener = createServer();
  await new Promise<void>((resolvePromise, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolvePromise));
  const address = listener.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolvePromise, reject) => listener.close(error => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function waitForHealth(url: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) throw new Error(`Server exited early (${server.exitCode})`);
    try { if ((await fetch(url)).ok) return; } catch { /* Wait for the loopback listener. */ }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error('Demo-path test server did not become healthy');
}

async function requestWithHeaders(url: string, headers: Record<string, string>) {
  return new Promise<{ status: number; body: string }>((resolvePromise, reject) => {
    const request = httpRequest(url, { headers }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolvePromise({ status: response.statusCode || 0, body }));
    });
    request.once('error', reject);
    request.end();
  });
}

await mkdir(artifacts, { recursive: true });
try {
  assert(chromePath, 'Chrome was not found; set DOTS_CHROME_BIN.');
  const port = await freePort();
  const envFile = join(tempRoot, 'empty.env');
  const dataDirectory = join(tempRoot, 'data');
  await writeFile(envFile, '');
  server = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test', DOTS_E2E_AUTH: '1', DOTS_ENV_FILE: envFile, DOTS_DATA_DIR: dataDirectory,
      DOTS_PORT: String(port), DOTS_BASE_PATH: '/dots-demo', DOTS_PUBLIC_HOST: 'demo.test',
      DOTS_PUBLIC_ORIGIN: 'https://demo.test', DOTS_TRUSTED_PROXY_TOKEN: proxyToken,
      GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
    },
    stdio: 'ignore',
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(`${baseUrl}/dots-demo/api/health`);

  const outsideBase = await fetch(`${baseUrl}/api/health`);
  assert.equal(outsideBase.status, 404, 'The service must not serve API routes outside the configured prefix');
  const missingProxyToken = await requestWithHeaders(`${baseUrl}/dots-demo/api/health`, { Host: 'demo.test', Origin: 'https://demo.test' });
  assert.equal(missingProxyToken.status, 403, 'A public hostname must require the trusted reverse-proxy token');
  const wrongProxyToken = await requestWithHeaders(`${baseUrl}/dots-demo/api/health`, { Host: 'demo.test', Origin: 'https://demo.test', 'x-dots-proxy-token': 'wrong' });
  assert.equal(wrongProxyToken.status, 403, 'A wrong reverse-proxy token must be rejected');
  const wrongOrigin = await requestWithHeaders(`${baseUrl}/dots-demo/api/health`, { Host: 'demo.test', Origin: 'https://attacker.test', 'x-dots-proxy-token': proxyToken });
  assert.equal(wrongOrigin.status, 403, 'A trusted proxy request must still enforce the public origin');
  const forwardedHealth = await requestWithHeaders(`${baseUrl}/dots-demo/api/health`, { Host: 'demo.test', Origin: 'https://demo.test', 'x-dots-proxy-token': proxyToken });
  assert.equal(forwardedHealth.status, 200, 'The trusted public reverse proxy should reach the subpath API');

  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const failedRequests: string[] = [];
  page.on('requestfailed', request => failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText || 'failed'}`));
  await page.goto(`${baseUrl}/dots-demo/`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('e2e-sign-in').waitFor({ state: 'visible' });
  await page.getByText('Google 登录配置完成后即可访问工作区。').waitFor({ state: 'visible' });
  assert.equal(await page.locator('script[src]').evaluateAll((nodes, origin) => nodes.every(node => (node as HTMLScriptElement).src.startsWith(`${origin}/dots-demo/`)), baseUrl), true, 'Built assets must use the demo prefix');
  await page.screenshot({ path: join(artifacts, 'demo-login.png'), fullPage: true });
  await page.getByLabel('E2E 测试账号').fill('demo@example.test');
  await page.getByTestId('e2e-sign-in').click();
  await page.getByTestId('app-shell').waitFor({ state: 'visible' });
  await page.getByTestId('chat-home').waitFor({ state: 'visible' });
  const cookies = await context.cookies(`${baseUrl}/dots-demo/`);
  const sessionCookie = cookies.find(cookie => cookie.name === 'coke_dots_session');
  assert(sessionCookie, 'E2E login should issue a session cookie');
  assert.equal(sessionCookie.path, '/dots-demo', 'Session cookies must be scoped to the demo prefix');
  assert.equal((await page.evaluate(() => new URLSearchParams(location.search).toString())), '', 'E2E login should return to the app without query residue');
  const unexpectedFailedRequests = failedRequests.filter(item => !item.endsWith('net::ERR_ABORTED'));
  assert.deepEqual(unexpectedFailedRequests, [], `Browser requests should all load: ${unexpectedFailedRequests.join('\n')}`);
  await page.screenshot({ path: join(artifacts, 'demo-authenticated.png'), fullPage: true });
  await context.close();
  console.log(JSON.stringify({ ok: true, basePath: '/dots-demo', trustedProxyChecks: 5, browserFlow: ['load prefixed app', 'load prefixed assets', 'E2E sign-in', 'authenticated app shell'], screenshots: [join(artifacts, 'demo-login.png'), join(artifacts, 'demo-authenticated.png')] }, null, 2));
} finally {
  await browser?.close().catch(() => undefined);
  if (server && server.exitCode === null) {
    const exited = new Promise<void>(resolvePromise => server!.once('exit', () => resolvePromise()));
    server.kill('SIGTERM');
    await Promise.race([exited, new Promise(resolvePromise => setTimeout(resolvePromise, 3000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  await rm(tempRoot, { recursive: true, force: true });
}
