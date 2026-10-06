import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DotAppearance, Engine, Entry, PageActionApproval, ScheduleSpec, Snapshot, Task, TaskStatus } from '../shared/types.ts';
import './style.css';
import './theme-base.css';
import './chat-theme.css';
import './watch.css';
import './dark-theme.css';
import './avatar-editor.css';
import './onboarding.css';
import './notification.css';
import './activity.css';
import './scheduled.css';
import './recurrence.css';
import './pages.css';
import { ComputerView } from './ComputerView.tsx';
import { DotContextPanel } from './DotContextPanel.tsx';
import { ScheduledView } from './ScheduledView.tsx';
import { PagePane, PagesView, ScratchpadNavigationPane } from './Pages.tsx';
import { PermissionRules } from './PermissionRules.tsx';
import { DotOnboarding } from './DotOnboarding.tsx';
import { DotAvatar } from './DotAvatar.tsx';
import { DotAvatarEditor } from './DotAvatarEditor.tsx';
import { DotSetupEditor } from './DotSetupEditor.tsx';
import { DotComputerChoice } from './DotComputerChoice.tsx';
import './shell-replica.css';
import './onboarding-replica.css';
import './computer-choice.css';

const initial: Snapshot = { profile: { name: 'Dot', shape: 'circle', color: '#c8cbd5', eyes: 'dot', glasses: 'none', accessory: 'none', character: 'ring', pet: 'moss', avatarSetupCompletedAt: null, onboardingCompletedAt: null, onboardingCompletedName: null }, preferences: { desktopNotifications: false }, computerAccess: { dotComputer: true, localComputer: true, configured: false }, tasks: [], watches: [], entries: [], configured: false, availableEngines: [], modelSettings: { baseUrl: '', model: '', hasKey: false } };
interface AuthContext { user: { id: string; email: string; name: string }; tenant: { id: string; name: string; role: string; kind: string }; tenants: { id: string; name: string; role: string; kind: string }[] }
type Theme = 'light' | 'dark';
interface TenantMember { id: string; email: string; name: string; role: string }
interface WorkspaceInvitation { tenantId: string; tenantName?: string; email: string; role: string; invitedAt: string; expiresAt: string }
interface TenantMemory { id: string; tenantId: string; note: string; createdBy: string; createdByName: string; createdAt: string; updatedAt: string }
const statusText: Record<TaskStatus, string> = {
  queued: '排队中', working: '工作中', delegating: '并行处理中', waiting: '等待你', scheduled: '已安排', done: '已完成', failed: '失败', paused: '已暂停', stopped: '已停止',
};
const engineText: Record<Engine, string> = { model: '模型 API', claude: 'Claude Code', pi: 'Pi', dsh: 'DeepSeek Harness' };

