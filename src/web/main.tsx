import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AttachmentSummary, DotAppearance, Engine, Entry, PageActionApproval, PersonalDotMemory, ReasoningEffort, ScheduleSpec, Snapshot, Task, TaskStatus, VoiceCallSession, WebsiteSignInRequest } from '../shared/types.ts';
import { appFetch, appPath } from './api.ts';
import './style.css';
import './chat-theme.css';
import './watch.css';
import './dark-theme.css';
import './dot-controls.css';
import './avatar-editor.css';
import './onboarding.css';
import './notification.css';
import './activity.css';
import './scheduled.css';
import './recurrence.css';
import './pages.css';
import { ComputerView } from './ComputerView.tsx';
import { DotContextPanel } from './DotContextPanel.tsx';
import { SlackSetupModal } from './SlackSetupModal.tsx';
import { TeamsSetupModal } from './TeamsSetupModal.tsx';
import { ScheduledView } from './ScheduledView.tsx';
import { PagePane, PagesView, ScratchpadNavigationPane } from './Pages.tsx';
import { PermissionRules } from './PermissionRules.tsx';
import { DotOnboarding } from './DotOnboarding.tsx';
import { DotAvatar } from './DotAvatar.tsx';
import { DotAvatarEditor } from './DotAvatarEditor.tsx';
import { DotSetupEditor } from './DotSetupEditor.tsx';
import { DotComputerChoice } from './DotComputerChoice.tsx';
import { VoiceCall } from './VoiceCall.tsx';
import { DictationButton } from './DictationButton.tsx';
import { RecurrenceEditor } from './RecurrenceEditor.tsx';
import './shell-replica.css';
import './onboarding-replica.css';
import './computer-choice.css';
import './call-timeline.css';
import './website-sign-in.css';

const initial: Snapshot = { profile: { name: 'Dot', shape: 'circle', color: '#c8cbd5', eyes: 'dot', glasses: 'none', accessory: 'none', character: 'ring', pet: 'moss', avatarSetupCompletedAt: null, onboardingCompletedAt: null, onboardingCompletedName: null }, dotPaused: false, preferences: { desktopNotifications: false, reasoningEffort: 'high' }, computerAccess: { dotComputer: true, localComputer: true, configured: false }, tasks: [], watches: [], entries: [], configured: false, availableEngines: [], remoteEngines: [], modelSettings: { baseUrl: '', model: '', hasKey: false } };
interface AuthContext { user: { id: string; email: string; name: string }; tenant: { id: string; name: string; role: string; kind: string }; tenants: { id: string; name: string; role: string; kind: string }[] }
type Theme = 'light' | 'dark';
interface TenantMember { id: string; email: string; name: string; role: string }
interface WorkspaceInvitation { tenantId: string; tenantName?: string; email: string; role: string; invitedAt: string; expiresAt: string }
interface TenantMemory { id: string; tenantId: string; note: string; createdBy: string; createdByName: string; createdAt: string; updatedAt: string }
type ChatTimelineItem =
  | { id: string; at: string; source: 'entry'; entry: Entry }
  | { id: string; at: string; source: 'call-ended'; call: VoiceCallSession };
function initialsForUser(name: string, email: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials = parts.length > 1 ? `${parts[0][0]}${parts.at(-1)?.[0] || ''}` : (parts[0] || email)[0] || '?';
  return initials.slice(0, 2).toUpperCase();
}
const statusText: Record<TaskStatus, string> = {
  queued: '排队中', working: '工作中', delegating: '并行处理中', waiting: '等待你', scheduled: '已安排', done: '已完成', failed: '失败', paused: '已暂停', stopped: '已停止',
};
const engineText: Record<Engine, string> = { model: '模型 API', claude: 'Claude Code', pi: 'Pi', dsh: 'DeepSeek Harness' };

