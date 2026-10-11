import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';

export const VOLCENGINE_REALTIME_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue';
export const VOLCENGINE_REALTIME_RESOURCE_ID = 'volc.speech.dialog';
export const VOLCENGINE_REALTIME_APP_KEY = 'PlgvMymc7f3tQnJ6';
export const VOLCENGINE_REALTIME_MODEL = 'doubao-realtime-dialogue-2.0';
const MAX_FRAME_BYTES = 1024 * 1024;

export type VolcengineVoiceConfig = { appId: string; accessToken: string; resourceId: string };
export type VolcengineFrame = {
  messageType: number;
  eventId: number | null;
  sessionId: string | null;
  payload: Buffer;
  payloadIsJson: boolean;
  errorCode: number | null;
};

export class VolcengineVoiceError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function volcengineVoiceConfig(env: NodeJS.ProcessEnv = process.env): VolcengineVoiceConfig {
  const appId = (env.DOTS_VOLCENGINE_APP_ID || '').trim();
  const accessToken = (env.DOTS_VOLCENGINE_ACCESS_TOKEN || '').trim();
  const resourceId = (env.DOTS_VOLCENGINE_RESOURCE_ID || VOLCENGINE_REALTIME_RESOURCE_ID).trim();
  if (!appId || appId.length > 256) throw new VolcengineVoiceError('火山引擎实时语音未配置有效的 App ID', 503);
  if (!accessToken || accessToken.length > 4096) throw new VolcengineVoiceError('火山引擎实时语音未配置有效的 Access Token', 503);
  if (resourceId !== VOLCENGINE_REALTIME_RESOURCE_ID) throw new VolcengineVoiceError('火山引擎实时语音 Resource ID 必须为 volc.speech.dialog', 503);
  return { appId, accessToken, resourceId };
}

export function volcengineVoiceInfo(env: NodeJS.ProcessEnv = process.env) {
  try {
    volcengineVoiceConfig(env);
    return { provider: 'volcengine', configured: true, model: VOLCENGINE_REALTIME_MODEL } as const;
  } catch {
    return { provider: 'volcengine', configured: false, model: VOLCENGINE_REALTIME_MODEL } as const;
  }
}

export function volcengineRealtimeUrl(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV === 'test' && env.DOTS_E2E_AUTH === '1' && env.DOTS_E2E_VOLCENGINE_WS_URL) {
    const url = new URL(env.DOTS_E2E_VOLCENGINE_WS_URL);
    if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
      throw new VolcengineVoiceError('测试语音服务地址无效', 500);
    }
    return url.toString();
  }
  return VOLCENGINE_REALTIME_ENDPOINT;
}

export function volcengineHeaders(config: VolcengineVoiceConfig, connectId: string) {
  return {
    'X-Api-App-ID': config.appId,
    'X-Api-Access-Key': config.accessToken,
    'X-Api-Resource-Id': config.resourceId,
    'X-Api-App-Key': VOLCENGINE_REALTIME_APP_KEY,
    'X-Api-Connect-Id': connectId,
  };
}

function identifierBytes(identifier: string | undefined) {
  if (identifier === undefined) return Buffer.alloc(0);
  const bytes = Buffer.from(identifier, 'utf8');
  if (bytes.length > 512) throw new VolcengineVoiceError('火山语音会话标识无效', 400);
  const size = Buffer.alloc(2);
  size.writeUInt16BE(bytes.length);
  return Buffer.concat([size, bytes]);
}

export function encodeVolcengineEvent(eventId: number, payload: unknown, sessionId?: string, connectId?: string) {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const id = sessionId === undefined ? identifierBytes(connectId) : identifierBytes(sessionId);
  return encodeVolcengineFrame(1, 4, 1, eventId, id, json);
}

export function encodeVolcengineAudio(pcm: Uint8Array, sessionId: string) {
  if (!pcm.byteLength || pcm.byteLength > 20_000 || pcm.byteLength % 2 !== 0) {
    throw new VolcengineVoiceError('火山实时语音 PCM 音频帧无效', 400);
  }
  return encodeVolcengineFrame(2, 4, 0, 200, identifierBytes(sessionId), Buffer.from(pcm));
}

function encodeVolcengineFrame(messageType: number, flags: number, serialization: number, eventId: number, identifier: Buffer, payload: Buffer) {
  if (!Number.isInteger(eventId) || eventId < 0 || eventId > 0xffffffff) throw new VolcengineVoiceError('火山语音事件编号无效', 400);
  if (payload.byteLength > MAX_FRAME_BYTES) throw new VolcengineVoiceError('火山语音数据帧过大', 413);
  const header = Buffer.from([0x11, (messageType << 4) | flags, (serialization << 4), 0]);
  const event = Buffer.alloc(4);
  event.writeUInt32BE(eventId);
  const payloadSize = Buffer.alloc(4);
  payloadSize.writeUInt32BE(payload.byteLength);
  return Buffer.concat([header, event, identifier, payloadSize, payload]);
}

