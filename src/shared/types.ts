import type { ScheduleSpec } from './scheduling.ts';

// `claude` remains only as a historical stored-task value; current dispatch rejects it.
export type Engine = 'model' | 'claude' | 'pi' | 'dsh';
export type ReasoningEffort = 'medium' | 'high' | 'xhigh';
export const reasoningEfforts: ReasoningEffort[] = ['medium', 'high', 'xhigh'];
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && reasoningEfforts.includes(value as ReasoningEffort);
}
export type TaskStatus = 'queued' | 'working' | 'delegating' | 'waiting' | 'scheduled' | 'done' | 'failed' | 'paused' | 'stopped';
export type TaskExecutionMode = 'standard' | 'read-only' | 'proactive-research';
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
  reasoningEffort: ReasoningEffort;
  executionMode: TaskExecutionMode;
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
  unreadScheduledRunCount?: number;
}

export type ScheduledTaskRunStatus = 'complete' | 'waiting' | 'failed';

export interface ScheduledTaskRun {
  id: string;
  tenantId: string;
  taskId: string;
  status: ScheduledTaskRunStatus;
  result: string | null;
  error: string | null;
  needsAttention: boolean;
  readAt: string | null;
  startedAt: string;
  finishedAt: string;
}

export interface WebsiteSignInRequest {
  id: string;
  tenantId: string;
  taskId: string;
  url: string;
  hostname: string;
  reason: string;
  status: 'pending' | 'submitted' | 'continued' | 'cancelled';
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
  preferences: { desktopNotifications: boolean; reasoningEffort: ReasoningEffort };
  computerAccess: { dotComputer: true; localComputer: boolean; configured: boolean };
  tasks: Task[];
  watches: Watch[];
  entries: Entry[];
  configured: boolean;
  availableEngines: Engine[];
  remoteEngines: Engine[];
  modelSettings: { baseUrl: string; model: string; hasKey: boolean; canManage?: boolean };
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
  lastTaskId: string | null;
  error: string | null;
}

export interface SlackEventMonitor {
  id: string;
  tenantId: string;
  teamId: string;
  teamName: string;
  channelId: string;
  channelName: string;
  instructions: string;
  status: 'active' | 'paused';
  createdAt: string;
  updatedAt: string;
  lastEventAt: string | null;
  lastTaskId: string | null;
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

export interface PersonalActionRule {
  id: string;
  userId: string;
  scope: 'scratchpad-write';
  instruction: string;
  mode: ActionRuleMode;
  createdAt: string;
  updatedAt: string;
}

/** A private note attached to one signed-in user's Dot, not a shared workspace memory. */
export interface PersonalDotMemory {
  id: string;
  note: string;
  sourceTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PersonalDotMemoryUpdate =
  | { action: 'remember'; note: string }
  | { action: 'update'; memoryId: string; note: string }
  | { action: 'forget'; memoryId: string };

export interface AppliedPersonalDotMemoryUpdate {
  action: PersonalDotMemoryUpdate['action'];
  id: string;
  note: string;
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
  canDecide?: boolean;
}
