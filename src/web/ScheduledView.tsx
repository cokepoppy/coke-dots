import { useEffect, useMemo, useRef, useState } from 'react';
import type { ScheduledTaskRun, Task, Watch } from '../shared/types.ts';
import { describeSchedule, scheduleForTask } from '../shared/scheduling.ts';

type ScheduledItem =
  | { key: string; kind: 'task'; title: string; searchable: string; updatedAt: string; task: Task }
  | { key: string; kind: 'watch'; title: string; searchable: string; updatedAt: string; watch: Watch };

const statusText: Record<Task['status'], string> = {
  queued: 'Queued', working: 'Working', delegating: 'Parallel work', waiting: 'Needs you', scheduled: 'Monitoring', done: 'Complete', failed: 'Failed', paused: 'Paused', stopped: 'Stopped',
};

function taskStatusText(task: Task) {
  return task.status === 'scheduled' && scheduleForTask(task.scheduleSpec, task.scheduleMinutes) === null
    ? 'Scheduled'
    : statusText[task.status];
}

export function ScheduledView({ tasks, watches, onCancelTask, onWatchAction, onOpenTask, onLoadTaskRuns, onMarkTaskRunsRead, onNewTask, onAddWatch }: {
  tasks: Task[];
  watches: Watch[];
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
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [tasks, watches]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized ? items.filter(item => item.searchable.toLocaleLowerCase().includes(normalized)) : items;
  }, [items, query]);
  const selected = filtered.find(item => item.key === selectedKey) || null;
  const selectedTaskUpdatedAt = selected?.kind === 'task' ? selected.task.updatedAt : '';
  const selectedWatchReview = selected?.kind === 'watch' && selected.watch.lastTaskId
    ? tasks.find(task => task.id === selected.watch.lastTaskId) || null
    : null;

  useEffect(() => {
    if (!selected || !filtered.some(item => item.key === selectedKey)) setSelectedKey(filtered[0]?.key || null);
  }, [filtered, selected, selectedKey]);

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
          const status = item.kind === 'task' ? taskStatusText(item.task) : item.watch.status === 'active' ? 'Monitoring' : item.watch.status === 'paused' ? 'Paused' : 'Failed';
          const unreadRuns = item.kind === 'task' ? item.task.unreadScheduledRunCount || 0 : 0;
          return <button key={item.key} className={`scheduled-item ${selectedKey === item.key ? 'selected' : ''}`} aria-pressed={selectedKey === item.key} onMouseEnter={event => showItemPreview(event.currentTarget, item)} onMouseLeave={() => clearItemPreview(item.key)} onFocus={event => showItemPreview(event.currentTarget, item)} onBlur={() => clearItemPreview(item.key)} onClick={() => { setTaskOpenError(false); if (item.kind === 'task') { if (selectedKey !== item.key) explicitTaskSelection.current = true; setSelectedKey(item.key); void reviewRunsAgain(item.task.id); } else setSelectedKey(item.key); }}>
            <span className="scheduled-item-copy"><strong>{item.title}</strong><small>{status}</small></span>
            {unreadRuns > 0 && <span className="scheduled-item-unread" data-testid={`scheduled-unread-${item.kind}-${item.kind === 'task' ? item.task.id : item.watch.id}`} aria-label={`${unreadRuns} unread scheduled run${unreadRuns === 1 ? '' : 's'}`} title={`${unreadRuns} unread run${unreadRuns === 1 ? '' : 's'}`} />}
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
      <button className="scheduled-add-watch" onClick={() => setShowWatchForm(value => !value)} aria-expanded={showWatchForm}>＋ Monitor a page</button>
    </aside>

    <div className="scheduled-detail-pane">
      {taskOpenError && <div className="scheduled-chat-open-error" role="alert" data-testid="scheduled-chat-open-error">
        <p>Couldn't open this chat. Try again.</p>
        {selected?.kind === 'task' && <button type="button" onClick={() => void openTask(selected.task)} disabled={taskOpenBusy}>Try again</button>}
        {selectedWatchReview && <button type="button" onClick={() => void openTask(selectedWatchReview)} disabled={taskOpenBusy}>Try again</button>}
      </div>}
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
      {!taskOpenError && !selected && <div className="scheduled-empty-detail"><div className="scheduled-empty-icon" aria-hidden="true">◷</div><h2>{items.length ? 'No matching tasks' : 'No scheduled tasks yet'}</h2><p>{items.length ? 'Try a different search.' : 'Create a recurring task or monitor a page to see it here.'}</p><button className="scheduled-primary" onClick={onNewTask}>＋ New task</button></div>}
    </div>
  </section>;
}
