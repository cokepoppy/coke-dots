import type { ScheduleSpec } from './scheduling.ts';

export type Engine = 'model' | 'claude' | 'pi' | 'dsh';
export type TaskStatus = 'queued' | 'working' | 'delegating' | 'waiting' | 'scheduled' | 'done' | 'failed' | 'paused' | 'stopped';
export type ActionRuleMode = 'without-asking' | 'when-requested' | 'ask-before' | 'hand-off';
export type { ScheduleSpec } from './scheduling.ts';

export interface DotAppearance {
  shape: string;
  color: string;
  eyes: string;
  glasses: string;
  accessory: string;
  character: string;
  pet: string;
}

export interface Task {
  id: string;
  tenantId: string;
  parentTaskId: string | null;
  engine: Engine;
  agentSessionId: string | null;
  title: string;
  instruction: string;
  status: TaskStatus;
  priority: number;
  nextRunAt: string | null;
  scheduleMinutes: number | null;
  scheduleSpec: ScheduleSpec | null;
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
  attachments?: AttachmentSummary[];
}

export interface AttachmentSummary {
  id: string;
  name: string;
  mediaType: string;
  size: number;
}

export interface VoiceCallSession {
  id: string;
  tenantId: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
}

export interface Snapshot {
  profile: { name: string; avatarSetupCompletedAt: string | null; onboardingCompletedAt: string | null; onboardingCompletedName: string | null } & DotAppearance;
  dotPaused: boolean;
  preferences: { desktopNotifications: boolean };
  computerAccess: { dotComputer: true; localComputer: boolean; configured: boolean };
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

export interface WorkspacePage {
  id: string;
  tenantId: string;
  title: string;
  content: string;
  createdBy: string | null;
  createdByName: string | null;
  sourceTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TenantActionRule {
  id: string;
  tenantId: string;
  scope: 'scratchpad-write';
  instruction: string;
  mode: ActionRuleMode;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type ScratchpadPageAction =
  | { action: 'create'; title: string; content: string }
  | { action: 'update'; pageId: string; title: string; content: string };

export interface PageActionApproval {
  id: string;
  tenantId: string;
  taskId: string;
  action: ScratchpadPageAction;
  message: string;
  status: 'pending' | 'approved' | 'declined' | 'cancelled';
  resumeStatus: 'done' | 'scheduled';
  nextRunAt: string | null;
  createdAt: string;
  decidedAt: string | null;
}
