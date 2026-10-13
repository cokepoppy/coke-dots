import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import {
  volcengineDuplexHeaders,
  volcengineDuplexRealtimeUrl,
  volcengineDuplexSessionPayload,
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
let closeTimer: NodeJS.Timeout | null = null;
const timeout = setTimeout(() => finish({ ok: false, stage: 'timeout', sessionCreated, audioBytes }), 30_000);

function finish(result: Record<string, unknown>, exitCode = 0) {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  if (closeTimer) clearTimeout(closeTimer);
  console.log(JSON.stringify({ ...result, elapsedMs: Date.now() - startedAt }));
  process.exitCode = exitCode;
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
}

function send(type: string, payload: Record<string, unknown> = {}) {
  if (socket.readyState !== WebSocket.OPEN) throw new Error('provider socket is not open');
  socket.send(JSON.stringify({ type, event_id: randomUUID(), ...payload }));
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
      send('speech_text_buffer.commit', { text: '请用普通话只说：火山实时语音连接成功。' });
    } catch {
      finish({ ok: false, stage: 'session-send-failed', sessionCreated, audioBytes }, 1);
    }
    return;
  }
  if (event.type === 'response.output_audio.delta' && typeof event.delta === 'string') {
    const chunk = Buffer.from(event.delta, 'base64');
    if (chunk.length > 0) {
      audioBytes += chunk.length;
      firstAudioMs ??= Date.now() - startedAt;
    }
    return;
  }
  if (event.type === 'response.output_audio.done' && closeTimer === null) {
    try { send('session.close'); } catch { /* The audio response itself is still a successful smoke result. */ }
    closeTimer = setTimeout(() => finish({ ok: audioBytes > 0, stage: 'speech-complete', sessionCreated, audioBytes, firstAudioMs }, audioBytes > 0 ? 0 : 1), 5_000);
    return;
  }
  if (event.type === 'session.closed') {
    finish({ ok: audioBytes > 0, stage: audioBytes > 0 ? 'speech-complete' : 'session-closed-without-audio', sessionCreated, audioBytes, firstAudioMs }, audioBytes > 0 ? 0 : 1);
  }
});

socket.on('error', error => finish({ ok: false, stage: 'socket-error', errorType: error.name }, 1));
socket.on('close', (code: number) => {
  if (!settled) finish({ ok: false, stage: 'socket-closed', closeCode: code, sessionCreated, audioBytes }, 1);
});
