import { useEffect, useState } from 'react';
import { appFetch } from './api.ts';
import './teams-setup.css';

interface TeamsState { configured: boolean; connectAllowed: boolean; endpoint: string; linked: { displayName: string; linkedAt: string } | null }
interface LinkCode { code: string; expiresAt: string }

export function TeamsSetupModal({ dotName, onClose }: { dotName: string; onClose: () => void }) {
  const [state, setState] = useState<TeamsState | null>(null);
  const [code, setCode] = useState<LinkCode | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function refresh() {
    setLoading(true); setError('');
    try {
      const response = await appFetch('/api/teams');
      if (!response.ok) throw new Error('无法加载 Microsoft Teams 状态');
      setState(await response.json() as TeamsState);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法加载 Microsoft Teams 状态'); }
    finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); }, []);

  async function createCode() {
    setSaving(true); setError('');
    try {
      const response = await appFetch('/api/teams/link-code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const result = await response.json() as LinkCode & { error?: string };
      if (!response.ok) throw new Error(result.error || '无法生成连接码');
      setCode(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法生成连接码'); }
    finally { setSaving(false); }
  }

  return <div className="teams-setup-backdrop" data-testid="teams-setup-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="teams-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="teams-setup-title" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
      <button className="teams-setup-close" type="button" aria-label="Close Microsoft Teams setup" onClick={onClose}>×</button>
      <div className="teams-setup-mark" aria-hidden="true">T</div>
      <h2 id="teams-setup-title">Set up Microsoft Teams</h2>
      {loading ? <p className="teams-setup-status" role="status">Loading connection…</p> : state?.linked ? <>
        <div className="teams-setup-connected" role="status"><span aria-hidden="true">✓</span><span>Connected as {state.linked.displayName}</span></div>
        <p className="teams-setup-description">Message {dotName} in your personal Teams chat to continue work.</p>
        {code ? <div className="teams-setup-code" data-testid="teams-link-code"><span>{code.code}</span><small>Expires at {new Date(code.expiresAt).toLocaleTimeString()}</small></div> : <button className="teams-setup-secondary" type="button" disabled={saving} onClick={() => void createCode()}>{saving ? 'Creating…' : 'Connect another Teams account'}</button>}
        {code && <p className="teams-setup-warning" role="status">Send <strong>connect {code.code}</strong> in a personal Teams chat. Keep this code private; it expires in 10 minutes.</p>}
      </> : state?.configured && !state.connectAllowed ? <>
        <p className="teams-setup-description">Microsoft Teams messages are private conversations.</p>
        <div className="teams-setup-unavailable" role="status">Teams contact setup currently supports personal Dot workspaces only.</div>
        <p className="teams-setup-note">A shared workspace exposes task history to its members. Use a personal Dot workspace to connect your private Teams chat.</p>
      </> : state?.configured ? <>
        <p className="teams-setup-description">Connect your Microsoft Teams account to message {dotName} directly.</p>
        <p className="teams-setup-note">Create a one-time code, then send <strong>connect CODE</strong> to the Coke Dots bot in a personal Teams chat. Your messages are handled as tasks for this workspace.</p>
        {code ? <div className="teams-setup-code" data-testid="teams-link-code"><span>{code.code}</span><small>Expires at {new Date(code.expiresAt).toLocaleTimeString()}</small></div> : <button className="teams-setup-primary" type="button" disabled={saving} onClick={() => void createCode()}>{saving ? 'Creating…' : 'Create connection code'}</button>}
        {code && <p className="teams-setup-warning" role="status">Keep this code private. It can be used once and expires in 10 minutes.</p>}
      </> : <>
        <p className="teams-setup-description">Connect Microsoft Teams to add {dotName} as a contact method.</p>
        <div className="teams-setup-unavailable" role="status">Microsoft Teams bot is not configured for this build.</div>
        <p className="teams-setup-note">The bot app must be registered with Microsoft and configured to send activities to <code>/teams/messages</code>.</p>
      </>}
      {error && <p className="teams-setup-error" role="alert">{error}<button type="button" aria-label="Retry Microsoft Teams status" onClick={() => void refresh()}>Retry</button></p>}
      <button className="teams-setup-dismiss" type="button" onClick={onClose}>Close</button>
    </section>
  </div>;
}
