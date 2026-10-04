export type TaskStatus = 'queued' | 'working' | 'waiting' | 'scheduled' | 'done' | 'failed' | 'paused';

export interface Task {
  id: string;
  title: string;
  instruction: string;
  status: TaskStatus;
  priority: number;
  nextRunAt: string | null;
  scheduleMinutes: number | null;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Entry {
  id: number;
  taskId: string | null;
  kind: 'user' | 'dot' | 'system';
  body: string;
  createdAt: string;
}

export interface Snapshot {
  profile: { name: string; shape: string; color: string };
  tasks: Task[];
  entries: Entry[];
  configured: boolean;
}
