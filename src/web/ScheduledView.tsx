import { useEffect, useMemo, useRef, useState } from 'react';
import { githubPullRequestActions, type GitHubPullRequestAction, type GitHubPullRequestTrigger, type ScheduledTaskRun, type Task, type Watch } from '../shared/types.ts';
import { describeSchedule, scheduleForTask } from '../shared/scheduling.ts';
import { appFetch, appPath } from './api.ts';

type ScheduledItem =
  | { key: string; kind: 'task'; title: string; searchable: string; updatedAt: string; task: Task }
  | { key: string; kind: 'watch'; title: string; searchable: string; updatedAt: string; watch: Watch }
  | { key: string; kind: 'github-trigger'; title: string; searchable: string; updatedAt: string; trigger: GitHubPullRequestTrigger };

const statusText: Record<Task['status'], string> = {
  queued: 'Queued', working: 'Working', delegating: 'Parallel work', waiting: 'Needs you', scheduled: 'Monitoring', done: 'Complete', failed: 'Failed', paused: 'Paused', stopped: 'Stopped',
};

function taskStatusText(task: Task) {
  return task.status === 'scheduled' && scheduleForTask(task.scheduleSpec, task.scheduleMinutes) === null
    ? 'Scheduled'
    : statusText[task.status];
}

