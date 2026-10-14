import { useEffect, useState } from 'react';
import type { ActionRuleMode, TenantActionRule } from '../shared/types.ts';
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

export function PermissionRules({ tenantId, role }: { tenantId: string; role: string }) {
  const [rule, setRule] = useState<TenantActionRule | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [mode, setMode] = useState<ActionRuleMode>('when-requested');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canManage = ['owner', 'admin'].includes(role);

  useEffect(() => {
    let active = true;
    setRule(null); setEditing(false); setError(''); setLoading(true);
    void appFetch('/api/action-rule').then(response => responseData<TenantActionRule | null>(response)).then(next => {
      if (active) setRule(next);
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [tenantId]);

  function startEdit() {
    setInstruction(rule?.instruction || 'For creating or updating pages in Scratchpad');
    setMode(rule?.mode || 'when-requested'); setEditing(true); setError('');
  }

  async function save() {
    setBusy(true); setError('');
    try {
      const saved = await responseData<TenantActionRule>(await appFetch('/api/action-rule', {
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

  return <>
    <div className="section-heading model-heading"><h2>Permissions · Custom rules</h2><p>Set how Dot handles Scratchpad page writes in this workspace.</p></div>
    <div className="profile-card model-card permission-rule-card" data-testid="action-rule-manager">
      <div className="permission-rule-scope"><span className="permission-rule-icon" aria-hidden="true">◇</span><div><strong>Create or update Scratchpad pages</strong><small>Rules in a shared workspace affect its members. Personal workspaces keep separate rules.</small></div></div>
      {loading ? <p className="permission-rule-empty" role="status">Loading rules…</p> : editing ? <div className="permission-rule-form">
        <label>Rule description<textarea aria-label="规则说明" maxLength={1000} value={instruction} onChange={event => setInstruction(event.target.value)} placeholder="Describe when this page action should happen" /></label>
        <label>How should Dot handle this action?<select aria-label="规则处理方式" value={mode} onChange={event => setMode(event.target.value as ActionRuleMode)}>
          {(Object.keys(modeLabels) as ActionRuleMode[]).map(value => <option key={value} value={value}>{modeLabels[value]}</option>)}
        </select></label>
        <div className="permission-rule-actions"><button className="primary" disabled={busy || !instruction.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save rule'}</button><button disabled={busy} onClick={() => setEditing(false)}>Cancel</button></div>
      </div> : rule ? <article className="permission-rule-row" data-testid="custom-action-rule">
        <div><p>{rule.instruction}</p><small>{modeLabels[rule.mode]}</small></div>
        {canManage && <div className="permission-rule-actions"><button disabled={busy} onClick={startEdit}>Edit rule</button><button disabled={busy} onClick={() => void remove()}>Delete rule</button></div>}
      </article> : <div className="permission-rule-default"><p>No custom rule is set. Dot acts on Scratchpad pages only when you explicitly ask.</p>{canManage && <button className="primary" onClick={startEdit}>Add rule</button>}</div>}
      <small className="permission-rule-note">This first rule controls only local Scratchpad pages. It does not connect apps or grant external account access. Rules guide the agent; the app still checks supported actions.</small>
      {error && <small role="alert" className="permission-rule-error">{error}</small>}
    </div>
  </>;
}
