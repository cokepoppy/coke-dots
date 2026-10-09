import { useEffect, useState } from 'react';
import { appFetch } from './api.ts';
import './slack-setup.css';

interface SlackInstallation {
  teamId: string; teamName: string; installedAt: string; scopes: string[]; contactEnabled: boolean;
}
interface SlackChannel { id: string; name: string }
interface SlackMonitor { id: string; teamId: string; channelId: string; channelName: string; instructions: string; status: 'active' | 'paused'; lastEventAt: string | null; lastTaskId: string | null }
interface SlackState { configured: boolean; eventsConfigured: boolean; installations: SlackInstallation[]; monitors: SlackMonitor[] }

export function SlackSetupModal({ dotName, canManage, onClose, onConnectSlack }: { dotName: string; canManage: boolean; onClose: () => void; onConnectSlack: () => void }) {
  const [state, setState] = useState<SlackState | null>(null);
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [channels, setChannels] = useState<SlackChannel[]>([]);
  const [channelsError, setChannelsError] = useState('');
  const [channelId, setChannelId] = useState('');
  const [instructions, setInstructions] = useState('');
  const [showWorkspaceChoices, setShowWorkspaceChoices] = useState(false);
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  const [monitorBusy, setMonitorBusy] = useState(false);
  const [monitorError, setMonitorError] = useState('');

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

  useEffect(() => {
    if (!selectedTeamId || !canManage) { setChannels([]); setChannelsError(''); return; }
    let current = true;
    setChannelsError('');
    void appFetch(`/api/slack/channels?teamId=${encodeURIComponent(selectedTeamId)}`).then(async response => {
      const body = await response.json() as { channels?: SlackChannel[]; error?: string };
      if (!response.ok) throw new Error(body.error || '无法加载 Slack 公共频道');
      return body.channels || [];
    }).then(next => {
      if (!current) return;
      setChannels(next);
      setChannelId(value => next.some(channel => channel.id === value) ? value : next[0]?.id || '');
    }).catch(reason => {
      if (current) { setChannels([]); setChannelsError(reason instanceof Error ? reason.message : '无法加载 Slack 公共频道'); }
    });
    return () => { current = false; };
  }, [selectedTeamId, canManage]);

  async function selectWorkspace() {
    if (!selectedTeamId || !canManage) return;
    setSaving(true); setError('');
    try {
      const response = await appFetch('/api/slack/contact', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ teamId: selectedTeamId }) });
      const body = await response.json() as SlackState & { error?: string };
      if (!response.ok) throw new Error(body.error || '无法设置 Slack 联系方式');
      setState(body); setShowWorkspaceChoices(false); setNotice(`${body.installations.find(item => item.teamId === selectedTeamId)?.teamName || 'Slack'} is selected for ${dotName}.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法设置 Slack 联系方式'); }
    finally { setSaving(false); }
  }

  function connectAnotherWorkspace() {
    if (canManage) onConnectSlack();
  }

  async function addMonitor() {
    if (!selectedTeamId || !channelId || !instructions.trim() || monitorBusy || !canManage) return;
    setMonitorBusy(true); setMonitorError('');
    try {
      const response = await appFetch('/api/slack/monitors', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ teamId: selectedTeamId, channelId, instructions: instructions.trim() }) });
      const body = await response.json() as SlackMonitor & { error?: string };
      if (!response.ok) throw new Error(body.error || '无法创建事件监控');
      setInstructions('');
      await refresh();
    } catch (reason) { setMonitorError(reason instanceof Error ? reason.message : '无法创建事件监控'); }
    finally { setMonitorBusy(false); }
  }

  async function toggleMonitor(monitor: SlackMonitor) {
    setMonitorError('');
    try {
      const response = await appFetch(`/api/slack/monitors/${monitor.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: monitor.status === 'active' ? 'pause' : 'resume' }) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error || '无法更新事件监控');
      await refresh();
    } catch (reason) { setMonitorError(reason instanceof Error ? reason.message : '无法更新事件监控'); }
  }

  return <div className="slack-setup-backdrop" data-testid="slack-setup-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="slack-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="slack-setup-title" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
      <button className="slack-setup-close" type="button" aria-label="Close Slack setup" onClick={onClose}>×</button>
      <div className="slack-setup-mark" aria-hidden="true">✣</div>
      <h2 id="slack-setup-title">Set up Slack</h2>
      {loading ? <p className="slack-setup-status" role="status">Loading workspaces…</p> : state?.installations.length ? <>
        <div className="slack-setup-picker">
          <span>Your dot in</span>
          <strong className="slack-current-workspace"><i aria-hidden="true">✣</i>{state.installations.find(item => item.teamId === selectedTeamId)?.teamName || 'Slack'}</strong>
          <button className="slack-select-another" type="button" aria-expanded={showWorkspaceChoices} disabled={!canManage} onClick={() => setShowWorkspaceChoices(value => !value)}>{showWorkspaceChoices ? 'Cancel' : 'Select another'}</button>
        </div>
        {showWorkspaceChoices && <label className="slack-workspace-options"><span className="sr-only">Slack workspace</span><select aria-label="Slack workspace" value={selectedTeamId} onChange={event => { setSelectedTeamId(event.target.value); setNotice(''); }}>
          {state.installations.map(workspace => <option key={workspace.teamId} value={workspace.teamId}>{workspace.teamName}</option>)}
        </select></label>}
        {state.installations.find(item => item.teamId === selectedTeamId)?.contactEnabled && <span className="sr-only" role="status">Workspace selected</span>}
        <p className="slack-setup-description">Choose the workspace to add {dotName} to Slack</p>
        {!canManage && <p className="slack-setup-readonly">Ask a workspace owner or admin to change this connection.</p>}
        <button className="slack-setup-primary" type="button" disabled={!canManage || saving || !selectedTeamId} onClick={() => void selectWorkspace()}>{saving ? 'Saving…' : 'Select a workspace'}</button>
        <details className="slack-setup-advanced" open={advancedSettingsOpen} onToggle={event => setAdvancedSettingsOpen(event.currentTarget.open)}>
          <summary>More Slack settings</summary>
          <p className="slack-setup-readonly">Direct messages and mentions from the Slack account that connected this workspace can create Dot tasks. Mention replies are delivered privately.</p>
          {state.eventsConfigured
            ? <p className="slack-setup-readonly" role="status">Message receiver is ready. Subscribe to app_mention and message.im in the Slack app’s Events API and send events to /slack/events.</p>
            : <p className="slack-setup-readonly" role="status">Message receiving needs SLACK_SIGNING_SECRET and the Slack app’s Events API URL set to /slack/events.</p>}
          <button className="slack-setup-secondary" type="button" disabled={!canManage} onClick={connectAnotherWorkspace}>Connect or refresh Slack access</button>
          <div className="slack-monitor-section" aria-label="Proactive Slack monitoring">
            <h3>Proactive monitoring</h3>
            <p className="slack-setup-readonly">Choose a public channel and tell your dot what to look for. New messages create read-only reviews in Activity; Dot will not reply in Slack.</p>
            {state.eventsConfigured && <p className="slack-setup-readonly" role="status">For channel events, add the Slack app to the channel and subscribe to message.channels in the Events API.</p>}
            {canManage && <>
              {channelsError ? <p className="slack-setup-error" role="alert">{channelsError}</p> : <>
                <label className="slack-monitor-field">Public channel<select aria-label="Public Slack channel" value={channelId} onChange={event => setChannelId(event.target.value)} disabled={!channels.length}>
                  {channels.length ? channels.map(channel => <option key={channel.id} value={channel.id}>#{channel.name}</option>) : <option value="">No public channels available</option>}
                </select></label>
                <label className="slack-monitor-field">What should Dot look for?<textarea aria-label="Slack monitoring instructions" value={instructions} onChange={event => setInstructions(event.target.value)} maxLength={1000} placeholder="For example: new bug reports that block the release" /></label>
                <button className="slack-setup-primary" type="button" onClick={() => void addMonitor()} disabled={monitorBusy || !channelId || instructions.trim().length < 3}>{monitorBusy ? 'Starting…' : 'Monitor this channel'}</button>
              </>}
            </>}
            {monitorError && <p className="slack-setup-error" role="alert">{monitorError}</p>}
            <div className="slack-monitor-list" aria-label="Configured Slack monitors">
              {(state.monitors || []).filter(monitor => monitor.teamId === selectedTeamId).map(monitor => <div className="slack-monitor-row" key={monitor.id}>
                <div><strong>#{monitor.channelName}</strong><span>{monitor.instructions}</span><small>{monitor.status === 'active' ? 'Monitoring' : 'Paused'}</small></div>
                {canManage && <button type="button" onClick={() => void toggleMonitor(monitor)}>{monitor.status === 'active' ? 'Pause' : 'Resume'}</button>}
              </div>)}
            </div>
          </div>
        </details>
      </> : <>
        <p className="slack-setup-description">Connect a Slack workspace to add {dotName} as a contact method.</p>
        {state?.configured ? <button className="slack-setup-primary" data-testid="slack-connect" type="button" disabled={!canManage} onClick={onConnectSlack}>Add to Slack</button> : <div className="slack-setup-unavailable" role="status">Slack connection is not configured for this build.</div>}
        {!canManage && <p className="slack-setup-readonly">Ask a workspace owner or admin to connect Slack.</p>}
      </>}
      {error && <p className="slack-setup-error" role="alert">{error}<button type="button" aria-label="Retry Slack workspace loading" onClick={() => void refresh()}>Retry</button></p>}
      {notice && <p className="slack-setup-notice" role="status">{notice}</p>}
    </section>
  </div>;
}
