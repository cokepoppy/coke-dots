import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeVolcengineFrame,
  encodeVolcengineAudio,
  encodeVolcengineEvent,
  volcengineHeaders,
  volcengineRealtimeUrl,
  volcengineSessionId,
  volcengineStartSessionPayload,
  volcengineVoiceConfig,
  volcengineVoiceInfo,
  VolcengineVoiceError,
} from '../src/server/volcengine-voice.ts';

const env = (): NodeJS.ProcessEnv => ({ DOTS_VOLCENGINE_APP_ID: 'test-app', DOTS_VOLCENGINE_ACCESS_TOKEN: 'server-token' });

test('Volcano credentials are validated and never returned in public provider information', () => {
  assert.deepEqual(volcengineVoiceInfo({}), { provider: 'volcengine', configured: false, model: 'doubao-realtime-dialogue-2.0' });
  assert.deepEqual(volcengineVoiceInfo(env()), { provider: 'volcengine', configured: true, model: 'doubao-realtime-dialogue-2.0' });
  assert.deepEqual(volcengineVoiceConfig(env()), { appId: 'test-app', accessToken: 'server-token', resourceId: 'volc.speech.dialog' });
  const headers = volcengineHeaders(volcengineVoiceConfig(env()), 'call-connection');
  assert.equal(headers['X-Api-App-ID'], 'test-app');
  assert.equal(headers['X-Api-Access-Key'], 'server-token');
  assert.equal(headers['X-Api-Resource-Id'], 'volc.speech.dialog');
  assert.equal(volcengineVoiceInfo(env()).configured, true);
  assert.equal(JSON.stringify(volcengineVoiceInfo(env())).includes('server-token'), false);
  assert.throws(() => volcengineVoiceConfig({ ...env(), DOTS_VOLCENGINE_RESOURCE_ID: 'other-resource' }), /Resource ID/);
});

test('Volcano test websocket override is restricted to a local test server', () => {
  assert.equal(volcengineRealtimeUrl({ NODE_ENV: 'test', DOTS_E2E_AUTH: '1', DOTS_E2E_VOLCENGINE_WS_URL: 'ws://127.0.0.1:9123/voice' }), 'ws://127.0.0.1:9123/voice');
  assert.equal(volcengineRealtimeUrl({ NODE_ENV: 'production', DOTS_E2E_AUTH: '1', DOTS_E2E_VOLCENGINE_WS_URL: 'ws://127.0.0.1/voice' }), 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue');
  assert.throws(() => volcengineRealtimeUrl({ NODE_ENV: 'test', DOTS_E2E_AUTH: '1', DOTS_E2E_VOLCENGINE_WS_URL: 'wss://attacker.example/voice' }), /测试语音服务地址无效/);
});

test('Volcano event framing encodes event, session id, JSON payload, and big-endian lengths', () => {
  const encoded = encodeVolcengineEvent(100, { dialog: { bot_name: 'Dot' } }, 'session-123');
  assert.equal(encoded[0], 0x11);
  assert.equal(encoded[1], 0x14);
  assert.equal(encoded[2], 0x10);
  assert.equal(encoded.readUInt32BE(4), 100);
  assert.equal(encoded.readUInt16BE(8), 11);
  const decoded = decodeVolcengineFrame(encoded);
  assert.equal(decoded.eventId, 100);
  assert.equal(decoded.sessionId, 'session-123');
  assert.equal(decoded.payloadIsJson, true);
  assert.deepEqual(JSON.parse(decoded.payload.toString('utf8')), { dialog: { bot_name: 'Dot' } });
});

test('Volcano PCM packets use the audio-only request frame and preserve raw little-endian samples', () => {
  const pcm = Buffer.from([0x01, 0x00, 0xff, 0xff]);
  const encoded = encodeVolcengineAudio(pcm, 's');
  assert.equal(encoded[1], 0x24);
  assert.equal(encoded[2], 0x00);
  const decoded = decodeVolcengineFrame(encoded);
  assert.equal(decoded.messageType, 2);
  assert.equal(decoded.eventId, 200);
  assert.equal(decoded.sessionId, 's');
  assert.deepEqual(decoded.payload, pcm);
  assert.throws(() => encodeVolcengineAudio(Buffer.from([0]), 's'), error => error instanceof VolcengineVoiceError && error.status === 400);
});

test('Volcano response decoder handles connection frames without an identifier and raw PCM audio', () => {
  const connection = encodeVolcengineEvent(50, {});
  assert.equal(decodeVolcengineFrame(connection).eventId, 50);
  const sessionId = volcengineSessionId();
  assert.match(sessionId, /^[0-9a-f-]{36}$/i);
  const pcm = Buffer.alloc(128);
  const id = Buffer.from(sessionId, 'utf8');
  const tts = Buffer.alloc(4 + 4 + 2 + id.length + 4 + pcm.length);
  tts.set([0x11, 0xb4, 0x00, 0x00], 0);
  tts.writeUInt32BE(352, 4);
  tts.writeUInt16BE(id.length, 8);
  id.copy(tts, 10);
  tts.writeUInt32BE(pcm.length, 10 + id.length);
  pcm.copy(tts, 14 + id.length);
  const decoded = decodeVolcengineFrame(tts);
  assert.equal(decoded.eventId, 352);
  assert.equal(decoded.sessionId, sessionId);
  assert.equal(decoded.payloadIsJson, false);
  assert.deepEqual(decoded.payload, pcm);
});

test('Volcano session requests Chinese PCM output and limits Dot names', () => {
  const payload = volcengineStartSessionPayload('名字\n太长'.repeat(8));
  assert.equal(payload.dialog.bot_name.length, 20);
  assert.equal(payload.dialog.extra.model, '1.2.1.1');
  assert.equal(payload.tts.audio_config.format, 'pcm_s16le');
  assert.equal(payload.tts.audio_config.sample_rate, 24000);
  assert.match(payload.dialog.system_role, /简体中文/);
});
