import { useEffect, useRef, useState } from 'react';
import type { DotAppearance, Snapshot, Task, VoiceCallSession } from '../shared/types.ts';
import { appFetch } from './api.ts';
import './voice-call.css';

interface RecognitionAlternative { transcript: string }
interface RecognitionResult extends ArrayLike<RecognitionAlternative> { isFinal: boolean }
interface RecognitionEvent extends Event { resultIndex: number; results: ArrayLike<RecognitionResult> }
interface RecognitionErrorEvent extends Event { error: string }
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}
type RecognitionConstructor = new () => RecognitionLike;
type SpeechWindow = Window & { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };

export function VoiceCall({ dotName, appearance, onTranscript, onClose }: {
  dotName: string;
  appearance: DotAppearance;
  onTranscript: (text: string, waitingTaskId: string | undefined, callId: string, turnId: string) => Promise<Task>;
  onClose: () => void;
}) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [muted, setMuted] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [status, setStatus] = useState('正在连接…');
  const [transcript, setTranscript] = useState('');
  const [taskStatus, setTaskStatus] = useState('');
  const [callError, setCallError] = useState('');
  const [voiceProvider, setVoiceProvider] = useState<'browser' | 'qwen' | 'volcengine'>('browser');
  const [voiceModel, setVoiceModel] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [desktopLayout, setDesktopLayout] = useState(() => window.innerWidth > 700);
  const sessionRef = useRef<VoiceCallSession | null>(null);
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const providerRef = useRef<'browser' | 'qwen' | 'volcengine'>('browser');
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const realtimeSendChannelRef = useRef<RTCDataChannel | null>(null);
  const realtimeEventChannelRef = useRef<RTCDataChannel | null>(null);
  const volcWebSocketRef = useRef<WebSocket | null>(null);
  const volcDuplexRef = useRef(false);
  const volcAudioContextRef = useRef<AudioContext | null>(null);
  const volcAudioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const volcAudioProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const volcOutputSourcesRef = useRef(new Set<AudioBufferSourceNode>());
  const volcSessionReadyRef = useRef(false);
  const volcPlaybackAtRef = useRef(0);
  const recognitionConstructorRef = useRef<RecognitionConstructor | null>(null);
  const startRecognitionRef = useRef<() => void>(() => {});
  const activeRef = useRef(true);
  const mutedRef = useRef(false);
  const speakerRef = useRef(true);
  const endedRef = useRef(false);
  const speakingRef = useRef(false);
  const speechGenerationRef = useRef(0);
  const startedAtRef = useRef(Date.now());
  const startupFailedRef = useRef(false);
  const onTranscriptRef = useRef(onTranscript);
  const waitingTaskIdRef = useRef<string | null>(null);
  const taskFollowStopsRef = useRef(new Set<() => void>());
  onTranscriptRef.current = onTranscript;
  mutedRef.current = muted;
  speakerRef.current = speakerOn;

  function stopRealtimeTransport() {
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    localStreamRef.current?.getTracks().forEach(track => track.stop());
    localStreamRef.current = null;
    realtimeSendChannelRef.current?.close();
    realtimeSendChannelRef.current = null;
    realtimeEventChannelRef.current?.close();
    realtimeEventChannelRef.current = null;
    const volcSocket = volcWebSocketRef.current;
    volcWebSocketRef.current = null;
    if (volcSocket && (volcSocket.readyState === WebSocket.OPEN || volcSocket.readyState === WebSocket.CONNECTING)) volcSocket.close();
    volcSessionReadyRef.current = false;
    for (const source of volcOutputSourcesRef.current) { try { source.stop(); } catch { /* Already ended. */ } }
    volcOutputSourcesRef.current.clear();
    volcAudioSourceRef.current?.disconnect();
    volcAudioSourceRef.current = null;
    volcAudioProcessorRef.current?.disconnect();
    volcAudioProcessorRef.current = null;
    const volcAudioContext = volcAudioContextRef.current;
    volcAudioContextRef.current = null;
    if (volcAudioContext && volcAudioContext.state !== 'closed') void volcAudioContext.close();
    if (remoteAudioRef.current) { remoteAudioRef.current.pause(); remoteAudioRef.current.srcObject = null; remoteAudioRef.current = null; }
  }

  useEffect(() => {
    const updateLayout = () => setDesktopLayout(window.innerWidth > 700);
    updateLayout();
    window.addEventListener('resize', updateLayout);
    return () => window.removeEventListener('resize', updateLayout);
  }, []);

  useEffect(() => {
    activeRef.current = true;
    startedAtRef.current = Date.now();
    const timer = window.setInterval(() => {
      if (!startupFailedRef.current) setElapsedSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    const speechWindow = window as SpeechWindow;
    recognitionConstructorRef.current = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition || null;
    let qwenResponseActive = false;
    const qwenSpeechQueue: string[] = [];
    const processedVoiceTurns = new Set<string>();
    let qwenSessionCreated = false;
    let qwenSessionUpdateSent = false;
    let qwenModelReady = false;
    let qwenAudioSender: RTCRtpSender | null = null;
    let qwenMicrophoneTrack: MediaStreamTrack | null = null;
    const volcSpeechQueue: string[] = [];

    const flushQwenSpeech = () => {
      if (!qwenModelReady || qwenResponseActive) return;
      const next = qwenSpeechQueue.shift();
      if (next) sendQwenText(next);
    };

    const initializeQwenSession = () => {
      const channel = realtimeSendChannelRef.current;
      if (!qwenSessionCreated || qwenSessionUpdateSent || !channel || channel.readyState !== 'open') return;
      channel.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: `你是 ${dotName}，是 Coke Dots 的语音界面。请始终使用中文。用户说话时，你只做简短确认，并明确真实工作会交给独立的 Dots Agent 处理；不要自行回答任务内容、假称已完成或编造进度。稍后收到以“Dots Agent 状态更新”开头的文字时，只简短朗读其中状态。`,
          audio: { output: { voice: 'Tina' } },
          turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 700 },
          input_audio_transcription: { model: 'qwen3-asr-flash-realtime' },
        },
      }));
      qwenSessionUpdateSent = true;
      setStatus('正在初始化语音模型…');
    };

    const sendQwenText = (text: string) => {
      const channel = realtimeSendChannelRef.current;
      if (!qwenModelReady || !channel || channel.readyState !== 'open') return false;
      channel.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Dots Agent 状态更新：${text}\n请用简短、自然的中文朗读这条状态，不要添加未经证实的信息。` }] },
      }));
      channel.send(JSON.stringify({ type: 'response.create' }));
      qwenResponseActive = true;
      return true;
    };
    const queueQwenSpeech = (text: string) => {
      if (qwenResponseActive || !sendQwenText(text)) qwenSpeechQueue.push(text);
    };

    function speak(text: string) {
      const content = text.trim().slice(0, 1200);
      if (!content || !speakerRef.current) return;
      if (providerRef.current === 'qwen') {
        queueQwenSpeech(content);
        return;
      }
      if (providerRef.current === 'volcengine') {
        const socket = volcWebSocketRef.current;
        if (!volcSessionReadyRef.current || !socket || socket.readyState !== WebSocket.OPEN) { volcSpeechQueue.push(content); return; }
        socket.send(JSON.stringify({ type: 'speak', text: content }));
        return;
      }
      if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return;
      const generation = ++speechGenerationRef.current;
      speakingRef.current = true;
      recognitionRef.current?.abort();
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(content);
      const resumeRecognition = () => {
        if (generation !== speechGenerationRef.current) return;
        speakingRef.current = false;
        if (activeRef.current && !mutedRef.current) window.setTimeout(() => startRecognitionRef.current(), 180);
      };
      utterance.onend = resumeRecognition;
      utterance.onerror = resumeRecognition;
      window.speechSynthesis.speak(utterance);
    }

    const followTask = (submittedTask: Task) => new Promise<void>((resolve, reject) => {
      let stream: EventSource | null = null;
      let fallbackTimer: number | null = null;
      let fallbackBusy = false;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (fallbackTimer !== null) window.clearInterval(fallbackTimer);
        window.clearTimeout(timeout);
        stream?.close();
        taskFollowStopsRef.current.delete(finish);
        if (error) reject(error); else resolve();
      };
      const timeout = window.setTimeout(() => {
        if (activeRef.current) setTaskStatus('仍在后台运行；你可以结束通话。');
        finish();
      }, 15 * 60 * 1000);
      const reconcile = (snapshot: Snapshot) => {
        if (!activeRef.current) { finish(); return; }
        const task = snapshot.tasks.find(candidate => candidate.id === submittedTask.id);
        if (!task) { finish(new Error('找不到刚提交的任务')); return; }
        const latestDotMessage = [...snapshot.entries].reverse().find(entry => entry.taskId === task.id && entry.kind === 'dot')?.body || '';
        if (task.status === 'done') {
          if (waitingTaskIdRef.current === task.id) waitingTaskIdRef.current = null;
          setTaskStatus('已完成：' + task.title);
          speak(task.result || latestDotMessage || '任务已完成。');
          finish();
          return;
        }
        if (task.status === 'waiting') {
          waitingTaskIdRef.current = task.id;
          setTaskStatus('等待你的回复');
          if (latestDotMessage) speak(latestDotMessage);
          finish();
          return;
        }
        if (task.status === 'failed' || task.status === 'stopped' || task.status === 'paused') {
          if (waitingTaskIdRef.current === task.id) waitingTaskIdRef.current = null;
          const message = task.error || (task.status === 'failed' ? '任务执行失败。' : task.status === 'stopped' ? '任务已停止。' : '任务已暂停。');
          setTaskStatus(message);
          speak(message);
          finish();
          return;
        }
        setTaskStatus(task.status === 'working' || task.status === 'delegating' ? 'Dot 正在处理：' + task.title : '任务排队中：' + task.title);
      };
      const refreshSnapshot = async () => {
        if (fallbackBusy || settled || !activeRef.current) return;
        fallbackBusy = true;
        try {
          const response = await appFetch('/api/state');
          if (response.ok) reconcile(await response.json() as Snapshot);
        } catch { /* EventSource reconnects automatically; this is only a recovery probe. */ }
        finally { fallbackBusy = false; }
      };

      taskFollowStopsRef.current.add(finish);
      if (typeof EventSource === 'undefined') {
        void refreshSnapshot();
        fallbackTimer = window.setInterval(() => void refreshSnapshot(), 1000);
        return;
      }
      stream = new EventSource('/api/events');
      stream.onmessage = event => {
        if (fallbackTimer !== null) { window.clearInterval(fallbackTimer); fallbackTimer = null; }
        try { reconcile(JSON.parse(event.data) as Snapshot); }
        catch (error) { finish(error instanceof Error ? error : new Error('任务进度事件无效')); }
      };
      stream.onerror = () => {
        if (fallbackTimer === null) fallbackTimer = window.setInterval(() => void refreshSnapshot(), 5000);
      };
    });

    const stopTaskFollowers = () => {
      for (const stop of [...taskFollowStopsRef.current]) stop();
    };

    const processTranscript = (rawText: string, sourceTurnId?: string) => {
      const text = rawText.trim().slice(0, 5000);
      if (!text || !activeRef.current) return;
      const callId = sessionRef.current?.id;
      if (!callId) return;
      const turnId = sourceTurnId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sourceTurnId) ? sourceTurnId : crypto.randomUUID();
      if (processedVoiceTurns.has(turnId)) return;
      processedVoiceTurns.add(turnId);
      setTranscript(text);
      setTaskStatus('正在交给 Dot…');
      const waitingTaskId = waitingTaskIdRef.current;
      if (waitingTaskId) waitingTaskIdRef.current = null;
      void (async () => {
        let accepted = false;
        try {
          const task = await onTranscriptRef.current(text, waitingTaskId || undefined, callId, turnId);
          accepted = true;
          if (!activeRef.current) return;
          setTaskStatus(waitingTaskId ? '已回复并继续：' + task.title : '已加入工作队列：' + task.title);
          if (providerRef.current === 'browser') speak(waitingTaskId ? '收到，我会接着处理。' : '收到，已加入工作队列。');
          await followTask(task);
        } catch (error) {
          processedVoiceTurns.delete(turnId);
          if (!accepted && waitingTaskId && !waitingTaskIdRef.current) waitingTaskIdRef.current = waitingTaskId;
          if (activeRef.current) setTaskStatus(error instanceof Error ? error.message : '任务创建失败');
        }
      })();
    };

    const handleQwenEvent = (raw: string) => {
      let event: { type?: string; event_id?: string; item_id?: string; text?: string; stash?: string; transcript?: string; error?: { message?: string } };
      try { event = JSON.parse(raw) as typeof event; } catch { return; }
      if (event.type === 'session.created') {
        qwenSessionCreated = true;
        initializeQwenSession();
        return;
      }
      if (event.type === 'session.updated') {
        if (!qwenSessionUpdateSent || qwenModelReady) return;
        if (!qwenAudioSender || !qwenMicrophoneTrack) {
          setCallError('Qwen 语音会话已就绪，但麦克风音轨尚未准备好。');
          return;
        }
        void qwenAudioSender.replaceTrack(qwenMicrophoneTrack).then(() => {
          if (!activeRef.current) {
            void qwenAudioSender?.replaceTrack(null);
            return;
          }
          qwenModelReady = true;
          setStatus(mutedRef.current ? '麦克风已静音' : '正在聆听');
          flushQwenSpeech();
        }).catch(() => setCallError('Qwen 实时语音麦克风音轨启动失败'));
        return;
      }
      if (event.type === 'conversation.item.input_audio_transcription.delta') {
        setTranscript(`${event.text || ''}${event.stash || ''}`.trim());
        return;
      }
      if (event.type === 'conversation.item.input_audio_transcription.completed') {
        if (event.transcript) processTranscript(event.transcript, event.item_id || event.event_id);
        return;
      }
      if (event.type === 'conversation.item.input_audio_transcription.failed' || event.type === 'error') {
        setCallError(event.error?.message || 'Qwen 语音识别失败，请重试。');
        return;
      }
      if (event.type === 'input_audio_buffer.speech_started') {
        setTranscript('');
        return;
      }
      if (event.type === 'response.created') { qwenResponseActive = true; return; }
      if (event.type === 'response.done') {
        qwenResponseActive = false;
        flushQwenSpeech();
      }
    };

    const startQwenRealtime = async (call: VoiceCallSession) => {
      if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined') throw new Error('当前浏览器不支持 WebRTC 实时通话');
      setStatus('正在连接 Qwen 实时语音…');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!activeRef.current) { stream.getTracks().forEach(track => track.stop()); return; }
      localStreamRef.current = stream;
      const peer = new RTCPeerConnection({ iceServers: [] });
      peerConnectionRef.current = peer;
      qwenMicrophoneTrack = stream.getAudioTracks()[0] || null;
      qwenAudioSender = peer.addTransceiver('audio', { direction: 'sendrecv' }).sender;
      const sendChannel = peer.createDataChannel('oai-events');
      realtimeSendChannelRef.current = sendChannel;
      sendChannel.onopen = () => {
        if (providerRef.current === 'qwen' && !qwenModelReady) setStatus('正在初始化语音模型…');
        initializeQwenSession();
        flushQwenSpeech();
      };
      peer.ondatachannel = event => {
        realtimeEventChannelRef.current = event.channel;
        event.channel.onmessage = message => handleQwenEvent(String(message.data));
        event.channel.onerror = () => setCallError('Qwen 实时语音事件通道中断');
      };
      peer.ontrack = event => {
        const audio = new Audio();
        audio.autoplay = true;
        audio.muted = !speakerRef.current;
        audio.srcObject = event.streams[0] || new MediaStream([event.track]);
        remoteAudioRef.current = audio;
        void audio.play().catch(() => setStatus('请点击通话页面以启用扬声器播放'));
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') setCallError('Qwen 实时语音网络连接中断');
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (peer.iceGatheringState !== 'complete') {
        await new Promise<void>((resolve, reject) => {
          const timeout = window.setTimeout(() => reject(new Error('WebRTC 网络协商超时')), 8000);
          peer.onicegatheringstatechange = () => {
            if (peer.iceGatheringState !== 'complete') return;
            window.clearTimeout(timeout);
            resolve();
          };
        });
      }
      const signaling = await appFetch(`/api/voice-calls/${call.id}/realtime-session`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sdp: peer.localDescription?.sdp || '' }),
      });
      const response = await signaling.json() as { answerSdp?: string; error?: string };
      if (!signaling.ok || !response.answerSdp) throw new Error(response.error || 'Qwen WebRTC 信令协商失败');
      await peer.setRemoteDescription({ type: 'answer', sdp: response.answerSdp });
    };

    const flushVolcSpeech = () => {
      const socket = volcWebSocketRef.current;
      if (!volcSessionReadyRef.current || !socket || socket.readyState !== WebSocket.OPEN) return;
      const next = volcSpeechQueue.shift();
      if (!next) return;
      socket.send(JSON.stringify({ type: 'speak', text: next }));
      if (volcSpeechQueue.length) window.setTimeout(flushVolcSpeech, 80);
    };

    const stopVolcPlayback = () => {
      for (const source of volcOutputSourcesRef.current) { try { source.stop(); } catch { /* Already ended. */ } }
      volcOutputSourcesRef.current.clear();
      volcPlaybackAtRef.current = volcAudioContextRef.current?.currentTime || 0;
    };

    const playVolcPcm = (bytes: ArrayBuffer) => {
      const context = volcAudioContextRef.current;
      if (!context || !speakerRef.current || bytes.byteLength < 2 || bytes.byteLength % 2 !== 0) return;
      const samples = new Int16Array(bytes);
      const buffer = context.createBuffer(1, samples.length, 24000);
      const channel = buffer.getChannelData(0);
      for (let index = 0; index < samples.length; index += 1) channel[index] = samples[index] / 32768;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => volcOutputSourcesRef.current.delete(source);
      volcOutputSourcesRef.current.add(source);
      const startAt = Math.max(context.currentTime + 0.025, volcPlaybackAtRef.current);
      volcPlaybackAtRef.current = startAt + buffer.duration;
      source.start(startAt);
      if (context.state === 'suspended') void context.resume().catch(() => setStatus('请点击通话页面以启用扬声器播放'));
    };

    const startVolcRealtime = async (call: VoiceCallSession) => {
      if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined' || typeof WebSocket === 'undefined') throw new Error('当前浏览器不支持火山引擎实时语音');
      setStatus('正在连接火山实时语音…');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!activeRef.current) { stream.getTracks().forEach(track => track.stop()); return; }
      localStreamRef.current = stream;
      const context = new AudioContext({ latencyHint: 'interactive' });
      volcAudioContextRef.current = context;
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(1024, 1, 1);
      const silentOutput = context.createGain();
      silentOutput.gain.value = 0;
      source.connect(processor);
      processor.connect(silentOutput);
      silentOutput.connect(context.destination);
      volcAudioSourceRef.current = source;
      volcAudioProcessorRef.current = processor;
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${location.host}/api/voice-calls/${call.id}/volcengine-stream`);
      socket.binaryType = 'arraybuffer';
      volcWebSocketRef.current = socket;
      let carry = new Float32Array(0);
      let sourcePhase = 0;
      const pcmPending: number[] = [];
      const sampleStep = context.sampleRate / 16000;
      processor.onaudioprocess = event => {
        if (!volcSessionReadyRef.current || mutedRef.current || socket.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        const combined = new Float32Array(carry.length + input.length);
        combined.set(carry);
        combined.set(input, carry.length);
        let position = sourcePhase;
        while (position + 1 < combined.length) {
          const left = Math.floor(position);
          const fraction = position - left;
          const value = combined[left] * (1 - fraction) + combined[left + 1] * fraction;
          pcmPending.push(Math.max(-32768, Math.min(32767, Math.round(value * (value < 0 ? 32768 : 32767)))));
          position += sampleStep;
        }
        const consumed = Math.min(combined.length, Math.floor(position));
        carry = combined.slice(consumed);
        sourcePhase = position - consumed;
        while (pcmPending.length >= 320) {
          const frame = new ArrayBuffer(640);
          const view = new DataView(frame);
          for (let index = 0; index < 320; index += 1) view.setInt16(index * 2, pcmPending[index], true);
          pcmPending.splice(0, 320);
          socket.send(frame);
        }
      };
      void context.resume().catch(() => setCallError('无法启用麦克风音频处理，请检查浏览器权限。'));
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timeout = window.setTimeout(() => finish(new Error('火山实时语音连接超时')), 20_000);
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          if (error) reject(error); else resolve();
        };
        socket.onopen = () => setStatus('正在初始化火山实时语音…');
        socket.onmessage = event => {
          if (typeof event.data !== 'string') {
            const frame = event.data instanceof ArrayBuffer ? event.data : new ArrayBuffer(0);
            if (new Uint8Array(frame)[0] === 1) playVolcPcm(frame.slice(1));
            return;
          }
          let message: { type?: string; error?: string; transcript?: string; turnId?: string };
          try { message = JSON.parse(event.data) as typeof message; } catch { return; }
          if (message.type === 'ready') {
            volcSessionReadyRef.current = true;
            setStatus(mutedRef.current ? '麦克风已静音' : '正在聆听');
            flushVolcSpeech();
            finish();
          } else if (message.type === 'asr') {
            setTranscript(message.transcript || '');
          } else if (message.type === 'asr-final' && message.transcript) {
            processTranscript(message.transcript, message.turnId);
          } else if (message.type === 'speech-started') {
            stopVolcPlayback();
          } else if (message.type === 'error') {
            const error = message.error || '火山实时语音连接失败';
            setCallError(error);
            finish(new Error(error));
          }
        };
        socket.onerror = () => finish(new Error('无法连接火山实时语音，请检查服务配置和网络。'));
        socket.onclose = () => finish(new Error('火山实时语音连接已关闭。'));
      });
    };

    const startRecognition = () => {
      if (providerRef.current !== 'browser') return;
      if (!activeRef.current || mutedRef.current) return;
      if (speakingRef.current) return;
      const Recognition = recognitionConstructorRef.current;
      if (!Recognition) {
        setStatus('当前浏览器不支持语音识别，可继续在下方输入文字。');
        return;
      }
      let recognition = recognitionRef.current;
      if (!recognition) {
        recognition = new Recognition();
        recognition.lang = navigator.language || 'zh-CN';
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.onresult = event => {
          const finalParts: string[] = [];
          for (let index = event.resultIndex; index < event.results.length; index += 1) {
            const result = event.results[index];
            if (result?.isFinal) {
              const text = result[0]?.transcript?.trim();
              if (text) finalParts.push(text);
            }
          }
          processTranscript(finalParts.join(' '));
        };
        recognition.onerror = event => {
          if (!activeRef.current) return;
          if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
            setStatus('麦克风权限未开启，可继续在下方输入文字。');
            return;
          }
          if (event.error !== 'no-speech' && event.error !== 'aborted') setStatus('语音输入暂不可用：' + event.error);
        };
        recognition.onend = () => {
          if (!activeRef.current || mutedRef.current || speakingRef.current) return;
          window.setTimeout(() => startRecognitionRef.current(), 180);
        };
        recognitionRef.current = recognition;
      }
      try {
        recognition.start();
        setStatus('正在聆听');
      } catch (error) {
        if (error instanceof DOMException && error.name === 'InvalidStateError') return;
        setStatus('无法开启麦克风，可继续在下方输入文字。');
      }
    };
    startRecognitionRef.current = startRecognition;

    void (async () => {
      try {
        const providerResponse = await appFetch('/api/voice/provider');
        if (!providerResponse.ok) throw new Error('无法读取语音服务配置');
        const provider = await providerResponse.json() as { provider?: string; configured?: boolean; model?: string };
        if (provider.provider !== 'browser' && provider.provider !== 'qwen' && provider.provider !== 'volcengine') throw new Error('服务端配置了不支持的语音供应商');
        const selectedProvider = provider.provider === 'qwen' || provider.provider === 'volcengine' ? provider.provider : 'browser';
        providerRef.current = selectedProvider;
        setVoiceProvider(selectedProvider);
        setVoiceModel(provider.model || '');
        volcDuplexRef.current = selectedProvider === 'volcengine' && provider.model === 'doubao-seedduplex-3.0';
        if (selectedProvider === 'qwen' && !provider.configured) throw new Error('服务端尚未配置 Qwen 实时语音所需的百炼 API Key 和工作空间 ID；地域默认使用北京。');
        if (selectedProvider === 'volcengine' && !provider.configured) throw new Error(provider.model === 'doubao-realtime-dialogue-2.0'
          ? '服务端尚未配置火山引擎 O2.0 实时语音所需的 App ID 和 Access Token。'
          : '服务端尚未配置火山引擎 SeedDuplex 实时语音 API Key。');
        const response = await appFetch('/api/voice-calls', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        const call = await response.json() as VoiceCallSession & { error?: string };
        if (!response.ok) throw new Error(call.error || 'HTTP ' + response.status);
        sessionRef.current = call;
        if (!activeRef.current) {
          const durationSeconds = Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1000));
          await appFetch('/api/voice-calls/' + call.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'end', durationSeconds }) });
          return;
        }
        if (selectedProvider === 'qwen') await startQwenRealtime(call);
        else if (selectedProvider === 'volcengine') await startVolcRealtime(call);
        else startRecognitionRef.current();
      } catch (error) {
        if (activeRef.current) {
          const message = error instanceof Error ? error.message : '无法启动语音通话';
          setCallError(message);
          setStatus('通话无法启动');
          if (providerRef.current === 'qwen' || providerRef.current === 'volcengine') {
            startupFailedRef.current = true;
            stopRealtimeTransport();
            const call = sessionRef.current;
            if (call) {
              const durationSeconds = Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1000));
              void appFetch('/api/voice-calls/' + call.id, {
                method: 'PATCH', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'end', durationSeconds }),
              }).then(response => {
                if (!response.ok) throw new Error('通话记录未能保存');
                if (sessionRef.current?.id === call.id) sessionRef.current = null;
              }).catch(() => {
                if (activeRef.current) setCallError(message + '；结束通话记录失败，请关闭通话后重试。');
              });
            }
          }
        }
      }
    })();

    return () => {
      activeRef.current = false;
      window.clearInterval(timer);
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      stopTaskFollowers();
      stopRealtimeTransport();
      speakingRef.current = false;
      speechGenerationRef.current += 1;
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      if (!endedRef.current && sessionRef.current) {
        endedRef.current = true;
        const durationSeconds = Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1000));
        void appFetch('/api/voice-calls/' + sessionRef.current.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'end', durationSeconds }) });
      }
    };
  }, []);

  function toggleMute() {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    for (const track of localStreamRef.current?.getAudioTracks() || []) track.enabled = !next;
    if (providerRef.current === 'volcengine' && volcDuplexRef.current) {
      const socket = volcWebSocketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: next ? 'mute' : 'unmute' }));
    }
    if (next) {
      if (providerRef.current === 'browser') recognitionRef.current?.abort();
      setStatus('麦克风已静音');
    } else {
      setStatus('正在聆听');
      if (providerRef.current === 'browser') window.setTimeout(() => startRecognitionRef.current(), 180);
    }
  }

  function toggleSpeaker() {
    const next = !speakerRef.current;
    speakerRef.current = next;
    setSpeakerOn(next);
    if (remoteAudioRef.current) remoteAudioRef.current.muted = !next;
    if (providerRef.current === 'volcengine' && !next) {
      for (const source of volcOutputSourcesRef.current) { try { source.stop(); } catch { /* Already ended. */ } }
      volcOutputSourcesRef.current.clear();
      volcPlaybackAtRef.current = volcAudioContextRef.current?.currentTime || 0;
    }
    if (providerRef.current === 'volcengine' && next && volcAudioContextRef.current?.state === 'suspended') void volcAudioContextRef.current.resume();
    if (providerRef.current === 'browser' && !next && 'speechSynthesis' in window) {
      speechGenerationRef.current += 1;
      speakingRef.current = false;
      window.speechSynthesis.cancel();
      if (activeRef.current && !mutedRef.current) window.setTimeout(() => startRecognitionRef.current(), 180);
    }
  }

  async function endCall() {
    if (endedRef.current) return;
    endedRef.current = true;
    activeRef.current = false;
    recognitionRef.current?.abort();
    for (const stop of [...taskFollowStopsRef.current]) stop();
    stopRealtimeTransport();
    speakingRef.current = false;
    speechGenerationRef.current += 1;
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    const session = sessionRef.current;
    if (session) {
      const durationSeconds = Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1000));
      try {
        const response = await appFetch('/api/voice-calls/' + session.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'end', durationSeconds }) });
        if (!response.ok) throw new Error('通话记录未能保存');
      } catch (error) { setCallError(error instanceof Error ? error.message : '通话记录未能保存'); }
    }
    onClose();
  }

  const minutes = Math.floor(elapsedSeconds / 60).toString().padStart(2, '0');
  const seconds = (elapsedSeconds % 60).toString().padStart(2, '0');
  if (desktopLayout) return <section className="voice-call-inline" role="dialog" aria-modal="false" aria-label="语音通话" data-testid="voice-call" data-variant="desktop" data-voice-provider={voiceProvider} data-voice-model={voiceModel}>
    <button type="button" className={`voice-call-inline-mic${muted ? ' is-muted' : ''}`} aria-label={muted ? '取消静音' : '静音'} aria-pressed={muted} title={muted ? '取消静音' : '静音'} onClick={toggleMute}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3" fill="currentColor"/><path d="M5 11a7 7 0 0 0 14 0m-7 7v3m-4 0h8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>{muted && <path d="m4 4 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>}</svg>
    </button>
    <button type="button" className="voice-call-inline-end" aria-label="结束通话" title="结束通话" onClick={() => void endCall()}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 13.8c4.6-4.1 10.4-4.1 15 0 .5.4.7 1.1.4 1.6l-1.3 3.2a1.4 1.4 0 0 1-1.6.8l-3.6-.9a1.4 1.4 0 0 1-1-1.4v-.9a12 12 0 0 0-4.2 0v.9a1.4 1.4 0 0 1-1 1.4l-3.6.9a1.4 1.4 0 0 1-1.6-.8l-1.3-3.2c-.3-.5-.1-1.2.4-1.6z" fill="currentColor"/></svg>
    </button>
    <p className="voice-call-inline-error" role="alert" hidden={!callError}>{callError}</p>
    <div className="voice-call-a11y" aria-live="polite" aria-atomic="true" data-testid="voice-call-transcript" data-task-status={taskStatus}>
      <span>{status}</span>{transcript && <span>你说：{transcript}</span>}{taskStatus && <span>{taskStatus}</span>}
    </div>
  </section>;
  return <section className={`voice-call-dock${expanded ? ' voice-call-expanded' : ''}`} role="dialog" aria-modal="false" aria-label="语音通话" data-testid="voice-call" data-variant="handset" data-voice-provider={voiceProvider} data-voice-model={voiceModel}>
    <div className="voice-call-screen">
      <div className="voice-call-screen-content">
      <div className="voice-call-statusbar" aria-hidden="true">
        <span className="voice-call-status-leading"><span className="voice-call-status-time">12:55</span><svg className="voice-call-silent" viewBox="0 0 16 16"><path d="M3.5 11.5h9c-.9-1.2-1.2-2.1-1.2-4.3a3.3 3.3 0 0 0-6.6 0c0 2.2-.3 3.1-1.2 4.3ZM6.6 13.2h2.8M2.5 2.5l11 11" /></svg></span><span className="voice-call-notch" />
        <span className="voice-call-status-icons"><svg className="voice-call-signal" viewBox="0 0 14 12"><path d="M1 11V8.5h2V11zM4.5 11V6h2v5zM8 11V3.5h2V11zM11.5 11V1h2v10z" /></svg><svg className="voice-call-wifi" viewBox="0 0 16 14"><path d="M1.5 4.5c4-3.5 9-3.5 13 0M4 7c2.4-2.1 5.6-2.1 8 0M6.5 9.5c.9-.8 2.1-.8 3 0" /><circle cx="8" cy="12" r=".7" fill="currentColor" /></svg><i className="voice-call-battery" /></span>
      </div>
      <button type="button" className="voice-call-expand" aria-label={expanded ? '收起通话界面' : '展开通话界面'} aria-pressed={expanded} onClick={() => setExpanded(value => !value)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4H4v4m0-4 6 6m6-6h4v4m0-4-6 6M4 16v4h4m-4 0 6-6m10 2v4h-4m4 0-6-6" /></svg>
      </button>
      <div className="voice-call-person">
        <div className="voice-call-avatar" aria-hidden="true"><span /></div>
        <strong>{dotName}</strong>
        <span className="voice-call-screen-timer" data-testid="voice-call-timer">{Number(minutes)}:{seconds}</span>
      </div>
      <p className="voice-call-error" role="alert" hidden={!callError}>{callError}</p>
      <div className="voice-call-controls">
        <button type="button" className="voice-call-control voice-call-speaker" aria-label={speakerOn ? '关闭扬声器' : '打开扬声器'} aria-pressed={speakerOn} onClick={toggleSpeaker}>
          <span className="voice-call-control-icon" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M4 12h6l8-6v20l-8-6H4z" fill="currentColor"/><path d="M22 11a7 7 0 0 1 0 10m3-14a12 12 0 0 1 0 18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/></svg></span>
          <small>Speaker</small>
        </button>
        <button type="button" className="voice-call-control voice-call-end" aria-label="结束通话" onClick={() => void endCall()}>
          <span className="voice-call-control-icon" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M6.7 18.6c5.7-5.1 13-5.1 18.6 0 .6.5.8 1.3.5 2l-1.6 4a1.7 1.7 0 0 1-2 .9l-4.4-1.1a1.7 1.7 0 0 1-1.3-1.7v-1.1a15 15 0 0 0-5.1 0v1.1a1.7 1.7 0 0 1-1.3 1.7l-4.4 1.1a1.7 1.7 0 0 1-2-.9l-1.6-4c-.3-.7-.1-1.5.5-2z" fill="currentColor"/></svg></span>
          <small>End</small>
        </button>
        <button type="button" className="voice-call-control voice-call-mute" aria-label={muted ? '取消静音' : '静音'} aria-pressed={muted} onClick={toggleMute}>
          <span className="voice-call-control-icon" aria-hidden="true"><svg viewBox="0 0 32 32"><rect x="12" y="4" width="8" height="15" rx="4" fill="currentColor"/><path d="M8 15a8 8 0 0 0 16 0m-8 8v5m-5 0h10M7 6l18 20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/></svg></span>
          <small>{muted ? 'Unmute' : 'Mute'}</small>
        </button>
      </div>
      <div className="voice-call-a11y" aria-live="polite" aria-atomic="true" data-testid="voice-call-transcript" data-task-status={taskStatus}>
        <span>{status}</span>{transcript && <span>你说：{transcript}</span>}{taskStatus && <span>{taskStatus}</span>}
      </div>
      </div>
    </div>
  </section>;
}
