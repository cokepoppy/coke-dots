import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page, type Response } from 'playwright-core';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const baseUrl = new URL(process.env.DOTS_PUBLIC_DEMO_URL || 'https://codex.cokeagent.com/dots-demo/');
const basePath = baseUrl.pathname.endsWith('/') ? baseUrl.pathname : `${baseUrl.pathname}/`;
const storageState = process.env.DOTS_PUBLIC_DEMO_STORAGE_STATE;
const agentTaskMode = process.env.DOTS_PUBLIC_VOICE_AGENT_TASK === '1';
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
  outputAudioFrames: number;
  outputAudioEncoding: string | null;
  outputAudioScheduledSources: number;
  outputAudioPlaybackCompletedSources: number;
  outputAudioRms: number;
  outputAudioPeak: number;
  outputAudioLagOneCorrelation: number;
  speakerDestinationConnections: number;
  speakerOutputPathVerified: boolean;
  agentTaskId: string | null;
  agentTaskCompleted: boolean;
  transcriptVerified: boolean;
  spokenResultVerified: boolean;
  turnSubmissionCount: number;
  statuses: Record<string, number>;
  checks: string[];
} = {
  testKind: agentTaskMode ? 'authenticated-public-volcengine-voice-pi-cloud-agent-e2e' : 'authenticated-public-volcengine-voice-browser-e2e',
  runAt: new Date().toISOString(),
  origin: baseUrl.origin,
  tenantHash: null,
  provider: null,
  model: null,
  voiceCallId: null,
  websocketPath: null,
  outputAudioBytes: 0,
  outputAudioFrames: 0,
  outputAudioEncoding: null,
  outputAudioScheduledSources: 0,
  outputAudioPlaybackCompletedSources: 0,
  outputAudioRms: 0,
  outputAudioPeak: 0,
  outputAudioLagOneCorrelation: 0,
  speakerDestinationConnections: 0,
  speakerOutputPathVerified: false,
  agentTaskId: null,
  agentTaskCompleted: false,
  transcriptVerified: false,
  spokenResultVerified: false,
  turnSubmissionCount: 0,
  statuses: {},
  checks: [],
};

async function saveFloat32AssistantReply(chunks: string[]) {
  const floatPcm = Buffer.concat(chunks.map(chunk => Buffer.from(chunk, 'base64')));
  assert(floatPcm.length > 0 && floatPcm.length % 4 === 0, 'SeedDuplex must return complete float32 PCM samples');
  const sampleCount = floatPcm.length / 4;
  const samples = new Float32Array(sampleCount);
  const outputPcm = Buffer.alloc(sampleCount * 2);
  let sum = 0;
  let sumSquares = 0;
  let peak = 0;
  let clippedSamples = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = floatPcm.readFloatLE(index * 4);
    assert(Number.isFinite(sample) && Math.abs(sample) <= 1.5, 'SeedDuplex output must be finite normalized float32 PCM');
    samples[index] = sample;
    sum += sample;
    sumSquares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
    const clipped = Math.max(-1, Math.min(1, sample));
    if (Math.abs(clipped) >= 0.999) clippedSamples += 1;
    outputPcm.writeInt16LE(Math.round(clipped * (clipped < 0 ? 32768 : 32767)), index * 2);
  }
  const mean = sum / sampleCount;
  let covariance = 0;
  let variance = 0;
  for (let index = 1; index < sampleCount; index += 1) {
    covariance += (samples[index] - mean) * (samples[index - 1] - mean);
    variance += (samples[index] - mean) ** 2;
  }
  const lagOneCorrelation = variance > 0 ? covariance / variance : 0;
  const rms = Math.sqrt(sumSquares / sampleCount);
  assert(rms > 0.005 && rms < 0.35 && peak > 0.02, 'Assistant audio must contain bounded, audible speech energy');
  assert(clippedSamples / sampleCount < 0.01, 'Assistant audio must not be broadly clipped');
  assert(lagOneCorrelation > 0.2, 'Assistant audio must have speech-like temporal continuity instead of broadband static');

  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + outputPcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24); header.writeUInt32LE(48_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(outputPcm.length, 40);
  const audioPath = join(artifactRoot, 'assistant-reply.wav');
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  await writeFile(audioPath, Buffer.concat([header, outputPcm]), { mode: 0o600 });
  await chmod(audioPath, 0o600);
  return { rms, peak, lagOneCorrelation, audioPath };
}

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

