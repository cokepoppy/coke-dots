import type { DotVoiceCall } from './dot-voice-call.ts';
import './voice-call.css';

export function VoiceCallControls({ call, dotName, showLauncher = true }: {
  call: DotVoiceCall;
  dotName: string;
  showLauncher?: boolean;
}) {
  if (!call.active) return <div className="voice-call-controls" data-testid="voice-call-controls">
    {showLauncher && <button type="button" className="call-launch" aria-label={`Call ${dotName}`} title={`Call ${dotName}`} onClick={call.start}><PhoneIcon /></button>}
    {call.error && <span className="voice-call-error" role="alert">{call.error}</span>}
  </div>;

  const statusText = call.status === 'connecting' ? 'Connecting…' : call.status === 'speaking' ? 'Speaking' : call.status === 'muted' ? 'Muted' : 'Active';
  const minutes = Math.floor(call.durationSeconds / 60);
  const seconds = String(call.durationSeconds % 60).padStart(2, '0');
  const duration = `${minutes}:${seconds}`;

  return <div className="voice-call-controls active" data-testid="voice-call-controls" data-call-status={call.status} role="group" aria-label={`Voice call with ${dotName}`}>
    <span className="sr-only" role="status" aria-live="polite">{`${statusText}, ${duration}`}</span>
    <button type="button" className={`call-mute ${call.muted ? 'muted' : ''}`} aria-label={call.muted ? 'Unmute microphone' : 'Mute microphone'} title={call.muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={call.muted} onClick={call.toggleMute}><MicrophoneIcon muted={call.muted} /></button>
    <button type="button" className="call-end" aria-label="End call" title="End call" onClick={call.end}><HangupIcon /></button>
  </div>;
}

function PhoneIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6.6 3.8 9 3.3a1.5 1.5 0 0 1 1.7.9l1 2.5a1.5 1.5 0 0 1-.4 1.7l-1.2 1a14.2 14.2 0 0 0 4.5 4.5l1-1.2a1.5 1.5 0 0 1 1.7-.4l2.5 1a1.5 1.5 0 0 1 .9 1.7l-.5 2.4a1.8 1.8 0 0 1-1.8 1.4A15.5 15.5 0 0 1 4.8 5.6a1.8 1.8 0 0 1 1.8-1.8Z" /></svg>;
}

function MicrophoneIcon({ muted }: { muted: boolean }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6"/>{muted && <path d="m4 4 16 16"/>}</svg>;
}

function HangupIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3.7 15.2a14.1 14.1 0 0 1 16.6 0l-2.1 3.1a1 1 0 0 1-1.3.3l-2.5-1.4a1 1 0 0 1-.5-.9v-1a9.4 9.4 0 0 0-4 0v1a1 1 0 0 1-.5.9l-2.5 1.4a1 1 0 0 1-1.3-.3l-2.1-3.1Z"/></svg>;
}