export function decodeVolcengineFrame(data: Uint8Array): VolcengineFrame {
  const frame = Buffer.from(data);
  if (frame.byteLength < 4 || frame.byteLength > MAX_FRAME_BYTES) throw new VolcengineVoiceError('火山语音返回了无效的数据帧', 502);
  const headerSize = (frame[0] & 0x0f) * 4;
  if ((frame[0] >> 4) !== 1 || headerSize < 4 || headerSize > frame.byteLength) throw new VolcengineVoiceError('火山语音数据帧头无效', 502);
  const messageType = frame[1] >> 4;
  const flags = frame[1] & 0x0f;
  const serialization = frame[2] >> 4;
  const compression = frame[2] & 0x0f;
  let offset = headerSize;
  let eventId: number | null = null;
  let errorCode: number | null = null;
  if (messageType === 15) {
    if (offset + 4 > frame.byteLength) throw new VolcengineVoiceError('火山语音错误帧不完整', 502);
    errorCode = frame.readUInt32BE(offset);
    offset += 4;
  } else if ((flags & 0x04) !== 0) {
    if (offset + 4 > frame.byteLength) throw new VolcengineVoiceError('火山语音事件帧不完整', 502);
    eventId = frame.readUInt32BE(offset);
    offset += 4;
  }
  let sessionId: string | null = null;
  if (eventId !== null && eventId >= 100) {
    if (offset + 2 > frame.byteLength) throw new VolcengineVoiceError('火山语音会话标识不完整', 502);
    const idLength = frame.readUInt16BE(offset);
    offset += 2;
    if (idLength > 512 || offset + idLength + 4 > frame.byteLength) throw new VolcengineVoiceError('火山语音会话标识无效', 502);
    sessionId = frame.toString('utf8', offset, offset + idLength);
    offset += idLength;
  } else if (eventId !== null && eventId < 100) {
    // Connection events may include a connection identifier. Accept it only when
    // its length prefix and the following payload length describe the full frame.
    if (offset + 6 <= frame.byteLength) {
      const candidateLength = frame.readUInt16BE(offset);
      const candidatePayloadOffset = offset + 2 + candidateLength;
      if (candidateLength <= 512 && candidatePayloadOffset + 4 <= frame.byteLength && candidatePayloadOffset + 4 + frame.readUInt32BE(candidatePayloadOffset) === frame.byteLength) {
        sessionId = frame.toString('utf8', offset + 2, candidatePayloadOffset);
        offset = candidatePayloadOffset;
      }
    }
  }
  if (offset + 4 > frame.byteLength) throw new VolcengineVoiceError('火山语音 Payload 长度缺失', 502);
  const payloadLength = frame.readUInt32BE(offset);
  offset += 4;
  if (payloadLength > MAX_FRAME_BYTES || offset + payloadLength !== frame.byteLength) throw new VolcengineVoiceError('火山语音 Payload 长度无效', 502);
  let payload = frame.subarray(offset);
  if (compression === 1) {
    try { payload = gunzipSync(payload); }
    catch { throw new VolcengineVoiceError('火山语音压缩数据无效', 502); }
  } else if (compression !== 0) {
    throw new VolcengineVoiceError('火山语音使用了不支持的压缩方式', 502);
  }
  return { messageType, eventId, sessionId, payload, payloadIsJson: serialization === 1, errorCode };
}

export function volcengineSessionId() { return randomUUID(); }

export function volcengineStartSessionPayload(dotName: string) {
  const safeName = dotName.replace(/[\r\n]/g, ' ').slice(0, 20) || 'Dot';
  return {
    asr: { extra: { end_smooth_window_ms: 700 } },
    dialog: {
      bot_name: safeName,
      system_role: `你是 ${safeName}，是 Coke Dots 的语音界面。始终使用简体中文。用户在布置工作时，只用一句简短的话确认收到，不要自行回答任务或假称完成。Dots Agent 会在用户所属的独立云电脑中执行工作。收到客户端通过 ChatTTSText 事件提供的“Dots Agent 状态更新”后，只按原文简洁播报。`,
      speaking_style: '自然、简洁、清楚',
      extra: { model: '1.2.1.1', enable_loudness_norm: true },
    },
    tts: { speaker: 'zh_female_vv_jupiter_bigtts', audio_config: { channel: 1, format: 'pcm_s16le', sample_rate: 24000 } },
  };
}
