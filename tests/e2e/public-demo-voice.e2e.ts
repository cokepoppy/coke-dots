import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const baseUrl = new URL(process.env.DOTS_PUBLIC_DEMO_URL || 'https://codex.cokeagent.com/dots-demo/');
const basePath = baseUrl.pathname.endsWith('/') ? baseUrl.pathname : `${baseUrl.pathname}/`;
const storageState = process.env.DOTS_PUBLIC_DEMO_STORAGE_STATE;
const artifactRoot = resolve(process.env.DOTS_E2E_ARTIFACTS || join(projectRoot, 'artifacts', 'e2e', `public-demo-voice-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const manifestPath = join(artifactRoot, 'manifest.json');
const browserPath = [process.env.DOTS_CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
  .find(candidate => candidate && existsSync(candidate));
const result: {
  testKind: string;
  runAt: string;
  origin: string;
  tenantHash: string | null;
  provider: string | null;
  model: string | null;
  voiceCallId: string | null;
  websocketPath: string | null;
  outputAudioBytes: number;
  statuses: Record<string, number>;
  checks: string[];
} = {
  testKind: 'authenticated-public-volcengine-voice-browser-e2e',
  runAt: new Date().toISOString(),
  origin: baseUrl.origin,
  tenantHash: null,
  provider: null,
  model: null,
  voiceCallId: null,
  websocketPath: null,
  outputAudioBytes: 0,
  statuses: {},
  checks: [],
};

if (baseUrl.protocol !== 'https:' || basePath !== baseUrl.pathname) {
  throw new Error('Set DOTS_PUBLIC_DEMO_URL to an HTTPS URL ending in a slash.');
}
if (!storageState || !existsSync(storageState)) {
  throw new Error('Set DOTS_PUBLIC_DEMO_STORAGE_STATE to a mode-0600 session for a dedicated Dots test account.');
}
if (process.platform !== 'win32' && ((await stat(storageState)).mode & 0o077) !== 0) {
  throw new Error('The Playwright storage-state file is readable by group or other users. Restrict it with chmod 600 before testing.');
}
if (!browserPath) throw new Error('Chrome was not found. Set DOTS_CHROME_BIN to a local Chrome executable.');

// An all-zero WAV keeps this public integration test off the user's microphone and
// prevents accidental ASR transcripts from creating unrelated Agent tasks.
const audioDirectory = await mkdtemp(join(tmpdir(), 'coke-dots-public-voice-'));
const silentWavPath = join(audioDirectory, 'silent.wav');
const sampleRate = 48_000;
const dataBytes = sampleRate * 2;
const wav = Buffer.alloc(44 + dataBytes);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataBytes, 4); wav.write('WAVE', 8);
wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(dataBytes, 40);
await writeFile(silentWavPath, wav, { mode: 0o600 });

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let activeCallNeedsClosing = false;
const failures: string[] = [];

async function check(name: string, run: () => Promise<void>) {
  await run();
  result.checks.push(name);
  console.log(`PASS ${name}`);
}

try {
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  browser = await chromium.launch({
    executablePath: browserPath,
    headless: process.env.DOTS_E2E_HEADFUL !== '1',
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${silentWavPath}`,
    ],
  });
  context = await browser.newContext({ storageState, viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  await context.grantPermissions(['microphone'], { origin: baseUrl.origin });
  page = await context.newPage();
  page.on('pageerror', error => failures.push(`pageerror:${error.name}`));
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin !== baseUrl.origin || !url.pathname.startsWith(basePath)) return;
    if (url.pathname.includes('/api/voice')) result.statuses[`${response.request().method()} ${url.pathname}`] = response.status();
  });

  await check('the signed-in browser loads the deployed tenant and configured Volcengine provider', async () => {
    const response = await page!.goto(baseUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    assert.equal(response?.status(), 200);
    await page!.getByTestId('app-shell').waitFor({ state: 'visible', timeout: 20_000 });
    await page!.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true', null, { timeout: 30_000 });
    const auth = await page!.evaluate(async () => {
      const response = await fetch('api/auth/me', { cache: 'no-store' });
      return { status: response.status, body: response.ok ? await response.json() as { tenant?: { id?: string } } : null };
    });
    assert.equal(auth.status, 200);
    assert(auth.body?.tenant?.id);
    result.tenantHash = createHash('sha256').update(auth.body.tenant.id).digest('hex').slice(0, 12);

    const provider = await page!.evaluate(async () => {
      const response = await fetch('api/voice/provider', { cache: 'no-store' });
      return { status: response.status, body: response.ok ? await response.json() as { provider?: string; configured?: boolean; model?: string } : null };
    });
    result.statuses['GET /api/voice/provider'] = provider.status;
    assert.equal(provider.status, 200);
    assert.equal(provider.body?.provider, 'volcengine');
    assert.equal(provider.body?.configured, true);
    assert.equal(provider.body?.model, 'doubao-seedduplex-3.0');
    result.provider = provider.body.provider;
    result.model = provider.body.model;
  });

  await check('a page click establishes the real public SeedDuplex session using only synthetic silent audio', async () => {
    await page!.addInitScript(() => {
      const NativeWebSocket = window.WebSocket;
      const sockets: WebSocket[] = [];
      Object.defineProperty(window, '__dotsPublicVoiceSockets', { configurable: false, value: sockets });
      window.WebSocket = new Proxy(NativeWebSocket, {
        construct(target, args, newTarget) {
          const socket = Reflect.construct(target, args, newTarget) as WebSocket;
          if (String(args[0]).includes('/volcengine-stream')) sockets.push(socket);
          return socket;
        },
      });
    });
    const callCreated = page!.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `${basePath}api/voice-calls`, { timeout: 20_000 });
    await page!.getByTestId('voice-call-launch').click();
    const callResponse = await callCreated;
    result.statuses[`POST ${basePath}api/voice-calls`] = callResponse.status();
    assert.equal(callResponse.status(), 201);
    const callBody = await callResponse.json() as { id?: string };
    assert(callBody.id);
    result.voiceCallId = callBody.id;
    activeCallNeedsClosing = true;

    const call = page!.getByTestId('voice-call');
    await call.waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await call.getAttribute('data-voice-provider'), 'volcengine');
    assert.equal(await call.getAttribute('data-voice-model'), 'doubao-seedduplex-3.0');
    await page!.getByTestId('voice-call-transcript').getByText('正在聆听', { exact: true }).waitFor({ state: 'visible', timeout: 35_000 });

    const socketUrl = await page!.waitForFunction(() => {
      const sockets = (window as Window & { __dotsPublicVoiceSockets?: WebSocket[] }).__dotsPublicVoiceSockets || [];
      const socket = sockets.find(item => item.readyState === WebSocket.OPEN);
      return socket?.url || null;
    }, null, { timeout: 10_000 }).then(handle => handle.jsonValue() as Promise<string>);
    const url = new URL(socketUrl);
    assert.equal(url.protocol, 'wss:');
    assert.equal(url.pathname, `${basePath}api/voice-calls/${callBody.id}/volcengine-stream`);
    result.websocketPath = url.pathname;
  });

  await check('the public browser sends Chinese speech text to SeedDuplex and receives synthesized audio', async () => {
    await page!.getByRole('button', { name: '关闭扬声器' }).click();
    await page!.getByRole('button', { name: '静音' }).click();
    const audioBytes = await page!.evaluate(async () => {
      const sockets = (window as Window & { __dotsPublicVoiceSockets?: WebSocket[] }).__dotsPublicVoiceSockets || [];
      const socket = sockets.find(item => item.readyState === WebSocket.OPEN);
      if (!socket) throw new Error('The public SeedDuplex websocket is not open');
      return await new Promise<number>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('Timed out waiting for synthesized SeedDuplex audio')), 25_000);
        const onMessage = (event: MessageEvent) => {
          if (typeof event.data === 'string') return;
          const finish = (buffer: ArrayBuffer) => {
            const bytes = new Uint8Array(buffer);
            if (bytes.length < 3 || bytes[0] !== 1) return;
            window.clearTimeout(timeout);
            socket.removeEventListener('message', onMessage);
            resolve(bytes.length - 1);
          };
          if (event.data instanceof ArrayBuffer) finish(event.data);
          else if (event.data instanceof Blob) void event.data.arrayBuffer().then(finish, reject);
        };
        socket.addEventListener('message', onMessage);
        socket.send(JSON.stringify({ type: 'speak', text: '公网火山语音服务测试成功。' }));
      });
    });
    assert(audioBytes > 2, 'The provider must return PCM audio bytes to the browser');
    result.outputAudioBytes = audioBytes;
  });

  await check('the page ends the call and the public tenant history persists the ended state', async () => {
    await page!.getByRole('button', { name: '结束通话' }).click();
    activeCallNeedsClosing = false;
    await page!.waitForFunction(async callId => {
      const response = await fetch('api/voice-calls', { cache: 'no-store' });
      if (!response.ok) return false;
      const calls = await response.json() as { id: string; endedAt: string | null }[];
      return calls.some(call => call.id === callId && Boolean(call.endedAt));
    }, result.voiceCallId, { timeout: 15_000 });
    assert.equal(await page!.getByTestId('voice-call').count(), 0, 'The voice UI should close after the end-call click');
  });

  assert.deepEqual(failures, [], `Browser JavaScript errors: ${failures.join('; ')}`);
} finally {
  if (activeCallNeedsClosing && page) {
    const endButton = page.getByRole('button', { name: '结束通话' });
    if (await endButton.isVisible().catch(() => false)) await endButton.click().catch(() => undefined);
  }
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await rm(audioDirectory, { recursive: true, force: true });
  result.runAt = new Date().toISOString();
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  await writeFile(manifestPath, JSON.stringify({ ...result, statuses: result.statuses }, null, 2) + '\n', { mode: 0o600 });
  await chmod(manifestPath, 0o600);
  console.log(`Public voice E2E record: ${manifestPath}`);
}
