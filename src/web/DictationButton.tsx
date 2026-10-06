import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { insertDictation, transcriptFromResults } from '../shared/dictation.ts';

interface RecognitionResult extends ArrayLike<{ transcript?: string }> { isFinal?: boolean }
interface RecognitionEvent extends Event { results: ArrayLike<RecognitionResult> }
interface RecognitionErrorEvent extends Event { error: string }
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionConstructor = new () => RecognitionLike;
type SpeechWindow = Window & { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };

export function DictationButton({ draft, setDraft, onError, textareaRef }: {
  draft: string;
  setDraft: (value: string) => void;
  onError: (message: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [status, setStatus] = useState<'idle' | 'listening' | 'stopping'>('idle');
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const baseDraftRef = useRef('');
  const selectionRef = useRef({ start: 0, end: 0 });
  const caretRef = useRef(-1);

  useEffect(() => () => recognitionRef.current?.abort(), []);

  function toggleDictation() {
    const active = recognitionRef.current;
    if (active && status === 'listening') {
      setStatus('stopping');
      active.stop();
      return;
    }
    if (status !== 'idle') return;

    const speechWindow = window as SpeechWindow;
    const Recognition = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!Recognition) {
      onError('当前浏览器不支持语音输入，请直接输入文字。');
      return;
    }

    const recognition = new Recognition();
    recognition.lang = navigator.language || 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = true;
    baseDraftRef.current = draft;
    caretRef.current = -1;
    selectionRef.current = {
      start: textareaRef.current?.selectionStart ?? draft.length,
      end: textareaRef.current?.selectionEnd ?? draft.length,
    };
    recognition.onresult = event => {
      const transcript = transcriptFromResults(event.results);
      if (!transcript) return;
      const { start, end } = selectionRef.current;
      const updated = insertDictation(baseDraftRef.current, transcript, start, end);
      const insertionStart = updated.indexOf(transcript.trim(), start);
      caretRef.current = insertionStart + transcript.trim().length;
      setDraft(updated);
    };
    recognition.onerror = event => {
      setStatus('idle');
      recognitionRef.current = null;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        onError('麦克风权限未开启，请允许访问麦克风后重试。');
      } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
        onError(`语音输入暂不可用：${event.error}`);
      }
    };
    recognition.onend = () => {
      setStatus('idle');
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      if (caretRef.current >= 0) {
        window.setTimeout(() => {
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(caretRef.current, caretRef.current);
        }, 0);
      }
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setStatus('listening');
    } catch {
      recognitionRef.current = null;
      setStatus('idle');
      onError('无法开启麦克风，请检查浏览器权限后重试。');
    }
  }

  const listening = status !== 'idle';
  return <>
    <button
      className={`dictation-button${listening ? ' listening' : ''}`}
      data-testid="dictation-button"
      type="button"
      aria-label={status === 'listening' ? '停止语音输入' : status === 'stopping' ? '正在完成语音输入' : '开始语音输入'}
      aria-pressed={listening}
      title={status === 'listening' ? '停止语音输入' : '语音输入'}
      disabled={status === 'stopping'}
      onMouseDown={event => event.preventDefault()}
      onClick={toggleDictation}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
        <rect x="9" y="3" width="6" height="12" rx="3" fill="currentColor" />
        <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3m-4 0h8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    </button>
    <span className="sr-only" aria-live="polite">{status === 'listening' ? '正在聆听' : status === 'stopping' ? '正在完成转写' : ''}</span>
  </>;
}