async function request(path: string, method: 'POST' | 'PATCH', body: object) {
  const response = await appFetch(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function MessageBody({ body, onOpenPage }: { body: string; onOpenPage: (id: string) => void }) {
  const token = /\[\[page:([a-f0-9-]{36})\|([^\]]+)\]\]/gi;
  const content: React.ReactNode[] = [];
  let cursor = 0;
  for (const match of body.matchAll(token)) {
    const index = match.index ?? 0;
    if (index > cursor) content.push(<React.Fragment key={`text-${cursor}`}>{body.slice(cursor, index)}</React.Fragment>);
    let title = match[2];
    try { title = decodeURIComponent(match[2]); } catch { /* Preserve malformed display text safely. */ }
    content.push(<button key={`page-${match[1]}`} className="message-page-link" onClick={() => onOpenPage(match[1])}>{title} ↗</button>);
    cursor = index + match[0].length;
  }
  if (cursor < body.length) content.push(<React.Fragment key={`text-${cursor}`}>{body.slice(cursor)}</React.Fragment>);
  return <p className="message-body">{content}</p>;
}

function App() {
  const [authContext, setAuthContext] = useState<AuthContext | null>(null);
  const [theme, setTheme] = useState<Theme>('light');
  const [authChecked, setAuthChecked] = useState(false);
  const [stateLoaded, setStateLoaded] = useState(false);
  const [googleConfigured, setGoogleConfigured] = useState(false);
  const [e2eAuthAvailable, setE2eAuthAvailable] = useState(false);
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
  const [state, setState] = useState<Snapshot>(initial);
  const [voiceCalls, setVoiceCalls] = useState<VoiceCallSession[]>([]);
  const [voiceCallsScope, setVoiceCallsScope] = useState('');
  const timelineRef = useRef<HTMLDivElement>(null);
  const timelineAtBottomRef = useRef(true);
  const [avatarEditorOpen, setAvatarEditorOpen] = useState(false);
  const [avatarSetupOpen, setAvatarSetupOpen] = useState(false);
  const [computerAccessOpen, setComputerAccessOpen] = useState(false);
  const [computerConnectedToast, setComputerConnectedToast] = useState(false);
  const [voiceCallOpen, setVoiceCallOpen] = useState(false);
  const [slackModalOpen, setSlackModalOpen] = useState(false);
  const [teamsModalOpen, setTeamsModalOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<'home' | 'chat' | 'activity' | 'scheduled' | 'computer' | 'profile' | 'pages'>('home');
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const lastChatLocation = useRef<{ view: 'home' | 'chat'; selected: string | null; selectedPageId: string | null }>({ view: 'home', selected: null, selectedPageId: null });
  const [pageIndexVersion, setPageIndexVersion] = useState(0);
  const [draft, setDraft] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentSummary[]>([]);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [schedule, setSchedule] = useState(false);
  const [minutes, setMinutes] = useState(60);
  const [frequency, setFrequency] = useState<'interval' | 'daily' | 'weekly'>('interval');
  const [scheduleTime, setScheduleTime] = useState('09:00');
  const [scheduleTimeZone, setScheduleTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [scheduleWeekdays, setScheduleWeekdays] = useState<number[]>([]);
  const [scheduleEndDate, setScheduleEndDate] = useState('');
  const [engine, setEngine] = useState<Engine>('model');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (view === 'home' || view === 'chat') lastChatLocation.current = { view, selected, selectedPageId };
  }, [view, selected, selectedPageId]);

  useEffect(() => {
    void appFetch('/api/auth/me').then(async response => response.ok ? await response.json() as AuthContext : null)
      .then(setAuthContext).catch(() => setAuthContext(null)).finally(() => setAuthChecked(true));
    void appFetch('/api/auth/config').then(response => response.json()).then(data => { setGoogleConfigured(Boolean(data.googleConfigured)); setE2eAuthAvailable(Boolean(data.e2eAuthAvailable)); }).catch(() => { setGoogleConfigured(false); setE2eAuthAvailable(false); });
  }, []);

  useEffect(() => {
    if (!authContext) return;
    const url = new URL(window.location.href);
    const connected = url.searchParams.get('slack') === 'connected';
    const slackError = url.searchParams.get('slackError');
    if (!connected && !slackError) return;
    try {
      const saved = sessionStorage.getItem('coke-dots:slack-return-state');
      if (saved) {
        sessionStorage.removeItem('coke-dots:slack-return-state');
        const route = JSON.parse(saved) as { view?: string; selected?: unknown };
        if (route.view === 'chat' && (route.selected === null || (typeof route.selected === 'string' && route.selected.length <= 100))) {
          setView('chat');
          setSelected(route.selected as string | null);
        }
      }
    } catch { /* Continue with the home view when session storage is unavailable. */ }
    url.searchParams.delete('slack'); url.searchParams.delete('slackError');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    if (connected) setSlackModalOpen(true);
    else if (slackError === 'cancelled') setError('Slack 工作区连接已取消。');
    else if (slackError === 'expired') setError('Slack 连接已过期，请重新连接。');
    else setError('Slack 工作区连接失败，请重试。');
  }, [authContext?.user.id]);

  useEffect(() => {
    if (!authContext) { setInvitations([]); return; }
    const refresh = () => void appFetch('/api/auth/invitations').then(async response => response.ok ? await response.json() as WorkspaceInvitation[] : [])
      .then(setInvitations).catch(() => setInvitations([]));
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => window.clearInterval(timer);
  }, [authContext?.user.id]);

  useEffect(() => {
    setPendingAttachments([]);
    if (!authContext) return;
    const controller = new AbortController();
    void appFetch('/api/attachments', { signal: controller.signal })
      .then(async response => response.ok ? await response.json() as AttachmentSummary[] : [])
      .then(items => setPendingAttachments(items))
      .catch(error => { if (error instanceof Error && error.name !== 'AbortError') setPendingAttachments([]); });
    return () => controller.abort();
  }, [authContext?.tenant.id, authContext?.user.id]);

  useEffect(() => {
    setVoiceCalls([]);
    setVoiceCallsScope('');
    if (!authContext) return;
    const scope = `${authContext.tenant.id}:${authContext.user.id}`;
    const controller = new AbortController();
    void appFetch('/api/voice-calls', { signal: controller.signal })
      .then(async response => response.ok ? await response.json() as VoiceCallSession[] : [])
      .then(items => { setVoiceCalls(items); setVoiceCallsScope(scope); })
      .catch(error => { if (!(error instanceof Error && error.name === 'AbortError')) { setVoiceCalls([]); setVoiceCallsScope(scope); } });
    return () => controller.abort();
  }, [authContext?.tenant.id, authContext?.user.id]);

  useEffect(() => {
    if (!authContext) { setTheme('light'); return; }
    try {
      setTheme(localStorage.getItem(`coke-dots:theme:${authContext.user.id}`) === 'dark' ? 'dark' : 'light');
    } catch {
      setTheme('light');
    }
  }, [authContext?.user.id]);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!accountMenuRef.current?.contains(event.target as Node)) setAccountMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAccountMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [accountMenuOpen]);

  useEffect(() => {
    if (!computerConnectedToast) return;
    const timer = window.setTimeout(() => setComputerConnectedToast(false), 5000);
    return () => window.clearTimeout(timer);
  }, [computerConnectedToast]);

  useEffect(() => {
    if (!authContext) return;
    setStateLoaded(false);
    const stream = new EventSource(appPath('/api/events'));
    stream.onmessage = event => {
      setState(JSON.parse(event.data));
      setStateLoaded(true);
      setError(current => current === '与本机服务的连接已断开，正在重连。' ? '' : current);
    };
    stream.onerror = () => {
      setError('与本机服务的连接已断开，正在重连。');
      void appFetch('/api/auth/me').then(async response => {
        if (response.status === 401) setAuthContext(null);
        else if (response.ok) setAuthContext(await response.json() as AuthContext);
      }).catch(() => undefined);
    };
    return () => stream.close();
  }, [authContext?.tenant.id]);

  const selectedTask = state.tasks.find(t => t.id === selected) || null;
  const entries = useMemo(() => selected ? state.entries.filter(e => e.taskId === selected) : state.entries, [state.entries, selected]);
  const currentVoiceCallScope = authContext ? `${authContext.tenant.id}:${authContext.user.id}` : '';
  const currentVoiceCalls = voiceCallsScope === currentVoiceCallScope ? voiceCalls : [];
  const voiceCallsLoaded = voiceCallsScope === currentVoiceCallScope;
  const timelineItems = useMemo<ChatTimelineItem[]>(() => {
    const items: ChatTimelineItem[] = entries.map(entry => ({ id: `entry-${entry.id}`, at: entry.createdAt, source: 'entry', entry }));
    if (!selected) {
      for (const call of currentVoiceCalls) if (call.endedAt) items.push({ id: `call-${call.id}`, at: call.endedAt, source: 'call-ended', call });
    }
    return items.sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.id.localeCompare(right.id));
  }, [entries, selected, currentVoiceCalls]);
  const hasConversationHistory = entries.length > 0 || timelineItems.some(item => item.source === 'call-ended');
  const active = state.tasks.filter(t => ['queued', 'working', 'waiting', 'scheduled'].includes(t.status));

  useLayoutEffect(() => { timelineAtBottomRef.current = true; }, [view, selected]);
  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (timeline && timelineAtBottomRef.current) timeline.scrollTop = timeline.scrollHeight;
  }, [timelineItems, view, selected, stateLoaded]);

  async function refreshVoiceCalls() {
    const response = await appFetch('/api/voice-calls');
    if (!response.ok) throw new Error('读取通话记录失败：HTTP ' + response.status);
    setVoiceCalls(await response.json() as VoiceCallSession[]);
    if (authContext) setVoiceCallsScope(`${authContext.tenant.id}:${authContext.user.id}`);
  }

  function openPage(pageId: string, taskId: string | null = null) {
    setSelectedPageId(pageId);
    if (taskId) setSelected(taskId);
    setView('chat');
  }

  function toggleTheme() {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    if (authContext) {
      try { localStorage.setItem(`coke-dots:theme:${authContext.user.id}`, next); } catch { /* Keep the current session usable when storage is unavailable. */ }
    }
    setAccountMenuOpen(false);
  }

  async function saveAvatarAppearance(appearance: DotAppearance, name?: string, completeOnboarding = false, completeSetup = false) {
    try {
      const profile = await request('/profile', 'PATCH', { ...appearance, ...(name === undefined ? {} : { name }), ...(completeOnboarding ? { onboardingComplete: true } : {}), ...(completeSetup ? { setupComplete: true } : {}) }) as Snapshot['profile'];
      setState(current => ({ ...current, profile }));
      setAvatarEditorOpen(false);
      setAvatarSetupOpen(false);
    } catch (error) { setError(String(error)); }
  }

  function openDotCustomizer() {
    if (state.profile.avatarSetupCompletedAt) setAvatarEditorOpen(true);
    else setAvatarSetupOpen(true);
  }

  async function saveComputerAccess(localComputer: boolean) {
    const shouldShowConnectedToast = localComputer && (!state.computerAccess.localComputer || !state.computerAccess.configured);
    const computerAccess = await request('/computer-access', 'PATCH', { localComputer }) as Snapshot['computerAccess'];
    setState(current => ({ ...current, computerAccess }));
    if (shouldShowConnectedToast) setComputerConnectedToast(true);
    setComputerAccessOpen(false);
  }

  async function setDotPaused(paused: boolean) {
    const result = await request('/dot-control', 'PATCH', { paused }) as { dotPaused: boolean };
    setState(current => ({ ...current, dotPaused: result.dotPaused }));
  }

  function returnToFreshDotChat() {
    setSelected(null);
    setSelectedPageId(null);
    setPendingAttachments([]);
    setVoiceCalls([]);
    if (authContext) setVoiceCallsScope(`${authContext.tenant.id}:${authContext.user.id}`);
    setView('chat');
  }

  async function submit() {
    if (!draft.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const scheduleSpec: ScheduleSpec | null = !schedule ? null : frequency === 'interval'
        ? { frequency, intervalMinutes: minutes }
        : frequency === 'daily'
          ? { frequency, time: scheduleTime, timeZone: scheduleTimeZone, endDate: scheduleEndDate || null }
          : { frequency, weekdays: scheduleWeekdays, time: scheduleTime, timeZone: scheduleTimeZone, endDate: scheduleEndDate || null };
      const task = await request('/tasks', 'POST', { instruction: draft, scheduleSpec, scheduleMinutes: schedule && frequency === 'interval' ? minutes : null, engine, reasoningEffort: state.preferences.reasoningEffort, attachmentIds: pendingAttachments.map(attachment => attachment.id) }) as Task;
      setDraft(''); setPendingAttachments([]); setSelected(task.id); setSelectedPageId(null); setView('chat'); setSchedule(false); setFrequency('interval'); setMinutes(60); setScheduleWeekdays([]); setScheduleEndDate('');
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  async function uploadAttachments(files: FileList | null) {
    if (!files?.length || uploadingAttachments) return;
    setUploadingAttachments(true); setError('');
    try {
      for (const file of Array.from(files)) {
        const response = await appFetch('/api/attachments', {
          method: 'POST',
          headers: { 'content-type': file.type || 'application/octet-stream', 'x-attachment-name': encodeURIComponent(file.name) },
          body: file,
        });
        const data = await response.json() as AttachmentSummary & { error?: string };
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        setPendingAttachments(current => current.some(item => item.id === data.id) ? current : [...current, data]);
      }
    } catch (uploadError) { setError(uploadError instanceof Error ? uploadError.message : String(uploadError)); }
    finally {
      setUploadingAttachments(false);
      if (attachmentInputRef.current) attachmentInputRef.current.value = '';
    }
  }

  async function removePendingAttachment(attachment: AttachmentSummary) {
    try {
      const response = await appFetch(`/api/attachments/${attachment.id}`, { method: 'DELETE' });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setPendingAttachments(current => current.filter(item => item.id !== attachment.id));
    } catch (removeError) { setError(removeError instanceof Error ? removeError.message : String(removeError)); }
  }

  async function act(task: Task, action: string, extra: object = {}) {
    try { setError(''); await request(`/tasks/${task.id}`, 'PATCH', { action, ...extra }); }
    catch (e) { setError(String(e)); }
  }

  async function setTaskCompletionNotification(task: Task, enabled: boolean) {
    const updated = await request(`/tasks/${task.id}`, 'PATCH', { notifyOnCompletion: enabled }) as Task;
    setState(current => ({ ...current, tasks: current.tasks.map(item => item.id === updated.id ? updated : item) }));
  }

  async function updateScheduledTask(task: Task, scheduleSpec: ScheduleSpec) {
    const updated = await request(`/tasks/${task.id}`, 'PATCH', { scheduleSpec }) as Task;
    setState(current => ({ ...current, tasks: current.tasks.map(item => item.id === updated.id ? updated : item) }));
  }

  async function actOnScheduledTask(task: Task, action: 'pauseSchedule' | 'resumeSchedule') {
    const updated = await request(`/tasks/${task.id}`, 'PATCH', { action }) as Task;
    setState(current => ({ ...current, tasks: current.tasks.map(item => item.id === updated.id ? updated : item) }));
  }

  async function submitVoiceTranscript(instruction: string, waitingTaskId?: string) {
    const task = waitingTaskId
      ? await request(`/tasks/${waitingTaskId}`, 'PATCH', { action: 'reply', message: instruction }) as Task
      : await request('/tasks', 'POST', { instruction, scheduleSpec: null, scheduleMinutes: null, engine, reasoningEffort: state.preferences.reasoningEffort }) as Task;
    setSelected(task.id); setSelectedPageId(null); setView('chat');
    return task;
  }

  async function updateReasoningEffort(reasoningEffort: ReasoningEffort) {
    const previous = state.preferences.reasoningEffort;
    setState(current => ({ ...current, preferences: { ...current.preferences, reasoningEffort } }));
    try {
      const preferences = await request('/preferences', 'PATCH', { reasoningEffort }) as Snapshot['preferences'];
      setState(current => ({ ...current, preferences }));
    } catch (error) {
      setState(current => ({ ...current, preferences: { ...current.preferences, reasoningEffort: previous } }));
      setError(String(error));
    }
  }

  async function addScheduledWatch(url: string, intervalMinutes: number) {
    try { setError(''); await request('/watches', 'POST', { url, intervalMinutes }); }
    catch (e) { setError(String(e)); throw e; }
  }

  async function actWatch(id: string, action: 'pause' | 'resume') {
    try { setError(''); await request(`/watches/${id}`, 'PATCH', { action }); }
    catch (e) { setError(String(e)); }
  }

  async function switchTenant(tenantId: string) {
    if (authContext?.tenant.id === tenantId) { setAccountMenuOpen(false); return; }
    setVoiceCallOpen(false); setPendingAttachments([]);
    try {
      const response = await appFetch('/api/auth/tenant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setAuthContext(data as AuthContext); setState(initial); setStateLoaded(false); setSelected(null); setSelectedPageId(null); setError(''); setAccountMenuOpen(false);
    } catch (e) { setError(String(e)); }
  }

  async function createTenant(name: string) {
    setVoiceCallOpen(false);
    const response = await appFetch('/api/tenants', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    const refreshed = await appFetch('/api/auth/me');
    if (refreshed.ok) setAuthContext(await refreshed.json() as AuthContext);
    setState(initial); setStateLoaded(false); setSelected(null); setSelectedPageId(null);
  }

  async function logout() {
    setVoiceCallOpen(false);
    setAccountMenuOpen(false);
    try { await appFetch('/api/auth/logout', { method: 'POST' }); }
    finally { setAuthContext(null); setState(initial); setPendingAttachments([]); setSelectedPageId(null); }
  }

  async function acceptInvitation(invitation: WorkspaceInvitation) {
    try {
      setError('');
      const response = await appFetch(`/api/auth/invitations/${invitation.tenantId}/accept`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setAuthContext(data as AuthContext);
      setInvitations(current => current.filter(item => item.tenantId !== invitation.tenantId));
      setState(initial); setStateLoaded(false); setSelected(null); setSelectedPageId(null); setView('chat');
    } catch (e) { setError(String(e)); }
  }

  if (!authChecked) return <div className="auth-loading">Coke Dots</div>;
  if (!authContext) return <LoginScreen googleConfigured={googleConfigured} e2eAuthAvailable={e2eAuthAvailable} />;

  const workSurface = ['activity', 'scheduled', 'computer', 'pages'].includes(view);
  const onboardingMode = view === 'chat' && !selectedTask && !hasConversationHistory && voiceCallsLoaded;
  const computerChoiceMode = onboardingMode && !state.computerAccess.configured;
  const contextMode = view === 'chat' && Boolean(selectedTask || hasConversationHistory);
  return <div className={`shell ${theme === 'dark' ? 'dots-dark' : ''} ${view === 'home' ? 'home-mode' : ''} ${view === 'chat' ? 'dot-chat-mode' : ''} ${contextMode ? 'dot-context-mode' : ''} ${onboardingMode ? 'dot-onboarding-mode' : ''} ${computerChoiceMode ? 'dot-computer-choice-mode' : ''} ${view === 'scheduled' ? 'scheduled-mode' : ''} ${view === 'chat' && selectedPageId ? 'page-open-mode' : ''}`} data-testid="app-shell" data-theme={theme} data-tenant-id={authContext.tenant.id} data-state-loaded={stateLoaded}>
    <aside className="icon-rail" aria-label="主导航">
      <button className={`rail-button ${view === 'home' ? 'selected' : ''}`} aria-label="新聊天" title="新聊天" onClick={() => { setSelectedPageId(null); setSelected(null); setView('home'); }}>⌂</button>
      <button className={`rail-button ${view === 'pages' ? 'selected' : ''}`} aria-label="Scratchpad" title="Scratchpad" onClick={() => { setSelectedPageId(null); setView('pages'); }}>▱</button>
      <button className={`rail-button ${view === 'activity' ? 'selected' : ''}`} aria-label="Activity" title="Activity" onClick={() => { setSelectedPageId(null); setView('activity'); }}>◷</button>
      <button className={`rail-button ${view === 'scheduled' ? 'selected' : ''}`} aria-label="Scheduled" title="Scheduled" onClick={() => { setSelectedPageId(null); setView('scheduled'); }}>◴</button>
      <button className={`rail-button ${view === 'computer' ? 'selected' : ''}`} aria-label="电脑" title="电脑" onClick={() => { setSelectedPageId(null); setView('computer'); }}>▣</button>
      <span className="rail-spacer" />
      <div className="account-menu-anchor" ref={accountMenuRef}>
        <button className="rail-user" data-testid="account-menu-trigger" aria-label="账户菜单" title="账户菜单" aria-haspopup="true" aria-expanded={accountMenuOpen} onClick={() => setAccountMenuOpen(value => !value)}><span className="account-avatar" aria-hidden="true">{initialsForUser(authContext.user.name, authContext.user.email)}</span></button>
        {accountMenuOpen && <section className="account-menu-popover" data-testid="account-menu" aria-label="账号与工作区">
          <div className="account-menu-identity"><strong>{authContext.user.name || authContext.user.email}</strong><small>{authContext.user.email}</small></div>
          <WorkspaceSwitcher auth={authContext} onSwitch={switchTenant} onCreate={createTenant} onError={message => setError(message)} />
          <button className="theme-toggle" data-testid="theme-toggle" aria-label={`切换到${theme === 'light' ? '深色' : '浅色'}主题`} aria-pressed={theme === 'dark'} title={`切换到${theme === 'light' ? '深色' : '浅色'}主题`} onClick={toggleTheme}><span aria-hidden="true">{theme === 'light' ? '◐' : '☀'}</span><span>{theme === 'light' ? '深色主题' : '浅色主题'}</span></button>
          <button className="account-menu-dot-settings" onClick={() => { setSelectedPageId(null); setView('profile'); setAccountMenuOpen(false); }}>Dot 设置</button>
          <button className="logout-button" onClick={() => void logout()}>退出</button>
        </section>}
      </div>
    </aside>
    <aside className="sidebar">
      <div className="sidebar-heading"><strong>ChatGPT</strong><span>⌄</span><button aria-label="搜索" title="搜索">⌕</button></div>
      <button className={`nav new-chat-link ${view === 'home' ? 'selected' : ''}`} aria-label="New chat" title="New chat" onClick={() => { setSelectedPageId(null); setSelected(null); setView('home'); }}>＋ <span>New chat</span></button>
      <button className={`nav ${view === 'chat' ? 'selected' : ''}`} aria-label="你的 dot" title="你的 dot" onClick={() => { setSelectedPageId(null); setView('chat'); setSelected(null); }}>◉ <span>你的 dot</span></button>
      <div className="side-caption">Pinned</div>
      <button className={`sidebar-item ${view === 'pages' ? 'selected' : ''}`} aria-label="Pinned Scratchpad" onClick={() => { setSelectedPageId(null); setView('pages'); }}>▱ <span>Scratchpad</span></button>
      <div className="side-caption recent-caption">Recent</div>
      <div className="task-links">{stateLoaded ? state.tasks.slice(0, 12).map(task => <button key={task.id} className={selected === task.id ? 'on' : ''} onClick={() => { setSelectedPageId(null); setView('chat'); setSelected(task.id); }}><span className={`status-dot ${task.status}`} />{task.title}</button>) : <span className="side-loading">恢复中…</span>}</div>
      <button className="profile-link" onClick={() => { setSelectedPageId(null); setView('profile'); }}><DotAvatar appearance={state.profile} small /><span><strong>{state.profile.name}</strong><small>{authContext.user.email}</small></span><span>⌄</span></button>
    </aside>
    <main className="main">
      <header className="topbar"><span className="topbar-title">{view === 'chat' ? selectedTask?.title || state.profile.name : view === 'activity' ? 'Activity' : view === 'computer' ? '电脑' : view === 'profile' ? '你的 dot' : view === 'pages' ? 'Your Personal Scratchpad' : ''}</span><div className="surface-switcher" data-testid="surface-switcher" role="group" aria-label="Chat 与 Work"><button aria-pressed={!workSurface} onClick={() => { const previous = lastChatLocation.current; setSelected(previous.selected); setSelectedPageId(previous.selectedPageId); setView(previous.view); }}>Chat</button><button aria-pressed={workSurface} onClick={() => { setSelectedPageId(null); setView('activity'); }}>Work</button></div></header>
      {invitations.length > 0 && <section className="invitation-banner" aria-label="工作区邀请">{invitations.map(invitation => <div className="invitation-banner-row" key={invitation.tenantId}><div><strong>工作区邀请：{invitation.tenantName}</strong><span>{invitation.email} · {invitation.role === 'admin' ? '管理员' : '成员'} · 有效期至 {new Date(invitation.expiresAt).toLocaleDateString('zh-CN')}</span></div><button onClick={() => void acceptInvitation(invitation)}>接受并打开工作区</button></div>)}</section>}
      {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError('')}>×</button></div>}
      {computerConnectedToast && <div className="computer-connected-toast" data-testid="computer-connected-toast" role="status"><span className="computer-connected-icon" aria-hidden="true">✓</span><span>The computer is connected to your dot</span><button type="button" aria-label="Dismiss notification" onClick={() => setComputerConnectedToast(false)}>×</button></div>}
      {(view === 'home' || view === 'chat') && <div className="chat-layout"><section className="chat-panel">
        {!stateLoaded ? <div className="workspace-loading" role="status">正在恢复工作区…</div> : view === 'home' ? <div className="welcome chat-home" data-testid="chat-home"><h1>What's on your mind today?</h1></div> : !voiceCallsLoaded ? <div className="workspace-loading" role="status">正在恢复工作区…</div> : !selectedTask && !hasConversationHistory ? <DotOnboarding profile={state.profile} computerAccess={state.computerAccess} onComputerAccess={saveComputerAccess} onEditSetup={openDotCustomizer} /> : <div className="timeline" ref={timelineRef} onScroll={() => { const timeline = timelineRef.current; if (timeline) timelineAtBottomRef.current = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight <= 48; }}>
          {!selectedTask && <div className="timeline-title">最近的对话和进度</div>}
          {timelineItems.map(item => item.source === 'entry'
            ? <article key={item.id} data-testid="chat-timeline-item" data-timestamp={item.at} className={`message ${item.entry.kind}`}><div className="message-avatar">{item.entry.kind === 'user' ? '你' : item.entry.kind === 'dot' ? <DotAvatar appearance={state.profile} small /> : '·'}</div><div><div className="message-name">{item.entry.kind === 'user' ? '你' : item.entry.kind === 'dot' ? state.profile.name : '系统'} <time>{new Date(item.entry.createdAt).toLocaleString('zh-CN')}</time></div><MessageBody body={item.entry.body} onOpenPage={id => openPage(id, item.entry.taskId)} />{Boolean(item.entry.attachments?.length) && <ul className="message-attachments" data-testid="message-attachments" aria-label="附加文件">{item.entry.attachments!.map(attachment => <li key={attachment.id}><span aria-hidden="true">▤</span><span>{attachment.name}</span></li>)}</ul>}</div></article>
            : <article key={item.id} data-testid="chat-timeline-item" data-timestamp={item.at} className="message voice-call-ended" data-call-id={item.call.id}><div className="voice-call-ended-chip"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7.1 3.8 10 7.2 8.2 9.1a13 13 0 0 0 6.7 6.7l1.9-1.8 3.4 2.9-.8 3.2a1.8 1.8 0 0 1-2 1.4C9 20.2 3.8 15 2.5 6.6a1.8 1.8 0 0 1 1.4-2z" fill="currentColor" /></svg>Me: Call ended</div><small>Optional</small></article>)}
          {selectedTask && <TaskControls task={selectedTask} act={act} onOpenComputer={() => setView('computer')} />}
        </div>}
        <div className="composer-wrap">
          {pendingAttachments.length > 0 && <ul className="pending-attachments" data-testid="pending-attachments" aria-label="待发送附件">{pendingAttachments.map(attachment => <li key={attachment.id} data-testid="pending-attachment"><span aria-hidden="true">▤</span><span className="attachment-name" title={attachment.name}>{attachment.name}</span><button type="button" aria-label={`移除附件 ${attachment.name}`} onClick={() => void removePendingAttachment(attachment)}>×</button></li>)}</ul>}
          <div className="composer"><input ref={attachmentInputRef} className="attachment-input" data-testid="attachment-input" type="file" multiple accept=".txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.xml,.html,.htm,.css,.js,.jsx,.ts,.tsx,.py,.go,.rs,.java,.sql,.sh,.toml,.ini,.log,.c,.h,.cpp,.hpp" onChange={event => void uploadAttachments(event.currentTarget.files)} /><button className="attachment-button" data-testid="attachment-button" type="button" onMouseDown={event => event.preventDefault()} aria-label="添加附件" title="添加附件" disabled={uploadingAttachments || pendingAttachments.length >= 5} onClick={() => attachmentInputRef.current?.click()}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg></button><textarea data-testid="task-composer" ref={composerRef} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } }} placeholder={view === 'home' ? 'Ask ChatGPT' : 'Type a message'} />{engine === 'model' && <label className="reasoning-picker" title="Reasoning effort"><select aria-label="Reasoning effort" data-testid="reasoning-effort" value={state.preferences.reasoningEffort} onChange={event => void updateReasoningEffort(event.target.value as ReasoningEffort)}><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra High</option></select><span aria-hidden="true">⌄</span></label>}<DictationButton draft={draft} setDraft={setDraft} onError={setError} textareaRef={composerRef} /><div className="composer-bottom"><label>内核 <select value={engine} onChange={e => setEngine(e.target.value as Engine)}>{(['model', 'pi', 'dsh'] as Engine[]).map(id => <option key={id} value={id}>{id === 'model' ? '模型 API' : id === 'pi' ? 'Pi' : 'DeepSeek Harness'}{state.availableEngines.includes(id) ? '' : ' · 未配置'}</option>)}</select></label><label className="schedule-toggle"><input type="checkbox" checked={schedule} onChange={e => setSchedule(e.target.checked)} /> 定期检查</label><button className="voice-call-launch" data-testid="voice-call-launch" type="button" onMouseDown={event => event.preventDefault()} aria-label={`拨打 ${state.profile.name}`} title={`拨打 ${state.profile.name}`} onClick={() => setVoiceCallOpen(true)}><svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true"><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg></button><button className="send" onMouseDown={event => event.preventDefault()} disabled={!stateLoaded || busy || !draft.trim()} onClick={() => void submit()}>↑</button></div>{schedule && <RecurrenceEditor frequency={frequency} setFrequency={setFrequency} minutes={minutes} setMinutes={setMinutes} time={scheduleTime} setTime={setScheduleTime} timeZone={scheduleTimeZone} setTimeZone={setScheduleTimeZone} weekdays={scheduleWeekdays} setWeekdays={setScheduleWeekdays} endDate={scheduleEndDate} setEndDate={setScheduleEndDate} />}</div><small className="hint">{state.remoteEngines.includes(engine) ? '任务由 Dot 的云电脑运行。' : state.availableEngines.includes(engine) ? '任务由本机后台处理。' : '所选内核未配置；新任务会显示失败并可在配置后重试。'}</small></div>
      </section>{view === 'chat' && selectedPageId ? <div className="scratchpad-page-split" data-testid="scratchpad-page-split"><ScratchpadNavigationPane tenantId={authContext.tenant.id} selectedPageId={selectedPageId} refreshKey={pageIndexVersion} onOpen={setSelectedPageId} onBack={() => { setSelectedPageId(null); setView('pages'); }} /><PagePane pageId={selectedPageId} tenantId={authContext.tenant.id} onBack={() => { setSelectedPageId(null); setView('pages'); }} onPageUpdated={() => setPageIndexVersion(version => version + 1)} /></div> : view === 'chat' && (selectedTask || hasConversationHistory) && <DotContextPanel profile={state.profile} state={state} tenantId={authContext.tenant.id} onOpenComputer={() => setView('computer')} onStartCall={() => setVoiceCallOpen(true)} onOpenSlack={() => setSlackModalOpen(true)} onOpenTeams={() => setTeamsModalOpen(true)} onSelectTask={taskId => { setSelected(taskId); setView('chat'); }} />}</div>}
      {view === 'pages' && (selectedPageId ? <PagePane pageId={selectedPageId} tenantId={authContext.tenant.id} full onBack={() => setSelectedPageId(null)} onPageUpdated={() => setPageIndexVersion(version => version + 1)} /> : <PagesView tenantId={authContext.tenant.id} onOpen={id => setSelectedPageId(id)} />)}
      {view === 'activity' && <ActivityView tenantId={authContext.tenant.id} profileName={state.profile.name} state={state} stateLoaded={stateLoaded} onSelectTask={taskId => { setSelected(taskId); setView('chat'); }} onOpenPage={openPage} />}
      {view === 'scheduled' && <ScheduledView tasks={state.tasks} watches={state.watches}
        onCancelTask={task => void act(task, 'cancelSchedule')}
        onSetTaskNotifications={setTaskCompletionNotification}
        onScheduleAction={actOnScheduledTask}
        onUpdateTaskSchedule={updateScheduledTask}
        onWatchAction={(watch, action) => void actWatch(watch.id, action)}
        onOpenTask={async task => {
          const response = await appFetch('/api/state');
          if (!response.ok) throw new Error('Unable to load the latest task state');
          const latest = await response.json() as Snapshot;
          if (!latest.tasks.some(item => item.id === task.id)) throw new Error('Task is no longer available');
          setState(latest);
          setSelected(task.id);
          setView('chat');
        }}
        onNewTask={() => { setSchedule(true); setView('chat'); requestAnimationFrame(() => composerRef.current?.focus()); }}
        onAddWatch={addScheduledWatch} />}
      {view === 'profile' && <Profile state={state} auth={authContext} onError={setError} onSetDotPaused={setDotPaused} onResetDot={returnToFreshDotChat} onEditAppearance={() => setAvatarEditorOpen(true)} onManageComputerAccess={() => setComputerAccessOpen(true)} onStartCall={() => setVoiceCallOpen(true)} />}
      {view === 'computer' && <ComputerView dotName={state.profile.name} localComputerEnabled={state.computerAccess.localComputer} onManageAccess={() => setComputerAccessOpen(true)} onError={setError} />}
    </main>
    {avatarSetupOpen && <DotSetupEditor profile={state.profile} onClose={() => setAvatarSetupOpen(false)} onSave={(appearance, name) => saveAvatarAppearance(appearance, name, false, true)} />}
    {computerAccessOpen && <DotComputerChoice localComputer={state.computerAccess.localComputer} mode="settings" onSave={saveComputerAccess} onCancel={() => setComputerAccessOpen(false)} />}
    {avatarEditorOpen && <DotAvatarEditor profile={state.profile} onClose={() => setAvatarEditorOpen(false)} onSave={(appearance, name) => saveAvatarAppearance(appearance, name, !state.profile.onboardingCompletedAt)} />}
    {voiceCallOpen && <VoiceCall dotName={state.profile.name} appearance={state.profile} onTranscript={submitVoiceTranscript} onClose={() => { setVoiceCallOpen(false); void refreshVoiceCalls().catch(reason => setError(reason instanceof Error ? reason.message : String(reason))); }} />}
    {slackModalOpen && authContext && <SlackSetupModal key={authContext.tenant.id} dotName={state.profile.name} canManage={['owner', 'admin'].includes(authContext.tenant.role)} onClose={() => setSlackModalOpen(false)} onConnectSlack={() => {
      try { sessionStorage.setItem('coke-dots:slack-return-state', JSON.stringify({ view, selected })); } catch { /* Restore the home view if session storage is unavailable. */ }
      window.location.assign(appPath('/api/slack/oauth/start'));
    }} />}
    {teamsModalOpen && authContext && <TeamsSetupModal key={authContext.tenant.id} dotName={state.profile.name} onClose={() => setTeamsModalOpen(false)} />}
  </div>;
}

function LoginScreen({ googleConfigured, e2eAuthAvailable }: { googleConfigured: boolean; e2eAuthAvailable: boolean }) {
  const [desktopPending, setDesktopPending] = useState(false);
  const [desktopError, setDesktopError] = useState('');
  const [e2eEmail, setE2eEmail] = useState('alpha@example.test');
  const isElectron = /Electron/i.test(navigator.userAgent);
  const authError = new URLSearchParams(window.location.search).get('authError');
  const authErrors: Record<string, string> = { cancelled: '你取消了登录。', expired: '登录请求已过期，请重试。', invalid: '登录返回信息无效。', invalid_identity: 'Google 身份验证未通过。', missing_identity: 'Google 没有返回身份令牌。', sign_in_failed: 'Google 登录失败，请检查配置后重试。' };
  async function beginDesktopLogin() {
    setDesktopError(''); setDesktopPending(true);
    const random = new Uint8Array(32); crypto.getRandomValues(random);
    const handoffToken = Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('');
    const authorization = new URL(appPath('/api/auth/desktop/start'), window.location.href);
    authorization.searchParams.set('handoffToken', handoffToken);
    const popup = window.open(authorization.toString(), '_blank');
    if (!popup && !isElectron) { setDesktopPending(false); setDesktopError('浏览器阻止了登录窗口，请允许弹出窗口后重试。'); return; }
    try {
      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const response = await appFetch('/api/auth/desktop/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handoffToken }) });
        const data = await response.json();
        if (response.status === 202) continue;
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        window.location.reload();
        return;
      }
      throw new Error('登录等待超时，请重试。');
    } catch (error) { setDesktopError(error instanceof Error ? error.message : String(error)); }
    finally { setDesktopPending(false); }
  }
  async function signInE2e() {
    setDesktopError('');
    try {
      const response = await appFetch('/api/auth/e2e/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e2eEmail }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      window.location.reload();
    } catch (error) { setDesktopError(error instanceof Error ? error.message : String(error)); }
  }
  return <main className="auth-page"><div className="auth-card"><div className="brand"><span className="brand-mark">●</span> Coke Dots</div><h1>让你的个人代理持续推进工作</h1><p>使用 Google 账号登录。每个工作区的任务、记录和浏览器会话相互隔离；此 Coke Dots 实例的模型 API 凭据由所有 Google 账号和工作区共用。</p>{authError && <div className="auth-error">{authErrors[authError] || '登录失败，请重试。'}</div>}{desktopError && <div className="auth-error">{desktopError}</div>}{googleConfigured ? isElectron ? <button className="google-login" disabled={desktopPending} onClick={() => void beginDesktopLogin()}><span>G</span>{desktopPending ? '等待浏览器完成登录…' : '使用 Google 登录'}</button> : <a className="google-login" href={appPath('/api/auth/google/start')}><span>G</span>使用 Google 登录</a> : <div className="auth-setup"><strong>登录暂未开放</strong><span>Google 登录配置完成后即可访问工作区。</span></div>}{e2eAuthAvailable && <div className="e2e-login"><label htmlFor="e2e-email">E2E 测试账号</label><input id="e2e-email" type="email" value={e2eEmail} onChange={event => setE2eEmail(event.target.value)} /><button data-testid="e2e-sign-in" className="google-login" onClick={() => void signInE2e()}>测试环境登录</button></div>}<small>仅申请基本身份信息；Coke Dots 不会取得 Gmail 或 Google Drive 权限。</small></div></main>;
}

function ActivityView({ tenantId, profileName, state, stateLoaded, onSelectTask, onOpenPage }: { tenantId: string; profileName: string; state: Snapshot; stateLoaded: boolean; onSelectTask: (taskId: string) => void; onOpenPage: (pageId: string, taskId?: string | null) => void }) {
  const tenantIdRef = useRef(tenantId);
  tenantIdRef.current = tenantId;
  const pageGeneration = useRef(0);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const generation = ++pageGeneration.current;
    let current = true;
    setLoading(true); setLoadingOlder(false); setError(''); setEntries([]); setNextCursor(null);
    void appFetch('/api/activity?limit=50').then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      return data as { entries: Entry[]; nextCursor: number | null };
    }).then(page => { if (current && generation === pageGeneration.current) { setEntries(page.entries); setNextCursor(page.nextCursor); } })
      .catch(reason => { if (current) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (current && generation === pageGeneration.current) setLoading(false); });
    return () => { current = false; };
  }, [tenantId, refreshKey]);

  useEffect(() => {
    if (loading || !state.entries.length) return;
    const oldestSnapshotEntryId = Math.min(...state.entries.map(entry => entry.id));
    setEntries(current => {
      const byId = new Map(current.map(entry => [entry.id, entry]));
      for (const entry of state.entries) byId.set(entry.id, entry);
      return [...byId.values()].sort((a, b) => b.id - a.id);
    });
    setNextCursor(current => state.entries.length < 150 ? null : current === null ? null : Math.min(current, oldestSnapshotEntryId));
  }, [state.entries, loading]);

  async function loadOlder() {
    if (nextCursor === null || loadingOlder) return;
    const requestedTenantId = tenantIdRef.current;
    const generation = pageGeneration.current;
    setLoadingOlder(true); setError('');
    try {
      const response = await appFetch(`/api/activity?limit=50&before=${nextCursor}`);
      const data = await response.json() as { entries?: Entry[]; nextCursor?: number | null; error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (requestedTenantId !== tenantIdRef.current || generation !== pageGeneration.current) return;
      setEntries(current => {
        const byId = new Map(current.map(entry => [entry.id, entry]));
        for (const entry of data.entries || []) byId.set(entry.id, entry);
        return [...byId.values()].sort((a, b) => b.id - a.id);
      });
      setNextCursor(data.nextCursor ?? null);
    } catch (reason) { if (requestedTenantId === tenantIdRef.current && generation === pageGeneration.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (requestedTenantId === tenantIdRef.current && generation === pageGeneration.current) setLoadingOlder(false); }
  }

  const tasks = new Map(state.tasks.map(task => [task.id, task]));
  const childrenByParent = new Map<string, Task[]>();
  for (const task of state.tasks) if (task.parentTaskId) childrenByParent.set(task.parentTaskId, [...(childrenByParent.get(task.parentTaskId) || []), task]);
  const activityTasks = state.tasks.filter(task => !task.parentTaskId).flatMap(task => [task, ...(childrenByParent.get(task.id) || [])]);
  return <section className="content activity-content">
    <div className="section-heading"><h1>Activity</h1><p>查看 dot 正在处理的工作、结果和需要你决定的事项。</p></div>
    <div className="cards">{!stateLoaded ? <div className="empty workspace-loading" role="status">正在加载工作区…</div> : !state.tasks.length ? <div className="empty">还没有任务。回到对话，交给 dot 第一项工作。</div> : activityTasks.map(task => {
      const parent = task.parentTaskId ? tasks.get(task.parentTaskId) : undefined;
      const children = childrenByParent.get(task.id) || [];
      const terminalChildren = children.filter(child => ['done', 'failed', 'stopped'].includes(child.status)).length;
      const description = task.executionMode === 'proactive-research' && ['queued', 'working'].includes(task.status)
        ? '正在检查近期工作之间是否存在有证据支持的联系。'
        : task.parentTaskId ? task.error || task.result || task.instruction
        : task.status === 'delegating' ? `${terminalChildren}/${children.length} 项子任务已结束。${task.result ? ` ${task.result}` : ''}`
          : task.error || task.result || task.instruction;
      return <div className={`task-card ${task.parentTaskId ? 'delegated-child' : ''}`} data-testid={`task-card-${task.id}`} key={task.id}>
      <div className="task-card-head"><span className={`pill ${task.status}`}>{statusText[task.status]}</span><time>{new Date(task.updatedAt).toLocaleString('zh-CN')}</time></div>
      {parent && <small className="delegated-from">委派自：{parent.title} · 内核：{engineText[task.engine]}</small>}
      {task.executionMode === 'proactive-research' && <small className="delegated-from">Dot 主动研究 · 只读</small>}
      <h2>{task.title}</h2><p>{description}</p>
      <div className="card-actions"><button onClick={() => onSelectTask(task.id)}>查看详情 →</button><TaskControls task={task} act={async (item, action, extra) => { try { await request(`/tasks/${item.id}`, 'PATCH', { action, ...extra }); } catch (reason) { setError(String(reason)); } }} compact /></div>
    </div>})}</div>
    <section className="activity-feed" data-testid="activity-feed" aria-label="Recent activity">
      <header><div><h2>Recent activity</h2><p>任务进度、用户方向和执行记录</p></div><button onClick={() => setRefreshKey(value => value + 1)} disabled={loading}>刷新</button></header>
      {error && <p className="activity-error" role="alert">{error}</p>}
      {loading ? <p className="activity-empty" role="status">正在加载活动记录…</p> : !entries.length ? <p className="activity-empty">还没有活动记录。</p> : <ol className="activity-list">{entries.map(entry => {
        const task = entry.taskId ? tasks.get(entry.taskId) : undefined;
        return <li className={`activity-entry ${entry.kind}`} data-testid="activity-entry" key={entry.id}>
          <div className="activity-entry-head"><strong>{entry.kind === 'user' ? '你' : entry.kind === 'dot' ? profileName : '系统'}</strong><time>{new Date(entry.createdAt).toLocaleString('zh-CN')}</time></div>
          <MessageBody body={entry.body} onOpenPage={pageId => onOpenPage(pageId, entry.taskId)} />
          {task && <button className="activity-open-task" onClick={() => onSelectTask(task.id)}>打开任务：{task.title} →</button>}
        </li>;
      })}</ol>}
      {nextCursor !== null && <button className="activity-load-older" onClick={() => void loadOlder()} disabled={loadingOlder}>{loadingOlder ? '正在加载…' : '加载更早记录'}</button>}
    </section>
  </section>;
}

function WorkspaceSwitcher({ auth, onSwitch, onCreate, onError }: { auth: AuthContext; onSwitch: (id: string) => Promise<void>; onCreate: (name: string) => Promise<void>; onError: (message: string) => void }) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  return <div className="workspace-switcher"><label><span>工作区</span><select value={auth.tenant.id} onChange={event => void onSwitch(event.target.value)}>{auth.tenants.map(tenant => <option key={tenant.id} value={tenant.id}>{tenant.name} · {tenant.role}</option>)}</select></label>{creating ? <form onSubmit={event => { event.preventDefault(); void onCreate(name.trim()).then(() => { setName(''); setCreating(false); }).catch(error => onError(String(error))); }}><input aria-label="新工作区名称" autoFocus maxLength={60} value={name} onChange={event => setName(event.target.value)} placeholder="工作区名称" /><button disabled={!name.trim()}>创建</button><button type="button" onClick={() => setCreating(false)}>取消</button></form> : <button className="new-workspace" onClick={() => setCreating(true)}>＋ 新建工作区</button>}</div>;
}