async function request(path: string, method: 'POST' | 'PATCH', body: object) {
  const response = await fetch(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
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
  const [avatarEditorOpen, setAvatarEditorOpen] = useState(false);
  const [avatarSetupOpen, setAvatarSetupOpen] = useState(false);
  const [computerAccessOpen, setComputerAccessOpen] = useState(false);
  const [computerConnectedToast, setComputerConnectedToast] = useState(false);
  const [view, setView] = useState<'home' | 'chat' | 'activity' | 'scheduled' | 'computer' | 'profile' | 'pages'>('home');
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const lastChatLocation = useRef<{ view: 'home' | 'chat'; selected: string | null; selectedPageId: string | null }>({ view: 'home', selected: null, selectedPageId: null });
  const [pageIndexVersion, setPageIndexVersion] = useState(0);
  const [draft, setDraft] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
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
    void fetch('/api/auth/me').then(async response => response.ok ? await response.json() as AuthContext : null)
      .then(setAuthContext).catch(() => setAuthContext(null)).finally(() => setAuthChecked(true));
    void fetch('/api/auth/config').then(response => response.json()).then(data => { setGoogleConfigured(Boolean(data.googleConfigured)); setE2eAuthAvailable(Boolean(data.e2eAuthAvailable)); }).catch(() => { setGoogleConfigured(false); setE2eAuthAvailable(false); });
  }, []);

  useEffect(() => {
    if (!authContext) { setInvitations([]); return; }
    const refresh = () => void fetch('/api/auth/invitations').then(async response => response.ok ? await response.json() as WorkspaceInvitation[] : [])
      .then(setInvitations).catch(() => setInvitations([]));
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => window.clearInterval(timer);
  }, [authContext?.user.id]);

  useEffect(() => {
    if (!authContext) { setTheme('light'); return; }
    try {
      setTheme(localStorage.getItem(`coke-dots:theme:${authContext.user.id}`) === 'dark' ? 'dark' : 'light');
    } catch {
      setTheme('light');
    }
  }, [authContext?.user.id]);

  useEffect(() => {
    if (!computerConnectedToast) return;
    const timer = window.setTimeout(() => setComputerConnectedToast(false), 5000);
    return () => window.clearTimeout(timer);
  }, [computerConnectedToast]);

  useEffect(() => {
    if (!authContext) return;
    setStateLoaded(false);
    const stream = new EventSource('/api/events');
    stream.onmessage = event => { setState(JSON.parse(event.data)); setStateLoaded(true); };
    stream.onerror = () => {
      setError('与本机服务的连接已断开，正在重连。');
      void fetch('/api/auth/me').then(response => response.ok ? response.json() as Promise<AuthContext> : null).then(next => { if (!next) setAuthContext(null); }).catch(() => setAuthContext(null));
    };
    return () => stream.close();
  }, [authContext?.tenant.id]);

  const selectedTask = state.tasks.find(t => t.id === selected) || null;
  const entries = useMemo(() => selected ? state.entries.filter(e => e.taskId === selected) : state.entries, [state.entries, selected]);
  const active = state.tasks.filter(t => ['queued', 'working', 'waiting', 'scheduled'].includes(t.status));

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

  async function submit() {
    if (!draft.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const scheduleSpec: ScheduleSpec | null = !schedule ? null : frequency === 'interval'
        ? { frequency, intervalMinutes: minutes }
        : frequency === 'daily'
          ? { frequency, time: scheduleTime, timeZone: scheduleTimeZone, endDate: scheduleEndDate || null }
          : { frequency, weekdays: scheduleWeekdays, time: scheduleTime, timeZone: scheduleTimeZone, endDate: scheduleEndDate || null };
      const task = await request('/tasks', 'POST', { instruction: draft, scheduleSpec, scheduleMinutes: schedule && frequency === 'interval' ? minutes : null, engine }) as Task;
      setDraft(''); setSelected(task.id); setSelectedPageId(null); setView('chat'); setSchedule(false); setFrequency('interval'); setMinutes(60); setScheduleWeekdays([]); setScheduleEndDate('');
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  async function act(task: Task, action: string, extra: object = {}) {
    try { setError(''); await request(`/tasks/${task.id}`, 'PATCH', { action, ...extra }); }
    catch (e) { setError(String(e)); }
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
    if (authContext?.tenant.id === tenantId) return;
    try {
      const response = await fetch('/api/auth/tenant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setAuthContext(data as AuthContext); setState(initial); setStateLoaded(false); setSelected(null); setSelectedPageId(null); setError('');
    } catch (e) { setError(String(e)); }
  }

  async function createTenant(name: string) {
    const response = await fetch('/api/tenants', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    const refreshed = await fetch('/api/auth/me');
    if (refreshed.ok) setAuthContext(await refreshed.json() as AuthContext);
    setState(initial); setStateLoaded(false); setSelected(null); setSelectedPageId(null);
  }

  async function logout() {
    try { await fetch('/api/auth/logout', { method: 'POST' }); }
    finally { setAuthContext(null); setState(initial); setSelectedPageId(null); }
  }

  async function acceptInvitation(invitation: WorkspaceInvitation) {
    try {
      setError('');
      const response = await fetch(`/api/auth/invitations/${invitation.tenantId}/accept`, { method: 'POST' });
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
  const onboardingMode = view === 'chat' && !selectedTask && entries.length === 0;
  const computerChoiceMode = onboardingMode && !state.computerAccess.configured;
  const contextMode = view === 'chat' && Boolean(selectedTask || entries.length > 0);
  return <div className={`shell ${theme === 'dark' ? 'dots-dark' : ''} ${view === 'home' ? 'home-mode' : ''} ${view === 'chat' ? 'dot-chat-mode' : ''} ${contextMode ? 'dot-context-mode' : ''} ${onboardingMode ? 'dot-onboarding-mode' : ''} ${computerChoiceMode ? 'dot-computer-choice-mode' : ''} ${view === 'scheduled' ? 'scheduled-mode' : ''} ${view === 'chat' && selectedPageId ? 'page-open-mode' : ''}`} data-testid="app-shell" data-theme={theme} data-tenant-id={authContext.tenant.id} data-state-loaded={stateLoaded}>
    <aside className="icon-rail" aria-label="主导航">
      <button className={`rail-button ${view === 'home' ? 'selected' : ''}`} aria-label="新聊天" title="新聊天" onClick={() => { setSelectedPageId(null); setSelected(null); setView('home'); }}>⌂</button>
      <button className={`rail-button ${view === 'pages' ? 'selected' : ''}`} aria-label="Scratchpad" title="Scratchpad" onClick={() => { setSelectedPageId(null); setView('pages'); }}>▱</button>
      <button className={`rail-button ${view === 'activity' ? 'selected' : ''}`} aria-label="Activity" title="Activity" onClick={() => { setSelectedPageId(null); setView('activity'); }}>◷</button>
      <button className={`rail-button ${view === 'scheduled' ? 'selected' : ''}`} aria-label="Scheduled" title="Scheduled" onClick={() => { setSelectedPageId(null); setView('scheduled'); }}>◴</button>
      <button className={`rail-button ${view === 'computer' ? 'selected' : ''}`} aria-label="电脑" title="电脑" onClick={() => { setSelectedPageId(null); setView('computer'); }}>▣</button>
      <span className="rail-spacer" />
      <button className="rail-user" aria-label="你的 dot 设置" title="你的 dot 设置" onClick={() => { setSelectedPageId(null); setView('profile'); }}><DotAvatar appearance={state.profile} small /></button>
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
      <header className="topbar"><span className="topbar-title">{view === 'chat' ? selectedTask?.title || state.profile.name : view === 'activity' ? 'Activity' : view === 'computer' ? '电脑' : view === 'profile' ? '你的 dot' : view === 'pages' ? 'Your Personal Scratchpad' : ''}</span><div className="surface-switcher" data-testid="surface-switcher" role="group" aria-label="Chat 与 Work"><button aria-pressed={!workSurface} onClick={() => { const previous = lastChatLocation.current; setSelected(previous.selected); setSelectedPageId(previous.selectedPageId); setView(previous.view); }}>Chat</button><button aria-pressed={workSurface} onClick={() => { setSelectedPageId(null); setView('activity'); }}>Work</button></div><div className="top-actions"><button className="theme-toggle" data-testid="theme-toggle" aria-label={`切换到${theme === 'light' ? '深色' : '浅色'}主题`} aria-pressed={theme === 'dark'} title={`切换到${theme === 'light' ? '深色' : '浅色'}主题`} onClick={toggleTheme}><span aria-hidden="true">{theme === 'light' ? '◐' : '☀'}</span><span>{theme === 'light' ? '深色' : '浅色'}</span></button><WorkspaceSwitcher auth={authContext} onSwitch={switchTenant} onCreate={createTenant} onError={message => setError(message)} /><button className="logout-button" onClick={() => void logout()}>退出</button><span className="top-status"><span className="online" />本机运行中</span></div></header>
      {invitations.length > 0 && <section className="invitation-banner" aria-label="工作区邀请">{invitations.map(invitation => <div className="invitation-banner-row" key={invitation.tenantId}><div><strong>工作区邀请：{invitation.tenantName}</strong><span>{invitation.email} · {invitation.role === 'admin' ? '管理员' : '成员'} · 有效期至 {new Date(invitation.expiresAt).toLocaleDateString('zh-CN')}</span></div><button onClick={() => void acceptInvitation(invitation)}>接受并打开工作区</button></div>)}</section>}
      {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError('')}>×</button></div>}
      {computerConnectedToast && <div className="computer-connected-toast" data-testid="computer-connected-toast" role="status"><span className="computer-connected-icon" aria-hidden="true">✓</span><span>The computer is connected to your dot</span><button type="button" aria-label="Dismiss notification" onClick={() => setComputerConnectedToast(false)}>×</button></div>}
      {(view === 'home' || view === 'chat') && <div className="chat-layout"><section className="chat-panel">
        {!stateLoaded ? <div className="workspace-loading" role="status">正在恢复工作区…</div> : view === 'home' ? <div className="welcome chat-home" data-testid="chat-home"><h1>What’s on your mind today?</h1></div> : !selectedTask && entries.length === 0 ? <DotOnboarding profile={state.profile} computerAccess={state.computerAccess} onComputerAccess={saveComputerAccess} onEditSetup={openDotCustomizer} /> : <div className="timeline">
          {!selectedTask && <div className="timeline-title">最近的对话和进度</div>}
          {entries.map(entry => <article key={entry.id} className={`message ${entry.kind}`}><div className="message-avatar">{entry.kind === 'user' ? '你' : entry.kind === 'dot' ? <DotAvatar appearance={state.profile} small /> : '·'}</div><div><div className="message-name">{entry.kind === 'user' ? '你' : entry.kind === 'dot' ? state.profile.name : '系统'} <time>{new Date(entry.createdAt).toLocaleString('zh-CN')}</time></div><MessageBody body={entry.body} onOpenPage={id => openPage(id, entry.taskId)} /></div></article>)}
          {selectedTask && <TaskControls task={selectedTask} act={act} />}
        </div>}
        <div className="composer-wrap"><div className="composer"><textarea data-testid="task-composer" ref={composerRef} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } }} placeholder={view === 'home' ? 'Ask ChatGPT' : 'Type a message'} /><div className="composer-bottom"><label>内核 <select value={engine} onChange={e => setEngine(e.target.value as Engine)}>{(['model', 'claude', 'pi', 'dsh'] as Engine[]).map(id => <option key={id} value={id}>{id === 'model' ? '模型 API' : id === 'claude' ? 'Claude Code' : id === 'pi' ? 'Pi' : 'DeepSeek Harness'}{state.availableEngines.includes(id) ? '' : ' · 未配置'}</option>)}</select></label><label className="schedule-toggle"><input type="checkbox" checked={schedule} onChange={e => setSchedule(e.target.checked)} /> 定期检查</label><button className="send" disabled={!stateLoaded || busy || !draft.trim()} onClick={() => void submit()}>↑</button></div>{schedule && <RecurrenceEditor frequency={frequency} setFrequency={setFrequency} minutes={minutes} setMinutes={setMinutes} time={scheduleTime} setTime={setScheduleTime} timeZone={scheduleTimeZone} setTimeZone={setScheduleTimeZone} weekdays={scheduleWeekdays} setWeekdays={setScheduleWeekdays} endDate={scheduleEndDate} setEndDate={setScheduleEndDate} />}</div><small className="hint">{state.availableEngines.includes(engine) ? '任务由本机后台处理。' : '所选内核未配置；新任务会显示失败并可在配置后重试。'}</small></div>
      </section>{view === 'chat' && selectedPageId ? <div className="scratchpad-page-split" data-testid="scratchpad-page-split"><ScratchpadNavigationPane tenantId={authContext.tenant.id} selectedPageId={selectedPageId} refreshKey={pageIndexVersion} onOpen={setSelectedPageId} onBack={() => { setSelectedPageId(null); setView('pages'); }} /><PagePane pageId={selectedPageId} tenantId={authContext.tenant.id} onBack={() => { setSelectedPageId(null); setView('pages'); }} onPageUpdated={() => setPageIndexVersion(version => version + 1)} /></div> : view === 'chat' && (selectedTask || entries.length > 0) && <DotContextPanel profile={state.profile} state={state} tenantId={authContext.tenant.id} onOpenComputer={() => setView('computer')} onSelectTask={taskId => { setSelected(taskId); setView('chat'); }} />}</div>}
      {view === 'pages' && (selectedPageId ? <PagePane pageId={selectedPageId} tenantId={authContext.tenant.id} full onBack={() => setSelectedPageId(null)} onPageUpdated={() => setPageIndexVersion(version => version + 1)} /> : <PagesView tenantId={authContext.tenant.id} onOpen={id => setSelectedPageId(id)} />)}
      {view === 'activity' && <ActivityView tenantId={authContext.tenant.id} profileName={state.profile.name} state={state} stateLoaded={stateLoaded} onSelectTask={taskId => { setSelected(taskId); setView('chat'); }} onOpenPage={openPage} />}
      {view === 'scheduled' && <ScheduledView tasks={state.tasks} watches={state.watches}
        onCancelTask={task => void act(task, 'cancelSchedule')}
        onWatchAction={(watch, action) => void actWatch(watch.id, action)}
        onOpenTask={task => { setSelected(task.id); setView('chat'); }}
        onNewTask={() => { setSchedule(true); setView('chat'); requestAnimationFrame(() => composerRef.current?.focus()); }}
        onAddWatch={addScheduledWatch} />}
      {view === 'profile' && <Profile state={state} auth={authContext} onError={setError} onEditAppearance={() => setAvatarEditorOpen(true)} onManageComputerAccess={() => setComputerAccessOpen(true)} />}
      {view === 'computer' && <ComputerView dotName={state.profile.name} localComputerEnabled={state.computerAccess.localComputer} onManageAccess={() => setComputerAccessOpen(true)} onError={setError} />}
    </main>
    {avatarSetupOpen && <DotSetupEditor profile={state.profile} onClose={() => setAvatarSetupOpen(false)} onSave={(appearance, name) => saveAvatarAppearance(appearance, name, false, true)} />}
    {computerAccessOpen && <DotComputerChoice localComputer={state.computerAccess.localComputer} mode="settings" onSave={saveComputerAccess} onCancel={() => setComputerAccessOpen(false)} />}
    {avatarEditorOpen && <DotAvatarEditor profile={state.profile} onClose={() => setAvatarEditorOpen(false)} onSave={(appearance, name) => saveAvatarAppearance(appearance, name, !state.profile.onboardingCompletedAt)} />}
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
    const authorization = new URL('/api/auth/desktop/start', window.location.href);
    authorization.searchParams.set('handoffToken', handoffToken);
    const popup = window.open(authorization.toString(), '_blank');
    if (!popup && !isElectron) { setDesktopPending(false); setDesktopError('浏览器阻止了登录窗口，请允许弹出窗口后重试。'); return; }
    try {
      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const response = await fetch('/api/auth/desktop/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handoffToken }) });
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
      const response = await fetch('/api/auth/e2e/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: e2eEmail }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      window.location.reload();
    } catch (error) { setDesktopError(error instanceof Error ? error.message : String(error)); }
  }
  return <main className="auth-page"><div className="auth-card"><div className="brand"><span className="brand-mark">●</span> Coke Dots</div><h1>让你的个人代理持续推进工作</h1><p>使用 Google 账号登录。每个工作区的任务、记录、模型密钥和浏览器会话相互隔离。</p>{authError && <div className="auth-error">{authErrors[authError] || '登录失败，请重试。'}</div>}{desktopError && <div className="auth-error">{desktopError}</div>}{googleConfigured ? isElectron ? <button className="google-login" disabled={desktopPending} onClick={() => void beginDesktopLogin()}><span>G</span>{desktopPending ? '等待浏览器完成登录…' : '使用 Google 登录'}</button> : <a className="google-login" href="/api/auth/google/start"><span>G</span>使用 Google 登录</a> : <div className="auth-setup"><strong>需要配置 Google OAuth</strong><span>在本机服务环境中设置 GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET，然后重启服务。</span></div>}{e2eAuthAvailable && <div className="e2e-login"><label htmlFor="e2e-email">E2E 测试账号</label><input id="e2e-email" type="email" value={e2eEmail} onChange={event => setE2eEmail(event.target.value)} /><button data-testid="e2e-sign-in" className="google-login" onClick={() => void signInE2e()}>测试环境登录</button></div>}<small>仅申请基本身份信息；Coke Dots 不会取得 Gmail 或 Google Drive 权限。</small></div></main>;
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
    void fetch('/api/activity?limit=50').then(async response => {
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
      const response = await fetch(`/api/activity?limit=50&before=${nextCursor}`);
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
      const description = task.parentTaskId ? task.error || task.result || task.instruction
        : task.status === 'delegating' ? `${terminalChildren}/${children.length} 项子任务已结束。${task.result ? ` ${task.result}` : ''}`
          : task.error || task.result || task.instruction;
      return <div className={`task-card ${task.parentTaskId ? 'delegated-child' : ''}`} data-testid={`task-card-${task.id}`} key={task.id}>
      <div className="task-card-head"><span className={`pill ${task.status}`}>{statusText[task.status]}</span><time>{new Date(task.updatedAt).toLocaleString('zh-CN')}</time></div>
      {parent && <small className="delegated-from">委派自：{parent.title} · 内核：{engineText[task.engine]}</small>}
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

function RecurrenceEditor({ frequency, setFrequency, minutes, setMinutes, time, setTime, timeZone, setTimeZone, weekdays, setWeekdays, endDate, setEndDate }: {
  frequency: 'interval' | 'daily' | 'weekly';
  setFrequency: React.Dispatch<React.SetStateAction<'interval' | 'daily' | 'weekly'>>;
  minutes: number; setMinutes: React.Dispatch<React.SetStateAction<number>>;
  time: string; setTime: React.Dispatch<React.SetStateAction<string>>;
  timeZone: string; setTimeZone: React.Dispatch<React.SetStateAction<string>>;
  weekdays: number[]; setWeekdays: React.Dispatch<React.SetStateAction<number[]>>;
  endDate: string; setEndDate: React.Dispatch<React.SetStateAction<string>>;
}) {
  const zones = useMemo(() => {
    const supported = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    return [...new Set(['UTC', timeZone, ...supported])].sort();
  }, [timeZone]);
  const dayLabels = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  return <div className="schedule-details" data-testid="schedule-details">
    <label>频率<select aria-label="重复频率" value={frequency} onChange={event => setFrequency(event.target.value as 'interval' | 'daily' | 'weekly')}><option value="interval">按间隔</option><option value="daily">每天</option><option value="weekly">每周</option></select></label>
    {frequency === 'interval' ? <label>每 <input aria-label="间隔分钟数" className="minutes" type="number" min="1" max="10080" value={minutes} onChange={event => setMinutes(Number(event.target.value))} /> 分钟</label> : <>
      <label>时间<input aria-label="定时时间" type="time" value={time} onChange={event => setTime(event.target.value)} /></label>
      <label>时区<select aria-label="时区" value={timeZone} onChange={event => setTimeZone(event.target.value)}>{zones.map(zone => <option key={zone} value={zone}>{zone}</option>)}</select></label>
      {frequency === 'weekly' && <fieldset className="schedule-weekdays"><legend>重复日</legend>{dayLabels.map((label, day) => <label key={day}><input aria-label={label} type="checkbox" checked={weekdays.includes(day)} onChange={event => setWeekdays(current => event.target.checked ? [...current, day] : current.filter(value => value !== day))} />{label.slice(2)}</label>)}</fieldset>}
      <label>结束日期（可选）<input aria-label="结束日期" type="date" value={endDate} onChange={event => setEndDate(event.target.value)} /></label>
    </>}
  </div>;
}

function TaskControls({ task, act, compact = false }: { task: Task; act: (task: Task, action: string, extra?: object) => Promise<void>; compact?: boolean }) {
  const [redirect, setRedirect] = useState('');
  const [approval, setApproval] = useState<PageActionApproval | null>(null);
  const [approvalLoaded, setApprovalLoaded] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalError, setApprovalError] = useState('');
  useEffect(() => {
    let active = true;
    setApproval(null); setApprovalLoaded(false); setApprovalError('');
    if (compact || task.status !== 'waiting') { setApprovalLoaded(true); return () => { active = false; }; }
    void fetch(`/api/tasks/${task.id}/approval`).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (active) setApproval(data as PageActionApproval | null);
    }).catch(reason => { if (active) setApprovalError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (active) setApprovalLoaded(true); });
    return () => { active = false; };
  }, [task.id, task.status, compact]);
  async function decideApproval(decision: 'approve' | 'decline') {
    setApprovalBusy(true); setApprovalError('');
    try {
      const result = await request(`/tasks/${task.id}/approval`, 'POST', { decision }) as { approval: PageActionApproval };
      setApproval(result.approval);
    } catch (reason) { setApprovalError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setApprovalBusy(false); }
  }
  const hasRecurringSchedule = Boolean(task.scheduleSpec || task.scheduleMinutes !== null);
  const canStop = !hasRecurringSchedule && ['queued', 'working', 'delegating', 'waiting', 'scheduled', 'paused'].includes(task.status);
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
        <div className="page-approval-actions"><button className="approve" disabled={approvalBusy} onClick={() => void decideApproval('approve')}>{approvalBusy ? '处理中…' : '批准并执行'}</button><button disabled={approvalBusy} onClick={() => void decideApproval('decline')}>拒绝并保持不变</button></div>
      </div>}
      {approvalLoaded && !approval && task.status !== 'stopped' && <div className="redirect">
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

function Profile({ state, auth, onError, onEditAppearance, onManageComputerAccess }: { state: Snapshot; auth: AuthContext; onError: (s: string) => void; onEditAppearance: () => void; onManageComputerAccess: () => void }) {
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
  const refreshMembers = async () => {
    const response = await fetch(`/api/tenants/${auth.tenant.id}/members`);
    if (!response.ok) throw new Error((await response.json()).error || `HTTP ${response.status}`);
    setMembers(await response.json() as TenantMember[]);
    if (['owner', 'admin'].includes(auth.tenant.role)) {
      const inviteResponse = await fetch(`/api/tenants/${auth.tenant.id}/invitations`);
      if (!inviteResponse.ok) throw new Error((await inviteResponse.json()).error || `HTTP ${inviteResponse.status}`);
      setInvitations(await inviteResponse.json() as WorkspaceInvitation[]);
    } else setInvitations([]);
  };
  useEffect(() => { setName(state.profile.name); }, [state.profile.name]);
  useEffect(() => { setDesktopNotifications(state.preferences.desktopNotifications); }, [state.preferences.desktopNotifications]);
  useEffect(() => { if (state.modelSettings.baseUrl) setBaseUrl(state.modelSettings.baseUrl); if (state.modelSettings.model) setModel(state.modelSettings.model); }, [state.modelSettings.baseUrl, state.modelSettings.model]);
  useEffect(() => { void refreshMembers().catch(error => setMembersError(String(error))); }, [auth.tenant.id]);
  useEffect(() => {
    let active = true;
    setMemoryDraft(''); setEditingMemory(null); setEditingDraft(''); setMemoryError(''); setMemories([]);
    void fetch('/api/memories').then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (active) setMemories(data as TenantMemory[]);
    }).catch(error => { if (active) setMemoryError(String(error)); });
    return () => { active = false; };
  }, [auth.tenant.id]);
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
      const response = await fetch(`/api/memories/${memory.id}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setMemories(current => current.filter(item => item.id !== memory.id));
    } catch (error) { setMemoryError(String(error)); }
    finally { setMemoryBusy(false); }
  }
  return <section className="content profile-content">
    <div className="section-heading"><h1>你的 dot</h1><p>给它起个名字，选择一个外观。</p></div>
    <div className="profile-card">
      <DotAvatar appearance={state.profile} />
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
    <PermissionRules tenantId={auth.tenant.id} role={auth.tenant.role} />
    <div className="section-heading model-heading"><h2>工作区成员</h2><p>所有成员都必须使用对应 Google 账号登录并接受邀请后才能访问。邀请 7 天后过期；Coke Dots 不会代发邮件，请通过其他方式通知对方。当前角色：{auth.tenant.role}。</p></div>
    <div className="profile-card model-card">
      <div className="member-list">{members.map(member => <div className="member-row" key={member.id}>
        <span><strong>{member.name}</strong><small>{member.email}</small></span>
        <span className="member-role">{member.role === 'owner' ? '所有者' : member.role === 'admin' ? '管理员' : '成员'}</span>
        {['owner', 'admin'].includes(auth.tenant.role) && member.role !== 'owner' && <button onClick={async () => { try { const response = await fetch(`/api/tenants/${auth.tenant.id}/members/${member.id}`, { method: 'DELETE' }); const data = await response.json(); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); await refreshMembers(); } catch (error) { setMembersError(String(error)); } }}>移除</button>}
      </div>)}</div>
      {invitations.length > 0 && <div className="member-invitations" role="region" aria-label="待接受邀请"><strong>待接受邀请</strong>{invitations.map(invitation => <div className="member-row pending-invitation" key={invitation.email}>
        <span><strong>{invitation.email}</strong><small>有效期至 {new Date(invitation.expiresAt).toLocaleDateString('zh-CN')}</small></span>
        <span className="member-role">{invitation.role === 'admin' ? '管理员' : '成员'}</span>
        <button aria-label={`撤销 ${invitation.email} 的邀请`} onClick={async () => { try { const response = await fetch(`/api/tenants/${auth.tenant.id}/invitations/${encodeURIComponent(invitation.email)}`, { method: 'DELETE' }); const data = await response.json(); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); await refreshMembers(); } catch (error) { setMembersError(String(error)); } }}>撤销</button>
      </div>)}</div>}
      <label>Google 账号邮箱<input type="email" value={memberEmail} onChange={e => { setMemberEmail(e.target.value); setMemberNotice(''); }} placeholder="teammate@example.com" /></label>
      <button className="primary" disabled={!['owner', 'admin'].includes(auth.tenant.role) || !memberEmail.trim()} onClick={async () => { try { const result = await request(`/tenants/${auth.tenant.id}/members`, 'POST', { email: memberEmail, role: 'member' }) as { invited: boolean }; setMemberEmail(''); setMembersError(''); setMemberNotice(result.invited ? '邀请已创建。对方在 Coke Dots 登录同一 Google 账号后，会看到待接受邀请。' : '成员已加入工作区。'); await refreshMembers(); } catch (e) { onError(String(e)); } }}>添加工作区成员</button>
      {memberNotice && <small role="status">{memberNotice}</small>}
      {membersError && <small className="member-error">{membersError}</small>}
      {!['owner', 'admin'].includes(auth.tenant.role) && <small>只有工作区所有者或管理员可以添加成员。</small>}
    </div>
    <div className="section-heading model-heading"><h2>模型 API</h2><p>此 API 密钥只用于当前工作区，并保存在 macOS 钥匙串。</p></div>
    <div className="profile-card model-card">
      <label>API 地址<input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} /></label>
      <label>模型名称<input value={model} onChange={e => setModel(e.target.value)} /></label>
      <label>API 密钥<input type="password" autoComplete="off" placeholder={state.modelSettings.hasKey ? '已保存；留空则保持不变' : '输入密钥'} value={apiKey} onChange={e => setApiKey(e.target.value)} /></label>
      <button className="primary" onClick={async () => { try { await request('/model-settings', 'PATCH', { baseUrl, model, apiKey }); setApiKey(''); } catch (e) { onError(String(e)); } }}>保存模型设置</button>
    </div>
  </section>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
