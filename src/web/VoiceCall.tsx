import { useEffect, useRef, useState } from 'react';
import type { DotAppearance, Snapshot, Task, VoiceCallSession } from '../shared/types.ts';
import { DotAvatar } from './DotAvatar.tsx';
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
  onTranscript: (text: string) => Promise<Task>;
  onClose: () => void;
}) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [muted, setMuted] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [status, setStatus] = useState('正在连接…');
  const [transcript, setTranscript] = useState('');
  const [taskStatus, setTaskStatus] = useState('');
  const [callError, setCallError] = useState('');
  const sessionRef = useRef<VoiceCallSession | null>(null);
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const recognitionConstructorRef = useRef<RecognitionConstructor | null>(null);
  const startRecognitionRef = useRef<() => void>(() => {});
  const activeRef = useRef(true);
  const mutedRef = useRef(false);
  const speakerRef = useRef(true);
  const endedRef = useRef(false);
  const speakingRef = useRef(false);
  const speechGenerationRef = useRef(0);
  const startedAtRef = useRef(Date.now());
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  mutedRef.current = muted;
  speakerRef.current = speakerOn;

  useEffect(() => {
    activeRef.current = true;
    startedAtRef.current = Date.now();
    const timer = window.setInterval(() => setElapsedSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000)), 1000);
    const speechWindow = window as SpeechWindow;
    recognitionConstructorRef.current = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition || null;

    const startRecognition = () => {
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
          const text = finalParts.join(' ').trim();
          if (!text || !activeRef.current) return;
          setTranscript(text);
          setTaskStatus('正在交给 Dot…');
          void (async () => {
            try {
              const task = await onTranscriptRef.current(text);
              if (!activeRef.current) return;
              setTaskStatus('已加入工作队列：' + task.title);
              speak('收到，已加入工作队列。');
              await followTask(task);
            } catch (error) {
              if (activeRef.current) setTaskStatus(error instanceof Error ? error.message : '任务创建失败');
            }
          })();
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

    const speak = (text: string) => {
      const content = text.trim().slice(0, 1200);
      if (!content || !speakerRef.current || !('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return;
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
    };

    const followTask = async (submittedTask: Task) => {
      for (let attempt = 0; attempt < 1200 && activeRef.current; attempt += 1) {
        const response = await fetch('/api/state');
        if (!activeRef.current) return;
        if (!response.ok) throw new Error('读取任务进度失败：HTTP ' + response.status);
        const snapshot = await response.json() as Snapshot;
        if (!activeRef.current) return;
        const task = snapshot.tasks.find(candidate => candidate.id === submittedTask.id);
        if (!task) throw new Error('找不到刚提交的任务');
        const latestDotMessage = [...snapshot.entries].reverse().find(entry => entry.taskId === task.id && entry.kind === 'dot')?.body || '';
        if (task.status === 'done') {
          setTaskStatus('已完成：' + task.title);
          speak(task.result || latestDotMessage || '任务已完成。');
          return;
        }
        if (task.status === 'waiting') {
          setTaskStatus('等待你的回复');
          if (latestDotMessage) speak(latestDotMessage);
          return;
        }
        if (task.status === 'failed' || task.status === 'stopped' || task.status === 'paused') {
          const message = task.error || (task.status === 'failed' ? '任务执行失败。' : task.status === 'stopped' ? '任务已停止。' : '任务已暂停。');
          setTaskStatus(message);
          speak(message);
          return;
        }
        setTaskStatus(task.status === 'working' || task.status === 'delegating' ? 'Dot 正在处理：' + task.title : '任务排队中：' + task.title);
        await new Promise(resolve => window.setTimeout(resolve, 750));
      }
      if (activeRef.current) setTaskStatus('仍在后台运行；你可以结束通话。');
    };

    void fetch('/api/voice-calls', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(async response => {
        const data = await response.json() as VoiceCallSession & { error?: string };
        if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status);
        sessionRef.current = data;
        if (!activeRef.current) {
          const durationSeconds = Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1000));
          await fetch('/api/voice-calls/' + data.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'end', durationSeconds }) });
          return;
        }
        startRecognitionRef.current();
      })
      .catch(error => { if (activeRef.current) { setCallError(error instanceof Error ? error.message : '无法记录通话'); setStatus('通话无法启动'); } });

    return () => {
      activeRef.current = false;
      window.clearInterval(timer);
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      speakingRef.current = false;
      speechGenerationRef.current += 1;
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
      if (!endedRef.current && sessionRef.current) {
        endedRef.current = true;
        const durationSeconds = Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1000));
        void fetch('/api/voice-calls/' + sessionRef.current.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'end', durationSeconds }) });
      }
    };
  }, []);

  function toggleMute() {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    if (next) {
      recognitionRef.current?.abort();
      setStatus('麦克风已静音');
    } else {
      setStatus('正在聆听');
      window.setTimeout(() => startRecognitionRef.current(), 180);
    }
  }

  function toggleSpeaker() {
    const next = !speakerRef.current;
    speakerRef.current = next;
    setSpeakerOn(next);
    if (!next && 'speechSynthesis' in window) {
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
    speakingRef.current = false;
    speechGenerationRef.current += 1;
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    const session = sessionRef.current;
    if (session) {
      const durationSeconds = Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1000));
      try {
        const response = await fetch('/api/voice-calls/' + session.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'end', durationSeconds }) });
        if (!response.ok) throw new Error('通话记录未能保存');
      } catch (error) { setCallError(error instanceof Error ? error.message : '通话记录未能保存'); }
    }
    onClose();
  }

  const minutes = Math.floor(elapsedSeconds / 60).toString().padStart(2, '0');
  const seconds = (elapsedSeconds % 60).toString().padStart(2, '0');
  return <section className="voice-call-dock" role="dialog" aria-modal="false" aria-label="语音通话" data-testid="voice-call">
    <div className="voice-call-top"><span className="voice-call-live"><i />正在通话</span><span data-testid="voice-call-timer">{minutes}:{seconds}</span><button type="button" className="voice-call-close" aria-label="关闭通话窗口" onClick={() => void endCall()}>×</button></div>
    <div className="voice-call-person"><DotAvatar appearance={appearance} /><strong>{dotName}</strong><small>{status}</small></div>
    {transcript && <div className="voice-call-transcript" aria-live="polite"><span>你说</span><p>{transcript}</p>{taskStatus && <small>{taskStatus}</small>}</div>}
    {callError && <p className="voice-call-error" role="alert">{callError}</p>}
    <div className="voice-call-controls">
      <button type="button" aria-label={speakerOn ? '关闭扬声器' : '打开扬声器'} aria-pressed={speakerOn} onClick={toggleSpeaker}><span aria-hidden="true">{speakerOn ? '◖))' : '◖×'}</span><small>扬声器</small></button>
      <button type="button" className="voice-call-end" aria-label="结束通话" onClick={() => void endCall()}><span aria-hidden="true">☎</span><small>结束</small></button>
      <button type="button" aria-label={muted ? '取消静音' : '静音'} aria-pressed={muted} onClick={toggleMute}><span aria-hidden="true">{muted ? '🎙' : '🎙̸'}</span><small>{muted ? '取消静音' : '静音'}</small></button>
    </div>
  </section>;
}