export function ScheduledView({ tasks, watches, githubTriggers, eventTriggerEngines, canManageGitHubTriggers, onCancelTask, onWatchAction, onOpenTask, onLoadTaskRuns, onMarkTaskRunsRead, onNewTask, onAddWatch }: {
  tasks: Task[];
  watches: Watch[];
  githubTriggers: GitHubPullRequestTrigger[];
  eventTriggerEngines: Extract<GitHubPullRequestTrigger['engine'], 'pi' | 'dsh'>[];
  canManageGitHubTriggers: boolean;
  onCancelTask: (task: Task) => void;
  onWatchAction: (watch: Watch, action: 'pause' | 'resume') => void;
  onOpenTask: (task: Task) => void | Promise<void>;
  onLoadTaskRuns: (taskId: string) => Promise<ScheduledTaskRun[]>;
  onMarkTaskRunsRead: (taskId: string) => Promise<number>;
  onNewTask: () => void;
  onAddWatch: (url: string, intervalMinutes: number) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showWatchForm, setShowWatchForm] = useState(false);
  const [showGitHubForm, setShowGitHubForm] = useState(false);
  const [repository, setRepository] = useState('');
  const [githubActions, setGitHubActions] = useState<GitHubPullRequestAction[]>(['opened', 'synchronize', 'reopened']);
  const [triggerCondition, setTriggerCondition] = useState('');
  const [triggerPrompt, setTriggerPrompt] = useState('');
  const [triggerEngine, setTriggerEngine] = useState<GitHubPullRequestTrigger['engine'] | ''>(eventTriggerEngines[0] || '');
  const [githubBusy, setGitHubBusy] = useState(false);
  const [githubError, setGitHubError] = useState('');
  const [createdWebhook, setCreatedWebhook] = useState<{ trigger: GitHubPullRequestTrigger; secret: string } | null>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const [watchUrl, setWatchUrl] = useState('');
  const [watchMinutes, setWatchMinutes] = useState(60);
  const [watchBusy, setWatchBusy] = useState(false);
  const [watchError, setWatchError] = useState('');
  const [taskOpenBusy, setTaskOpenBusy] = useState(false);
  const [taskOpenError, setTaskOpenError] = useState(false);
  const [itemPreview, setItemPreview] = useState<{ key: string; top: number; left: number } | null>(null);
  const [taskRuns, setTaskRuns] = useState<ScheduledTaskRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState('');
  const explicitTaskSelection = useRef(false);

  const items = useMemo<ScheduledItem[]>(() => [
    ...tasks.filter(task => scheduleForTask(task.scheduleSpec, task.scheduleMinutes) !== null || task.status === 'scheduled').map(task => ({
      key: `task:${task.id}`, kind: 'task' as const, title: task.title,
      searchable: `${task.title} ${task.instruction} ${taskStatusText(task)} ${scheduleForTask(task.scheduleSpec, task.scheduleMinutes) ? describeSchedule(scheduleForTask(task.scheduleSpec, task.scheduleMinutes)!) : 'One-time follow-up'}`,
      updatedAt: task.updatedAt, task,
    })),
    ...watches.map(watch => ({
      key: `watch:${watch.id}`, kind: 'watch' as const, title: watch.url,
      searchable: `${watch.url} ${watch.lastStatus || ''} ${watch.status}`,
      updatedAt: watch.lastCheckedAt || '', watch,
    })),
    ...githubTriggers.map(trigger => ({
      key: `github-trigger:${trigger.id}`, kind: 'github-trigger' as const, title: `${trigger.repository} · Pull requests`,
      searchable: `${trigger.repository} ${trigger.condition} ${trigger.prompt} ${trigger.status} GitHub pull request`,
      updatedAt: trigger.updatedAt, trigger,
    })),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [tasks, watches, githubTriggers]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized ? items.filter(item => item.searchable.toLocaleLowerCase().includes(normalized)) : items;
  }, [items, query]);
  const selected = filtered.find(item => item.key === selectedKey) || null;
  const selectedTaskUpdatedAt = selected?.kind === 'task' ? selected.task.updatedAt : '';
  const selectedWatchReview = selected?.kind === 'watch' && selected.watch.lastTaskId
    ? tasks.find(task => task.id === selected.watch.lastTaskId) || null
    : null;
  const hasPendingDelivery = taskRuns.some(run => run.deliveryStatus === 'pending');

  useEffect(() => {
    if (!selected || !filtered.some(item => item.key === selectedKey)) setSelectedKey(filtered[0]?.key || null);
  }, [filtered, selected, selectedKey]);

  useEffect(() => {
    if (!triggerEngine || !eventTriggerEngines.includes(triggerEngine)) setTriggerEngine(eventTriggerEngines[0] || '');
  }, [eventTriggerEngines, triggerEngine]);

  useEffect(() => {
    if (explicitTaskSelection.current) {
      explicitTaskSelection.current = false;
      return;
    }
    if (selected?.kind !== 'task') {
      setTaskRuns([]);
      setRunsError('');
      setRunsLoading(false);
      return;
    }
    let cancelled = false;
    setTaskRuns([]);
    setRunsLoading(true);
    setRunsError('');
    void onLoadTaskRuns(selected.task.id).then(runs => {
      if (!cancelled) setTaskRuns(runs);
    }).catch(error => {
      if (!cancelled) setRunsError(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (!cancelled) setRunsLoading(false);
    });
    return () => { cancelled = true; };
  // Scheduled history refreshes with task state; only an explicit row click marks it read.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, selectedTaskUpdatedAt]);

  useEffect(() => {
    if (selected?.kind !== 'task' || !hasPendingDelivery) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void onLoadTaskRuns(selected.task.id).then(runs => { if (!cancelled) setTaskRuns(runs); }).catch(() => undefined);
    }, 5_000);
    return () => { cancelled = true; clearInterval(timer); };
  // Poll only while the selected task has a durable result delivery awaiting completion.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, hasPendingDelivery]);

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

  function toggleGitHubAction(action: GitHubPullRequestAction) {
    setGitHubActions(current => current.includes(action) ? current.filter(item => item !== action) : [...current, action]);
  }

  async function submitGitHubTrigger() {
    if (!canManageGitHubTriggers || githubBusy || !triggerEngine || !repository.trim() || githubActions.length === 0) return;
    setGitHubBusy(true); setGitHubError(''); setCopyStatus('');
    try {
      const response = await appFetch('/api/github-triggers', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repository: repository.trim(), actions: githubActions, condition: triggerCondition.trim(), prompt: triggerPrompt.trim(), engine: triggerEngine }),
      });
      const data = await response.json() as { trigger?: GitHubPullRequestTrigger; secret?: string; error?: string };
      if (!response.ok || !data.trigger || !data.secret) throw new Error(data.error || 'Unable to create GitHub event task');
      setCreatedWebhook({ trigger: data.trigger, secret: data.secret });
      setRepository(''); setTriggerCondition(''); setTriggerPrompt('');
      setShowGitHubForm(false);
      setSelectedKey(`github-trigger:${data.trigger.id}`);
    } catch (error) {
      setGitHubError(error instanceof Error ? error.message : String(error));
    } finally { setGitHubBusy(false); }
  }

  async function changeGitHubTrigger(trigger: GitHubPullRequestTrigger, action: 'pause' | 'resume' | 'delete') {
    if (!canManageGitHubTriggers || githubBusy) return;
    setGitHubBusy(true); setGitHubError('');
    try {
      const response = await appFetch(`/api/github-triggers/${trigger.id}`, action === 'delete'
        ? { method: 'DELETE' }
        : { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || 'Unable to update GitHub event task');
      if (action === 'delete') {
        setSelectedKey(null);
        setCreatedWebhook(current => current?.trigger.id === trigger.id ? null : current);
      }
    } catch (error) {
      setGitHubError(error instanceof Error ? error.message : String(error));
    } finally { setGitHubBusy(false); }
  }

  async function copyValue(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(`${label} copied`);
    } catch { setCopyStatus('Select the value and copy it manually.'); }
  }

  function githubWebhookUrl(trigger: GitHubPullRequestTrigger) {
    return new URL(appPath(`/github/events/${trigger.id}`), window.location.origin).toString();
  }

  async function openTask(task: Task) {
    if (taskOpenBusy) return;
    setShowWatchForm(false);
    setTaskOpenBusy(true);
    setTaskOpenError(false);
    try {
      await onOpenTask(task);
    } catch {
      setTaskOpenError(true);
    } finally {
      setTaskOpenBusy(false);
    }
  }

  async function reviewRunsAgain(taskId: string) {
    setTaskRuns([]);
    setRunsLoading(true);
    setRunsError('');
    try {
      const runs = await onLoadTaskRuns(taskId);
      setTaskRuns(runs);
      const markedRead = await onMarkTaskRunsRead(taskId);
      if (markedRead > 0) {
        const readAt = new Date().toISOString();
        setTaskRuns(current => current.map(run => run.needsAttention && !run.readAt ? { ...run, readAt } : run));
      }
    }
    catch (error) { setRunsError(error instanceof Error ? error.message : String(error)); }
    finally { setRunsLoading(false); }
  }

  function showItemPreview(target: HTMLButtonElement, item: ScheduledItem) {
    const row = target.getBoundingClientRect();
    const list = target.closest('.scheduled-list-pane')?.getBoundingClientRect();
    if (!list) return;
    setItemPreview({ key: item.key, top: Math.round(row.top), left: Math.round(list.right + 2) });
  }

  function clearItemPreview(key: string) {
    setItemPreview(current => current?.key === key ? null : current);
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
          const status = item.kind === 'task' ? taskStatusText(item.task)
            : item.kind === 'watch' ? item.watch.status === 'active' ? 'Monitoring' : item.watch.status === 'paused' ? 'Paused' : 'Failed'
              : item.trigger.status === 'active' ? 'Monitoring' : 'Paused';
          const unreadRuns = item.kind === 'task' ? item.task.unreadScheduledRunCount || 0 : 0;
          return <button key={item.key} className={`scheduled-item ${selectedKey === item.key ? 'selected' : ''}`} aria-pressed={selectedKey === item.key} onMouseEnter={event => showItemPreview(event.currentTarget, item)} onMouseLeave={() => clearItemPreview(item.key)} onFocus={event => showItemPreview(event.currentTarget, item)} onBlur={() => clearItemPreview(item.key)} onClick={() => { setTaskOpenError(false); if (item.kind === 'task') { if (selectedKey !== item.key) explicitTaskSelection.current = true; setSelectedKey(item.key); void reviewRunsAgain(item.task.id); } else { setShowGitHubForm(false); setSelectedKey(item.key); } }}>
            <span className="scheduled-item-copy"><strong>{item.title}</strong><small>{status}</small></span>
            {unreadRuns > 0 && item.kind === 'task' && <span className="scheduled-item-unread" data-testid={`scheduled-unread-task-${item.task.id}`} aria-label={`${unreadRuns} unread scheduled run${unreadRuns === 1 ? '' : 's'}`} title={`${unreadRuns} unread run${unreadRuns === 1 ? '' : 's'}`} />}
            <span className="scheduled-item-menu" aria-hidden="true">···</span>
            {itemPreview?.key === item.key && <span className="scheduled-hover-preview" data-testid="scheduled-item-preview" aria-hidden="true" style={{ top: itemPreview.top, left: itemPreview.left }}>
              <strong>{item.title}</strong>
              <small><span className="scheduled-preview-clock" aria-hidden="true">◷</span>{status}</small>
            </span>}
          </button>;
        })}
        {filtered.length === 0 && <p className="scheduled-no-results">{items.length ? 'No matching tasks' : 'No scheduled tasks yet'}</p>}
      </div>
      <div className="scheduled-suggestions" aria-label="Suggested schedules">
        <h2>Suggested</h2>
        <div className="scheduled-suggestion"><strong>Email monitor</strong><span>Scan my emails and let me know anything that needs my attention</span></div>
        <div className="scheduled-suggestion"><strong>AI tools industry pulse</strong><span>Give me a concise weekly briefing on AI changes that matter for my YouTube coverage</span></div>
      </div>
      <button className="scheduled-add-watch" onClick={() => { setShowWatchForm(value => !value); setShowGitHubForm(false); }} aria-expanded={showWatchForm}>＋ Monitor a page</button>
      {canManageGitHubTriggers && <button className="scheduled-add-watch" data-testid="add-github-trigger" onClick={() => { setShowGitHubForm(value => !value); setShowWatchForm(false); setGitHubError(''); setCreatedWebhook(null); }} aria-expanded={showGitHubForm}>＋ GitHub pull request trigger</button>}
      {canManageGitHubTriggers && eventTriggerEngines.length === 0 && <p className="scheduled-trigger-note">Configure Pi or DeepSeek Harness in the Debian cloud computer to add GitHub event tasks.</p>}
    </aside>

    <div className="scheduled-detail-pane">
      {taskOpenError && <div className="scheduled-chat-open-error" role="alert" data-testid="scheduled-chat-open-error">
        <p>Couldn't open this chat. Try again.</p>
        {selected?.kind === 'task' && <button type="button" onClick={() => void openTask(selected.task)} disabled={taskOpenBusy}>Try again</button>}
        {selectedWatchReview && <button type="button" onClick={() => void openTask(selectedWatchReview)} disabled={taskOpenBusy}>Try again</button>}
      </div>}
      {showGitHubForm && <form className="scheduled-watch-form github-trigger-form" data-testid="github-trigger-form" onSubmit={event => { event.preventDefault(); void submitGitHubTrigger(); }}>
        <div className="scheduled-watch-form-heading"><strong>GitHub Pull Request trigger</strong><button type="button" aria-label="Close GitHub trigger form" onClick={() => { setShowGitHubForm(false); setGitHubError(''); }}>×</button></div>
        <p className="scheduled-trigger-note">Create a repository webhook using the URL and one-time secret shown after saving. Event runs use read-only Pi or DeepSeek Harness in the tenant’s Debian cloud computer.</p>
        <label>Repository<input aria-label="GitHub repository" value={repository} onChange={event => setRepository(event.target.value)} placeholder="owner/repo" autoComplete="off" required /></label>
        <fieldset className="github-trigger-actions"><legend>Pull request events</legend>{githubPullRequestActions.map(action => <label key={action}><input type="checkbox" checked={githubActions.includes(action)} onChange={() => toggleGitHubAction(action)} />{action}</label>)}</fieldset>
        <label>Condition<textarea aria-label="GitHub trigger condition" value={triggerCondition} onChange={event => setTriggerCondition(event.target.value)} maxLength={500} placeholder="For example: the change affects the release process" required /></label>
        <label>Task instructions<textarea aria-label="GitHub trigger instructions" value={triggerPrompt} onChange={event => setTriggerPrompt(event.target.value)} maxLength={2000} placeholder="For example: summarize the change and flag any release decision I need to make" required /></label>
        <label>Cloud agent kernel<select aria-label="Cloud agent kernel" value={triggerEngine} onChange={event => setTriggerEngine(event.target.value as GitHubPullRequestTrigger['engine'])} required>{eventTriggerEngines.map(engine => <option value={engine} key={engine}>{engine === 'pi' ? 'Pi' : 'DeepSeek Harness'}</option>)}</select></label>
        {githubError && <p className="scheduled-watch-error" role="alert">{githubError}</p>}
        <button className="scheduled-primary" type="submit" disabled={githubBusy || !triggerEngine || eventTriggerEngines.length === 0 || !repository.trim() || githubActions.length === 0 || triggerCondition.trim().length < 3 || triggerPrompt.trim().length < 3}>{githubBusy ? 'Creating…' : 'Create trigger'}</button>
      </form>}
      {createdWebhook && <section className="scheduled-detail github-webhook-created" data-testid="github-webhook-created" aria-label="GitHub webhook setup">
        <div className="scheduled-detail-top"><span className="scheduled-detail-label">Webhook setup</span><span className="scheduled-status active">Secret shown once</span><button type="button" aria-label="Close webhook setup" onClick={() => setCreatedWebhook(null)}>×</button></div>
        <h2>Connect {createdWebhook.trigger.repository}</h2>
        <p className="scheduled-instruction">In the repository’s Settings → Webhooks, add a webhook with content type application/json, paste this URL and secret, then subscribe to Pull requests.</p>
        <label>Payload URL<div className="github-webhook-value"><input aria-label="GitHub webhook URL" readOnly value={githubWebhookUrl(createdWebhook.trigger)} /><button type="button" onClick={() => void copyValue(githubWebhookUrl(createdWebhook.trigger), 'URL')}>Copy</button></div></label>
        <label>Webhook secret<div className="github-webhook-value"><input aria-label="GitHub webhook secret" readOnly value={createdWebhook.secret} /><button type="button" onClick={() => void copyValue(createdWebhook.secret, 'Secret')}>Copy</button></div></label>
        {copyStatus && <p role="status" className="scheduled-trigger-note">{copyStatus}</p>}
        <p className="scheduled-trigger-warning">The secret is stored in the Mac Keychain and will not appear again. If you lose it, delete this trigger and create a replacement. Webhook events provide PR metadata only; Coke Dots does not fetch private code or publish comments.</p>
      </section>}
      {showWatchForm && <form className="scheduled-watch-form" onSubmit={event => { event.preventDefault(); void submitWatch(); }}>
        <div className="scheduled-watch-form-heading"><strong>Monitor a page</strong><button type="button" aria-label="Close monitor form" onClick={() => { setShowWatchForm(false); setWatchError(''); }}>×</button></div>
        <label>HTTPS URL<input aria-label="HTTPS URL" type="url" placeholder="https://example.com/page" value={watchUrl} onChange={event => setWatchUrl(event.target.value)} required /></label>
        <label>Check every (minutes)<input aria-label="Check interval in minutes" type="number" min="5" max="10080" value={watchMinutes} onChange={event => setWatchMinutes(Number(event.target.value))} required /></label>
        {watchError && <p className="scheduled-watch-error" role="alert">{watchError}</p>}
        <button className="scheduled-primary" type="submit" disabled={watchBusy || !watchUrl.trim()}>{watchBusy ? 'Adding…' : 'Add monitor'}</button>
      </form>}
      {!taskOpenError && selected?.kind === 'task' && <article className="scheduled-detail" data-testid="scheduled-detail" data-item-id={selected.task.id}>
        <div className="scheduled-detail-top"><span className="scheduled-detail-label">Your dot</span><span className={`scheduled-status ${selected.task.status}`}>{taskStatusText(selected.task)}</span></div>
        <h2>{selected.task.title}</h2>
        <p className="scheduled-instruction">{selected.task.instruction}</p>
        <div className="scheduled-detail-meta"><span>{scheduleForTask(selected.task.scheduleSpec, selected.task.scheduleMinutes) ? describeSchedule(scheduleForTask(selected.task.scheduleSpec, selected.task.scheduleMinutes)!) : 'One-time follow-up'}</span><span>Next run: {['failed', 'paused', 'waiting'].includes(selected.task.status) ? 'Not scheduled' : selected.task.nextRunAt ? new Date(selected.task.nextRunAt).toLocaleString() : 'Not scheduled'}</span></div>
        {scheduleForTask(selected.task.scheduleSpec, selected.task.scheduleMinutes) && <p className="scheduled-delivery-summary" data-testid="scheduled-delivery-summary">
          Results: {selected.task.deliveryDestination.type === 'slack' ? `Slack DM · ${selected.task.deliveryDestination.teamName}` : 'Dots conversation'}
          {' · '}{selected.task.notificationPolicy === 'every-run' ? 'Every run' : 'Only when attention is needed'}
        </p>}
        {selected.task.error && <p className="scheduled-detail-error" role="alert">{selected.task.error}</p>}
        {selected.task.result && <div className="scheduled-result"><span>Latest result</span><p>{selected.task.result}</p></div>}
        {(runsLoading || runsError || taskRuns.length > 0) && <section className="scheduled-run-history" aria-label="Recent scheduled runs" data-testid="scheduled-run-history">
          <div className="scheduled-run-history-heading"><h3>Recent runs</h3>{taskRuns.some(run => run.needsAttention && !run.readAt) && <span>Needs review</span>}</div>
          {runsLoading && <p className="scheduled-runs-empty" role="status">Loading recent runs…</p>}
          {runsError && <p className="scheduled-runs-error" role="alert">{runsError}</p>}
          {!runsLoading && !runsError && taskRuns.length === 0 && <p className="scheduled-runs-empty">No runs yet</p>}
          {!runsLoading && taskRuns.length > 0 && <ol className="scheduled-run-list">{taskRuns.map(run => <li key={run.id} className={`scheduled-run ${run.needsAttention && !run.readAt ? 'unread' : ''}`}>
            <div><strong>{run.status === 'waiting' ? 'Needs you' : run.status === 'failed' ? 'Failed' : 'Complete'}</strong><time dateTime={run.finishedAt}>{new Date(run.finishedAt).toLocaleString()}</time></div>
            {(run.error || run.result) && <p>{run.error || run.result}</p>}
            {run.deliveryStatus && <small className={`scheduled-run-delivery ${run.deliveryStatus}`} data-testid={`scheduled-run-delivery-${run.id}`}>
              Slack delivery: {run.deliveryStatus === 'sent' ? 'Sent' : run.deliveryStatus === 'pending' ? 'Sending' : 'Failed'}{run.deliveryError ? ` · ${run.deliveryError}` : ''}
            </small>}
          </li>)}</ol>}
        </section>}
        <div className="scheduled-detail-actions">
          <button onClick={() => void openTask(selected.task)} disabled={taskOpenBusy}>Open conversation</button>
          {selected.task.status === 'paused'
            ? <button className="scheduled-primary" onClick={() => onCancelTask(selected.task)}>Remove schedule</button>
            : <button className="scheduled-danger" onClick={() => onCancelTask(selected.task)}>Cancel schedule</button>}
        </div>
      </article>}
      {!taskOpenError && selected?.kind === 'watch' && <article className="scheduled-detail" data-testid="scheduled-detail" data-item-id={selected.watch.id}>
        <div className="scheduled-detail-top"><span className="scheduled-detail-label">Your dot</span><span className={`scheduled-status ${selected.watch.status}`}>{selected.watch.status === 'active' ? 'Monitoring' : selected.watch.status === 'paused' ? 'Paused' : 'Failed'}</span></div>
        <h2>{selected.watch.url}</h2>
        <p className="scheduled-instruction">Check this page for changes and let you know when its content changes.</p>
        <div className="scheduled-detail-meta"><span>Every {selected.watch.intervalMinutes} minutes</span><span>Last checked: {selected.watch.lastCheckedAt ? new Date(selected.watch.lastCheckedAt).toLocaleString() : 'Not checked yet'}</span></div>
        <p className="scheduled-watch-last-status" role="status" data-testid="scheduled-watch-status">{selected.watch.lastStatus || 'Waiting for the first check'}</p>
        {selected.watch.error && <p className="scheduled-detail-error" role="alert">{selected.watch.error}</p>}
        <div className="scheduled-detail-actions">
          {selectedWatchReview && <button data-testid="watch-open-review" onClick={() => void openTask(selectedWatchReview)} disabled={taskOpenBusy}>Open latest review</button>}
          <button className="scheduled-primary" onClick={() => onWatchAction(selected.watch, selected.watch.status === 'active' ? 'pause' : 'resume')}>{selected.watch.status === 'active' ? 'Pause monitor' : 'Resume monitor'}</button>
        </div>
      </article>}
      {!taskOpenError && selected?.kind === 'github-trigger' && <article className="scheduled-detail" data-testid="github-trigger-detail" data-item-id={selected.trigger.id}>
        <div className="scheduled-detail-top"><span className="scheduled-detail-label">Your dot</span><span className={`scheduled-status ${selected.trigger.status}`}>{selected.trigger.status === 'active' ? 'Monitoring' : 'Paused'}</span></div>
        <h2>{selected.trigger.repository} · Pull requests</h2>
        <p className="scheduled-instruction">Run when {selected.trigger.actions.join(', ')} occurs. The task evaluates the condition, then follows your instructions using webhook metadata in a read-only cloud session.</p>
        <div className="scheduled-detail-meta"><span>Kernel: {selected.trigger.engine === 'pi' ? 'Pi' : 'DeepSeek Harness'}</span><span>Last event: {selected.trigger.lastEventAt ? new Date(selected.trigger.lastEventAt).toLocaleString() : 'None yet'}</span></div>
        <section className="github-trigger-summary"><h3>Condition</h3><p>{selected.trigger.condition}</p><h3>Instructions</h3><p>{selected.trigger.prompt}</p></section>
        <label className="github-detail-url">Payload URL<input aria-label="Configured GitHub webhook URL" readOnly value={githubWebhookUrl(selected.trigger)} /></label>
        {githubError && <p className="scheduled-watch-error" role="alert">{githubError}</p>}
        <p className="scheduled-trigger-warning">This trigger creates a task from pull request metadata only. It does not fetch repository code or send comments. Remove the repository webhook in GitHub separately when deleting this trigger.</p>
        <div className="scheduled-detail-actions">
          {selected.trigger.lastTaskId && <button onClick={() => {
            const task = tasks.find(item => item.id === selected.trigger.lastTaskId);
            if (task) void openTask(task);
          }}>Open latest task</button>}
          {canManageGitHubTriggers && <button className="scheduled-primary" disabled={githubBusy} onClick={() => void changeGitHubTrigger(selected.trigger, selected.trigger.status === 'active' ? 'pause' : 'resume')}>{selected.trigger.status === 'active' ? 'Pause trigger' : 'Resume trigger'}</button>}
          {canManageGitHubTriggers && <button className="scheduled-danger" disabled={githubBusy} onClick={() => void changeGitHubTrigger(selected.trigger, 'delete')}>Delete trigger</button>}
        </div>
      </article>}
      {!taskOpenError && !selected && <div className="scheduled-empty-detail"><div className="scheduled-empty-icon" aria-hidden="true">◷</div><h2>{items.length ? 'No matching tasks' : 'No scheduled tasks yet'}</h2><p>{items.length ? 'Try a different search.' : 'Create a recurring task or monitor a page to see it here.'}</p><button className="scheduled-primary" onClick={onNewTask}>＋ New task</button></div>}
    </div>
  </section>;
}
