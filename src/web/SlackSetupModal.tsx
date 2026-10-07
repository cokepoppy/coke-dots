import { useEffect, useState } from 'react';
import { appFetch } from './api.ts';
import './slack-setup.css';

interface SlackInstallation {
  teamId: string; teamName: string; installedAt: string; scopes: string[]; contactEnabled: boolean;
}
interface SlackState { configured: boolean; eventsConfigured: boolean; installations: SlackInstallation[] }

export function SlackSetupModal({ dotName, canManage, onClose, onConnectSlack }: { dotName: string; canManage: boolean; onClose: () => void; onConnectSlack: () => void }) {
  const [state, setState] = useState<SlackState | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function refresh() {
    setLoading(true);
    try {
      const response = await appFetch('/api/slack');
      if (!response.ok) throw new Error('无法加载 Slack 工作区');
      const next = await response.json() as SlackState;
      setState(next);
      setSelectedTeamId(current => current || next.installations.find(item => item.contactEnabled)?.teamId || next.installations[0]?.teamId || '');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法加载 Slack 工作区'); }
    finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); }, []);

  async function selectWorkspace() {
    if (!selectedTeamId || !canManage) return;
    setSaving(true); setError('');
    try {
      const response = await appFetch('/api/slack/contact', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ teamId: selectedTeamId }) });
      const body = await response.json() as SlackState & { error?: string };
      if (!response.ok) throw new Error(body.error || '无法设置 Slack 联系方式');
      setState(body); setNotice(`${body.installations.find(item => item.teamId === selectedTeamId)?.teamName || 'Slack'} is selected for ${dotName}.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法设置 Slack 联系方式'); }
    finally { setSaving(false); }
  }

  function connectAnotherWorkspace() {
    if (canManage) onConnectSlack();
  }

  return <div className="slack-setup-backdrop" data-testid="slack-setup-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="slack-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="slack-setup-title" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
      <button className="slack-setup-close" type="button" aria-label="Close Slack setup" onClick={onClose}>×</button>
      <div className="slack-setup-mark" aria-hidden="true">✣</div>
      <h2 id="slack-setup-title">Set up Slack</h2>
      {loading ? <p className="slack-setup-status" role="status">Loading workspaces…</p> : state?.installations.length ? <>
        <div className="slack-setup-picker">
          <span>Your dot in</span>
          <label><span className="sr-only">Slack workspace</span><select aria-label="Slack workspace" value={selectedTeamId} onChange={event => { setSelectedTeamId(event.target.value); setNotice(''); }}>
            {state.installations.map(workspace => <option key={workspace.teamId} value={workspace.teamId}>{workspace.teamName}{workspace.contactEnabled ? ' · selected' : ''}</option>)}
          </select></label>
          {state.installations.find(item => item.teamId === selectedTeamId)?.contactEnabled && <span className="slack-setup-connected">Selected</span>}
        </div>
        <p className="slack-setup-description">Choose the workspace to add {dotName} to Slack</p>
        <p className="slack-setup-readonly">Direct messages and mentions from the Slack account that connected this workspace can create Dot tasks. Mention replies are delivered privately.</p>
        {state.eventsConfigured
          ? <p className="slack-setup-readonly" role="status">Message receiver is ready. Subscribe to app_mention and message.im in the Slack app’s Events API and send events to /slack/events.</p>
          : <p className="slack-setup-readonly" role="status">Message receiving needs SLACK_SIGNING_SECRET and the Slack app’s Events API URL set to /slack/events.</p>}
        {!canManage && <p className="slack-setup-readonly">Ask a workspace owner or admin to change this connection.</p>}
        <button className="slack-setup-primary" type="button" disabled={!canManage || saving || !selectedTeamId} onClick={() => void selectWorkspace()}>{saving ? 'Saving…' : 'Select a workspace'}</button>
        <button className="slack-setup-secondary" type="button" disabled={!canManage} onClick={connectAnotherWorkspace}>Connect or refresh Slack access</button>
      </> : <>
        <p className="slack-setup-description">Connect a Slack workspace to add {dotName} as a contact method.</p>
        {state?.configured ? <button className="slack-setup-primary" data-testid="slack-connect" type="button" disabled={!canManage} onClick={onConnectSlack}>Connect Slack</button> : <div className="slack-setup-unavailable" role="status">Slack connection is not configured for this build.</div>}
        {!canManage && <p className="slack-setup-readonly">Ask a workspace owner or admin to connect Slack.</p>}
      </>}
      {error && <p className="slack-setup-error" role="alert">{error}<button type="button" aria-label="Retry Slack workspace loading" onClick={() => void refresh()}>Retry</button></p>}
      {notice && <p className="slack-setup-notice" role="status">{notice}</p>}
    </section>
  </div>;
}
