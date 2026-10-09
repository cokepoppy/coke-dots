import { useEffect, useState } from 'react';
import { appFetch } from './api.ts';
import './slack-setup.css';

interface SlackInstallation { teamId: string; teamName: string; installedAt: string; scopes: string[]; contactEnabled: boolean }
interface SlackState { configured: boolean; installations: SlackInstallation[] }

export function SlackSetupModal({ dotName, canManage, onClose, onConnectSlack }: { dotName: string; canManage: boolean; onClose: () => void; onConnectSlack: () => void }) {
  const [state, setState] = useState<SlackState | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [showWorkspaceChoices, setShowWorkspaceChoices] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const response = await appFetch('/api/slack');
      if (!response.ok) throw new Error('Unable to load Slack workspaces');
      const next = await response.json() as SlackState;
      setState(next);
      setSelectedTeamId(current => current || next.installations.find(item => item.contactEnabled)?.teamId || next.installations[0]?.teamId || '');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to load Slack workspaces'); }
    finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); }, []);

  async function selectWorkspace() {
    if (!canManage || saving) return;
    if (!state?.installations.length) {
      if (state?.configured) onConnectSlack();
      return;
    }
    if (!selectedTeamId) return;
    setSaving(true); setError('');
    try {
      const response = await appFetch('/api/slack/contact', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ teamId: selectedTeamId }) });
      const body = await response.json() as SlackState & { error?: string };
      if (!response.ok) throw new Error(body.error || 'Unable to select this Slack workspace');
      setState(body);
      setShowWorkspaceChoices(false);
      setNotice(`${body.installations.find(item => item.teamId === selectedTeamId)?.teamName || 'Slack'} is selected for ${dotName}.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Unable to select this Slack workspace'); }
    finally { setSaving(false); }
  }

  return <div className="slack-setup-backdrop" data-testid="slack-setup-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="slack-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="slack-setup-title" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
      <button className="slack-setup-close" type="button" aria-label="Close Slack setup" onClick={onClose}>×</button>
      <div className="slack-setup-mark" aria-hidden="true">✣</div>
      <h2 id="slack-setup-title">Set up Slack</h2>
      {loading ? <p className="slack-setup-status" role="status">Loading workspaces…</p> : <>
        <div className="slack-setup-picker">
          <span>Your dot in</span>
          {state?.installations.length ? <strong className="slack-current-workspace"><i aria-hidden="true">✣</i>{state.installations.find(item => item.teamId === selectedTeamId)?.teamName || 'Slack'}</strong>
            : <span className="slack-current-workspace is-placeholder"><i aria-hidden="true">✣</i>Workspace</span>}
          {state?.installations.length ? <button className="slack-select-another" type="button" aria-expanded={showWorkspaceChoices} disabled={!canManage} onClick={() => setShowWorkspaceChoices(value => !value)}>{showWorkspaceChoices ? 'Cancel' : 'Select another'}</button> : null}
        </div>
        {showWorkspaceChoices && state?.installations.length ? <label className="slack-workspace-options"><span className="sr-only">Slack workspace</span><select aria-label="Slack workspace" value={selectedTeamId} onChange={event => { setSelectedTeamId(event.target.value); setNotice(''); }}>
          {state.installations.map(workspace => <option key={workspace.teamId} value={workspace.teamId}>{workspace.teamName}</option>)}
        </select></label> : null}
        {state?.installations.find(item => item.teamId === selectedTeamId)?.contactEnabled && <span className="sr-only" role="status">Workspace selected</span>}
        <p className="slack-setup-description">{state?.installations.length ? `Choose the workspace to add ${dotName} to Slack` : `Connect a Slack workspace to add ${dotName} as a contact method.`}</p>
        {!canManage && <p className="slack-setup-readonly">Ask a workspace owner or admin to change this connection.</p>}
        {state?.installations.length
          ? <button className="slack-setup-primary" data-testid="slack-connect" type="button" disabled={!canManage || saving || !selectedTeamId} onClick={() => void selectWorkspace()}>{saving ? 'Saving…' : 'Select a workspace'}</button>
          : state?.configured
            ? <button className="slack-setup-primary" data-testid="slack-connect" type="button" disabled={!canManage || saving} onClick={() => void selectWorkspace()}>{saving ? 'Opening Slack…' : 'Add to Slack'}</button>
            : <div className="slack-setup-unavailable" role="status">Slack connection is not configured for this build.</div>}
        {state?.installations.length ? <details className="slack-setup-advanced">
          <summary>More Slack settings</summary>
          <button className="slack-setup-secondary" type="button" disabled={!canManage} onClick={onConnectSlack}>Connect or refresh Slack access</button>
        </details> : null}
        {!canManage && !state?.installations.length && <p className="slack-setup-readonly">Ask a workspace owner or admin to connect Slack.</p>}
      </>}
      {error && <p className="slack-setup-error" role="alert">{error}<button type="button" aria-label="Retry Slack workspace loading" onClick={() => void refresh()}>Retry</button></p>}
      {notice && <p className="slack-setup-notice" role="status">{notice}</p>}
    </section>
  </div>;
}
