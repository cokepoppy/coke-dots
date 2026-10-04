export type Engine = 'model' | 'claude' | 'pi' | 'dsh';
export type TaskStatus = 'queued' | 'working' | 'waiting' | 'scheduled' | 'done' | 'failed' | 'paused';

export interface Task {
  id: string;
  tenantId: string;
  engine: Engine;
  agentSessionId: string | null;
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
  tenantId: string;
  taskId: string | null;
  kind: 'user' | 'dot' | 'system';
  body: string;
  createdAt: string;
}

export interface Snapshot {
  profile: { name: string; shape: string; color: string };
  tasks: Task[];
  watches: Watch[];
  entries: Entry[];
  configured: boolean;
  availableEngines: Engine[];
  modelSettings: { baseUrl: string; model: string; hasKey: boolean };
}

export interface Watch {
  id: string;
  tenantId: string;
  url: string;
  intervalMinutes: number;
  status: 'active' | 'paused' | 'failed';
  nextCheckAt: string | null;
  lastCheckedAt: string | null;
  lastStatus: string | null;
  error: string | null;
}
