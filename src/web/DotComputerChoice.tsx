import { useState } from 'react';
import './computer-choice.css';

type Props = {
  localComputer: boolean;
  mode: 'onboarding' | 'settings';
  onSave: (enabled: boolean) => Promise<void>;
  onCancel?: () => void;
};

function ComputerIllustration() {
  return <svg className="computer-choice-illustration" viewBox="0 0 128 112" aria-hidden="true">
    <rect x="8" y="4" width="112" height="78" rx="10" className="computer-illustration-screen" />
    <rect x="15" y="11" width="98" height="64" rx="5" className="computer-illustration-window" />
    <path d="M52 82h24v11H52zM43 96h42v6H43z" className="computer-illustration-stand" />
    <rect x="24" y="20" width="29" height="7" rx="3.5" className="computer-illustration-line" />
    <rect x="24" y="33" width="18" height="18" rx="5" className="computer-illustration-tile" />
    <rect x="47" y="33" width="18" height="18" rx="5" className="computer-illustration-tile" />
    <rect x="70" y="33" width="18" height="18" rx="5" className="computer-illustration-tile" />
    <rect x="93" y="33" width="12" height="18" rx="5" className="computer-illustration-tile" />
    <circle cx="33" cy="42" r="3" className="computer-illustration-dot" />
    <circle cx="56" cy="42" r="3" className="computer-illustration-dot" />
    <circle cx="79" cy="42" r="3" className="computer-illustration-dot" />
    <rect x="24" y="58" width="80" height="6" rx="3" className="computer-illustration-line" />
  </svg>;
}

export function DotComputerChoice({ localComputer, mode, onSave, onCancel }: Props) {
  const [enabled, setEnabled] = useState(localComputer);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  async function save() {
    if (saving) return;
    setSaving(true);
    setSaveError('');
    try { await onSave(enabled); }
    catch (error) { setSaveError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  }

  const content = <div className="computer-choice-content">
    <ComputerIllustration />
    <h1>{mode === 'settings' ? 'Computer access' : 'Choose where your dot can work'}</h1>
    <p className="computer-choice-intro">Your dot has its own computer, but you can also let it use yours. You can change this anytime.</p>
    <div className="computer-choice-options">
      <div className="computer-choice-option selected" role="radio" aria-checked="true" aria-label="Your dot’s computer">
        <span className="computer-choice-device" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg></span>
        <span className="computer-choice-copy"><strong>Your dot’s computer</strong><small>A separate, private browser workspace for this dot.</small></span>
        <span className="computer-choice-check" aria-label="Selected">✓</span>
      </div>
      <label className="computer-choice-option local-computer-option">
        <span className="computer-choice-device" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg></span>
        <span className="computer-choice-copy"><strong>Your local computer</strong><small>Use a separate Chrome profile on this Mac while Coke Dots is running.</small></span>
        <input aria-label="Your local computer" type="checkbox" role="switch" checked={enabled} disabled={saving} onChange={event => setEnabled(event.currentTarget.checked)} />
      </label>
    </div>
    <p className="computer-choice-limit">This local version controls an isolated browser only. It does not access your Mac files or other apps.</p>
    {saveError && <p className="computer-choice-error" role="alert">{saveError}</p>}
    <div className="computer-choice-actions">
      {mode === 'settings' && <button type="button" className="computer-choice-cancel" disabled={saving} onClick={onCancel}>Cancel</button>}
      <button type="button" className="computer-choice-continue" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : mode === 'settings' ? 'Save' : 'Continue'}</button>
    </div>
  </div>;

  if (mode === 'onboarding') return <section className="computer-choice-screen" data-testid="computer-choice">{content}</section>;
  return <div className="computer-choice-backdrop" data-testid="computer-access-dialog" onMouseDown={event => { if (event.target === event.currentTarget) onCancel?.(); }}>
    <section className="computer-choice-dialog" role="dialog" aria-modal="true" aria-label="Computer access settings">{content}</section>
  </div>;
}
