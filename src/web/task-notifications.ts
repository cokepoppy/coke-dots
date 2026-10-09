import type { BrowserNotificationMode, TaskStatus } from '../shared/types.ts';

export interface TaskNotificationState {
  id: string;
  status: TaskStatus;
  isOwnedByCurrentUser: boolean;
  notifyUser: boolean;
  unreadScheduledRunCount: number;
}

export type TaskNotificationKind = 'waiting' | 'failed' | 'completed' | 'scheduled-result';

export interface TaskNotificationAlert {
  taskId: string;
  kind: TaskNotificationKind;
}

export function findTaskNotificationAlerts(previous: TaskNotificationState[] | null, current: TaskNotificationState[]): TaskNotificationAlert[] {
  if (!previous) return [];
  const before = new Map(previous.map(task => [task.id, task]));
  const alerts: TaskNotificationAlert[] = [];
  for (const task of current) {
    const old = before.get(task.id);
    if (!old || !task.isOwnedByCurrentUser || !old.isOwnedByCurrentUser) continue;
    if (task.unreadScheduledRunCount > old.unreadScheduledRunCount) {
      alerts.push({ taskId: task.id, kind: 'scheduled-result' });
    } else if (old.status !== task.status && task.status === 'waiting') {
      alerts.push({ taskId: task.id, kind: 'waiting' });
    } else if (old.status !== task.status && task.status === 'failed') {
      alerts.push({ taskId: task.id, kind: 'failed' });
    } else if (old.status !== task.status && task.status === 'done' && task.notifyUser) {
      alerts.push({ taskId: task.id, kind: 'completed' });
    }
  }
  return alerts;
}

export function browserNotificationAllowed(mode: BrowserNotificationMode, pageHidden: boolean) {
  return mode === 'always' || (mode === 'background' && pageHidden);
}

export function taskNotificationCopy(kind: TaskNotificationKind) {
  switch (kind) {
    case 'waiting': return '有一项工作需要你的决定。';
    case 'failed': return '有一项工作未能完成，请查看。';
    case 'completed': return '有一项工作已完成。';
    case 'scheduled-result': return '定时检查有新结果。';
  }
}
