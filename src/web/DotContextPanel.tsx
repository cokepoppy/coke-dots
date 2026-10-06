import { useEffect, useState } from 'react';
import type { Snapshot, Task, TaskStatus } from '../shared/types.ts';
import { DotAvatar } from './DotAvatar.tsx';
import './context-panel.css';

interface ComputerState { ready: boolean; owner: 'agent' | 'user'; url: string; title: string }

const statusLabel: Record<TaskStatus, string> = {
  queued: 'Queued', working: 'Working', delegating: 'Parallel work', waiting: 'Needs you', scheduled: 'Scheduled', done: 'Complete', failed: 'Failed', paused: 'Paused', stopped: 'Stopped',
};

export function DotContextPanel({ profile, state, tenantId, onOpenComputer, onSelectTask }: {
  profile: Snapshot['profile'];
  state: Snapshot;
  tenantId: string;
  onOpenComputer: () => void;
  onSelectTask: (taskId: string) => void;
}) {
  const [computer, setComputer] = useState<ComputerState | null>(null);
  const tasks = [...state.tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const outputs = tasks.filter(task => task.result).slice(0, 3);

  useEffect(() => {
    let current = true;
    const refresh = () => {
      void fetch('/api/computer').then(async response => response.ok ? await response.json() as ComputerState : null)
        .then(next => { if (current && next) setComputer(next); })
        .catch(() => { if (current) setComputer(null); });
    };
    setComputer(null);
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { current = false; window.clearInterval(timer); };
  }, [tenantId]);

  return <aside className="dot-context-panel" aria-label={`${profile.name} details`} data-testid="dot-context-panel" data-tenant-id={tenantId}>
    <div className="context-agent">
      <DotAvatar appearance={profile} small className="context-avatar" />
      <strong>{profile.name}</strong>
    </div>

    <div className="context-quick-actions">
      <button type="button" disabled title="Voice calling is not connected in this build" aria-label="Call, not connected"><span aria-hidden="true">☎</span>Call</button>
      <button type="button" disabled title="Slack is not connected in this build" aria-label="Slack, not connected"><span className="slack-mark" aria-hidden="true">✣</span>Slack</button>
    </div>

    <ContextSection title="Computers" testId="context-computers">
      <button className="context-computer-row" data-testid="dot-computer-row" onClick={onOpenComputer}>
        <span className="context-computer-icon" aria-hidden="true">▣</span>
        <span className="context-row-copy"><strong>{profile.name}'s computer</strong><small className={computer?.ready ? 'connected' : ''}>{computer?.ready ? 'Connected' : computer ? 'Not open' : 'Checking…'}</small></span>
        <span className="context-chevron" aria-hidden="true">›</span>
      </button>
      <div className="context-computer-row local-computer-row">
        <span className="context-computer-icon" aria-hidden="true">⌘</span>
        <span className="context-row-copy"><strong>This computer</strong><small>This device</small></span>
      </div>
    </ContextSection>

    <ContextSection title="Recent activity" testId="context-activity">
      {tasks.length ? <div className="context-list">{tasks.slice(0, 4).map(task => <ActivityRow key={task.id} task={task} onSelect={onSelectTask} />)}</div> : <p className="context-empty">No recent activity</p>}
    </ContextSection>

    <ContextSection title="Outputs" testId="context-outputs">
      {outputs.length ? <div className="context-list">{outputs.map(task => <button className="context-output-row" key={task.id} onClick={() => onSelectTask(task.id)}><span className="context-output-icon" aria-hidden="true">▤</span><span className="context-row-copy"><strong>{task.title}</strong><small>Task result</small></span></button>)}</div> : <p className="context-empty">No outputs yet</p>}
    </ContextSection>

  </aside>;
}

function ContextSection({ title, testId, children }: { title: string; testId: string; children: React.ReactNode }) {
  return <section className="context-section" aria-label={title} data-testid={testId}><h2>{title}</h2>{children}</section>;
}

function ActivityRow({ task, onSelect }: { task: Task; onSelect: (taskId: string) => void }) {
  return <button className="context-activity-row" onClick={() => onSelect(task.id)}>
    <span className={`context-status ${task.status}`} aria-hidden="true" />
    <span className="context-row-copy"><strong>{task.title}</strong><small>{statusLabel[task.status]}</small></span>
  </button>;
}
