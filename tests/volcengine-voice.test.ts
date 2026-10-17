import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeVolcengineFloat32Pcm } from '../src/shared/volcengine-audio.ts';
import { isVolcengineFloat32Pcm, safeVolcengineProviderErrorCode, safeVolcengineProviderLogId, updateVolcengineTranscriptSnapshot } from '../src/server/volcengine-duplex-voice-gateway.ts';
import {
  VOLCENGINE_DUPLEX_MODEL_VERSION,
  decodeVolcengineFrame,
  encodeVolcengineAudio,
  encodeVolcengineEvent,
  volcengineDuplexHeaders,
  volcengineDuplexHandshakeErrorMessage,
  volcengineDuplexRealtimeUrl,
  volcengineDuplexSessionPayload,
  volcengineHeaders,
  volcengineRealtimeUrl,
  volcengineSessionId,
  volcengineStartSessionPayload,
  volcengineVoiceConfig,
  volcengineVoiceInfo,
  VolcengineVoiceError,
} from '../src/server/volcengine-voice.ts';

const env = (): NodeJS.ProcessEnv => ({ DOTS_VOLCENGINE_APP_ID: 'test-app', DOTS_VOLCENGINE_ACCESS_TOKEN: 'server-token' });

test('SeedDuplex cumulative ASR snapshots replace earlier partials without repeating them', () => {
  const snapshots = [
    '情',
    '情之用中文回复。',
    '情之用中文回复',
    '情之用中文回复公网火山语音识别测试成功不要调用工具',
    '情之用中文回复，公网火山语音识别测试成功，不要调用工具。',
  ];
  const transcript = snapshots.reduce(updateVolcengineTranscriptSnapshot, '');
  assert.equal(transcript, '情之用中文回复，公网火山语音识别测试成功，不要调用工具。');
  assert.equal(updateVolcengineTranscriptSnapshot(transcript, ''), transcript, 'An empty provider event must not erase the latest transcript');
});

test('SeedDuplex diagnostics retain only bounded numeric provider error codes', () => {
  assert.equal(safeVolcengineProviderErrorCode({ type: 'error', error: { code: 45000030, message: 'private text and api_key=secret' } }), '45000030');
  assert.equal(safeVolcengineProviderErrorCode({ type: 'error', code: '401' }), '401');
  assert.equal(safeVolcengineProviderErrorCode({ type: 'error', error: { code: 'secret-token', message: 'private' } }), null);
  assert.equal(safeVolcengineProviderErrorCode({ type: 'error', error: { message: 'private' } }), null);
  assert.equal(safeVolcengineProviderErrorCode(null), null);
});

test('SeedDuplex diagnostics retain only bounded safe provider Logids', () => {
  assert.equal(safeVolcengineProviderLogId(' 2026101804071234ABCDEF '), '2026101804071234ABCDEF');
  assert.equal(safeVolcengineProviderLogId(['2026101804071234ABCDEF', 'ignored']), '2026101804071234ABCDEF');
  assert.equal(safeVolcengineProviderLogId('logid=secret-value'), null);
  assert.equal(safeVolcengineProviderLogId('logid-with-newline\nprivate'), null);
  assert.equal(safeVolcengineProviderLogId('x'.repeat(129)), null);
  assert.equal(safeVolcengineProviderLogId(null), null);
});

test('SeedDuplex float32 PCM decodes little-endian samples and clamps invalid values', () => {
  const bytes = new ArrayBuffer(16);
  const view = new DataView(bytes);
  view.setFloat32(0, -1.25, true);
  view.setFloat32(4, -0.5, true);
  view.setFloat32(8, 0.75, true);
  view.setFloat32(12, Number.NaN, true);
  assert.deepEqual(Array.from(decodeVolcengineFloat32Pcm(bytes) || []), [-1, -0.5, 0.75, 0]);
  assert.equal(decodeVolcengineFloat32Pcm(new ArrayBuffer(2)), null);
  assert.equal(decodeVolcengineFloat32Pcm(new ArrayBuffer(6)), null);
});

test('SeedDuplex server accepts finite float32 output and rejects malformed or extreme samples', () => {
  const valid = Buffer.alloc(8);
  valid.writeFloatLE(-0.75, 0);
  valid.writeFloatLE(0.5, 4);
  assert.equal(isVolcengineFloat32Pcm(valid), true);
  assert.equal(isVolcengineFloat32Pcm(Buffer.alloc(6)), false);
  const invalid = Buffer.alloc(4);
  invalid.writeFloatLE(Number.NaN);
  assert.equal(isVolcengineFloat32Pcm(invalid), false);
  invalid.writeFloatLE(2);
  assert.equal(isVolcengineFloat32Pcm(invalid), false);
});

