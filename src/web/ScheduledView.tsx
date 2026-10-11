import { useEffect, useMemo, useState } from 'react';
import type { GmailEventTrigger, GmailSnapshot, Task, Watch } from '../shared/types.ts';
import { describeSchedule, scheduleForTask } from '../shared/scheduling.ts';
import { appFetch, appPath } from './api.ts';

type ScheduledItem =
  | { key: string; kind: 'task'; title: string; searchable: string; updatedAt: string; task: Task }
  | { key: string; kind: 'watch'; title: string; searchable: string; updatedAt: string; watch: Watch }
  | { key: string; kind: 'gmail-trigger'; title: string; searchable: string; updatedAt: string; trigger: GmailEventTrigger };

const statusText: Record<Task['status'], string> = {
  queued: 'Queued', working: 'Working', delegating: 'Parallel work', waiting: 'Needs you', scheduled: 'Monitoring', done: 'Complete', failed: 'Failed', paused: 'Paused', stopped: 'Stopped',
};

export function ScheduledView({ tasks, watches, gmail, eventTriggerEngines, onCancelTask, onWatchAction, onOpenTask, onNewTask, onAddWatch }: {
  tasks: Task[];
  watches: Watch[];
  gmail: GmailSnapshot;
  eventTriggerEngines: Extract<GmailEventTrigger['engine'], 'pi' | 'dsh'>[];
  onCancelTask: (task: Task) => void;
  onWatchAction: (watch: Watch, action: 'pause' | 'resume') => void;
  onOpenTask: (task: Task) => void;
  onNewTask: () => void;
  onAddWatch: (url: string, intervalMinutes: number) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showWatchForm, setShowWatchForm] = useState(false);
  const [watchUrl, setWatchUrl] = useState('');
  const [watchMinutes, setWatchMinutes] = useState(60);
  const [watchBusy, setWatchBusy] = useState(false);
  const [watchError, setWatchError] = useState('');
  const [showGmailForm, setShowGmailForm] = useState(false);
  const [gmailFromFilter, setGmailFromFilter] = useState('');
  const [gmailSubjectFilter, setGmailSubjectFilter] = useState('');
  const [gmailCondition, setGmailCondition] = useState('');
  const [gmailPrompt, setGmailPrompt] = useState('');
  const [gmailEngine, setGmailEngine] = useState<GmailEventTrigger['engine'] | ''>(eventTriggerEngines[0] || '');
  const [gmailBusy, setGmailBusy] = useState(false);
  const [gmailError, setGmailError] = useState('');

  const items = useMemo<ScheduledItem[]>(() => [
    ...tasks.filter(task => scheduleForTask(task.scheduleSpec, task.scheduleMinutes) !== null).map(task => ({
      key: `task:${task.id}`, kind: 'task' as const, title: task.title,
      searchable: `${task.title} ${task.instruction} ${statusText[task.status]} ${describeSchedule(scheduleForTask(task.scheduleSpec, task.scheduleMinutes)!)}`,
      updatedAt: task.updatedAt, task,
    })),
    ...watches.map(watch => ({
      key: `watch:${watch.id}`, kind: 'watch' as const, title: watch.url,
      searchable: `${watch.url} ${watch.lastStatus || ''} ${watch.status}`,
      updatedAt: watch.lastCheckedAt || '', watch,
    })),
    ...gmail.triggers.map(trigger => ({
      key: `gmail-trigger:${trigger.id}`, kind: 'gmail-trigger' as const,
      title: `邮件 · ${trigger.fromFilter || trigger.subjectFilter}`,
      searchable: `${trigger.fromFilter} ${trigger.subjectFilter} ${trigger.condition} ${trigger.prompt} ${trigger.status}`,
      updatedAt: trigger.updatedAt, trigger,
    })),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [tasks, watches, gmail.triggers]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized ? items.filter(item => item.searchable.toLocaleLowerCase().includes(normalized)) : items;
  }, [items, query]);
  const selected = filtered.find(item => item.key === selectedKey) || null;

  useEffect(() => {
    if (!selected || !filtered.some(item => item.key === selectedKey)) setSelectedKey(filtered[0]?.key || null);
  }, [filtered, selected, selectedKey]);

  async function submitWatch() {
    if (!watchUrl.trim() || watchBusy) return;
    setWatchBusy(true); setWatchError('');
    try {
      await onAddWatch(watchUrl, watchMinutes);
      setWatchUrl(''); setShowWatchForm(false);
    } catch (error) {
      setWatchError(error instanceof Error ? error.message : String(error));
    } finally { setWatchBusy(false); }
  }

  async function submitGmailTrigger() {
    if (gmailBusy || !gmailEngine || (!gmailFromFilter.trim() && !gmailSubjectFilter.trim())) return;
    setGmailBusy(true); setGmailError('');
    try {
      const response = await appFetch('/api/gmail/triggers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fromFilter: gmailFromFilter.trim(), subjectFilter: gmailSubjectFilter.trim(), condition: gmailCondition.trim(), prompt: gmailPrompt.trim(), engine: gmailEngine }) });
      const data = await response.json() as { trigger?: GmailEventTrigger; error?: string };
      if (!response.ok || !data.trigger) throw new Error(data.error || '无法创建邮件触发任务');
      setGmailFromFilter(''); setGmailSubjectFilter(''); setGmailCondition(''); setGmailPrompt(''); setShowGmailForm(false); setSelectedKey(`gmail-trigger:${data.trigger.id}`);
    } catch (error) { setGmailError(error instanceof Error ? error.message : String(error)); }
    finally { setGmailBusy(false); }
  }

  async function changeGmailTrigger(trigger: GmailEventTrigger, action: 'pause' | 'resume' | 'delete') {
    if (gmailBusy) return;
    setGmailBusy(true); setGmailError('');
    try {
      const response = await appFetch(`/api/gmail/triggers/${trigger.id}`, action === 'delete' ? { method: 'DELETE' } : { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || '无法更新邮件触发任务');
      if (action === 'delete') setSelectedKey(null);
    } catch (error) { setGmailError(error instanceof Error ? error.message : String(error)); }
    finally { setGmailBusy(false); }
  }

  async function disconnectGmail() {
    if (gmailBusy || !window.confirm('断开 Gmail 并删除此账号的邮件触发器？')) return;
    setGmailBusy(true); setGmailError('');
    try {
      const response = await appFetch('/api/gmail/connection', { method: 'DELETE' });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || '无法断开 Gmail');
      setShowGmailForm(false); setSelectedKey(null);
    } catch (error) { setGmailError(error instanceof Error ? error.message : String(error)); }
    finally { setGmailBusy(false); }
  }

  return <section className="scheduled-hub" aria-label="Scheduled workspace" data-testid="scheduled-hub">
    <aside className="scheduled-list-pane">
      <div className="scheduled-heading"><h1>Scheduled</h1><span aria-hidden="true">☷</span></div>
      <label className="scheduled-search"><span aria-hidden="true">⌕</span><input aria-label="Search scheduled tasks" placeholder="Search scheduled tasks" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <button className="scheduled-new-task" data-testid="scheduled-new-task" onClick={onNewTask}><span aria-hidden="true">＋</span>New task</button>
      <div className="scheduled-group"><span>Personal</span><span aria-hidden="true">›</span></div>
      <div className="scheduled-dot"><span className="scheduled-dot-mark" aria-hidden="true">●</span>Your dot <span aria-hidden="true">⌄</span></div>
      <div className="scheduled-items" aria-label="Scheduled tasks">
        {filtered.map(item => {
          const status = item.kind === 'task' ? statusText[item.task.status] : item.kind === 'watch' ? item.watch.status === 'active' ? 'Monitoring' : item.watch.status === 'paused' ? 'Paused' : 'Failed' : item.trigger.status === 'active' ? '监控中' : '已暂停';
          return <button key={item.key} className={`scheduled-item ${selectedKey === item.key ? 'selected' : ''}`} aria-pressed={selectedKey === item.key} onClick={() => setSelectedKey(item.key)}>
            <span className="scheduled-item-copy"><strong>{item.title}</strong><small>{status}</small></span>
            <span className="scheduled-item-menu" aria-hidden="true">···</span>
          </button>;
        })}
        {filtered.length === 0 && <p className="scheduled-no-results">{items.length ? 'No matching tasks' : 'No scheduled tasks yet'}</p>}
      </div>
      <div className="scheduled-suggestions" aria-label="Suggested schedules">
        <h2>Suggested</h2>
        <div className="scheduled-suggestion"><strong>Email monitor</strong><span>Scan my emails and let me know anything that needs my attention</span></div>
        <div className="scheduled-suggestion"><strong>AI tools industry pulse</strong><span>Give me a concise weekly briefing on AI changes that matter for my YouTube coverage</span></div>
      </div>
      <button className="scheduled-add-watch" onClick={() => setShowWatchForm(value => !value)} aria-expanded={showWatchForm}>＋ Monitor a page</button>
      <section className="gmail-mailbox" data-testid="gmail-mailbox">
        <div className="gmail-mailbox-heading"><strong>Gmail 事件</strong><span aria-hidden="true">✉</span></div>
        {gmail.connection ? <>
          <p className="gmail-mailbox-account">{gmail.connection.email} · {gmail.connection.status === 'connected' ? '已连接' : '需要重新连接'}</p>
          {gmail.connection.error && <p className="scheduled-watch-error" role="alert">{gmail.connection.error}</p>}
          {gmail.connection.lastSyncedAt && <small>上次检查 {new Date(gmail.connection.lastSyncedAt).toLocaleString()}</small>}
          <div className="gmail-mailbox-actions"><button type="button" onClick={() => { window.location.assign(appPath('/api/gmail/oauth/start')); }} disabled={!gmail.configured}>重新授权</button><button type="button" onClick={() => void disconnectGmail()} disabled={gmailBusy}>断开</button></div>
          <p className="gmail-poll-note">每 {gmail.pollIntervalSeconds} 秒检查一次收件箱中的新邮件。此邮箱及其触发任务仅对你的账号可见。</p>
          {gmail.connection.status === 'connected' && <button className="scheduled-add-watch" data-testid="add-gmail-trigger" onClick={() => { setShowGmailForm(value => !value); setShowWatchForm(false); setGmailError(''); }} aria-expanded={showGmailForm}>＋ 新建邮件触发任务</button>}
        </> : <>
          <p className="gmail-poll-note">连接 Gmail 后，可按发件人和主题条件触发只读任务。需要单独授权 Gmail 只读访问。</p>
          <button type="button" className="scheduled-add-watch" data-testid="connect-gmail" onClick={() => { window.location.assign(appPath('/api/gmail/oauth/start')); }} disabled={!gmail.configured}>{gmail.configured ? '＋ 连接 Gmail' : 'Google 登录未配置'}</button>
        </>}
        {gmail.connection?.status === 'connected' && eventTriggerEngines.length === 0 && <p className="scheduled-trigger-note">请先在 Debian 云电脑配置 Pi 或 DeepSeek Harness。</p>}
      </section>
    </aside>

    <div className="scheduled-detail-pane">
      {showWatchForm && <form className="scheduled-watch-form" onSubmit={event => { event.preventDefault(); void submitWatch(); }}>
        <div className="scheduled-watch-form-heading"><strong>Monitor a page</strong><button type="button" aria-label="Close monitor form" onClick={() => { setShowWatchForm(false); setWatchError(''); }}>×</button></div>
        <label>HTTPS URL<input aria-label="HTTPS URL" type="url" placeholder="https://example.com/page" value={watchUrl} onChange={event => setWatchUrl(event.target.value)} required /></label>
        <label>Check every (minutes)<input aria-label="Check interval in minutes" type="number" min="5" max="10080" value={watchMinutes} onChange={event => setWatchMinutes(Number(event.target.value))} required /></label>
        {watchError && <p className="scheduled-watch-error" role="alert">{watchError}</p>}
        <button className="scheduled-primary" type="submit" disabled={watchBusy || !watchUrl.trim()}>{watchBusy ? 'Adding…' : 'Add monitor'}</button>
      </form>}
      {showGmailForm && <form className="scheduled-watch-form gmail-trigger-form" data-testid="gmail-trigger-form" onSubmit={event => { event.preventDefault(); void submitGmailTrigger(); }}>
        <div className="scheduled-watch-form-heading"><strong>新邮件触发任务</strong><button type="button" aria-label="关闭 Gmail 触发器表单" onClick={() => { setShowGmailForm(false); setGmailError(''); }}>×</button></div>
        <p className="scheduled-trigger-note">仅监控新进入收件箱且匹配筛选条件的邮件。邮件内容视为不可信输入；任务只分析匹配摘要，不会发送、归档或修改邮件。</p>
        <label>发件人包含<input aria-label="Gmail sender filter" maxLength={254} value={gmailFromFilter} onChange={event => setGmailFromFilter(event.target.value)} placeholder="alerts@example.com" /></label>
        <label>主题包含<input aria-label="Gmail subject filter" maxLength={160} value={gmailSubjectFilter} onChange={event => setGmailSubjectFilter(event.target.value)} placeholder="订单更新" /></label>
        <label>触发条件<textarea aria-label="Gmail trigger condition" value={gmailCondition} onChange={event => setGmailCondition(event.target.value)} maxLength={500} placeholder="例如：主题包含订单更新且发件人是商家" required /></label>
        <label>任务指令<textarea aria-label="Gmail trigger instructions" value={gmailPrompt} onChange={event => setGmailPrompt(event.target.value)} maxLength={2000} placeholder="例如：用中文提取订单号、发货状态和预计送达时间" required /></label>
        <label>云电脑 Agent 内核<select aria-label="Gmail cloud agent kernel" value={gmailEngine} onChange={event => setGmailEngine(event.target.value as GmailEventTrigger['engine'])} required>{eventTriggerEngines.map(engine => <option value={engine} key={engine}>{engine === 'pi' ? 'Pi' : 'DeepSeek Harness'}</option>)}</select></label>
        {gmailError && <p className="scheduled-watch-error" role="alert">{gmailError}</p>}
        <button className="scheduled-primary" type="submit" data-testid="create-gmail-trigger" disabled={gmailBusy || !gmailEngine || eventTriggerEngines.length === 0 || (!gmailFromFilter.trim() && !gmailSubjectFilter.trim()) || gmailCondition.trim().length < 3 || gmailPrompt.trim().length < 3}>{gmailBusy ? '正在创建…' : '创建邮件触发任务'}</button>
      </form>}
      {selected?.kind === 'task' && <article className="scheduled-detail" data-testid="scheduled-detail" data-item-id={selected.task.id}>
        <div className="scheduled-detail-top"><span className="scheduled-detail-label">Your dot</span><span className={`scheduled-status ${selected.task.status}`}>{statusText[selected.task.status]}</span></div>
        <h2>{selected.task.title}</h2>
        <p className="scheduled-instruction">{selected.task.instruction}</p>
        <div className="scheduled-detail-meta"><span>{describeSchedule(scheduleForTask(selected.task.scheduleSpec, selected.task.scheduleMinutes)!)}</span><span>Next run: {['failed', 'paused', 'waiting'].includes(selected.task.status) ? 'Not scheduled' : selected.task.nextRunAt ? new Date(selected.task.nextRunAt).toLocaleString() : 'Not scheduled'}</span></div>
        {selected.task.error && <p className="scheduled-detail-error" role="alert">{selected.task.error}</p>}
        {selected.task.result && <div className="scheduled-result"><span>Latest result</span><p>{selected.task.result}</p></div>}
        <div className="scheduled-detail-actions">
          <button onClick={() => onOpenTask(selected.task)}>Open conversation</button>
          {selected.task.status === 'paused'
            ? <button className="scheduled-primary" onClick={() => onCancelTask(selected.task)}>Remove schedule</button>
            : <button className="scheduled-danger" onClick={() => onCancelTask(selected.task)}>Cancel schedule</button>}
        </div>
      </article>}
      {selected?.kind === 'watch' && <article className="scheduled-detail" data-testid="scheduled-detail" data-item-id={selected.watch.id}>
        <div className="scheduled-detail-top"><span className="scheduled-detail-label">Your dot</span><span className={`scheduled-status ${selected.watch.status}`}>{selected.watch.status === 'active' ? 'Monitoring' : selected.watch.status === 'paused' ? 'Paused' : 'Failed'}</span></div>
        <h2>{selected.watch.url}</h2>
        <p className="scheduled-instruction">Check this page for changes and let you know when its content changes.</p>
        <div className="scheduled-detail-meta"><span>Every {selected.watch.intervalMinutes} minutes</span><span>Last checked: {selected.watch.lastCheckedAt ? new Date(selected.watch.lastCheckedAt).toLocaleString() : 'Not checked yet'}</span></div>
        {selected.watch.error && <p className="scheduled-detail-error" role="alert">{selected.watch.error}</p>}
        <div className="scheduled-detail-actions"><button className="scheduled-primary" onClick={() => onWatchAction(selected.watch, selected.watch.status === 'active' ? 'pause' : 'resume')}>{selected.watch.status === 'active' ? 'Pause monitor' : 'Resume monitor'}</button></div>
      </article>}
      {selected?.kind === 'gmail-trigger' && <article className="scheduled-detail" data-testid="gmail-trigger-detail" data-item-id={selected.trigger.id}>
        <div className="scheduled-detail-top"><span className="scheduled-detail-label">你的 Dot · 仅此账号</span><span className={`scheduled-status ${selected.trigger.status}`}>{selected.trigger.status === 'active' ? '监控中' : '已暂停'}</span></div>
        <h2>新邮件触发任务</h2>
        <p className="scheduled-instruction">新邮件同时满足已填写的发件人和主题筛选时，Dot 会评估条件，并在云电脑中运行只读任务。</p>
        <div className="scheduled-detail-meta"><span>发件人：{selected.trigger.fromFilter || '不限'}</span><span>主题：{selected.trigger.subjectFilter || '不限'}</span><span>内核：{selected.trigger.engine === 'pi' ? 'Pi' : 'DeepSeek Harness'}</span><span>检查间隔：{gmail.pollIntervalSeconds} 秒</span><span>上次触发：{selected.trigger.lastEventAt ? new Date(selected.trigger.lastEventAt).toLocaleString() : '暂无'}</span></div>
        <section className="github-trigger-summary"><h3>触发条件</h3><p>{selected.trigger.condition}</p><h3>任务指令</h3><p>{selected.trigger.prompt}</p></section>
        <p className="scheduled-trigger-warning">邮箱、邮件摘要和任务仅对当前用户可见。此触发器只分析邮件，不会发送或修改邮件。</p>
        <div className="scheduled-detail-actions">
          {selected.trigger.lastTaskId && tasks.some(task => task.id === selected.trigger.lastTaskId) && <button onClick={() => { const task = tasks.find(item => item.id === selected.trigger.lastTaskId); if (task) onOpenTask(task); }}>打开最近任务</button>}
          <button className="scheduled-primary" disabled={gmailBusy} onClick={() => void changeGmailTrigger(selected.trigger, selected.trigger.status === 'active' ? 'pause' : 'resume')}>{selected.trigger.status === 'active' ? '暂停触发器' : '恢复触发器'}</button>
          <button className="scheduled-danger" disabled={gmailBusy} onClick={() => void changeGmailTrigger(selected.trigger, 'delete')}>删除触发器</button>
        </div>
        {gmailError && <p className="scheduled-watch-error" role="alert">{gmailError}</p>}
      </article>}
      {!selected && <div className="scheduled-empty-detail"><div className="scheduled-empty-icon" aria-hidden="true">◷</div><h2>{items.length ? 'No matching tasks' : 'No scheduled tasks yet'}</h2><p>{items.length ? 'Try a different search.' : 'Create a recurring task or monitor a page to see it here.'}</p><button className="scheduled-primary" onClick={onNewTask}>＋ New task</button></div>}
    </div>
  </section>;
}