let microphoneWavPath = silentWavPath;
if (agentTaskMode) {
  const overridePath = process.env.DOTS_PUBLIC_VOICE_INPUT_WAV;
  if (overridePath) {
    if (!existsSync(overridePath)) throw new Error('DOTS_PUBLIC_VOICE_INPUT_WAV does not exist.');
    microphoneWavPath = resolve(overridePath);
  } else {
    if (process.platform !== 'darwin') throw new Error('Set DOTS_PUBLIC_VOICE_INPUT_WAV to a Chinese PCM WAV, or run this test on macOS with the built-in Tingting voice and ffmpeg.');
    const spokenInput = join(audioDirectory, 'synthetic-chinese-input.aiff');
    microphoneWavPath = join(audioDirectory, 'synthetic-chinese-input.wav');
    const instruction = '请用中文回答。请在你的云电脑浏览器打开 example.com，告诉我网页标题和页面主要意思。不要登录，不要修改网页。';
    execFileSync('say', ['-v', 'Tingting', '-r', '165', '-o', spokenInput, instruction], { stdio: 'ignore', timeout: 45_000 });
    execFileSync('ffmpeg', ['-nostdin', '-y', '-i', spokenInput, '-af', 'aresample=48000,adelay=12000:all=1,apad=pad_dur=30', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', microphoneWavPath], { stdio: 'ignore', timeout: 45_000 });
    await chmod(microphoneWavPath, 0o600);
  }
}

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
let voiceTurnResponsePromise: Promise<Response> | null = null;
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
      `--use-file-for-fake-audio-capture=${microphoneWavPath}`,
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
    if (response.request().method() === 'POST' && /\/api\/voice-calls\/[^/]+\/turns$/.test(url.pathname)) result.turnSubmissionCount += 1;
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

  await check(`a page click establishes the public SeedDuplex session using ${agentTaskMode ? 'synthetic Chinese audio' : 'synthetic silent audio'}`, async () => {
    await page!.addInitScript(({ capturePcm }) => {
      const NativeWebSocket = window.WebSocket;
      const sockets: WebSocket[] = [];
      type SpeechRun = { text: string; pcmBytes: number; pcmFrames: number; audioFormat: number | null; scheduledSources: number; playbackCompletedSources: number; destinationConnections: number; audioContextState: string | null; ended: boolean; chunks: string[] };
      const runs: SpeechRun[] = [];
      const capture = { sockets, runs, capturePcm };
      Object.defineProperty(window, '__dotsPublicVoiceCapture', { configurable: false, value: capture });
      window.WebSocket = new Proxy(NativeWebSocket, {
        construct(target, args, newTarget) {
          const socket = Reflect.construct(target, args, newTarget) as WebSocket;
          if (String(args[0]).includes('/volcengine-stream')) {
            sockets.push(socket);
            const nativeSend = socket.send.bind(socket);
            socket.send = data => {
              if (typeof data === 'string') {
                try {
                  const message = JSON.parse(data) as { type?: string; text?: string };
                  if (message.type === 'speak' && message.text) runs.push({ text: message.text, pcmBytes: 0, pcmFrames: 0, audioFormat: null, scheduledSources: 0, playbackCompletedSources: 0, destinationConnections: 0, audioContextState: null, ended: false, chunks: [] });
                } catch { /* Audio and control messages are only observed, never changed. */ }
              }
              nativeSend(data);
            };
            socket.addEventListener('message', event => {
              if (typeof event.data === 'string') {
                try {
                  const message = JSON.parse(event.data) as { type?: string };
                  if (message.type === 'speech-ended' && runs.length) runs[runs.length - 1].ended = true;
                } catch { /* Provider metadata is not needed by this test. */ }
                return;
              }
              const inspect = (buffer: ArrayBuffer) => {
                const bytes = new Uint8Array(buffer);
                if (bytes.length < 5 || (bytes[0] !== 1 && bytes[0] !== 2) || !runs.length) return;
                const run = runs[runs.length - 1];
                run.audioFormat = bytes[0];
                run.pcmBytes += bytes.length - 1;
                run.pcmFrames += 1;
                if (capturePcm) {
                  let binary = '';
                  const pcm = bytes.subarray(1);
                  for (let offset = 0; offset < pcm.length; offset += 0x8000) binary += String.fromCharCode(...pcm.subarray(offset, Math.min(offset + 0x8000, pcm.length)));
                  run.chunks.push(btoa(binary));
                }
              };
              if (event.data instanceof ArrayBuffer) inspect(event.data);
              else if (event.data instanceof Blob) void event.data.arrayBuffer().then(inspect);
            });
          }
          return socket;
        },
      });
      const nativeStart = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...args: [when?: number, offset?: number, duration?: number]) {
        if (runs.length) {
          const run = runs[runs.length - 1];
          run.scheduledSources += 1;
          const audioContext = this.context as AudioContext;
          run.audioContextState = audioContext.state;
          const requestedStartAt = args[0] ?? 0;
          const actualStartAt = requestedStartAt > 0 ? requestedStartAt : audioContext.currentTime;
          const offset = args[1] ?? 0;
          const duration = args[2] ?? Math.max(0, (this.buffer?.duration || 0) - offset);
          const expectedEndAt = actualStartAt + duration;
          this.addEventListener('ended', () => {
            if (audioContext.currentTime + 0.01 >= expectedEndAt) run.playbackCompletedSources += 1;
          }, { once: true });
        }
        return nativeStart.apply(this, args);
      };
      const nativeConnect = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (destination: AudioNode | AudioParam, ...args: unknown[]) {
        if (this instanceof AudioBufferSourceNode && destination instanceof AudioDestinationNode) {
          const run = runs[runs.length - 1];
          if (run) run.destinationConnections += 1;
        }
        return (nativeConnect as (...parameters: unknown[]) => AudioNode).call(this, destination, ...args);
      };
    }, { capturePcm: true });
    if (agentTaskMode) {
      voiceTurnResponsePromise = page!.waitForResponse(response => {
        const pathname = new URL(response.url()).pathname;
        return response.request().method() === 'POST' && pathname.startsWith(`${basePath}api/voice-calls/`) && /\/turns$/.test(pathname);
      }, { timeout: 120_000 });
    }
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
      const sockets = (window as Window & { __dotsPublicVoiceCapture?: { sockets?: WebSocket[] } }).__dotsPublicVoiceCapture?.sockets || [];
      const socket = sockets.find(item => item.readyState === WebSocket.OPEN);
      return socket?.url || null;
    }, null, { timeout: 10_000 }).then(handle => handle.jsonValue() as Promise<string>);
    const url = new URL(socketUrl);
    assert.equal(url.protocol, 'wss:');
    assert.equal(url.pathname, `${basePath}api/voice-calls/${callBody.id}/volcengine-stream`);
    result.websocketPath = url.pathname;
  });

  if (agentTaskMode) {
    await check('the signed-in tenant has a ready Linux cloud computer and the Pi cloud Agent available', async () => {
      const state = await page!.evaluate(async () => {
        const response = await fetch('api/state', { cache: 'no-store' });
        return { status: response.status, body: response.ok ? await response.json() as { remoteEngines?: string[] } : null };
      });
      assert.equal(state.status, 200);
      assert(state.body?.remoteEngines?.includes('pi'), 'Pi must be available in the tenant cloud computer');
      await page!.getByTestId('engine-select').selectOption('pi');
      assert.equal(await page!.getByTestId('engine-select').inputValue(), 'pi');
      const computer = await page!.evaluate(async () => {
        const response = await fetch('api/computer', { cache: 'no-store' });
        return { status: response.status, body: response.ok ? await response.json() as { ready?: boolean; backend?: string; owner?: string; url?: string; title?: string } : null };
      });
      assert.equal(computer.status, 200);
      assert.equal(computer.body?.backend, 'linux-desktop');
      assert.equal(computer.body?.ready, true, 'This voice test never provisions or restarts a cloud computer');
      assert.equal(computer.body?.owner, 'agent');
    });

    await check('Chrome captures one synthetic Chinese utterance, submits it once to Pi, and verifies the spoken cloud-agent result', async () => {
      const callId = result.voiceCallId;
      assert(callId);
      assert(voiceTurnResponsePromise, 'The voice task response listener must be armed before Chrome starts microphone capture');
      const turnResponse = await voiceTurnResponsePromise;
      assert.equal(new URL(turnResponse.url()).pathname, `${basePath}api/voice-calls/${callId}/turns`);
      result.statuses[`POST ${basePath}api/voice-calls/${callId}/turns`] = turnResponse.status();
      assert.equal(turnResponse.status(), 201, 'The recognized speech must create exactly one voice task');
      const task = await turnResponse.json() as { id?: string; engine?: string; status?: string };
      assert(task.id);
      assert.equal(task.engine, 'pi');
      result.agentTaskId = task.id;

      await page!.getByTestId('voice-call-transcript').waitFor({ state: 'visible' });
      await page!.waitForFunction(() => document.querySelector('[data-testid="voice-call-transcript"]')?.textContent?.includes('你说：') === true, null, { timeout: 10_000 });
      const spokenTranscript = await page!.getByTestId('voice-call-transcript').innerText();
      assert.match(spokenTranscript, /example|网页|标题/i, `The synthetic Mandarin utterance was not recognized as the requested website task: ${spokenTranscript}`);
      assert.match(spokenTranscript, /中文|意思|告诉/i, `The recognized request did not retain the Chinese response requirement: ${spokenTranscript}`);
      result.transcriptVerified = true;

      // Stop the looping fake microphone immediately after its one accepted turn.
      await page!.getByRole('button', { name: '静音' }).click();
      assert.equal(result.turnSubmissionCount, 1, 'Voice recognition must not enqueue duplicate tasks');

      await page!.waitForFunction(async taskId => {
        const response = await fetch('api/state', { cache: 'no-store' });
        if (!response.ok) return false;
        const snapshot = await response.json() as { tasks?: { id: string; status: string }[] };
        return snapshot.tasks?.some(candidate => candidate.id === taskId && ['done', 'failed', 'waiting', 'paused', 'stopped'].includes(candidate.status)) || false;
      }, task.id, { timeout: Number(process.env.DOTS_PUBLIC_VOICE_AGENT_TIMEOUT_MS || 240_000), polling: 1500 });
      const persisted = await page!.evaluate(async taskId => {
        const response = await fetch('api/state', { cache: 'no-store' });
        const snapshot = await response.json() as { tasks?: { id: string; status: string; engine: string; title: string; result: string | null; error: string | null }[] };
        return snapshot.tasks?.find(candidate => candidate.id === taskId) || null;
      }, task.id);
      assert(persisted, 'The Pi task must remain visible in the authenticated tenant state');
      assert.equal(persisted.status, 'done', `The cloud Agent task did not finish: ${persisted.error || persisted.status}`);
      assert.equal(persisted.engine, 'pi');
      assert.match(persisted.result || '', /Example Domain/i);
      assert.match(persisted.result || '', /[\u4e00-\u9fff]/, 'The cloud Agent result must be in Chinese');
      result.agentTaskCompleted = true;

      const computer = await page!.evaluate(async () => {
        const response = await fetch('api/computer', { cache: 'no-store' });
        return response.ok ? await response.json() as { ready?: boolean; backend?: string; owner?: string; url?: string; title?: string } : null;
      });
      assert.equal(computer?.backend, 'linux-desktop');
      assert.equal(computer?.ready, true);
      assert.equal(computer?.owner, 'agent');
      assert.match(computer?.url || '', /example\.com/i, 'Pi must have opened the public page inside the tenant cloud computer');
      assert.match(computer?.title || '', /Example Domain/i);

      await page!.waitForFunction(expectedText => {
        const capture = (window as Window & { __dotsPublicVoiceCapture?: { runs?: { text: string; pcmBytes: number; pcmFrames: number; audioFormat: number | null; scheduledSources: number; playbackCompletedSources: number; ended: boolean; destinationConnections: number; audioContextState: string | null }[] } }).__dotsPublicVoiceCapture;
        return capture?.runs?.some(run => run.text === expectedText && run.audioFormat === 2 && run.pcmBytes > 10_000 && run.pcmFrames > 2 && run.scheduledSources > 0 && run.playbackCompletedSources === run.scheduledSources && run.destinationConnections > 0 && run.audioContextState === 'running' && run.ended) || false;
      }, persisted.result || '', { timeout: 60_000, polling: 250 });
      const audioEvidence = await page!.evaluate(expectedText => {
        const capture = (window as Window & { __dotsPublicVoiceCapture?: { runs?: { text: string; pcmBytes: number; pcmFrames: number; audioFormat: number | null; scheduledSources: number; playbackCompletedSources: number; ended: boolean; chunks: string[]; destinationConnections: number; audioContextState: string | null }[] } }).__dotsPublicVoiceCapture;
        const run = capture?.runs?.find(candidate => candidate.text === expectedText);
        return run ? { text: run.text, pcmBytes: run.pcmBytes, pcmFrames: run.pcmFrames, audioFormat: run.audioFormat, scheduledSources: run.scheduledSources, playbackCompletedSources: run.playbackCompletedSources, destinationConnections: run.destinationConnections, audioContextState: run.audioContextState, ended: run.ended, chunks: run.chunks } : null;
      }, persisted.result || '');
      assert(audioEvidence);
      assert(audioEvidence.destinationConnections > 0, 'The decoded response must connect to Chrome’s speaker destination');
      assert.equal(audioEvidence.audioContextState, 'running', 'Chrome’s audio output context must be running');
      assert.equal(audioEvidence.audioFormat, 2, 'SeedDuplex PCM must use its float32 browser decoder');
      assert(audioEvidence.chunks.length > 0, 'The returned SeedDuplex PCM must be captured for playback verification');
      assert.match(audioEvidence.text, /Example Domain/i);
      assert.match(audioEvidence.text, /[\u4e00-\u9fff]/);
      result.outputAudioBytes = audioEvidence.pcmBytes;
      result.outputAudioFrames = audioEvidence.pcmFrames;
      result.outputAudioEncoding = 'pcm_f32le';
      result.outputAudioScheduledSources = audioEvidence.scheduledSources;
      result.outputAudioPlaybackCompletedSources = audioEvidence.playbackCompletedSources;
      result.speakerDestinationConnections = audioEvidence.destinationConnections;
      result.speakerOutputPathVerified = audioEvidence.audioContextState === 'running' && audioEvidence.destinationConnections > 0;
      result.spokenResultVerified = true;

      const quality = await saveFloat32AssistantReply(audioEvidence.chunks);
      result.outputAudioRms = Number(quality.rms.toFixed(5));
      result.outputAudioPeak = Number(quality.peak.toFixed(5));
      result.outputAudioLagOneCorrelation = Number(quality.lagOneCorrelation.toFixed(5));
    });
  } else await check('the public browser sends Chinese speech text to SeedDuplex and receives synthesized audio', async () => {
    assert.equal(await page!.getByRole('button', { name: '关闭扬声器' }).getAttribute('aria-pressed'), 'true', 'The public call must leave its speaker enabled');
    await page!.getByRole('button', { name: '静音' }).click();
    const text = '公网火山语音服务测试成功。';
    await page!.evaluate(async inputText => {
      const sockets = (window as Window & { __dotsPublicVoiceCapture?: { sockets?: WebSocket[] } }).__dotsPublicVoiceCapture?.sockets || [];
      const socket = sockets.find(item => item.readyState === WebSocket.OPEN);
      if (!socket) throw new Error('The public SeedDuplex websocket is not open');
      socket.send(JSON.stringify({ type: 'speak', text: inputText }));
    }, text);
    await page!.waitForFunction(expectedText => {
      const capture = (window as Window & { __dotsPublicVoiceCapture?: { runs?: { text: string; pcmBytes: number; pcmFrames: number; audioFormat: number | null; scheduledSources: number; playbackCompletedSources: number; ended: boolean; destinationConnections: number; audioContextState: string | null }[] } }).__dotsPublicVoiceCapture;
      return capture?.runs?.some(run => run.text === expectedText && run.audioFormat === 2 && run.pcmBytes > 10_000 && run.pcmFrames > 2 && run.scheduledSources > 0 && run.playbackCompletedSources === run.scheduledSources && run.destinationConnections > 0 && run.audioContextState === 'running' && run.ended) || false;
    }, text, { timeout: 25_000, polling: 100 });
    const audioEvidence = await page!.evaluate(expectedText => {
      const capture = (window as Window & { __dotsPublicVoiceCapture?: { runs?: { text: string; pcmBytes: number; pcmFrames: number; audioFormat: number | null; scheduledSources: number; playbackCompletedSources: number; ended: boolean; destinationConnections: number; audioContextState: string | null; chunks: string[] }[] } }).__dotsPublicVoiceCapture;
      const run = capture?.runs?.find(candidate => candidate.text === expectedText);
      return run ? { text: run.text, pcmBytes: run.pcmBytes, pcmFrames: run.pcmFrames, audioFormat: run.audioFormat, scheduledSources: run.scheduledSources, playbackCompletedSources: run.playbackCompletedSources, destinationConnections: run.destinationConnections, audioContextState: run.audioContextState, ended: run.ended, chunks: run.chunks } : null;
    }, text);
    assert(audioEvidence);
    assert.equal(audioEvidence.destinationConnections > 0, true, 'The decoded response must reach Chrome’s speaker destination');
    assert.equal(audioEvidence.audioContextState, 'running', 'Chrome’s audio output context must be running');
    assert.equal(audioEvidence.audioFormat, 2, 'SeedDuplex PCM must use its float32 browser decoder');
    assert(audioEvidence.chunks.length > 0);
    result.outputAudioBytes = audioEvidence.pcmBytes;
    result.outputAudioFrames = audioEvidence.pcmFrames;
    result.outputAudioEncoding = 'pcm_f32le';
    result.outputAudioScheduledSources = audioEvidence.scheduledSources;
    result.outputAudioPlaybackCompletedSources = audioEvidence.playbackCompletedSources;
    result.speakerDestinationConnections = audioEvidence.destinationConnections;
    result.speakerOutputPathVerified = audioEvidence.audioContextState === 'running' && audioEvidence.destinationConnections > 0;
    result.spokenResultVerified = true;

    const quality = await saveFloat32AssistantReply(audioEvidence.chunks);
    result.outputAudioRms = Number(quality.rms.toFixed(5));
    result.outputAudioPeak = Number(quality.peak.toFixed(5));
    result.outputAudioLagOneCorrelation = Number(quality.lagOneCorrelation.toFixed(5));
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
