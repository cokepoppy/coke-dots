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

  function connectAnotherWorkspace() {
    if (!canManage) return;
    setShowWorkspaceChoices(false);
    onConnectSlack();
  }

  const installations = state?.installations ?? [];
  const selectedWorkspace = installations.find(item => item.teamId === selectedTeamId);

  return <div className="slack-setup-backdrop" data-testid="slack-setup-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="slack-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="slack-setup-title" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); if (showWorkspaceChoices) setShowWorkspaceChoices(false); else onClose(); } }}>
      <button className="slack-setup-close" type="button" aria-label="Close Slack setup" onClick={onClose}>×</button>
      <h2 id="slack-setup-title">Set up Slack</h2>
      {loading ? <p className="slack-setup-status" role="status">Loading workspaces…</p> : <>
        <div className="slack-setup-workspace-card">
          <div className="slack-setup-picker">
            <span>Your dot in</span>
            {installations.length ? <div className="slack-workspace-control">
              <button className="slack-current-workspace" type="button" aria-haspopup="menu" aria-expanded={showWorkspaceChoices} disabled={!canManage} onClick={() => setShowWorkspaceChoices(value => !value)}>
                <span className="slack-workspace-icon" aria-hidden="true"><i /><i /><i /><i /></span>
                <span className="slack-workspace-name">{selectedWorkspace?.teamName || 'Workspace'}</span>
                <span className="slack-workspace-chevron" aria-hidden="true">⌄</span>
              </button>
              {showWorkspaceChoices && <div className="slack-workspace-menu" role="menu" aria-label="Choose a workspace">
                <div className="slack-workspace-menu-heading" role="presentation">Choose a workspace</div>
                {installations.map(workspace => <button key={workspace.teamId} type="button" role="menuitemradio" aria-checked={workspace.teamId === selectedTeamId} onClick={() => { setSelectedTeamId(workspace.teamId); setShowWorkspaceChoices(false); setNotice(''); }}>
                  <span className="slack-workspace-icon" aria-hidden="true"><i /><i /><i /><i /></span>{workspace.teamName}
                </button>)}
                <div className="slack-workspace-menu-separator" role="separator" />
                <button type="button" role="menuitem" disabled={!canManage} onClick={connectAnotherWorkspace}>Select another</button>
              </div>}
            </div> : <span className="slack-current-workspace is-placeholder" aria-label="Workspace">
              <span className="slack-workspace-icon" aria-hidden="true"><i /><i /><i /><i /></span>
              <span className="slack-workspace-name">Workspace</span>
              <span className="slack-workspace-chevron" aria-hidden="true">⌄</span>
            </span>}
          </div>
          <p className="slack-setup-description">Choose the workspace to add {dotName} to Slack</p>
        </div>
        {selectedWorkspace?.contactEnabled && <span className="sr-only" role="status">Workspace selected</span>}
        {!canManage && <p className="slack-setup-readonly">Ask a workspace owner or admin to change this connection.</p>}
        {installations.length
          ? <button className="slack-setup-primary" data-testid="slack-connect" type="button" disabled={!canManage || saving || !selectedTeamId} onClick={() => void selectWorkspace()}>{saving ? 'Saving…' : 'Select a workspace'}</button>
          : state?.configured
            ? <button className="slack-setup-primary" data-testid="slack-connect" type="button" disabled={!canManage || saving} onClick={() => void selectWorkspace()}>{saving ? 'Opening Slack…' : 'Add to Slack'}</button>
            : <><button className="slack-setup-primary" data-testid="slack-connect" type="button" disabled aria-disabled="true">Add to Slack</button><p className="slack-setup-unavailable" role="status">Slack connection is not configured for this build.</p></>}
        {!canManage && !installations.length && <p className="slack-setup-readonly">Ask a workspace owner or admin to connect Slack.</p>}
      </>}
      {error && <p className="slack-setup-error" role="alert">{error}<button type="button" aria-label="Retry Slack workspace loading" onClick={() => void refresh()}>Retry</button></p>}
      {notice && <p className="slack-setup-notice" role="status">{notice}</p>}
    </section>
  </div>;
}