function TaskControls({ task, act, compact = false, onOpenComputer }: { task: Task; act: (task: Task, action: string, extra?: object) => Promise<void>; compact?: boolean; onOpenComputer?: () => void }) {
  const [redirect, setRedirect] = useState('');
  const [approval, setApproval] = useState<PageActionApproval | null>(null);
  const [approvalLoaded, setApprovalLoaded] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalError, setApprovalError] = useState('');
  const [signIn, setSignIn] = useState<WebsiteSignInRequest | null>(null);
  const [signInLoaded, setSignInLoaded] = useState(false);
  const [signInBusy, setSignInBusy] = useState(false);
  const [signInError, setSignInError] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  useEffect(() => {
    let active = true;
    setApproval(null); setApprovalLoaded(false); setApprovalError('');
    if (compact || task.status !== 'waiting') { setApprovalLoaded(true); return () => { active = false; }; }
    void appFetch(`/api/tasks/${task.id}/approval`).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (active) setApproval(data as PageActionApproval | null);
    }).catch(reason => { if (active) setApprovalError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (active) setApprovalLoaded(true); });
    return () => { active = false; };
  }, [task.id, task.status, compact]);
  useEffect(() => {
    let active = true;
    setSignIn(null); setSignInLoaded(false); setSignInError(''); setIdentifier(''); setPassword('');
    if (compact || task.status !== 'waiting') { setSignInLoaded(true); return () => { active = false; }; }
    void appFetch(`/api/tasks/${task.id}/sign-in`).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (active) setSignIn(data as WebsiteSignInRequest | null);
    }).catch(reason => { if (active) setSignInError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (active) setSignInLoaded(true); });
    return () => { active = false; };
  }, [task.id, task.status, compact]);
  async function decideApproval(decision: 'approve' | 'decline') {
    if (!approval?.canDecide) return;
    setApprovalBusy(true); setApprovalError('');
    try {
      const result = await request(`/tasks/${task.id}/approval`, 'POST', { decision }) as { approval: PageActionApproval };
      setApproval(result.approval);
    } catch (reason) { setApprovalError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setApprovalBusy(false); }
  }
  async function submitWebsiteSignIn(event: React.FormEvent) {
    event.preventDefault();
    if (!signIn || signIn.status !== 'pending') return;
    setSignInBusy(true); setSignInError('');
    try {
      const result = await request(`/tasks/${task.id}/sign-in/submit`, 'POST', { identifier, password }) as { signIn: WebsiteSignInRequest };
      setSignIn(result.signIn);
      setIdentifier(''); setPassword('');
      onOpenComputer?.();
    } catch (reason) { setSignInError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSignInBusy(false); setPassword(''); }
  }
  async function continueAfterSignIn() {
    setSignInBusy(true); setSignInError('');
    try {
      await request(`/tasks/${task.id}/sign-in/continue`, 'POST', {});
      setSignIn(null);
    } catch (reason) { setSignInError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSignInBusy(false); }
  }
  async function cancelWebsiteSignIn() {
    setSignInBusy(true); setSignInError('');
    try {
      const result = await request(`/tasks/${task.id}/sign-in/cancel`, 'POST', {}) as { signIn: WebsiteSignInRequest };
      setSignIn(result.signIn);
    } catch (reason) { setSignInError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSignInBusy(false); }
  }
  const hasRecurringSchedule = Boolean(task.scheduleSpec || task.scheduleMinutes !== null);
  const canStop = !hasRecurringSchedule && ['queued', 'working', 'delegating', 'waiting', 'scheduled', 'paused'].includes(task.status);
  const signInActive = Boolean(signIn && ['pending', 'submitted'].includes(signIn.status));
  return <div className={`task-controls ${compact ? 'compact' : ''}`}>
    {!compact && <span className={`pill ${task.status}`}>{statusText[task.status]}</span>}
    {!hasRecurringSchedule && ['working', 'queued', 'delegating', 'scheduled'].includes(task.status) && <button onClick={() => void act(task, 'pause')}>暂停</button>}
    {['paused', 'failed'].includes(task.status) && <button onClick={() => void act(task, task.status === 'failed' ? 'retry' : 'resume')}>{task.status === 'failed' ? '重试' : '继续'}</button>}
    {canStop && <button className="stop-task" title="停止后这项工作不能继续" onClick={() => void act(task, 'stop')}>停止工作</button>}
    {!compact && <>
      {task.status !== 'stopped' && <button onClick={() => void act(task, 'priority', { priority: task.priority + 1 })}>提高优先级</button>}
      {task.status === 'waiting' && !approvalLoaded && <small role="status" className="approval-loading">正在读取待审批操作…</small>}
      {approval?.status === 'pending' && <div className="page-approval" data-testid="page-action-approval">
        <div className="page-approval-heading"><strong>Scratchpad 页面写入等待批准</strong><small>批准后才会保存到当前工作区。</small></div>
        <div className="page-approval-proposal"><strong>{approval.action.action === 'create' ? '创建' : '更新'}：{approval.action.title}</strong><p>{approval.message}</p><pre>{approval.action.content}</pre></div>
        {approvalError && <small role="alert" className="approval-error">{approvalError}</small>}
        {approval.canDecide ? <div className="page-approval-actions"><button className="approve" disabled={approvalBusy} onClick={() => void decideApproval('approve')}>{approvalBusy ? '处理中…' : '批准并执行'}</button><button disabled={approvalBusy} onClick={() => void decideApproval('decline')}>拒绝并保持不变</button></div> : <small className="approval-error">此工作由其他账号发起，只有发起任务的账号可以批准或拒绝。</small>}
      </div>}
      {signIn && ['pending', 'submitted'].includes(signIn.status) && <section className="website-sign-in" data-testid="website-sign-in">
        <div className="website-sign-in-heading"><span aria-hidden="true">↗</span><div><strong>网站需要登录</strong><small>{signIn.hostname}</small><code className="website-sign-in-url">{signIn.url}</code></div></div>
        <p>{signIn.reason}</p>
        <p className="website-sign-in-safety">凭据通过当前工作区的受保护连接直接填入电脑，不会发给 Dot，也不会保存到任务记录。填入后请在电脑中检查页面并亲自提交。</p>
        {signInError && <small role="alert" className="website-sign-in-error">{signInError}</small>}
        {signIn.status === 'pending' ? <>
          <form onSubmit={event => void submitWebsiteSignIn(event)} className="website-sign-in-form" autoComplete="off">
            <label>账号或邮箱<input aria-label="登录账号或邮箱" autoComplete="off" value={identifier} onChange={event => setIdentifier(event.target.value)} maxLength={320} /></label>
            <label>密码<input aria-label="网站密码" type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} maxLength={4096} /></label>
            <button className="website-sign-in-primary" type="submit" disabled={signInBusy || !identifier.trim() || !password}>{signInBusy ? '正在发送到电脑…' : '安全填入并打开电脑'}</button>
          </form>
          <div className="website-sign-in-actions"><button type="button" disabled={signInBusy} onClick={onOpenComputer}>改为手动接管电脑</button><button type="button" disabled={signInBusy} onClick={() => void continueAfterSignIn()}>我已手动完成登录</button><button type="button" disabled={signInBusy} onClick={() => void cancelWebsiteSignIn()}>取消登录请求</button></div>
        </> : <>
          <div className="website-sign-in-submitted" role="status">登录信息已填入电脑。完成登录或 MFA 验证后，请交还电脑。</div>
          <div className="website-sign-in-actions"><button type="button" onClick={onOpenComputer}>打开电脑</button><button type="button" className="website-sign-in-primary" disabled={signInBusy} onClick={() => void continueAfterSignIn()}>{signInBusy ? '正在继续…' : '我已完成登录，继续工作'}</button></div>
        </>}
      </section>}
      {signInLoaded && !signInActive && signInError && <small role="alert" className="website-sign-in-error">{signInError}</small>}
      {approvalLoaded && !approval && !signInActive && task.status !== 'stopped' && <div className="redirect">
        <input aria-label={task.status === 'waiting' ? '回复 dot 的问题' : '调整这项工作的要求'} value={redirect} onChange={e => setRedirect(e.target.value)} placeholder={task.status === 'waiting' ? '回复 dot 的问题…' : '调整这项工作的要求'} />
        <button disabled={!redirect.trim()} onClick={() => {
          const action = task.status === 'waiting' ? 'reply' : 'redirect';
          const extra = task.status === 'waiting' ? { message: redirect } : { instruction: redirect };
          void act(task, action, extra);
          setRedirect('');
        }}>{task.status === 'waiting' ? '回复并继续' : '更新'}</button>
      </div>}
    </>}
  </div>;
}

