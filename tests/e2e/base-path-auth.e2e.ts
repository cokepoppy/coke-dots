import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { connect as createNetConnection, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { WebSocketServer } from 'ws';

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
let oauthProvider: Server | null = null;
let voiceProvider: WebSocketServer | null = null;
let browser: Browser | null = null;
let page: Page | null = null;
const requests: string[] = [];
const pageErrors: string[] = [];
const oauthTrace: string[] = [];
const browserTrace: string[] = [];
const oauthClientId = 'coke-dots-base-path-e2e.apps.googleusercontent.com';
const oauthCode = 'coke-dots-mobile-google-code';
const oauthKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const oauthKid = 'coke-dots-mobile-e2e-key';
const oauthPublicJwk = { ...(oauthKeyPair.publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: oauthKid, alg: 'RS256', use: 'sig' };
const oauthFlows = new Map<string, { state: string; nonce: string; redirectUri: string; codeChallenge: string }>();
let oauthCallbackCookieSeen = false;
let oauthCookieScopeCorrect = false;
let oauthCookieClearScopeCorrect = false;
let oauthPkceVerified = false;
let voiceProviderEvents: string[] = [];
let voiceProviderPcmBytes = 0;
let voiceProviderPcmPeak = 0;
let voiceProviderSpokenTexts: string[] = [];

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

async function startMockVolcengineDuplexProvider() {
  voiceProviderEvents = [];
  voiceProviderPcmBytes = 0;
  voiceProviderPcmPeak = 0;
  voiceProviderSpokenTexts = [];
  voiceProvider = new WebSocketServer({ port: 0, host: '127.0.0.1', maxPayload: 1024 * 1024, perMessageDeflate: false });
  voiceProvider.on('connection', socket => {
    socket.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let event: Record<string, unknown>;
      try { event = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)) as Record<string, unknown>; }
      catch { return; }
      const type = typeof event.type === 'string' ? event.type : 'missing-type';
      voiceProviderEvents.push(type);
      if (type === 'session.create') {
        socket.send(JSON.stringify({ type: 'session.created', event_id: 'mobile-oauth-session-created', session: { id: 'mobile-oauth-call' } }));
      } else if (type === 'input_audio_buffer.append' && typeof event.audio === 'string') {
        const pcm = Buffer.from(event.audio, 'base64');
        voiceProviderPcmBytes += pcm.byteLength;
        for (let offset = 0; offset + 1 < pcm.byteLength; offset += 2) voiceProviderPcmPeak = Math.max(voiceProviderPcmPeak, Math.abs(pcm.readInt16LE(offset)));
      } else if (type === 'speech_text_buffer.commit' && typeof event.text === 'string') {
        voiceProviderSpokenTexts.push(event.text);
        socket.send(JSON.stringify({ type: 'response.output_audio.started', response_id: 'mobile-oauth-greeting' }));
        const pcm = Buffer.alloc(960);
        for (let index = 0; index < pcm.length / 4; index += 1) pcm.writeFloatLE(Math.sin(index * 2 * Math.PI * 440 / 24000) * 0.5, index * 4);
        socket.send(JSON.stringify({ type: 'response.output_audio.delta', response_id: 'mobile-oauth-greeting', delta: pcm.toString('base64') }));
        socket.send(JSON.stringify({ type: 'response.output_audio.done', response_id: 'mobile-oauth-greeting' }));
      } else if (type === 'session.close') {
        socket.send(JSON.stringify({ type: 'session.closed', event_id: 'mobile-oauth-session-closed' }));
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    voiceProvider!.once('error', reject);
    voiceProvider!.once('listening', resolvePromise);
  });
  const address = voiceProvider.address();
  assert(address && typeof address !== 'string');
  return `ws://127.0.0.1:${address.port}/duplex`;
}

function contentType(path: string) {
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' } as Record<string, string>)[extname(path)] || 'application/octet-stream';
}

function fakeMicrophoneWave(sampleRate = 48_000, durationSeconds = 3) {
  const samples = sampleRate * durationSeconds;
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) pcm.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / sampleRate) * 12_000), index * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function main() {
  const backendPort = await reservePort();
  const frontendPort = 5173;
  const oauthPort = await reservePort();
  const oauthOrigin = `http://127.0.0.1:${oauthPort}`;
  const voiceProviderUrl = await startMockVolcengineDuplexProvider();
  oauthProvider = createHttpServer(async (incoming, outgoing) => {
    const url = new URL(incoming.url || '/', oauthOrigin);
    oauthTrace.push(`${incoming.method} ${url.pathname}`);
    try {
      if (incoming.method === 'GET' && url.pathname === '/o/oauth2/v2/auth') {
        const redirectUri = url.searchParams.get('redirect_uri') || '';
        const state = url.searchParams.get('state') || '';
        const nonce = url.searchParams.get('nonce') || '';
        const codeChallenge = url.searchParams.get('code_challenge') || '';
        assert.equal(url.searchParams.get('client_id'), oauthClientId);
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(url.searchParams.get('response_type'), 'code');
        oauthFlows.set(oauthCode, { state, nonce, redirectUri, codeChallenge });
        outgoing.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        outgoing.end('<main><h1>Google account</h1><p>mobile.google@example.test</p><a href="/authorize/continue">Continue with Google</a></main>');
        return;
      }
      if (incoming.method === 'GET' && url.pathname === '/authorize/continue') {
        const flow = oauthFlows.get(oauthCode);
        assert(flow, 'OAuth authorization must be initiated before consent');
        const callback = new URL(flow.redirectUri);
        callback.searchParams.set('code', oauthCode);
        callback.searchParams.set('state', flow.state);
        outgoing.writeHead(302, { location: callback.toString(), 'cache-control': 'no-store' });
        outgoing.end();
        return;
      }
      if (incoming.method === 'POST' && url.pathname === '/token') {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        oauthTrace.push(`TOKEN body=${Buffer.concat(chunks).length}`);
        const flow = oauthFlows.get(form.get('code') || '');
        const verifier = form.get('code_verifier') || '';
        const actualChallenge = createHash('sha256').update(verifier).digest('base64url');
        assert(flow, 'The OAuth callback must exchange the issued authorization code');
        assert.equal(form.get('client_id'), oauthClientId);
        assert.equal(form.get('redirect_uri'), flow.redirectUri);
        assert.equal(form.get('grant_type'), 'authorization_code');
        assert.equal(actualChallenge, flow.codeChallenge, 'The token exchange must use the matching PKCE verifier');
        oauthPkceVerified = true;
        const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const signingInput = `${encode({ alg: 'RS256', typ: 'JWT', kid: oauthKid })}.${encode({
          iss: 'https://accounts.google.com', aud: oauthClientId, sub: 'coke-dots-mobile-google-user',
          email: 'mobile.google@example.test', email_verified: true, name: 'Mobile Google User',
          nonce: flow.nonce, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
        })}`;
        const idToken = `${signingInput}.${signBytes('RSA-SHA256', Buffer.from(signingInput), oauthKeyPair.privateKey).toString('base64url')}`;
        oauthTrace.push('TOKEN response=200');
        outgoing.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        outgoing.end(JSON.stringify({ access_token: 'e2e-mobile-access-token', token_type: 'Bearer', expires_in: 3600, id_token: idToken }));
        return;
      }
      if (incoming.method === 'GET' && url.pathname === '/certs') {
        oauthTrace.push('CERTS response=200');
        outgoing.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' });
        outgoing.end(JSON.stringify({ keys: [oauthPublicJwk] }));
        return;
      }
      if (incoming.method === 'GET' && url.pathname === '/pem-certs') {
        oauthTrace.push('PEM-CERTS response=200');
        const publicKey = oauthKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
        outgoing.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' });
        outgoing.end(JSON.stringify({ [oauthKid]: publicKey }));
        return;
      }
      outgoing.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      outgoing.end('Not found');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Mock OAuth provider failed at ${incoming.method} ${url.pathname}: ${message}`);
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      outgoing.end('Mock OAuth provider error');
    }
  });
  await new Promise<void>((resolvePromise, reject) => oauthProvider!.once('error', reject).listen(oauthPort, '127.0.0.1', resolvePromise));
  backend = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DOTS_ENV_FILE: envFile,
      DOTS_DATA_DIR: dataDir,
      DOTS_PORT: String(backendPort),
      DOTS_BASE_PATH: basePath,
      DOTS_APP_URL: `http://127.0.0.1:${frontendPort}${basePath}`,
      DOTS_E2E_GOOGLE_OAUTH_ORIGIN: oauthOrigin,
      DOTS_E2E_AUTH: '1',
      DOTS_VOICE_PROVIDER: 'volcengine',
      DOTS_VOLCENGINE_API_KEY: 'e2e-seedduplex-secret',
      DOTS_E2E_VOLCENGINE_DUPLEX_WS_URL: voiceProviderUrl,
      GOOGLE_CLIENT_ID: oauthClientId,
      GOOGLE_CLIENT_SECRET: 'coke-dots-base-path-e2e-secret',
      GOOGLE_REDIRECT_URI: `http://127.0.0.1:${frontendPort}${basePath}/auth/google/callback`,
      DOTS_COMPUTER_BACKEND: 'mock',
    },
    stdio: 'ignore',
  });
  await waitForBackend(`http://127.0.0.1:${backendPort}/api/auth/config`);

  proxy = createHttpServer((incoming, outgoing) => {
    const incomingUrl = new URL(incoming.url || '/', `http://127.0.0.1:${frontendPort}`);
    const callbackPath = `${basePath}/auth/google/callback`;
    if (incomingUrl.pathname === callbackPath) {
      const cookieHeader = incoming.headers.cookie || '';
      oauthCallbackCookieSeen = cookieHeader.split(';').some(item => item.trim().startsWith('coke_dots_oauth_state='));
      oauthTrace.push(`CALLBACK cookie=${oauthCallbackCookieSeen ? 'present' : 'missing'}`);
    }
    if (incomingUrl.pathname.startsWith(`${basePath}/api/`) || incomingUrl.pathname === callbackPath) {
      const upstream = httpRequest({
        hostname: '127.0.0.1', port: backendPort, method: incoming.method,
        path: `${incomingUrl.pathname.slice(basePath.length)}${incomingUrl.search}`,
        headers: { ...incoming.headers, host: `127.0.0.1:${frontendPort}` },
      }, response => {
        const setCookies = (response.headers['set-cookie'] || []).map(String);
        if (incomingUrl.pathname === `${basePath}/api/auth/google/start`) {
          oauthCookieScopeCorrect = setCookies.some(cookie => cookie.startsWith('coke_dots_oauth_state=') && cookie.includes(`Path=${basePath}/auth/google/callback`) && cookie.includes('HttpOnly') && cookie.includes('SameSite=Lax'));
        }
        if (incomingUrl.pathname === callbackPath) {
          oauthCookieClearScopeCorrect = setCookies.some(cookie => cookie.startsWith('coke_dots_oauth_state=') && cookie.includes(`Path=${basePath}/auth/google/callback`) && cookie.includes('Max-Age=0'));
        }
        if (incomingUrl.pathname === callbackPath) oauthTrace.push(`CALLBACK response=${response.statusCode || 0}`);
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
  proxy.on('upgrade', (incoming, client, head) => {
    const incomingUrl = new URL(incoming.url || '/', `http://127.0.0.1:${frontendPort}`);
    if (!incomingUrl.pathname.startsWith(`${basePath}/api/`)) { client.destroy(); return; }
    const upstream = createNetConnection({ host: '127.0.0.1', port: backendPort });
    upstream.once('connect', () => {
      const upstreamPath = `${incomingUrl.pathname.slice(basePath.length)}${incomingUrl.search}`;
      const headers: string[] = [];
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        const key = incoming.rawHeaders[index];
        const value = incoming.rawHeaders[index + 1];
        headers.push(`${key}: ${key.toLowerCase() === 'host' ? `127.0.0.1:${backendPort}` : value}`);
      }
      upstream.write(`${incoming.method || 'GET'} ${upstreamPath} HTTP/${incoming.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.once('error', () => client.destroy());
    client.once('error', () => upstream.destroy());
    client.once('close', () => upstream.destroy());
  });
  await new Promise<void>((resolvePromise, reject) => proxy!.once('error', reject).listen(frontendPort, '127.0.0.1', resolvePromise));

  const baseUrl = `http://127.0.0.1:${frontendPort}${basePath}/`;
  const fakeMicrophonePath = join(tempRoot, 'mobile-microphone.wav');
  await writeFile(fakeMicrophonePath, fakeMicrophoneWave());
  browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${fakeMicrophonePath}`] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, permissions: ['microphone'] });
  page = await context.newPage();
  page.on('requestfailed', request => browserTrace.push(`${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText || 'failed'}`));
  page.on('response', response => {
    const responseUrl = new URL(response.url());
    if (responseUrl.origin === `http://127.0.0.1:${frontendPort}` || responseUrl.origin === oauthOrigin) browserTrace.push(`${response.status()} ${response.request().method()} ${responseUrl.pathname}`);
  });
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
  await googleLogin.click();
  await page.getByRole('heading', { name: 'Google account' }).waitFor({ state: 'visible' });
  await page.getByRole('link', { name: 'Continue with Google' }).click({ noWaitAfter: true });
  try {
    await page.waitForURL(baseUrl, { timeout: 15_000 });
  } catch (error) {
    throw new Error(`Mobile OAuth callback did not return to the app. OAuth trace: ${oauthTrace.join(' | ')}. Browser trace: ${browserTrace.slice(-20).join(' | ')}. Current URL: ${page.url()}. ${error instanceof Error ? error.message : String(error)}`);
  }
  await page.getByTestId('app-shell').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true');
  assert.equal(page.url(), baseUrl, 'Completing OAuth must return to the mounted mobile app path');
  assert(oauthCallbackCookieSeen, 'The browser must send the HttpOnly OAuth state cookie to the prefixed callback path');
  assert(oauthCookieScopeCorrect, 'The OAuth state cookie must be HttpOnly, SameSite=Lax, and scoped to the exact public callback path');
  assert(oauthCookieClearScopeCorrect, 'The callback must clear the OAuth state cookie on that same prefixed path');
  assert(oauthPkceVerified, 'The mock Google token endpoint must verify the original PKCE challenge');
  const sessionCookies = await context.cookies(baseUrl);
  assert(sessionCookies.some(cookie => cookie.name === 'coke_dots_session'), 'A verified Google identity must create a browser session');
  assert(!sessionCookies.some(cookie => cookie.name === 'coke_dots_oauth_state'), 'The OAuth state cookie must be cleared after callback');
  await page.getByTestId('mobile-dot-nav').click();
  await page.getByTestId('mobile-chat-menu-toggle').click();
  await page.getByTestId('mobile-navigation').locator('.mobile-navigation-account small').filter({ hasText: 'mobile.google@example.test' }).waitFor({ state: 'visible' });
  await page.getByTestId('mobile-navigation').locator('.mobile-navigation-panel').getByRole('button', { name: '关闭导航菜单' }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    'The authenticated Coke Dots shell must load on mobile without horizontal overflow');
  await page.screenshot({ path: join(artifactRoot, 'base-path-mobile-first-run.png'), fullPage: true });
  await page.getByTestId('computer-choice').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Continue' }).click();
  const onboardingStatus = await page.evaluate(async () => (await fetch('/dots-demo/api/profile', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ onboardingComplete: true }) })).status);
  assert.equal(onboardingStatus, 200, 'The E2E tenant should finish onboarding before testing the mobile Dot conversation');
  const eventDeadline = Date.now() + 5_000;
  while (!requests.some(item => item === 'GET /dots-demo/api/events') && Date.now() < eventDeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  assert(requests.includes('GET /dots-demo/api/events'), 'The authenticated live event stream must use the prefixed API path');
  const providerResponse = await page.evaluate(async () => {
    const response = await fetch('/dots-demo/api/voice/provider');
    return { status: response.status, body: await response.json() };
  });
  assert.equal(providerResponse.status, 200, 'The voice provider API must resolve through the base path');
  assert.deepEqual(providerResponse.body, { provider: 'volcengine', configured: true, model: 'doubao-seedduplex-3.0' }, 'The prefixed API must report the configured Doubao SeedDuplex provider without exposing its API key');

  const mobileDotNav = page.getByTestId('mobile-dot-nav');
  if (await mobileDotNav.isVisible().catch(() => false)) await mobileDotNav.click();
  const connectedToast = page.getByTestId('computer-connected-toast');
  if (await connectedToast.isVisible().catch(() => false)) await connectedToast.getByRole('button', { name: 'Dismiss notification' }).click();
  await page.getByTestId('mobile-chat-menu-toggle').click();
  await page.getByTestId('mobile-navigation').getByRole('button', { name: '◉ 你的 dot' }).click();
  await page.getByTestId('conversation-call-launch').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    'The mobile Dot conversation must fit before placing a call');
  await page.screenshot({ path: join(artifactRoot, 'base-path-mobile-dot-chat.png'), fullPage: true });
  await page.evaluate(() => {
    const originalStart = AudioBufferSourceNode.prototype.start;
    Object.defineProperty(window, '__dotsVoiceOutputFrames', { configurable: true, value: [], writable: true });
    AudioBufferSourceNode.prototype.start = function(...args) {
      const buffer = this.buffer;
      if (buffer && buffer.sampleRate === 24_000) {
        const samples = buffer.getChannelData(0);
        let peak = 0;
        for (let index = 0; index < samples.length; index += 1) peak = Math.max(peak, Math.abs(samples[index]));
        (window as unknown as { __dotsVoiceOutputFrames: { sampleRate: number; peak: number }[] }).__dotsVoiceOutputFrames.push({ sampleRate: buffer.sampleRate, peak });
      }
      return originalStart.apply(this, args);
    };
  });
  await page.getByTestId('conversation-call-launch').click();
  const mobileCall = page.getByTestId('voice-call');
  await mobileCall.waitFor({ state: 'visible' });
  assert.equal(await mobileCall.getAttribute('data-variant'), 'mobile', 'Mobile Chrome must open the phone call surface');
  const callBounds = await mobileCall.boundingBox();
  assert(callBounds && callBounds.x === 0 && callBounds.y === 0 && callBounds.width === 390 && callBounds.height === 844,
    'The active phone call must fill the 390×844 viewport');
  assert.equal(await mobileCall.locator('.voice-call-mobile-controls button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')).join('|')),
    '关闭扬声器|结束通话|静音', 'Mobile call controls must keep speaker, red hang-up, and mute in the expected order');
  await page.waitForFunction(() => document.querySelector('[data-testid="voice-call"]')?.getAttribute('data-voice-mic-state') === 'sent', null, { timeout: 20_000 });
  const greeting = `你好，我是 Dot，有什么我可以帮你？`;
  const voiceDeadline = Date.now() + 10_000;
  while ((voiceProviderPcmBytes < 6_400 || !voiceProviderSpokenTexts.includes(greeting)) && Date.now() < voiceDeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  assert(voiceProviderEvents.includes('session.create'), 'The Google-authenticated mobile call must open the configured realtime voice session');
  assert(voiceProviderPcmBytes >= 6_400 && voiceProviderPcmPeak > 0, `Mobile Chrome must capture and stream non-silent microphone PCM to the provider (bytes=${voiceProviderPcmBytes}, peak=${voiceProviderPcmPeak})`);
  assert(voiceProviderSpokenTexts.includes(greeting), 'The Dot must send its Chinese call greeting through SeedDuplex speech output');
  await page.waitForFunction(() => (window as unknown as { __dotsVoiceOutputFrames: { sampleRate: number; peak: number }[] }).__dotsVoiceOutputFrames.some(frame => frame.sampleRate === 24_000 && frame.peak >= 0.45), null, { timeout: 10_000 });
  await page.screenshot({ path: join(artifactRoot, 'base-path-mobile-dot-call.png'), fullPage: true });
  const activeCalls = await page.evaluate(async () => await fetch('/dots-demo/api/voice-calls').then(response => response.json())) as { id: string; endedAt: string | null }[];
  const activeCall = activeCalls.find(call => !call.endedAt);
  assert(activeCall, 'The outgoing phone call must be saved to the signed-in user’s call history');
  await mobileCall.getByTestId('voice-call-minimize').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="voice-call"]')?.getAttribute('data-variant') === 'mobile-minimized');
  assert.equal(await page.getByTestId('task-composer').isVisible(), true, 'The same Dot conversation must remain usable while the call continues');
  assert.equal(voiceProviderEvents.includes('session.close'), false, 'Returning to chat must not end the active voice session');
  await mobileCall.getByTestId('voice-call-restore').click();
  await mobileCall.getByRole('button', { name: '结束通话' }).click();
  await mobileCall.waitFor({ state: 'detached' });
  const closeDeadline = Date.now() + 5_000;
  while (!voiceProviderEvents.includes('session.close') && Date.now() < closeDeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  const endedCall = await page.evaluate(async (callId: string) => (await fetch('/dots-demo/api/voice-calls').then(response => response.json()) as { id: string; endedAt: string | null }[]).find(call => call.id === callId), activeCall.id);
  assert(endedCall?.endedAt, 'Hang-up must persist the call end time');
  assert(voiceProviderEvents.includes('session.close'), 'Hang-up must close the realtime voice session');
  await page.screenshot({ path: join(artifactRoot, 'base-path-mobile-dot-call-ended.png'), fullPage: true });

  const apiRequests = requests.filter(item => item.includes('/api/'));
  assert(apiRequests.length >= 5, `Expected authenticated API traffic, received: ${apiRequests.join(', ')}`);
  assert(apiRequests.every(item => item.includes(`${basePath}/api/`)), `A browser API request escaped the base path: ${apiRequests.join(', ')}`);
  assert.deepEqual(pageErrors, [], `Browser errors: ${pageErrors.join('; ')}`);
  console.log(JSON.stringify({ result: 'passed', baseUrl, apiRequests, oauthCallbackCookieSeen, oauthCookieScopeCorrect, oauthCookieClearScopeCorrect, oauthPkceVerified, oauthTrace, authenticatedEmail: 'mobile.google@example.test', mobileCall: { provider: 'doubao-seedduplex-3.0 (mock)', pcmBytes: voiceProviderPcmBytes, pcmPeak: voiceProviderPcmPeak, spokenTexts: voiceProviderSpokenTexts, outputAudioFrames: await page.evaluate(() => (window as unknown as { __dotsVoiceOutputFrames: { sampleRate: number; peak: number }[] }).__dotsVoiceOutputFrames) }, pageErrors, screenshots: ['base-path-login.png', 'base-path-mobile-first-run.png', 'base-path-mobile-dot-chat.png', 'base-path-mobile-dot-call.png', 'base-path-mobile-dot-call-ended.png'], artifactRoot }, null, 2));
  await context.close();
}

try {
  await main();
} finally {
  const browserInstance = browser as unknown as Browser | undefined;
  await browserInstance?.close().catch(() => undefined);
  const proxyServer = proxy as unknown as Server | undefined;
  if (proxyServer?.listening) await new Promise<void>(resolvePromise => proxyServer.close(() => resolvePromise()));
  const oauthServer = oauthProvider as unknown as Server | undefined;
  if (oauthServer?.listening) await new Promise<void>(resolvePromise => oauthServer.close(() => resolvePromise()));
  const voiceServer = voiceProvider as unknown as WebSocketServer | undefined;
  if (voiceServer?.address()) await new Promise<void>(resolvePromise => voiceServer.close(() => resolvePromise()));
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
