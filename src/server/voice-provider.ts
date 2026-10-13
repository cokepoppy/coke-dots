export const QWEN_REALTIME_MODEL = 'qwen3.8-omni-flash-realtime';
const MAX_SDP_BYTES = 80_000;

export type VoiceProviderInfo = { provider: 'browser' | 'qwen' | 'unsupported'; configured: boolean; model?: string };
export type QwenRealtimeConfig = { apiKey: string; workspaceId: string; region: 'beijing' | 'singapore'; model: typeof QWEN_REALTIME_MODEL };

export class VoiceProviderError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function voiceProviderInfo(env: NodeJS.ProcessEnv = process.env): VoiceProviderInfo {
  const selected = env.DOTS_VOICE_PROVIDER || 'browser';
  if (selected === 'browser') return { provider: 'browser', configured: true };
  if (selected !== 'qwen') return { provider: 'unsupported', configured: false };
  try {
    qwenRealtimeConfig(env);
    return { provider: 'qwen', configured: true, model: QWEN_REALTIME_MODEL };
  } catch {
    return { provider: 'qwen', configured: false, model: QWEN_REALTIME_MODEL };
  }
}

export function qwenRealtimeConfig(env: NodeJS.ProcessEnv = process.env): QwenRealtimeConfig {
  const apiKey = (env.DOTS_QWEN_API_KEY || env.DASHSCOPE_API_KEY || '').trim();
  const workspaceId = (env.DOTS_QWEN_WORKSPACE_ID || '').trim();
  const region = env.DOTS_QWEN_REGION === 'singapore' ? 'singapore' : env.DOTS_QWEN_REGION === 'beijing' || !env.DOTS_QWEN_REGION ? 'beijing' : null;
  if (!apiKey || apiKey.length > 4096) throw new VoiceProviderError('Qwen 实时语音尚未配置 API Key', 503);
  if (!workspaceId || !/^[a-zA-Z0-9_-]{3,100}$/.test(workspaceId)) throw new VoiceProviderError('Qwen 实时语音尚未配置有效的工作空间 ID', 503);
  if (!region) throw new VoiceProviderError('Qwen 实时语音地域无效', 503);
  return { apiKey, workspaceId, region, model: QWEN_REALTIME_MODEL };
}

export function qwenRealtimeEndpoint(config: QwenRealtimeConfig): string {
  const host = config.region === 'singapore' ? 'ap-southeast-1' : 'cn-beijing';
  return `https://${config.workspaceId}.${host}.maas.aliyuncs.com/api/v1/webrtc/realtime?model=${config.model}`;
}

export async function negotiateQwenRealtime(sdp: string, env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Promise<string> {
  if (typeof sdp !== 'string' || !sdp.startsWith('v=0\r\n') || Buffer.byteLength(sdp, 'utf8') > MAX_SDP_BYTES) {
    throw new VoiceProviderError('WebRTC offer SDP 无效或超过大小限制', 400);
  }
  const config = qwenRealtimeConfig(env);
  let endpoint = qwenRealtimeEndpoint(config);
  if (env.NODE_ENV === 'test' && env.DOTS_E2E_AUTH === '1' && env.DOTS_E2E_QWEN_SIGNALING_URL) {
    const testEndpoint = new URL(env.DOTS_E2E_QWEN_SIGNALING_URL);
    if (testEndpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(testEndpoint.hostname)) {
      throw new VoiceProviderError('测试语音服务地址无效', 500);
    }
    endpoint = testEndpoint.toString();
  }
  let response: Response;
  try {
    response = await fetcher(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/sdp', Accept: 'application/sdp' },
      body: sdp,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new VoiceProviderError('Qwen 实时语音连接失败，请检查网络和地域配置', 502);
  }
  if (!response.ok) {
    // Do not expose upstream body: it may contain credentials or request details.
    throw new VoiceProviderError(`Qwen 实时语音协商失败（HTTP ${response.status}）`, 502);
  }
  const answer = await response.text();
  if (!answer.startsWith('v=0\r\n') || Buffer.byteLength(answer, 'utf8') > MAX_SDP_BYTES) {
    throw new VoiceProviderError('Qwen 返回了无效的 WebRTC answer', 502);
  }
  return answer;
}