function Profile({ state, auth, onError, onSetDotPaused, onResetDot, onEditAppearance, onManageComputerAccess, onStartCall }: { state: Snapshot; auth: AuthContext; onError: (s: string) => void; onSetDotPaused: (paused: boolean) => Promise<void>; onResetDot: () => void; onEditAppearance: () => void; onManageComputerAccess: () => void; onStartCall: () => void }) {
  const [name, setName] = useState(state.profile.name);
  const [baseUrl, setBaseUrl] = useState(state.modelSettings.baseUrl || 'https://api.openai.com/v1');
  const [model, setModel] = useState(state.modelSettings.model);
  const [apiKey, setApiKey] = useState('');
  const [desktopNotifications, setDesktopNotifications] = useState(state.preferences.desktopNotifications);
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [memberEmail, setMemberEmail] = useState('');
  const [members, setMembers] = useState<TenantMember[]>([]);
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
  const [memberNotice, setMemberNotice] = useState('');
  const [membersError, setMembersError] = useState('');
  const [memories, setMemories] = useState<TenantMemory[]>([]);
  const [memoryDraft, setMemoryDraft] = useState('');
  const [editingMemory, setEditingMemory] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState('');
  const [memoryError, setMemoryError] = useState('');
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [personalDotMemories, setPersonalDotMemories] = useState<PersonalDotMemory[]>([]);
  const [personalDotMemoryDraft, setPersonalDotMemoryDraft] = useState('');
  const [editingPersonalDotMemory, setEditingPersonalDotMemory] = useState<string | null>(null);
  const [editingPersonalDotMemoryDraft, setEditingPersonalDotMemoryDraft] = useState('');
  const [personalDotMemoryError, setPersonalDotMemoryError] = useState('');
  const [personalDotMemoryBusy, setPersonalDotMemoryBusy] = useState(false);
  const [dotMenuOpen, setDotMenuOpen] = useState(false);
  const [dotPauseBusy, setDotPauseBusy] = useState(false);
  const [dotResetOpen, setDotResetOpen] = useState(false);
  const [dotResetBusy, setDotResetBusy] = useState(false);
  const [dotResetError, setDotResetError] = useState('');
  const canManageDot = ['owner', 'admin'].includes(auth.tenant.role);
  const canManageModelSettings = state.modelSettings.canManage ?? canManageDot;
  const canResetDot = auth.tenant.kind === 'personal' && auth.tenant.role === 'owner' && members.length === 1 && members[0]?.id === auth.user.id;
  const refreshMembers = async () => {
    const response = await appFetch(`/api/tenants/${auth.tenant.id}/members`);
    if (!response.ok) throw new Error((await response.json()).error || `HTTP ${response.status}`);
    setMembers(await response.json() as TenantMember[]);
    if (['owner', 'admin'].includes(auth.tenant.role)) {
      const inviteResponse = await appFetch(`/api/tenants/${auth.tenant.id}/invitations`);
      if (!inviteResponse.ok) throw new Error((await inviteResponse.json()).error || `HTTP ${inviteResponse.status}`);
      setInvitations(await inviteResponse.json() as WorkspaceInvitation[]);
    } else setInvitations([]);
  };
  useEffect(() => { setName(state.profile.name); }, [state.profile.name]);
  useEffect(() => { setDotMenuOpen(false); }, [auth.tenant.id]);
  useEffect(() => { setDesktopNotifications(state.preferences.desktopNotifications); }, [state.preferences.desktopNotifications]);
  useEffect(() => { if (state.modelSettings.baseUrl) setBaseUrl(state.modelSettings.baseUrl); if (state.modelSettings.model) setModel(state.modelSettings.model); }, [state.modelSettings.baseUrl, state.modelSettings.model]);
  useEffect(() => { void refreshMembers().catch(error => setMembersError(String(error))); }, [auth.tenant.id]);
  useEffect(() => {
    let active = true;
    setMemoryDraft(''); setEditingMemory(null); setEditingDraft(''); setMemoryError(''); setMemories([]);
    void appFetch('/api/memories').then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (active) setMemories(data as TenantMemory[]);
    }).catch(error => { if (active) setMemoryError(String(error)); });
    return () => { active = false; };
  }, [auth.tenant.id]);
  useEffect(() => {
    let active = true;
    setPersonalDotMemories([]); setPersonalDotMemoryDraft(''); setEditingPersonalDotMemory(null); setEditingPersonalDotMemoryDraft(''); setPersonalDotMemoryError('');
    void appFetch('/api/dot-memories').then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (active) setPersonalDotMemories(data as PersonalDotMemory[]);
    }).catch(error => { if (active) setPersonalDotMemoryError(String(error)); });
    return () => { active = false; };
  }, [auth.user.id]);
  async function addMemory() {
    setMemoryBusy(true); setMemoryError('');
    try {
      const memory = await request('/memories', 'POST', { note: memoryDraft }) as TenantMemory;
      setMemories(current => [memory, ...current]); setMemoryDraft('');
    } catch (error) { setMemoryError(String(error)); }
    finally { setMemoryBusy(false); }
  }
  async function saveMemory(memory: TenantMemory) {
    setMemoryBusy(true); setMemoryError('');
    try {
      const updated = await request(`/memories/${memory.id}`, 'PATCH', { note: editingDraft }) as TenantMemory;
      setMemories(current => current.map(item => item.id === updated.id ? updated : item)); setEditingMemory(null); setEditingDraft('');
    } catch (error) { setMemoryError(String(error)); }
    finally { setMemoryBusy(false); }
  }
  async function removeMemory(memory: TenantMemory) {
    setMemoryBusy(true); setMemoryError('');
    try {
      const response = await appFetch(`/api/memories/${memory.id}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setMemories(current => current.filter(item => item.id !== memory.id));
    } catch (error) { setMemoryError(String(error)); }
    finally { setMemoryBusy(false); }
  }
  async function addPersonalDotMemory() {
    setPersonalDotMemoryBusy(true); setPersonalDotMemoryError('');
    try {
      const memory = await request('/dot-memories', 'POST', { note: personalDotMemoryDraft }) as PersonalDotMemory;
      setPersonalDotMemories(current => [memory, ...current]); setPersonalDotMemoryDraft('');
    } catch (error) { setPersonalDotMemoryError(String(error)); }
    finally { setPersonalDotMemoryBusy(false); }
  }
  async function savePersonalDotMemory(memory: PersonalDotMemory) {
    setPersonalDotMemoryBusy(true); setPersonalDotMemoryError('');
    try {
      const updated = await request(`/dot-memories/${memory.id}`, 'PATCH', { note: editingPersonalDotMemoryDraft }) as PersonalDotMemory;
      setPersonalDotMemories(current => current.map(item => item.id === updated.id ? updated : item)); setEditingPersonalDotMemory(null); setEditingPersonalDotMemoryDraft('');
    } catch (error) { setPersonalDotMemoryError(String(error)); }
    finally { setPersonalDotMemoryBusy(false); }
  }
  async function removePersonalDotMemory(memory: PersonalDotMemory) {
    setPersonalDotMemoryBusy(true); setPersonalDotMemoryError('');
    try {
      const response = await appFetch(`/api/dot-memories/${memory.id}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setPersonalDotMemories(current => current.filter(item => item.id !== memory.id));
    } catch (error) { setPersonalDotMemoryError(String(error)); }
    finally { setPersonalDotMemoryBusy(false); }
  }
  async function toggleDotPause() {
    if (dotPauseBusy || !canManageDot) return;
    setDotPauseBusy(true);
    try { await onSetDotPaused(!state.dotPaused); setDotMenuOpen(false); }
    catch (error) { onError(String(error)); }
    finally { setDotPauseBusy(false); }
  }

  async function confirmDotReset() {
    if (dotResetBusy || !canResetDot) return;
    setDotResetBusy(true); setDotResetError('');
    try {
      await request('/dot/reset', 'POST', { confirm: true });
      setDotResetOpen(false);
      onResetDot();
    } catch (error) { setDotResetError(error instanceof Error ? error.message : String(error)); }
    finally { setDotResetBusy(false); }
  }
  return <section className="content profile-content">
    <div className="section-heading dot-profile-heading"><div><h1>你的 dot</h1><p>给它起个名字，选择一个外观。</p></div><div className="dot-control-menu"><button type="button" className="dot-control-menu-trigger" aria-label="Dot options" aria-haspopup="menu" aria-expanded={dotMenuOpen} onClick={() => setDotMenuOpen(value => !value)}>•••</button>{dotMenuOpen && <div className="dot-control-menu-popover" role="menu"><button type="button" role="menuitem" data-testid="dot-pause-action" disabled={dotPauseBusy || !canManageDot} onClick={() => void toggleDotPause()}>{dotPauseBusy ? 'Saving…' : state.dotPaused ? 'Paused • Tap to resume' : 'Pause'}</button>{canResetDot && <button type="button" role="menuitem" data-testid="dot-reset-action" onClick={() => { setDotMenuOpen(false); setDotResetError(''); setDotResetOpen(true); }}>Reset</button>}{!canManageDot && <small>只有工作区所有者或管理员可以更改 Dot 状态。</small>}{auth.tenant.kind === 'personal' && auth.tenant.role === 'owner' && members.length > 1 && <small>此个人工作区已有其他成员；为保护共享数据，暂不可重置。</small>}</div>}</div></div>
    <div className="profile-card">
      <DotAvatar appearance={state.profile} />
      <button type="button" className="primary" data-testid="profile-voice-call-launch" aria-label={`拨打 ${state.profile.name}`} onClick={onStartCall}>拨打 {state.profile.name}</button>
      <button type="button" className="avatar-profile-customize" onClick={onEditAppearance}>Customize your dot</button>
      <label>名字<input maxLength={40} value={name} onChange={e => setName(e.target.value)} /></label>
      <button className="primary" onClick={async () => { try { await request('/profile', 'PATCH', { name }); } catch (e) { onError(String(e)); } }}>保存更改</button>
    </div>
    <div className="section-heading model-heading"><h2>电脑访问</h2><p>管理 Dot 是否可以使用本机上的隔离 Chrome 工作区。</p></div>
    <div className="profile-card model-card computer-access-card">
      <p>{state.computerAccess.localComputer ? '已允许 Dot 使用本机隔离 Chrome 工作区。' : '已关闭本机 Chrome 工作区访问。'}</p>
      <small>当前版本不连接 Mac 文件或其他应用。</small>
      <button className="primary" disabled={!['owner', 'admin'].includes(auth.tenant.role)} onClick={onManageComputerAccess}>更改电脑访问</button>
      {!['owner', 'admin'].includes(auth.tenant.role) && <small>只有工作区所有者或管理员可以更改此设置。</small>}
    </div>
    <div className="section-heading model-heading"><h2>通知</h2><p>后台工作需要你处理或完成时，在这台 Mac 上提醒你。</p></div>
    <div className="profile-card model-card notification-card">
      <label className="notification-toggle"><input aria-label="桌面通知" type="checkbox" checked={desktopNotifications} disabled={notificationBusy} onChange={async event => { const enabled = event.currentTarget.checked; setNotificationBusy(true); setDesktopNotifications(enabled); try { await request('/preferences', 'PATCH', { desktopNotifications: enabled }); } catch (error) { setDesktopNotifications(!enabled); onError(String(error)); } finally { setNotificationBusy(false); } }} /><span><strong>桌面通知</strong><small>{desktopNotifications ? '此工作区已开启任务和网页监控提醒。' : '此工作区的提醒目前关闭。'}</small></span></label>
      <small className="notification-note">通知只显示 Dot 名称和事项状态，不包含任务结果正文。</small>
    </div>
    <div className="section-heading model-heading"><h2>工作区记忆</h2><p>你明确保存的偏好、决定和背景会提供给此工作区中的 Dot 任务。成员可查看；创建者和管理员可编辑或删除。不会自动从聊天中提取。</p></div>
    <div className="profile-card model-card memory-card" data-testid="memory-manager">
      <div className="memory-list" aria-label="已保存的工作区记忆">
        {memories.map(memory => {
          const canManage = memory.createdBy === auth.user.id || ['owner', 'admin'].includes(auth.tenant.role);
          return <article className="memory-row" data-testid="memory-row" key={memory.id}>
            {editingMemory === memory.id ? <>
              <label>编辑这条记忆<textarea aria-label="编辑这条记忆" maxLength={1000} value={editingDraft} onChange={event => setEditingDraft(event.target.value)} /></label>
              <div className="memory-actions"><button className="primary" disabled={memoryBusy || !editingDraft.trim()} onClick={() => void saveMemory(memory)}>保存记忆</button><button disabled={memoryBusy} onClick={() => { setEditingMemory(null); setEditingDraft(''); }}>取消</button></div>
            </> : <>
              <p>{memory.note}</p><small>由 {memory.createdByName} 保存</small>
              {canManage && <div className="memory-actions"><button aria-label={`编辑记忆：${memory.note}`} disabled={memoryBusy} onClick={() => { setEditingMemory(memory.id); setEditingDraft(memory.note); }}>编辑</button><button aria-label={`删除记忆：${memory.note}`} disabled={memoryBusy} onClick={() => void removeMemory(memory)}>删除</button></div>}
            </>}
          </article>;
        })}
        {memories.length === 0 && <small data-testid="empty-memory-list">还没有保存的记忆。</small>}
      </div>
      <label>添加一条 Dot 应记住的信息<textarea aria-label="添加记忆" maxLength={1000} value={memoryDraft} onChange={event => setMemoryDraft(event.target.value)} placeholder="例如：回答时优先使用中文，日期按北京时间表达。" /></label>
      <button className="primary" disabled={memoryBusy || !memoryDraft.trim() || memories.length >= 20} onClick={() => void addMemory()}>添加记忆</button>
      <small>每个工作区最多 20 条，每条最多 1000 个字符。</small>
      {memoryError && <small role="alert" className="member-error">{memoryError}</small>}
    </div>
    <div className="section-heading model-heading"><h2>Dot 的私有记忆</h2><p>Dot 可根据你在个人工作区直接表达的长期偏好、决定和持续事项更新这些笔记。它们只属于你的账号，不会加入共享工作区；你可以随时编辑或删除。</p></div>
    <div className="profile-card model-card memory-card" data-testid="personal-dot-memory-manager">
      <div className="memory-list" aria-label="Dot 的私有记忆">
        {personalDotMemories.map(memory => <article className="memory-row" data-testid="personal-dot-memory-row" key={memory.id}>
          {editingPersonalDotMemory === memory.id ? <>
            <label>编辑这条私有记忆<textarea aria-label="编辑私有记忆" maxLength={1000} value={editingPersonalDotMemoryDraft} onChange={event => setEditingPersonalDotMemoryDraft(event.target.value)} /></label>
            <div className="memory-actions"><button className="primary" disabled={personalDotMemoryBusy || !editingPersonalDotMemoryDraft.trim()} onClick={() => void savePersonalDotMemory(memory)}>保存记忆</button><button disabled={personalDotMemoryBusy} onClick={() => { setEditingPersonalDotMemory(null); setEditingPersonalDotMemoryDraft(''); }}>取消</button></div>
          </> : <>
            <p>{memory.note}</p><small>{memory.sourceTaskId ? 'Dot 从个人对话中更新' : '你手动保存'}</small>
            <div className="memory-actions"><button aria-label={`编辑私有记忆：${memory.note}`} disabled={personalDotMemoryBusy} onClick={() => { setEditingPersonalDotMemory(memory.id); setEditingPersonalDotMemoryDraft(memory.note); }}>编辑</button><button aria-label={`删除私有记忆：${memory.note}`} disabled={personalDotMemoryBusy} onClick={() => void removePersonalDotMemory(memory)}>删除</button></div>
          </>}
        </article>)}
        {personalDotMemories.length === 0 && <small data-testid="empty-personal-dot-memory-list">Dot 还没有保存私有记忆。</small>}
      </div>
      <label>添加一条只属于你的记忆<textarea aria-label="添加私有记忆" maxLength={1000} value={personalDotMemoryDraft} onChange={event => setPersonalDotMemoryDraft(event.target.value)} placeholder="例如：我偏好简短的中文进展摘要。" /></label>
      <button className="primary" disabled={personalDotMemoryBusy || !personalDotMemoryDraft.trim() || personalDotMemories.length >= 20} onClick={() => void addPersonalDotMemory()}>添加私有记忆</button>
      <small>这些记忆只会提供给你个人工作区中的 Dot，每个账号最多 20 条。</small>
      {personalDotMemoryError && <small role="alert" className="member-error">{personalDotMemoryError}</small>}
    </div>
    <PermissionRules userId={auth.user.id} />
    <div className="section-heading model-heading"><h2>工作区成员</h2><p>所有成员都必须使用对应 Google 账号登录并接受邀请后才能访问。邀请 7 天后过期；Coke Dots 不会代发邮件，请通过其他方式通知对方。当前角色：{auth.tenant.role}。</p></div>
    <div className="profile-card model-card">
      <div className="member-list">{members.map(member => <div className="member-row" key={member.id}>
        <span><strong>{member.name}</strong><small>{member.email}</small></span>
        <span className="member-role">{member.role === 'owner' ? '所有者' : member.role === 'admin' ? '管理员' : '成员'}</span>
        {['owner', 'admin'].includes(auth.tenant.role) && member.role !== 'owner' && <button onClick={async () => { try { const response = await appFetch(`/api/tenants/${auth.tenant.id}/members/${member.id}`, { method: 'DELETE' }); const data = await response.json(); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); await refreshMembers(); } catch (error) { setMembersError(String(error)); } }}>移除</button>}
      </div>)}</div>
      {invitations.length > 0 && <div className="member-invitations" role="region" aria-label="待接受邀请"><strong>待接受邀请</strong>{invitations.map(invitation => <div className="member-row pending-invitation" key={invitation.email}>
        <span><strong>{invitation.email}</strong><small>有效期至 {new Date(invitation.expiresAt).toLocaleDateString('zh-CN')}</small></span>
        <span className="member-role">{invitation.role === 'admin' ? '管理员' : '成员'}</span>
        <button aria-label={`撤销 ${invitation.email} 的邀请`} onClick={async () => { try { const response = await appFetch(`/api/tenants/${auth.tenant.id}/invitations/${encodeURIComponent(invitation.email)}`, { method: 'DELETE' }); const data = await response.json(); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); await refreshMembers(); } catch (error) { setMembersError(String(error)); } }}>撤销</button>
      </div>)}</div>}
      <label>Google 账号邮箱<input type="email" value={memberEmail} onChange={e => { setMemberEmail(e.target.value); setMemberNotice(''); }} placeholder="teammate@example.com" /></label>
      <button className="primary" disabled={!['owner', 'admin'].includes(auth.tenant.role) || !memberEmail.trim()} onClick={async () => { try { const result = await request(`/tenants/${auth.tenant.id}/members`, 'POST', { email: memberEmail, role: 'member' }) as { invited: boolean }; setMemberEmail(''); setMembersError(''); setMemberNotice(result.invited ? '邀请已创建。对方在 Coke Dots 登录同一 Google 账号后，会看到待接受邀请。' : '成员已加入工作区。'); await refreshMembers(); } catch (e) { onError(String(e)); } }}>添加工作区成员</button>
      {memberNotice && <small role="status">{memberNotice}</small>}
      {membersError && <small className="member-error">{membersError}</small>}
      {!['owner', 'admin'].includes(auth.tenant.role) && <small>只有工作区所有者或管理员可以添加成员。</small>}
    </div>
    <div className="section-heading model-heading"><h2>模型 API</h2><p>模型 API 配置保存在系统钥匙串，由此 Coke Dots 实例下的所有 Google 账号和工作区共用。模型 API、Pi 和 DeepSeek Harness 都复用这套凭据，各账号的任务与运行目录仍彼此隔离。</p></div>
    <div className="profile-card model-card">
      <label>API 地址<input value={baseUrl} disabled={!canManageModelSettings} onChange={e => setBaseUrl(e.target.value)} /></label>
      <label>模型名称<input value={model} disabled={!canManageModelSettings} onChange={e => setModel(e.target.value)} /></label>
      <label>API 密钥<input type="password" autoComplete="off" disabled={!canManageModelSettings} placeholder={state.modelSettings.hasKey ? '已保存；留空则保持不变' : '输入密钥'} value={apiKey} onChange={e => setApiKey(e.target.value)} /></label>
      <button className="primary" disabled={!canManageModelSettings} onClick={async () => { try { await request('/model-settings', 'PATCH', { baseUrl, model, apiKey }); setApiKey(''); } catch (e) { onError(String(e)); } }}>保存模型设置</button>
      {!canManageModelSettings && <small>模型 API 凭据由 Coke Dots 实例管理员统一管理，所有账号都可以使用。</small>}
    </div>
    {dotResetOpen && <div className="dot-reset-overlay" data-testid="dot-reset-overlay"><section className="dot-reset-dialog" role="dialog" aria-modal="true" aria-labelledby="dot-reset-title" onKeyDown={event => { if (event.key === 'Escape' && !dotResetBusy) setDotResetOpen(false); }}>
      <h2 id="dot-reset-title">Reset this dot?</h2>
      <p>This permanently deletes this Dot’s conversations, activity, scheduled tasks, website monitors, saved memories, Scratchpad pages, and isolated computer data.</p>
      <p>Your Google sign-in, personal workspace, and model API configuration will remain. Reset won’t undo changes already made in connected apps or recall messages already delivered.</p>
      {dotResetError && <small role="alert" className="dot-reset-error">{dotResetError}</small>}
      <div className="dot-reset-actions"><button type="button" disabled={dotResetBusy} onClick={() => setDotResetOpen(false)}>Cancel</button><button type="button" className="dot-reset-confirm" data-testid="dot-reset-confirm" disabled={dotResetBusy} onClick={() => void confirmDotReset()}>{dotResetBusy ? 'Resetting…' : 'Reset'}</button></div>
    </section></div>}
  </section>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
