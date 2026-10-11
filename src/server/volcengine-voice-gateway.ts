import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import {
  decodeVolcengineFrame,
  encodeVolcengineAudio,
  encodeVolcengineEvent,
  volcengineHeaders,
  volcengineRealtimeUrl,
  volcengineSessionId,
  volcengineStartSessionPayload,
  volcengineVoiceConfig,
  VolcengineVoiceError,
} from './volcengine-voice.ts';

const MAX_CLIENT_AUDIO_FRAME = 20_000;
const MAX_SPEAK_TEXT = 1200;

type LocalVoiceMessage = { type?: unknown; text?: unknown };

export function bridgeVolcengineVoiceCall(client: WebSocket, dotName: string, env: NodeJS.ProcessEnv = process.env) {
  const config = volcengineVoiceConfig(env);
  const connectionId = randomUUID();
  const sessionId = volcengineSessionId();
  const upstream = new WebSocket(volcengineRealtimeUrl(env), {
    headers: volcengineHeaders(config, connectionId),
    handshakeTimeout: 15_000,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
  });
  let sessionStarted = false;
  let startSent = false;
  let transcript = '';
  let turnId: string = randomUUID();
  let closed = false;
  let sessionFinishing = false;
  let finishCode = 1000;
  let finishReason = 'call ended';
  let finishTimer: NodeJS.Timeout | null = null;
  const startupTimer = setTimeout(() => {
    sendLocal({ type: 'error', error: '火山实时语音初始化超时，请检查服务配置后重试。' });
    close(1011, 'voice startup timeout');
  }, 20_000);

  const sendLocal = (message: unknown) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
  };
  const sendUpstream = (frame: Buffer) => {
    if (upstream.readyState !== WebSocket.OPEN) throw new VolcengineVoiceError('火山实时语音连接尚未就绪', 503);
    upstream.send(frame, { binary: true });
  };
  const finishConnection = () => {
    if (finishTimer) clearTimeout(finishTimer);
    finishTimer = null;
    sessionFinishing = false;
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(encodeVolcengineEvent(2, {}, undefined, connectionId), { binary: true });
      upstream.close(finishCode, finishReason.slice(0, 120));
    } else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
  };
  const close = (code = 1000, reason = 'call ended') => {
    if (closed) return;
    closed = true;
    clearTimeout(startupTimer);
    if (upstream.readyState === WebSocket.OPEN) {
      finishCode = code;
      finishReason = reason;
      if (sessionStarted) {
        sessionFinishing = true;
        upstream.send(encodeVolcengineEvent(102, {}, sessionId), { binary: true });
        // The provider requires SessionFinished before FinishConnection. Keep
        // the connection briefly for the acknowledgement, then release it if
        // the upstream has already stopped responding.
        finishTimer = setTimeout(finishConnection, 5_000);
      } else finishConnection();
    } else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(code, reason.slice(0, 120));
  };

  client.on('message', (data, isBinary) => {
    if (isBinary) {
      const pcm = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (!sessionStarted || pcm.byteLength === 0 || pcm.byteLength > MAX_CLIENT_AUDIO_FRAME || pcm.byteLength % 2 !== 0) {
        close(1008, 'invalid or early PCM frame');
        return;
      }
      try { sendUpstream(encodeVolcengineAudio(pcm, sessionId)); }
      catch { sendLocal({ type: 'error', error: '语音音频未能发送，请稍后重试。' }); close(1011, 'audio forwarding failed'); }
      return;
    }
    let message: LocalVoiceMessage;
    try { message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) as LocalVoiceMessage; }
    catch { close(1008, 'invalid client message'); return; }
    if (!sessionStarted) { close(1008, 'session is not ready'); return; }
    try {
      if (message.type === 'speak' && typeof message.text === 'string' && message.text.trim() && message.text.length <= MAX_SPEAK_TEXT) {
        sendUpstream(encodeVolcengineEvent(500, { start: true, content: message.text.trim(), end: true }, sessionId));
      } else if (message.type === 'interrupt') {
        sendUpstream(encodeVolcengineEvent(515, {}, sessionId));
      } else close(1008, 'unsupported client message');
    } catch {
      sendLocal({ type: 'error', error: '语音消息未能发送，请稍后重试。' });
      close(1011, 'voice message forwarding failed');
    }
  });

  client.on('close', () => close());
  client.on('error', () => close(1011, 'client socket error'));
  upstream.on('open', () => {
    try { sendUpstream(encodeVolcengineEvent(1, {}, undefined, connectionId)); }
    catch { sendLocal({ type: 'error', error: '无法初始化火山实时语音连接。' }); close(1011, 'connection start failed'); }
  });
  upstream.on('message', (raw, isBinary) => {
    if (!isBinary) {
      sendLocal({ type: 'error', error: '火山实时语音返回了不支持的响应。' });
      close(1011, 'unexpected text response');
      return;
    }
    let frame;
    try { frame = decodeVolcengineFrame(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer)); }
    catch {
      sendLocal({ type: 'error', error: '火山实时语音响应格式无效。' });
      close(1011, 'invalid provider frame');
      return;
    }
    if (frame.errorCode !== null || frame.messageType === 15 || frame.eventId === 51 || frame.eventId === 153 || frame.eventId === 599) {
      sendLocal({ type: 'error', error: '火山实时语音服务暂不可用，请检查控制台配置后重试。' });
      close(1011, 'provider error');
      return;
    }
    if (frame.eventId === 50 && !startSent) {
      startSent = true;
      try { sendUpstream(encodeVolcengineEvent(100, volcengineStartSessionPayload(dotName), sessionId)); }
      catch { sendLocal({ type: 'error', error: '无法启动火山实时语音会话。' }); close(1011, 'session start failed'); }
      return;
    }
    if (frame.eventId === 150) {
      if (sessionStarted) return;
      sessionStarted = true;
      clearTimeout(startupTimer);
      sendLocal({ type: 'ready', provider: 'volcengine' });
      return;
    }
    if (frame.eventId === 152 && sessionFinishing) {
      finishConnection();
      return;
    }
    if (frame.eventId === 450) {
      try {
        const payload = JSON.parse(frame.payload.toString('utf8')) as { question_id?: string };
        turnId = typeof payload.question_id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(payload.question_id) ? payload.question_id : randomUUID();
      } catch { turnId = randomUUID(); }
      sendLocal({ type: 'speech-started' });
      return;
    }
    if (frame.eventId === 451) {
      try {
        const payload = JSON.parse(frame.payload.toString('utf8')) as { results?: { text?: string; is_interim?: boolean }[] };
        transcript = (payload.results || []).map(result => result.text || '').join('').trim();
        sendLocal({ type: 'asr', transcript, interim: (payload.results || []).some(result => result.is_interim) });
      } catch { sendLocal({ type: 'error', error: '语音识别结果格式无效。' }); }
      return;
    }
    if (frame.eventId === 459) {
      const finalTranscript = transcript;
      transcript = '';
      if (finalTranscript) sendLocal({ type: 'asr-final', transcript: finalTranscript, turnId });
      turnId = randomUUID();
      return;
    }
    if (frame.eventId === 352) {
      // The session explicitly asks for mono pcm_s16le at 24 kHz. Prefix with
      // a local marker so the browser can distinguish audio from JSON controls.
      client.send(Buffer.concat([Buffer.from([1]), frame.payload]), { binary: true });
      return;
    }
    if (frame.eventId === 359) {
      sendLocal({ type: 'speech-ended' });
      return;
    }
    if (frame.payloadIsJson && frame.eventId !== null) {
      try { sendLocal({ type: 'provider-event', eventId: frame.eventId, payload: JSON.parse(frame.payload.toString('utf8')) }); }
      catch { sendLocal({ type: 'provider-event', eventId: frame.eventId }); }
    }
  });
  upstream.on('close', () => {
    if (closed) return;
    sendLocal({ type: 'error', error: '火山实时语音连接已中断。' });
    close(1011, 'provider connection closed');
  });
  upstream.on('error', () => {
    if (closed) return;
    sendLocal({ type: 'error', error: '无法连接火山实时语音服务，请检查网络和凭据。' });
    close(1011, 'provider connection error');
  });
  return close;
}
