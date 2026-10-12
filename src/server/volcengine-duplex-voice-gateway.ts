import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  volcengineDuplexHeaders,
  volcengineDuplexHandshakeErrorMessage,
  volcengineDuplexRealtimeUrl,
  volcengineDuplexSessionPayload,
  volcengineVoiceConfig,
  VolcengineVoiceError,
} from './volcengine-voice.ts';

const MAX_CLIENT_AUDIO_FRAME = 20_000;
const MAX_SPEAK_TEXT = 1200;
const MAX_PROVIDER_AUDIO_FRAME = 512 * 1024;
const VOLCENGINE_FLOAT32_AUDIO_MARKER = 2;

type LocalVoiceMessage = { type?: unknown; text?: unknown };
type ProviderEvent = { type?: unknown; [key: string]: unknown };

export function isVolcengineFloat32Pcm(pcm: Uint8Array): boolean {
  if (!pcm.byteLength || pcm.byteLength % 4 !== 0) return false;
  const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let offset = 0; offset < bytes.byteLength; offset += 4) {
    const sample = bytes.readFloatLE(offset);
    if (!Number.isFinite(sample) || Math.abs(sample) > 1.5) return false;
  }
  return true;
}

export function bridgeVolcengineDuplexVoiceCall(client: WebSocket, dotName: string, env: NodeJS.ProcessEnv = process.env) {
  const config = volcengineVoiceConfig(env);
  if (config.mode !== 'seedduplex') throw new VolcengineVoiceError('火山引擎 SeedDuplex API Key 未配置', 503);
  const requestId = randomUUID();
  const connectId = randomUUID();
  const upstream = new WebSocket(volcengineDuplexRealtimeUrl(env), {
    headers: volcengineDuplexHeaders(config, requestId, connectId),
    handshakeTimeout: 15_000,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
  });

  let sessionReady = false;
  let closing = false;
  let finalized = false;
  let closeSent = false;
  let muted = false;
  let muteBeforeReady: boolean | null = null;
  let transcript = '';
  let turnId: string = randomUUID();
  let startupTimer: NodeJS.Timeout | null = setTimeout(() => fail('火山实时语音初始化超时，请检查服务配置后重试。'), 20_000);
  let finishTimer: NodeJS.Timeout | null = null;
  let muteKeepAliveTimer: NodeJS.Timeout | null = null;

  const sendLocal = (message: unknown) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
  };
  const sendUpstream = (type: string, payload: Record<string, unknown> = {}) => {
    if (upstream.readyState !== WebSocket.OPEN) throw new VolcengineVoiceError('火山实时语音连接尚未就绪', 503);
    upstream.send(JSON.stringify({ type, event_id: randomUUID(), ...payload }));
  };
  const finalize = (code = 1000, reason = 'call ended') => {
    if (finalized) return;
    finalized = true;
    if (startupTimer) clearTimeout(startupTimer);
    if (finishTimer) clearTimeout(finishTimer);
    if (muteKeepAliveTimer) clearInterval(muteKeepAliveTimer);
    startupTimer = null;
    finishTimer = null;
    muteKeepAliveTimer = null;
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close(code, reason.slice(0, 120));
    }
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
      client.close(code, reason.slice(0, 120));
    }
  };
  const closeGracefully = (code = 1000, reason = 'call ended') => {
    if (finalized || closing) return;
    closing = true;
    if (startupTimer) clearTimeout(startupTimer);
    startupTimer = null;
    if (upstream.readyState === WebSocket.OPEN && sessionReady) {
      closeSent = true;
      try { sendUpstream('session.close'); }
      catch { finalize(code, reason); return; }
      finishTimer = setTimeout(() => finalize(code, reason), 5_000);
    } else finalize(code, reason);
  };
  const fail = (message: string) => {
    if (finalized) return;
    sendLocal({ type: 'error', error: message });
    if (sessionReady && upstream.readyState === WebSocket.OPEN) closeGracefully(1011, 'voice provider error');
    else finalize(1011, 'voice provider error');
  };
  const sendMuteState = (nextMuted: boolean) => {
    if (!sessionReady) { muteBeforeReady = nextMuted; return; }
    if (muted === nextMuted) return;
    sendUpstream(nextMuted ? 'input_audio_mute.commit' : 'input_audio_unmute.commit');
    muted = nextMuted;
    if (muteKeepAliveTimer) clearInterval(muteKeepAliveTimer);
    muteKeepAliveTimer = nextMuted ? setInterval(() => {
      if (!closing && !finalized && sessionReady && upstream.readyState === WebSocket.OPEN) {
        try { sendUpstream('input_audio_mute.commit'); } catch { fail('语音连接保活失败，请稍后重试。'); }
      }
    }, 10_000) : null;
  };

  client.on('message', (data, isBinary) => {
    if (closing || finalized) return;
    if (isBinary) {
      const pcm = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (!sessionReady || muted || pcm.byteLength === 0 || pcm.byteLength > MAX_CLIENT_AUDIO_FRAME || pcm.byteLength % 2 !== 0) {
        fail('语音音频帧无效或会话尚未就绪。');
        return;
      }
      try { sendUpstream('input_audio_buffer.append', { audio: pcm.toString('base64') }); }
      catch { fail('语音音频未能发送，请稍后重试。'); }
      return;
    }
    let message: LocalVoiceMessage;
    try { message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) as LocalVoiceMessage; }
    catch { finalize(1008, 'invalid client message'); return; }
    if (message.type === 'mute' || message.type === 'unmute') {
      try { sendMuteState(message.type === 'mute'); }
      catch { fail('语音静音状态未能同步，请稍后重试。'); }
      return;
    }
    if (!sessionReady) { finalize(1008, 'session is not ready'); return; }
    try {
      if (message.type === 'speak' && typeof message.text === 'string' && message.text.trim() && message.text.length <= MAX_SPEAK_TEXT) {
        sendUpstream('speech_text_buffer.replacement.append', { text: message.text.trim() });
        sendUpstream('speech_text_buffer.replacement.commit', { text: '' });
      } else if (message.type === 'interrupt') sendUpstream('response.cancel');
      else finalize(1008, 'unsupported client message');
    } catch { fail('语音消息未能发送，请稍后重试。'); }
  });

  client.on('close', () => closeGracefully());
  client.on('error', () => closeGracefully(1011, 'client socket error'));
  upstream.on('open', () => {
    try { upstream.send(JSON.stringify(volcengineDuplexSessionPayload(dotName, randomUUID()))); }
    catch { fail('无法初始化火山实时语音连接。'); }
  });
  upstream.on('unexpected-response', (_request, response) => {
    const bodyChunks: Buffer[] = [];
    let retainedBytes = 0;
    const maxDiagnosticBytes = 16 * 1024;
    response.on('data', chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maxDiagnosticBytes - retainedBytes;
      if (remaining > 0) {
        const retained = bytes.subarray(0, remaining);
        bodyChunks.push(retained);
        retainedBytes += retained.byteLength;
      }
    });
    response.on('end', () => {
      const message = volcengineDuplexHandshakeErrorMessage(response.statusCode || 502, Buffer.concat(bodyChunks).toString('utf8'));
      fail(message);
    });
    response.on('error', () => fail('无法读取火山实时语音服务响应，请稍后重试。'));
  });
  upstream.on('message', (raw, isBinary) => {
    if (isBinary) { fail('火山 SeedDuplex 返回了不支持的二进制响应。'); return; }
    let event: ProviderEvent;
    try { event = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)) as ProviderEvent; }
    catch { fail('火山实时语音响应格式无效。'); return; }
    if (typeof event.type !== 'string') { fail('火山实时语音响应缺少事件类型。'); return; }

    if (event.type === 'error') {
      // Provider messages may include request details. Keep them server-side and
      // return only a stable Chinese error to the browser.
      fail('火山实时语音服务暂不可用，请检查控制台配置后重试。');
      return;
    }
    if (event.type === 'session.created') {
      if (closing || sessionReady) return;
      sessionReady = true;
      if (startupTimer) clearTimeout(startupTimer);
      startupTimer = null;
      sendLocal({ type: 'ready', provider: 'volcengine' });
      if (muteBeforeReady !== null) {
        try { sendMuteState(muteBeforeReady); } catch { fail('语音静音状态未能同步，请稍后重试。'); }
      }
      return;
    }
    if (event.type === 'session.closed') {
      if (closeSent || closing) finalize();
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.started') {
      transcript = '';
      turnId = typeof event.item_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(event.item_id) ? event.item_id : randomUUID();
      sendLocal({ type: 'speech-started' });
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.delta' || event.type === 'conversation.item.input_audio_transcription.result') {
      const piece = typeof event.delta === 'string' ? event.delta : typeof event.transcript === 'string' ? event.transcript : typeof event.result === 'string' ? event.result : '';
      if (piece) transcript = event.type.endsWith('.delta') ? transcript + piece : piece;
      sendLocal({ type: 'asr', transcript, interim: true });
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const finalTranscript = typeof event.transcript === 'string' ? event.transcript.trim() : transcript.trim();
      if (finalTranscript) sendLocal({ type: 'asr-final', transcript: finalTranscript, turnId });
      transcript = '';
      turnId = randomUUID();
      return;
    }
    if (event.type === 'conversation.item.input_audio_transcription.failed') {
      transcript = '';
      sendLocal({ type: 'error', error: '语音识别暂不可用，请再说一次。' });
      return;
    }
    if (event.type === 'response.output_audio.started') { sendLocal({ type: 'speech-started' }); return; }
    if (event.type === 'response.output_audio.done') { sendLocal({ type: 'speech-ended' }); return; }
    if (event.type === 'response.output_audio.delta') {
      const encoded = typeof event.delta === 'string' ? event.delta : '';
      if (!encoded || encoded.length > Math.ceil(MAX_PROVIDER_AUDIO_FRAME * 4 / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
        fail('火山实时语音返回了无效的音频数据。');
        return;
      }
      const pcm = Buffer.from(encoded, 'base64');
      if (!pcm.length || pcm.byteLength > MAX_PROVIDER_AUDIO_FRAME || pcm.byteLength % 4 !== 0) {
        fail('火山实时语音返回了无效的音频帧。');
        return;
      }
      if (!isVolcengineFloat32Pcm(pcm)) {
        fail('火山实时语音返回了不支持的音频格式。');
        return;
      }
      // SeedDuplex currently emits normalized float32 PCM for the requested
      // `audio.output.format.type: "pcm"` response. Preserve that encoding in
      // the local frame marker so the browser does not interpret each float as
      // two unrelated int16 samples (which sounds like broadband static).
      if (client.readyState === WebSocket.OPEN) client.send(Buffer.concat([Buffer.from([VOLCENGINE_FLOAT32_AUDIO_MARKER]), pcm]));
      return;
    }
  });
  upstream.on('close', () => {
    if (!finalized && !closing) fail('火山实时语音连接已中断。');
    else if (!finalized) finalize();
  });
  upstream.on('error', () => {
    if (!finalized) fail('无法连接火山实时语音服务，请检查网络和凭据。');
  });
  return closeGracefully;
}
