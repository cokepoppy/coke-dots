import { useState } from 'react';
import { appFetch } from './api.ts';

export function SlackAccountLinkModal({ code, onClose, onLinked }: { code: string; onClose: () => void; onLinked: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [linked, setLinked] = useState(false);

  async function link() {
    if (busy || linked) return;
    setBusy(true); setError('');
    try {
      const response = await appFetch('/api/slack/link/claim', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || '无法连接 Slack 账号');
      setLinked(true); onLinked();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法连接 Slack 账号'); }
    finally { setBusy(false); }
  }

  return <div className="slack-setup-backdrop" data-testid="slack-link-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="slack-link-dialog" role="dialog" aria-modal="true" aria-labelledby="slack-link-title" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
      <button className="slack-setup-close" type="button" aria-label="Close Slack account linking" onClick={onClose}>×</button>
      <div className="slack-setup-mark" aria-hidden="true">✣</div>
      <h2 id="slack-link-title">Connect your Slack account</h2>
      {linked ? <p className="slack-link-copy" role="status">This Slack account is connected to your currently selected Coke Dots workspace.</p> : <>
        <p className="slack-link-copy">Link the Slack account that opened this page to the currently selected Coke Dots workspace. Messages will only create tasks for this signed-in member.</p>
        {error && <p className="slack-setup-error" role="alert">{error}</p>}
        <button className="slack-setup-primary" data-testid="slack-link-confirm" type="button" disabled={busy} onClick={() => void link()}>{busy ? 'Connecting…' : 'Link Slack account'}</button>
      </>}
      {linked && <button className="slack-setup-primary" type="button" onClick={onClose}>Done</button>}
    </section>
  </div>;
}
