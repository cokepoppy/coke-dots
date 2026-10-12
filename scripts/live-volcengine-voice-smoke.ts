import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import { isVolcengineFloat32Pcm } from '../src/server/volcengine-duplex-voice-gateway.ts';
import {
  volcengineDuplexHeaders,
  volcengineDuplexRealtimeUrl,
  volcengineDuplexSessionPayload,
  volcengineDuplexSpeechTextEvent,
  volcengineVoiceConfig,
  VolcengineVoiceError,
} from '../src/server/volcengine-voice.ts';

const envFile = resolve(process.env.DOTS_ENV_FILE || '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = volcengineVoiceConfig(process.env);
if (config.mode !== 'seedduplex') throw new VolcengineVoiceError('需要配置 DOTS_VOLCENGINE_API_KEY', 503);

const startedAt = Date.now();
const requestId = randomUUID();
const connectId = randomUUID();
const socket = new WebSocket(volcengineDuplexRealtimeUrl(process.env), {
  headers: volcengineDuplexHeaders(config, requestId, connectId),
  handshakeTimeout: 15_000,
  maxPayload: 1024 * 1024,
  perMessageDeflate: false,
});

let settled = false;
let sessionCreated = false;
let audioBytes = 0;
let firstAudioMs: number | null = null;
const audioChunks: Buffer[] = [];
let audioFinalizing = false;
const timeout = setTimeout(() => finish({ ok: false, stage: 'timeout', sessionCreated, audioBytes }), 30_000);

function finish(result: Record<string, unknown>, exitCode = 0) {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  console.log(JSON.stringify({ ...result, elapsedMs: Date.now() - startedAt }));
  process.exitCode = exitCode;
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
}

function send(type: string, payload: Record<string, unknown> = {}) {
  if (socket.readyState !== WebSocket.OPEN) throw new Error('provider socket is not open');
  socket.send(JSON.stringify({ type, event_id: randomUUID(), ...payload }));
}

async function saveAndInspectAudio() {
  const floatPcm = Buffer.concat(audioChunks);
  if (floatPcm.length === 0 || floatPcm.length % 4 !== 0) throw new Error('SeedDuplex returned incomplete float32 audio samples');

  const sampleCount = floatPcm.length / 4;
  const outputPcm = Buffer.alloc(sampleCount * 2);
  let sum = 0;
  let sumSquares = 0;
  let peak = 0;
  let clippedSamples = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = floatPcm.readFloatLE(index * 4);
    if (!Number.isFinite(sample) || Math.abs(sample) > 1.5) throw new Error('SeedDuplex returned a non-normalized float32 sample');
    sum += sample;
    sumSquares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
    const clipped = Math.max(-1, Math.min(1, sample));
    if (Math.abs(clipped) >= 0.999) clippedSamples += 1;
    outputPcm.writeInt16LE(Math.round(clipped * (clipped < 0 ? 32768 : 32767)), index * 2);
  }

  const mean = sum / sampleCount;
  let centeredCovariance = 0;
  let centeredVariance = 0;
  for (let index = 1; index < sampleCount; index += 1) {
    const current = floatPcm.readFloatLE(index * 4) - mean;
    const prior = floatPcm.readFloatLE((index - 1) * 4) - mean;
    centeredCovariance += current * prior;
    centeredVariance += current * current;
  }
  const quality = {
    durationSeconds: Number((sampleCount / 24_000).toFixed(2)),
    rms: Number(Math.sqrt(sumSquares / sampleCount).toFixed(5)),
    peak: Number(peak.toFixed(5)),
    clippedSampleRatio: Number((clippedSamples / sampleCount).toFixed(6)),
    lagOneCorrelation: Number((centeredVariance > 0 ? centeredCovariance / centeredVariance : 0).toFixed(5)),
  };

  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + outputPcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24); header.writeUInt32LE(48_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(outputPcm.length, 40);
  const artifactDir = resolve(process.env.DOTS_VOICE_ARTIFACT_DIR || 'artifacts/volcengine-live-smoke');
  await mkdir(artifactDir, { recursive: true, mode: 0o700 });
  await chmod(artifactDir, 0o700);
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const audioPath = resolve(artifactDir, `assistant-reply-${timestamp}.wav`);
  await writeFile(audioPath, Buffer.concat([header, outputPcm]), { mode: 0o600 });
  await chmod(audioPath, 0o600);

  return {
    audioPath,
    quality,
    qualityPassed: quality.rms > 0.005 && quality.rms < 0.35 && quality.peak > 0.02 && quality.clippedSampleRatio < 0.01 && quality.lagOneCorrelation > 0.2,
  };
}

