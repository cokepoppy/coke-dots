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
  onTranscript: (text: string, waitingTaskId?: string) => Promise<Task>;
  onClose: () => void;
}) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [muted, setMuted] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(true);
  const [status, setStatus] = useState('正在连接…');
  const [transcript, setTranscript] = useState('');
  const [taskStatus, setTaskStatus] = useState('');
  const [callError, setCallError] = useState('');
  const [expanded, setExpanded] = useState(false);
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
  const waitingTaskIdRef = useRef<string | null>(null);
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
          const waitingTaskId = waitingTaskIdRef.current;
          if (waitingTaskId) waitingTaskIdRef.current = null;
          void (async () => {
            let accepted = false;
            try {
              const task = await onTranscriptRef.current(text, waitingTaskId || undefined);
              accepted = true;
              if (!activeRef.current) return;
              setTaskStatus(waitingTaskId ? '已回复并继续：' + task.title : '已加入工作队列：' + task.title);
              speak(waitingTaskId ? '收到，我会接着处理。' : '收到，已加入工作队列。');
              await followTask(task);
            } catch (error) {
              if (!accepted && waitingTaskId && !waitingTaskIdRef.current) waitingTaskIdRef.current = waitingTaskId;
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
        const response = await appFetch('/api/state');
        if (!activeRef.current) return;
        if (!response.ok) throw new Error('读取任务进度失败：HTTP ' + response.status);
        const snapshot = await response.json() as Snapshot;
        if (!activeRef.current) return;
        const task = snapshot.tasks.find(candidate => candidate.id === submittedTask.id);
        if (!task) throw new Error('找不到刚提交的任务');
        const latestDotMessage = [...snapshot.entries].reverse().find(entry => entry.taskId === task.id && entry.kind === 'dot')?.body || '';
        if (task.status === 'done') {
          if (waitingTaskIdRef.current === task.id) waitingTaskIdRef.current = null;
          setTaskStatus('已完成：' + task.title);
          speak(task.result || latestDotMessage || '任务已完成。');
          return;
        }
        if (task.status === 'waiting') {
          waitingTaskIdRef.current = task.id;
          setTaskStatus('等待你的回复');
          if (latestDotMessage) speak(latestDotMessage);
          return;
        }
        if (task.status === 'failed' || task.status === 'stopped' || task.status === 'paused') {
          if (waitingTaskIdRef.current === task.id) waitingTaskIdRef.current = null;
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

    void appFetch('/api/voice-calls', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(async response => {
        const data = await response.json() as VoiceCallSession & { error?: string };
        if (!response.ok) throw new Error(data.error || 'HTTP ' + response.status);
        sessionRef.current = data;
        if (!activeRef.current) {
          const durationSeconds = Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1000));
          await appFetch('/api/voice-calls/' + data.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'end', durationSeconds }) });
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
        void appFetch('/api/voice-calls/' + sessionRef.current.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'end', durationSeconds }) });
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
        const response = await appFetch('/api/voice-calls/' + session.id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'end', durationSeconds }) });
        if (!response.ok) throw new Error('通话记录未能保存');
      } catch (error) { setCallError(error instanceof Error ? error.message : '通话记录未能保存'); }
    }
    onClose();
  }

  const minutes = Math.floor(elapsedSeconds / 60).toString().padStart(2, '0');
  const seconds = (elapsedSeconds % 60).toString().padStart(2, '0');
  return <section className={`voice-call-dock${expanded ? ' voice-call-expanded' : ''}`} role="dialog" aria-modal="false" aria-label="语音通话" data-testid="voice-call">
    <div className="voice-call-screen">
      <div className="voice-call-statusbar" aria-hidden="true">
        <span>12:55</span><span className="voice-call-notch" />
        <span className="voice-call-status-icons"><i className="voice-call-silent">⌁</i><i className="voice-call-signal">▮▮▮</i><i className="voice-call-wifi">◔</i><i className="voice-call-battery" /></span>
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
  </section>;
}
