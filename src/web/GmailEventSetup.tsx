import { useEffect, useState } from 'react';
import type { GmailEventTrigger, GmailSnapshot } from '../shared/types.ts';
import { appFetch, appPath } from './api.ts';

type Engine = Extract<GmailEventTrigger['engine'], 'pi' | 'dsh'>;
type Stage = 'edit' | 'review' | 'created';

export function GmailEventSetup({ gmail, engines, onOpenScheduled }: {
  gmail: GmailSnapshot;
  engines: Engine[];
  onOpenScheduled: () => void;
}) {
  const [stage, setStage] = useState<Stage>('edit');
  const [fromFilter, setFromFilter] = useState('');
  const [subjectFilter, setSubjectFilter] = useState('');
  const [condition, setCondition] = useState('');
  const [prompt, setPrompt] = useState('');
  const [engine, setEngine] = useState<Engine | ''>(engines[0] || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setEngine(current => current && engines.includes(current) ? current : engines[0] || '');
  }, [engines]);

  function connectGmail() {
    try { sessionStorage.setItem('coke-dots:gmail-return-view', 'activity'); } catch { /* Continue with the default route if storage is unavailable. */ }
    window.location.assign(appPath('/api/gmail/oauth/start'));
  }

  async function disconnectGmail() {
    if (busy || !window.confirm('断开 Gmail 并删除此账号的邮件触发器？')) return;
    setBusy(true); setError('');
    try {
      const response = await appFetch('/api/gmail/connection', { method: 'DELETE' });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || '无法断开 Gmail');
      resetDraft();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  function resetDraft() {
    setFromFilter(''); setSubjectFilter(''); setCondition(''); setPrompt('');
    setStage('edit'); setError('');
  }

  async function createTrigger() {
    if (busy || !engine || !gmail.connection || gmail.connection.status !== 'connected') return;
    setBusy(true); setError('');
    try {
      const response = await appFetch('/api/gmail/triggers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fromFilter: fromFilter.trim(), subjectFilter: subjectFilter.trim(), condition: condition.trim(), prompt: prompt.trim(), engine }),
      });
      const data = await response.json() as { trigger?: GmailEventTrigger; error?: string };
      if (!response.ok || !data.trigger) throw new Error(data.error || '无法创建邮件触发任务');
      setStage('created');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  const canReview = Boolean(engine && engines.includes(engine) && (fromFilter.trim() || subjectFilter.trim()) && condition.trim().length >= 3 && prompt.trim().length >= 3);
  const connected = gmail.connection?.status === 'connected';

  return <section className="gmail-workflow" data-testid="gmail-workflow" aria-label="Gmail 邮件事件任务">
    <header className="gmail-workflow-header">
      <div><span className="gmail-workflow-icon" aria-hidden="true">✉</span><div><h2>邮件事件任务</h2><p>让 Dot 在有新邮件符合条件时主动开始处理。</p></div></div>
      {gmail.connection && <span className={`gmail-connection-state ${connected ? 'connected' : ''}`}>{connected ? '已连接' : '需要重新授权'}</span>}
    </header>

    {gmail.connection ? <div className="gmail-account-row">
      <div><strong>{gmail.connection.email}</strong><small>{gmail.connection.lastSyncedAt ? `上次检查 ${new Date(gmail.connection.lastSyncedAt).toLocaleString('zh-CN')}` : '仅读取新进入收件箱的邮件'}</small></div>
      <div className="gmail-account-actions"><button type="button" onClick={connectGmail} disabled={!gmail.configured || busy}>重新授权</button><button type="button" onClick={() => void disconnectGmail()} disabled={busy}>断开</button></div>
    </div> : <div className="gmail-connect-prompt">
      <p>连接 Gmail 后，Dot 可读取新进入收件箱的邮件摘要。授权仅包含 Gmail 只读访问。</p>
      <button type="button" data-testid="connect-gmail" onClick={connectGmail} disabled={!gmail.configured}>{gmail.configured ? '连接 Gmail' : 'Google OAuth 未配置'}</button>
    </div>}

    {gmail.connection?.error && <p className="gmail-workflow-error" role="alert">{gmail.connection.error}</p>}
    <p className="gmail-workflow-note">每 {gmail.pollIntervalSeconds} 秒检查一次收件箱。邮件正文视为不可信输入；触发任务只分析匹配邮件，不会发送、归档或修改邮件。连接和触发器仅对当前账号可见。</p>

    {connected && engines.length === 0 && <p className="gmail-workflow-warning">请先在 Debian 云电脑配置 Pi 或 DeepSeek Harness。</p>}
    {connected && stage === 'edit' && <div className="gmail-trigger-editor" data-testid="gmail-trigger-editor">
      <div className="gmail-trigger-editor-heading"><strong>设置触发规则</strong><span>新邮件 → 条件 → 任务</span></div>
      <label>发件人包含<input aria-label="Gmail sender filter" maxLength={254} value={fromFilter} onChange={event => setFromFilter(event.target.value)} placeholder="alerts@example.com" /></label>
      <label>主题包含<input aria-label="Gmail subject filter" maxLength={160} value={subjectFilter} onChange={event => setSubjectFilter(event.target.value)} placeholder="订单更新" /></label>
      <label>触发条件<textarea aria-label="Gmail trigger condition" value={condition} onChange={event => setCondition(event.target.value)} maxLength={500} placeholder="例如：主题包含订单更新且发件人是商家" /></label>
      <label>Dot 要完成的任务<textarea aria-label="Gmail trigger instructions" value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={2000} placeholder="例如：用中文提取订单号、发货状态和预计送达时间" /></label>
      <label>云电脑 Agent 内核<select aria-label="Gmail cloud agent kernel" value={engine} onChange={event => setEngine(event.target.value as Engine)}>{engines.map(item => <option value={item} key={item}>{item === 'pi' ? 'Pi' : 'DeepSeek Harness'}</option>)}</select></label>
      {error && <p className="gmail-workflow-error" role="alert">{error}</p>}
      <button type="button" className="gmail-primary" data-testid="review-gmail-trigger" disabled={!canReview} onClick={() => { setError(''); setStage('review'); }}>复核触发器</button>
    </div>}

    {connected && stage === 'review' && <div className="gmail-trigger-review" data-testid="gmail-trigger-review">
      <div className="gmail-trigger-editor-heading"><strong>复核触发器</strong><span>创建前请检查这三项</span></div>
      <dl><div><dt>Trigger · 触发范围</dt><dd>新进入收件箱的邮件{fromFilter.trim() ? ` · 发件人包含 ${fromFilter.trim()}` : ''}{subjectFilter.trim() ? ` · 主题包含 ${subjectFilter.trim()}` : ''}</dd></div><div><dt>Condition · 判断条件</dt><dd>{condition.trim()}</dd></div><div><dt>Prompt · 任务指令</dt><dd>{prompt.trim()}</dd></div><div><dt>Agent · 运行位置</dt><dd>{engine === 'pi' ? 'Pi' : 'DeepSeek Harness'} · 当前账号的 Debian 云电脑</dd></div></dl>
      <p>邮件只读；Dot 不会发送或修改邮件。创建后可在 Scheduled 查看、暂停或删除。</p>
      {error && <p className="gmail-workflow-error" role="alert">{error}</p>}
      <div className="gmail-review-actions"><button type="button" onClick={() => { setError(''); setStage('edit'); }} disabled={busy}>返回修改</button><button type="button" className="gmail-primary" data-testid="create-gmail-trigger" disabled={busy} onClick={() => void createTrigger()}>{busy ? '正在创建…' : '确认并创建'}</button></div>
    </div>}

    {connected && stage === 'created' && <div className="gmail-trigger-created" data-testid="gmail-trigger-created" role="status"><span aria-hidden="true">✓</span><div><strong>邮件触发任务已创建</strong><p>Dot 会按设置检查新邮件。你可以在 Scheduled 管理这个任务。</p><div><button type="button" className="gmail-primary" onClick={onOpenScheduled}>查看 Scheduled</button><button type="button" onClick={resetDraft}>创建另一个</button></div></div></div>}
  </section>;
}