function completeSpeech() {
  if (audioFinalizing || settled) return;
  audioFinalizing = true;
  void saveAndInspectAudio().then(({ audioPath, quality, qualityPassed }) => finish({
    ok: audioBytes > 0 && qualityPassed,
    stage: qualityPassed ? 'speech-complete' : 'audio-quality-check-failed',
    sessionCreated,
    audioFormat: 'float32-le-24khz-mono',
    audioBytes,
    firstAudioMs,
    audioPath,
    quality,
  }, audioBytes > 0 && qualityPassed ? 0 : 1)).catch(error => finish({
    ok: false,
    stage: 'audio-artifact-failed',
    sessionCreated,
    audioBytes,
    errorType: error instanceof Error ? error.name : 'Error',
  }, 1));
}

socket.on('open', () => {
  socket.send(JSON.stringify(volcengineDuplexSessionPayload('Dot', randomUUID())));
});

socket.on('unexpected-response', (_request, response) => {
  const chunks: Buffer[] = [];
  response.on('data', chunk => chunks.push(Buffer.from(chunk)));
  response.on('end', () => {
    let body: Record<string, any> = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, any>; } catch { /* Keep diagnostics bounded. */ }
    const error = body.error || {};
    const code = typeof error.code === 'string' || typeof error.code === 'number' ? error.code : null;
    const rawMessage = typeof error.message === 'string' ? error.message : 'Provider rejected the websocket handshake';
    const message = rawMessage.replaceAll(config.apiKey, '[redacted]').slice(0, 300);
    finish({
      ok: false,
      stage: 'handshake-rejected',
      status: response.statusCode || null,
      code,
      message,
      ttLogId: response.headers['x-tt-logid'] || null,
      ...(String(code) === '45000030' ? { diagnosis: 'Speech Console has not granted resource volc.speech.dialog to this API Key; check the active project and service entitlement.' } : {}),
    }, 1);
  });
});

socket.on('message', raw => {
  let event: Record<string, any>;
  try { event = JSON.parse(raw.toString()) as Record<string, any>; }
  catch { finish({ ok: false, stage: 'invalid-provider-event' }, 1); return; }

  if (event.type === 'error') {
    const error = event.error || {};
    const code = typeof error.code === 'string' || typeof error.code === 'number' ? error.code : null;
    const rawMessage = typeof error.message === 'string' ? error.message : 'Provider returned an error';
    finish({ ok: false, stage: 'provider-error', code, message: rawMessage.replaceAll(config.apiKey, '[redacted]').slice(0, 300) }, 1);
    return;
  }
  if (event.type === 'session.created' && !sessionCreated) {
    sessionCreated = true;
    try {
      socket.send(JSON.stringify(volcengineDuplexSpeechTextEvent('请用普通话只说：火山实时语音连接成功。')));
    } catch {
      finish({ ok: false, stage: 'session-send-failed', sessionCreated, audioBytes }, 1);
    }
    return;
  }
  if (event.type === 'response.output_audio.delta' && typeof event.delta === 'string') {
    const chunk = Buffer.from(event.delta, 'base64');
    if (chunk.length > 0) {
      if (!isVolcengineFloat32Pcm(chunk)) {
        finish({ ok: false, stage: 'unexpected-audio-format', sessionCreated, audioBytes: audioBytes + chunk.length }, 1);
        return;
      }
      audioChunks.push(chunk);
      audioBytes += chunk.length;
      firstAudioMs ??= Date.now() - startedAt;
    }
    return;
  }
  if (event.type === 'response.output_audio.done' && !audioFinalizing) {
    try { send('session.close'); } catch { /* The audio response itself is still a successful smoke result. */ }
    completeSpeech();
    return;
  }
  if (event.type === 'session.closed') {
    if (audioBytes > 0) completeSpeech();
    else finish({ ok: false, stage: 'session-closed-without-audio', sessionCreated, audioFormat: null, audioBytes, firstAudioMs }, 1);
  }
});

socket.on('error', error => finish({ ok: false, stage: 'socket-error', errorType: error.name }, 1));
socket.on('close', (code: number) => {
  if (!settled) finish({ ok: false, stage: 'socket-closed', closeCode: code, sessionCreated, audioBytes }, 1);
});
