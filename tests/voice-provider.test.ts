import assert from 'node:assert/strict';
import { test } from 'node:test';
import { negotiateQwenRealtime, qwenRealtimeConfig, qwenRealtimeEndpoint, VoiceProviderError, voiceProviderInfo } from '../src/server/voice-provider.ts';

const offer = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
const answer = 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
const env = (): NodeJS.ProcessEnv => ({ DOTS_VOICE_PROVIDER: 'qwen', DOTS_QWEN_API_KEY: 'server-secret', DOTS_QWEN_WORKSPACE_ID: 'workspace-123', DOTS_QWEN_REGION: 'beijing' });

test('Qwen configuration reports availability without exposing credentials', () => {
  assert.deepEqual(voiceProviderInfo({}), { provider: 'browser', configured: true });
  assert.deepEqual(voiceProviderInfo({ DOTS_VOICE_PROVIDER: 'typo' }), { provider: 'unsupported', configured: false });
  assert.deepEqual(voiceProviderInfo({ DOTS_VOICE_PROVIDER: 'qwen' }), { provider: 'qwen', configured: false, model: 'qwen3.8-omni-flash-realtime' });
  assert.deepEqual(voiceProviderInfo(env()), { provider: 'qwen', configured: true, model: 'qwen3.8-omni-flash-realtime' });
  assert.equal(qwenRealtimeEndpoint(qwenRealtimeConfig({ ...env(), DOTS_QWEN_REGION: 'singapore' })), 'https://workspace-123.ap-southeast-1.maas.aliyuncs.com/api/v1/webrtc/realtime?model=qwen3.8-omni-flash-realtime');
});

test('Qwen WebRTC negotiation forwards SDP and bearer key only to the fixed provider endpoint', async () => {
  let requestUrl = '';
  let requestAuthorization = '';
  let requestContentType = '';
  let requestBody = '';
  const fetcher: typeof fetch = async (input, init) => {
    requestUrl = String(input);
    requestAuthorization = new Headers(init?.headers).get('authorization') || '';
    requestContentType = new Headers(init?.headers).get('content-type') || '';
    requestBody = String(init?.body || '');
    return new Response(answer, { status: 200 });
  };
  assert.equal(await negotiateQwenRealtime(offer, env(), fetcher), answer);
  assert.equal(requestUrl, 'https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime?model=qwen3.8-omni-flash-realtime');
  assert.equal(requestAuthorization, 'Bearer server-secret');
  assert.equal(requestContentType, 'application/sdp');
  assert.equal(requestBody, offer);
});

test('provider errors do not reveal upstream response bodies or credentials', async () => {
  const failingFetcher: typeof fetch = async () => new Response('server-secret is invalid', { status: 401 });
  await assert.rejects(negotiateQwenRealtime(offer, env(), failingFetcher), error => {
    assert(error instanceof VoiceProviderError);
    assert.equal(error.status, 502);
    assert.equal(error.message.includes('server-secret'), false);
    return true;
  });
  await assert.rejects(negotiateQwenRealtime('not-sdp', env(), failingFetcher), /offer SDP 无效/);
  await assert.rejects(negotiateQwenRealtime(offer, { ...env(), DOTS_QWEN_REGION: 'mars' }, failingFetcher), /地域无效/);
  await assert.rejects(negotiateQwenRealtime(offer, { ...env(), DOTS_QWEN_WORKSPACE_ID: 'invalid.host' }, failingFetcher), /工作空间 ID/);
});