test('Volcano O2.0 credentials remain compatible and never appear in public provider information', () => {
  assert.deepEqual(volcengineVoiceInfo({}), { provider: 'volcengine', configured: false, model: 'doubao-seedduplex-3.0' });
  assert.deepEqual(volcengineVoiceInfo(env()), { provider: 'volcengine', configured: true, model: 'doubao-realtime-dialogue-2.0' });
  assert.deepEqual(volcengineVoiceConfig(env()), { mode: 'o2', appId: 'test-app', accessToken: 'server-token', resourceId: 'volc.speech.dialog' });
  const headers = volcengineHeaders(volcengineVoiceConfig(env()), 'call-connection');
  assert.equal(headers['X-Api-App-ID'], 'test-app');
  assert.equal(headers['X-Api-Access-Key'], 'server-token');
  assert.equal(headers['X-Api-Resource-Id'], 'volc.speech.dialog');
  assert.equal(volcengineVoiceInfo(env()).configured, true);
  assert.equal(JSON.stringify(volcengineVoiceInfo(env())).includes('server-token'), false);
  assert.throws(() => volcengineVoiceConfig({ ...env(), DOTS_VOLCENGINE_RESOURCE_ID: 'other-resource' }), /Resource ID/);
});

test('SeedDuplex API Key takes precedence over legacy credentials and stays server-side', () => {
  const config = volcengineVoiceConfig({ ...env(), DOTS_VOLCENGINE_API_KEY: 'seed-duplex-secret' });
  assert.deepEqual(config, { mode: 'seedduplex', apiKey: 'seed-duplex-secret' });
  assert.deepEqual(volcengineVoiceInfo({ DOTS_VOLCENGINE_API_KEY: 'seed-duplex-secret', ...env() }), { provider: 'volcengine', configured: true, model: 'doubao-seedduplex-3.0' });
  const headers = volcengineDuplexHeaders(config, 'request-id', 'connect-id');
  assert.deepEqual(headers, { 'X-Api-Key': 'seed-duplex-secret', 'X-Api-Request-Id': 'request-id', 'X-Api-Connect-Id': 'connect-id' });
  assert.equal(JSON.stringify(volcengineVoiceInfo({ DOTS_VOLCENGINE_API_KEY: 'seed-duplex-secret' })).includes('seed-duplex-secret'), false);
  assert.throws(() => volcengineVoiceConfig({ DOTS_VOLCENGINE_API_KEY: 'x'.repeat(4097) }), /API Key/);
});

test('SeedDuplex handshake entitlement errors are actionable and never expose provider response details', () => {
  const message = volcengineDuplexHandshakeErrorMessage(403, JSON.stringify({
    error: { code: 45000030, message: 'requested resource not granted [resource_id=volc.speech.dialog] key=secret-value' },
  }));
  assert.equal(message, '火山引擎端到端实时语音尚未开通，请在语音控制台为当前项目开通后重试。');
  assert.equal(message.includes('secret-value'), false);
  assert.equal(message.includes('requested resource'), false);
  assert.match(volcengineDuplexHandshakeErrorMessage(401, ''), /鉴权失败/);
  assert.match(volcengineDuplexHandshakeErrorMessage(403, ''), /语音服务权限/);
  assert.match(volcengineDuplexHandshakeErrorMessage(502, ''), /HTTP 502/);
});

test('Volcano test websocket override is restricted to a local test server', () => {
  assert.equal(volcengineRealtimeUrl({ NODE_ENV: 'test', DOTS_E2E_AUTH: '1', DOTS_E2E_VOLCENGINE_WS_URL: 'ws://127.0.0.1:9123/voice' }), 'ws://127.0.0.1:9123/voice');
  assert.equal(volcengineRealtimeUrl({ NODE_ENV: 'production', DOTS_E2E_AUTH: '1', DOTS_E2E_VOLCENGINE_WS_URL: 'ws://127.0.0.1/voice' }), 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue');
  assert.throws(() => volcengineRealtimeUrl({ NODE_ENV: 'test', DOTS_E2E_AUTH: '1', DOTS_E2E_VOLCENGINE_WS_URL: 'wss://attacker.example/voice' }), /测试语音服务地址无效/);
  assert.equal(volcengineDuplexRealtimeUrl({ NODE_ENV: 'test', DOTS_E2E_AUTH: '1', DOTS_E2E_VOLCENGINE_DUPLEX_WS_URL: 'ws://127.0.0.1:9123/duplex' }), 'ws://127.0.0.1:9123/duplex');
  assert.throws(() => volcengineDuplexRealtimeUrl({ NODE_ENV: 'test', DOTS_E2E_AUTH: '1', DOTS_E2E_VOLCENGINE_DUPLEX_WS_URL: 'wss://attacker.example/voice' }), /测试语音服务地址无效/);
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

test('SeedDuplex session.create uses the fixed 3.0 model, 16 kHz input, 24 kHz PCM output, and Chinese Agent instructions', () => {
  const event = volcengineDuplexSessionPayload('名字\n太长'.repeat(8), 'e2e-event-id');
  assert.equal(event.type, 'session.create');
  assert.equal(event.event_id, 'e2e-event-id');
  assert.equal(event.session.model, VOLCENGINE_DUPLEX_MODEL_VERSION);
  assert.deepEqual(event.session.audio, {
    input: { format: { type: 'pcm', rate: 16000 } },
    output: { format: { type: 'pcm', rate: 24000 }, voice: 'zh_female_vv_jupiter_bigtts' },
  });
  assert.equal(event.session.extension.tts.audio_config.format, event.session.audio.output.format.type);
  assert.equal(event.session.extension.tts.audio_config.format, 'pcm');
  assert.match(event.session.instructions, /简体中文/);
  assert.match(event.session.instructions, /Dots Agent/);
});
