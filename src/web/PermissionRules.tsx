import { useEffect, useState } from 'react';
import type { ActionRuleMode, PersonalActionRule } from '../shared/types.ts';
import { appFetch } from './api.ts';
import './permission-rules.css';

const modeLabels: Record<ActionRuleMode, string> = {
  'without-asking': 'Take action without asking',
  'when-requested': 'Take action when you say so',
  'ask-before': 'Ask before taking action',
  'hand-off': 'Hand off to you',
};

async function responseData<T>(response: Response): Promise<T> {
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export function PermissionRules({ userId, tenantId, tenantKind, tenantRole, workspaceCustomRulesEnabled }: { userId: string; tenantId: string; tenantKind: string; tenantRole: string; workspaceCustomRulesEnabled: boolean }) {
  const [rule, setRule] = useState<PersonalActionRule | null>(null);
  const [workspaceEnabled, setWorkspaceEnabled] = useState(workspaceCustomRulesEnabled);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [mode, setMode] = useState<ActionRuleMode>('when-requested');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setRule(null); setWorkspaceEnabled(workspaceCustomRulesEnabled); setEditing(false); setError(''); setLoading(true);
    void appFetch('/api/action-rule').then(response => responseData<PersonalActionRule | null>(response)).then(nextRule => {
      if (active) setRule(nextRule);
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [userId, tenantId]);

  useEffect(() => { setWorkspaceEnabled(workspaceCustomRulesEnabled); }, [tenantId, workspaceCustomRulesEnabled]);

  function startEdit() {
    setInstruction(rule?.instruction || 'For creating or updating pages in Scratchpad');
    setMode(rule?.mode || 'when-requested'); setEditing(true); setError('');
  }

  async function save() {
    setBusy(true); setError('');
    try {
      const saved = await responseData<PersonalActionRule>(await appFetch('/api/action-rule', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction, mode }),
      }));
      setRule(saved); setEditing(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true); setError('');
    try {
      await responseData<{ ok: boolean }>(await appFetch('/api/action-rule', { method: 'DELETE' }));
      setRule(null); setEditing(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function setWorkspaceRuleAvailability(enabled: boolean) {
    const previous = workspaceEnabled;
    setWorkspaceEnabled(enabled);
    setBusy(true); setError('');
    try {
      const saved = await responseData<{ enabled: boolean }>(await appFetch('/api/workspace/custom-action-rules', {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }),
      }));
      setWorkspaceEnabled(saved.enabled); setEditing(false);
    } catch (reason) { setWorkspaceEnabled(previous); setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  const canManageWorkspaceSetting = tenantKind === 'workspace' && ['owner', 'admin'].includes(tenantRole);

  return <>
    <div className="section-heading model-heading"><h2>Permissions · Custom rules</h2><p>Set the ongoing action boundaries for your Dot. The rule follows your account across workspaces.</p></div>
    <div className="profile-card model-card permission-rule-card" data-testid="action-rule-manager">
      <div className="permission-rule-scope"><span className="permission-rule-icon" aria-hidden="true">◇</span><div><strong>Create or update Scratchpad pages</strong><small>Your rule applies to tasks you start in every workspace you can access. Page content remains in its workspace.</small></div></div>
      {tenantKind === 'workspace' && <section className="permission-rule-workspace-setting" data-testid="workspace-custom-rules-setting">
        <div><strong>Use custom rules in this workspace</strong><small>When disabled, saved account rules are kept but do not apply here and cannot be edited here.</small></div>
        {canManageWorkspaceSetting
          ? <label><input type="checkbox" aria-label="在此工作区启用自定义规则" data-testid="workspace-custom-rules-toggle" checked={workspaceEnabled} disabled={loading || busy} onChange={event => void setWorkspaceRuleAvailability(event.currentTarget.checked)} /><span>{workspaceEnabled ? 'On' : 'Off'}</span></label>
          : <span className="permission-rule-workspace-status">{workspaceEnabled ? 'On' : 'Off'}</span>}
      </section>}
      {loading ? <p className="permission-rule-empty" role="status">Loading rules…</p> : editing ? <div className="permission-rule-form">
        <label>Rule description<textarea aria-label="规则说明" maxLength={1000} value={instruction} onChange={event => setInstruction(event.target.value)} placeholder="Describe when this page action should happen" /></label>
        <label>How should Dot handle this action?<select aria-label="规则处理方式" value={mode} onChange={event => setMode(event.target.value as ActionRuleMode)}>
          {(Object.keys(modeLabels) as ActionRuleMode[]).map(value => <option key={value} value={value}>{modeLabels[value]}</option>)}
        </select></label>
        <div className="permission-rule-actions"><button className="primary" disabled={busy || !instruction.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save rule'}</button><button disabled={busy} onClick={() => setEditing(false)}>Cancel</button></div>
      </div> : rule ? <article className="permission-rule-row" data-testid="custom-action-rule">
        <div><p>{rule.instruction}</p><small>{modeLabels[rule.mode]}</small></div>
        <div className="permission-rule-actions">{workspaceEnabled ? <><button disabled={busy} onClick={startEdit}>Edit rule</button><button disabled={busy} onClick={() => void remove()}>Delete rule</button></> : <small>This saved rule is not applied in this workspace.</small>}</div>
      </article> : <div className="permission-rule-default"><p>{workspaceEnabled ? 'No custom rule is set. Dot acts on Scratchpad pages only when you explicitly ask.' : 'Custom rules are disabled in this workspace.'}</p>{workspaceEnabled && <button className="primary" onClick={startEdit}>Add rule</button>}</div>}
      <small className="permission-rule-note">This currently controls only Scratchpad page writes. It does not grant workspace, app, or computer access. Rules guide the agent; the app still checks each supported action.</small>
      {error && <small role="alert" className="permission-rule-error">{error}</small>}
    </div>
  </>;
}
