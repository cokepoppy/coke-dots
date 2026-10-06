import { useCallback, useEffect, useRef, useState } from 'react';

type CallStatus = 'connecting' | 'listening' | 'muted' | 'speaking';

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
  length: number;
}

interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}

interface RecognitionErrorEvent { error: string }

interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface SpeechWindow extends Window {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
}

export interface DotVoiceCall {
  active: boolean;
  muted: boolean;
  status: CallStatus | null;
  error: string;
  durationSeconds: number;
  start(): void;
  toggleMute(): void;
  end(): void;
  speak(text: string): void;
}

export function useDotVoiceCall(onTranscript: (text: string) => void, onEnd: (durationSeconds: number) => void): DotVoiceCall {
  const [active, setActive] = useState(false);
  const [muted, setMuted] = useState(false);
  const [status, setStatus] = useState<CallStatus | null>(null);
  const [error, setError] = useState('');
  const [durationSeconds, setDurationSeconds] = useState(0);
  const activeRef = useRef(false);
  const mutedRef = useRef(false);
  const speakingRef = useRef(false);
  const startedAtRef = useRef<number | null>(null);
  const recognitionRef = useRef<Recognition | null>(null);
  const recognitionGeneration = useRef(0);
  const restartTimer = useRef<number | null>(null);
  const transcriptRef = useRef(onTranscript);
  const endRef = useRef(onEnd);

  useEffect(() => { transcriptRef.current = onTranscript; }, [onTranscript]);
  useEffect(() => { endRef.current = onEnd; }, [onEnd]);

  const stopRecognition = useCallback(() => {
    recognitionGeneration.current += 1;
    if (restartTimer.current !== null) window.clearTimeout(restartTimer.current);
    restartTimer.current = null;
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    try { recognition?.stop(); } catch { /* A recognition session may already have ended. */ }
  }, []);

  const startRecognition = useCallback(() => {
    if (!activeRef.current || mutedRef.current || speakingRef.current) return;
    const speechWindow = window as SpeechWindow;
    const Constructor = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!Constructor) return;
    const generation = ++recognitionGeneration.current;
    const recognition = new Constructor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = navigator.language || 'zh-CN';
    recognition.onstart = () => {
      if (activeRef.current && !mutedRef.current) setStatus('listening');
    };
    recognition.onresult = event => {
      if (!activeRef.current || mutedRef.current) return;
      const transcript: string[] = [];
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result?.isFinal) transcript.push(result[0]?.transcript || '');
      }
      const text = transcript.join(' ').trim();
      if (text) transcriptRef.current(text);
    };
    recognition.onerror = event => {
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      setError(event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? '麦克风权限未开启。请在浏览器地址栏允许麦克风后重试。'
        : `语音输入失败：${event.error}`);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        activeRef.current = false;
        setActive(false);
        setStatus(null);
        stopRecognition();
      }
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      if (activeRef.current && !mutedRef.current && !speakingRef.current && generation === recognitionGeneration.current) {
        restartTimer.current = window.setTimeout(() => {
          restartTimer.current = null;
          if (activeRef.current && !mutedRef.current && !speakingRef.current) startRecognition();
        }, 120);
      }
    };
    recognitionRef.current = recognition;
    try { recognition.start(); }
    catch (reason) {
      recognitionRef.current = null;
      const name = reason instanceof DOMException ? reason.name : '';
      if (name !== 'InvalidStateError') {
        setError('无法启动语音输入。请检查麦克风权限后重试。');
        activeRef.current = false;
        setActive(false);
        setStatus(null);
      }
    }
  }, [stopRecognition]);

  const start = useCallback(() => {
    if (activeRef.current) return;
    const speechWindow = window as SpeechWindow;
    if (!(speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition)) {
      setError('当前浏览器不支持语音识别，请使用 Chrome 桌面版。');
      return;
    }
    setError('');
    activeRef.current = true;
    mutedRef.current = false;
    speakingRef.current = false;
    startedAtRef.current = Date.now();
    setDurationSeconds(0);
    setMuted(false);
    setActive(true);
    setStatus('connecting');
    startRecognition();
  }, [startRecognition]);

  const toggleMute = useCallback(() => {
    if (!activeRef.current) return;
    const nextMuted = !mutedRef.current;
    mutedRef.current = nextMuted;
    setMuted(nextMuted);
    if (nextMuted) {
      setStatus('muted');
      stopRecognition();
    } else {
      setStatus('connecting');
      startRecognition();
    }
  }, [startRecognition, stopRecognition]);

  const end = useCallback(() => {
    if (!activeRef.current) return;
    const elapsed = startedAtRef.current === null ? 0 : Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1000));
    activeRef.current = false;
    mutedRef.current = false;
    speakingRef.current = false;
    startedAtRef.current = null;
    setActive(false);
    setMuted(false);
    setStatus(null);
    setDurationSeconds(elapsed);
    stopRecognition();
    window.speechSynthesis?.cancel();
    endRef.current(elapsed);
  }, [stopRecognition]);

  const speak = useCallback((text: string) => {
    if (!activeRef.current || !text.trim() || !window.speechSynthesis || typeof window.SpeechSynthesisUtterance !== 'function') return;
    stopRecognition();
    window.speechSynthesis.cancel();
    speakingRef.current = true;
    setStatus('speaking');
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = navigator.language || 'zh-CN';
    const resume = () => {
      if (!speakingRef.current) return;
      speakingRef.current = false;
      if (activeRef.current && !mutedRef.current) {
        setStatus('connecting');
        startRecognition();
      } else if (activeRef.current) setStatus('muted');
    };
    utterance.onend = resume;
    utterance.onerror = resume;
    window.speechSynthesis.speak(utterance);
  }, [startRecognition, stopRecognition]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      const startedAt = startedAtRef.current;
      if (startedAt !== null) setDurationSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  useEffect(() => () => {
    activeRef.current = false;
    stopRecognition();
    window.speechSynthesis?.cancel();
  }, [stopRecognition]);

  return { active, muted, status, error, durationSeconds, start, toggleMute, end, speak };
}
