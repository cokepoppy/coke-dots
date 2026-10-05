import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Engine, ScheduleSpec, Snapshot, Task, TaskStatus } from '../shared/types.ts';
import './style.css';
import './watch.css';
import './dark-theme.css';
import './onboarding.css';
import './notification.css';
import './scheduled.css';
import './recurrence.css';
import { ComputerView } from './ComputerView.tsx';
import { DotContextPanel } from './DotContextPanel.tsx';
import { ScheduledView } from './ScheduledView.tsx';

const initial: Snapshot = { profile: { name: 'Dot', shape: 'circle', color: '#ba9af7' }, preferences: { desktopNotifications: false }, tasks: [], watches: [], entries: [], configured: false, availableEngines: [], modelSettings: { baseUrl: '', model: '', hasKey: false } };
interface AuthContext { user: { id: string; email: string; name: string }; tenant: { id: string; name: string; role: string; kind: string }; tenants: { id: string; name: string; role: string; kind: string }[] }
interface TenantMember { id: string; email: string; name: string; role: string }
const statusText: Record<TaskStatus, string> = {
  queued: '排队中', working: '工作中', waiting: '等待你', scheduled: '已安排', done: '已完成', failed: '失败', paused: '已暂停',
};

async function request(path: string, method: 'POST' | 'PATCH', body: object) {
  const response = await fetch(`/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function Avatar({ shape, color, small = false }: { shape: string; color: string; small?: boolean }) {
  return <div className={`avatar ${shape} ${small ? 'small' : ''}`} style={{ backgroundColor: color }}><span className="eyes"><i /><i /></span></div>;
}

function App() {
  const [authContext, setAuthContext] = useState<AuthContext | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [stateLoaded, setStateLoaded] = useState(false);
  const [googleConfigured, setGoogleConfigured] = useState(false);
  const [e2eAuthAvailable, setE2eAuthAvailable] = useState(false);
  const [state, setState] = useState<Snapshot>(initial);
  const [view, setView] = useState<'chat' | 'activity' | 'scheduled' | 'computer' | 'profile'>('chat');
  const [selected, setSelected] = useState<string | null>(null);
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
    void fetch('/api/auth/me').then(async response => response.ok ? await response.json() as AuthContext : null)
      .then(setAuthContext).catch(() => setAuthContext(null)).finally(() => setAuthChecked(true));
    void fetch('/api/auth/config').then(response => response.json()).then(data => { setGoogleConfigured(Boolean(data.googleConfigured)); setE2eAuthAvailable(Boolean(data.e2eAuthAvailable)); }).catch(() => { setGoogleConfigured(false); setE2eAuthAvailable(false); });
  }, []);

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
      setDraft(''); setSelected(task.id); setView('chat');
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
      setAuthContext(data as AuthContext); setState(initial); setStateLoaded(false); setSelected(null); setError('');
    } catch (e) { setError(String(e)); }
  }

  async function createTenant(name: string) {
    const response = await fetch('/api/tenants', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    const refreshed = await fetch('/api/auth/me');
    if (refreshed.ok) setAuthContext(await refreshed.json() as AuthContext);
    setState(initial); setStateLoaded(false); setSelected(null);
  }

  async function logout() {
    try { await fetch('/api/auth/logout', { method: 'POST' }); }
    finally { setAuthContext(null); setState(initial); }
  }

  if (!authChecked) return <div className="auth-loading">Coke Dots</div>;
  if (!authContext) return <LoginScreen googleConfigured={googleConfigured} e2eAuthAvailable={e2eAuthAvailable} />;

  return <div className={`shell dots-dark ${view === 'scheduled' ? 'scheduled-mode' : ''}`} data-testid="app-shell" data-theme="dark" data-tenant-id={authContext.tenant.id} data-state-loaded={stateLoaded}>
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">●</span> Coke Dots</div>
      <button className={`nav ${view === 'chat' ? 'selected' : ''}`} onClick={() => { setView('chat'); setSelected(null); }}>✦ <span>你的 dot</span></button>
      <button className={`nav ${view === 'activity' ? 'selected' : ''}`} onClick={() => setView('activity')}>▤ <span>Activity</span><em>{active.length || ''}</em></button>
      <button className={`nav ${view === 'scheduled' ? 'selected' : ''}`} onClick={() => setView('scheduled')}>◷ <span>Scheduled</span></button>
      <button className={`nav ${view === 'computer' ? 'selected' : ''}`} onClick={() => setView('computer')}>▣ <span>电脑</span></button>
      <div className="side-caption">正在负责</div>
      <div className="task-links">{stateLoaded ? state.tasks.slice(0, 12).map(task => <button key={task.id} className={selected === task.id ? 'on' : ''} onClick={() => { setView('chat'); setSelected(task.id); }}><span className={`status-dot ${task.status}`} />{task.title}</button>) : <span className="side-loading">恢复中…</span>}</div>
      <button className="profile-link" onClick={() => setView('profile')}><Avatar {...state.profile} small /><span><strong>{state.profile.name}</strong><small>{authContext.user.email}</small></span><span>⌄</span></button>
    </aside>
    <main className="main">
      <header className="topbar"><span>{view === 'chat' ? selectedTask?.title || state.profile.name : view === 'activity' ? 'Activity' : view === 'computer' ? '电脑' : view === 'profile' ? '你的 dot' : ''}</span><div className="top-actions"><WorkspaceSwitcher auth={authContext} onSwitch={switchTenant} onCreate={createTenant} onError={message => setError(message)} /><button className="logout-button" onClick={() => void logout()}>退出</button><span className="top-status"><span className="online" />本机运行中</span></div></header>
      {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError('')}>×</button></div>}
      {view === 'chat' && <div className="chat-layout"><section className="chat-panel">
        {!stateLoaded ? <div className="workspace-loading" role="status">正在恢复工作区…</div> : !selectedTask && entries.length === 0 ? <div className="welcome onboarding-welcome" data-testid="dot-onboarding"><Avatar {...state.profile} /><h1>Hey! I’m your dot</h1><p className="onboarding-promise">Message or call me anytime. I’ll keep things moving, even when we’re not talking, and check in with updates or questions.</p><p className="onboarding-name-prompt">Want to give me a name?</p><button className="onboarding-customize" data-testid="onboarding-customize" onClick={() => setView('profile')}>Customize your dot <span aria-hidden="true">→</span></button><p className="onboarding-start-prompt">Start looking for ways to help. Anything top of mind?</p><div className="suggestions onboarding-actions"><button data-testid="onboarding-start" onClick={() => { composerRef.current?.focus(); }}>Start looking for ways to help <span aria-hidden="true">→</span></button></div><p className="onboarding-footer">A few things I could take off your plate.</p></div> : <div className="timeline">
          {!selectedTask && <div className="timeline-title">最近的对话和进度</div>}
          {entries.map(entry => <article key={entry.id} className={`message ${entry.kind}`}><div className="message-avatar">{entry.kind === 'user' ? '你' : entry.kind === 'dot' ? <Avatar {...state.profile} small /> : '·'}</div><div><div className="message-name">{entry.kind === 'user' ? '你' : entry.kind === 'dot' ? state.profile.name : '系统'} <time>{new Date(entry.createdAt).toLocaleString('zh-CN')}</time></div><p>{entry.body}</p></div></article>)}
          {selectedTask && <TaskControls task={selectedTask} act={act} />}
        </div>}
        <div className="composer-wrap"><div className="composer"><textarea ref={composerRef} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } }} placeholder="告诉 dot 接下来要负责什么…" /><div className="composer-bottom"><label>内核 <select value={engine} onChange={e => setEngine(e.target.value as Engine)}>{(['model', 'claude', 'pi', 'dsh'] as Engine[]).map(id => <option key={id} value={id}>{id === 'model' ? '模型 API' : id === 'claude' ? 'Claude Code' : id === 'pi' ? 'Pi' : 'DeepSeek Harness'}{state.availableEngines.includes(id) ? '' : ' · 未配置'}</option>)}</select></label><label className="schedule-toggle"><input type="checkbox" checked={schedule} onChange={e => setSchedule(e.target.checked)} /> 定期检查</label><button className="send" disabled={!stateLoaded || busy || !draft.trim()} onClick={() => void submit()}>↑</button></div>{schedule && <RecurrenceEditor frequency={frequency} setFrequency={setFrequency} minutes={minutes} setMinutes={setMinutes} time={scheduleTime} setTime={setScheduleTime} timeZone={scheduleTimeZone} setTimeZone={setScheduleTimeZone} weekdays={scheduleWeekdays} setWeekdays={setScheduleWeekdays} endDate={scheduleEndDate} setEndDate={setScheduleEndDate} />}</div><small className="hint">{state.availableEngines.includes(engine) ? '任务由本机后台处理。' : '所选内核未配置；新任务会显示失败并可在配置后重试。'}</small></div>
      </section>{(selectedTask || entries.length > 0) && <DotContextPanel profile={state.profile} state={state} tenantId={authContext.tenant.id} onOpenComputer={() => setView('computer')} onSelectTask={taskId => { setSelected(taskId); setView('chat'); }} />}</div>}
      {view === 'activity' && <section className="content"><div className="section-heading"><h1>Activity</h1><p>查看 dot 正在处理的工作、结果和需要你决定的事项。</p></div><div className="cards">{!stateLoaded ? <div className="empty workspace-loading" role="status">正在加载工作区…</div> : state.tasks.length ? state.tasks.map(task => <div className="task-card" key={task.id}><div className="task-card-head"><span className={`pill ${task.status}`}>{statusText[task.status]}</span><time>{new Date(task.updatedAt).toLocaleString('zh-CN')}</time></div><h2>{task.title}</h2><p>{task.error || task.result || task.instruction}</p><div className="card-actions"><button onClick={() => { setSelected(task.id); setView('chat'); }}>查看详情 →</button><TaskControls task={task} act={act} compact /></div></div>) : <div className="empty">还没有任务。回到对话，交给 dot 第一项工作。</div>}</div></section>}
      {view === 'scheduled' && <ScheduledView tasks={state.tasks} watches={state.watches}
        onCancelTask={task => void act(task, 'cancelSchedule')}
        onWatchAction={(watch, action) => void actWatch(watch.id, action)}
        onOpenTask={task => { setSelected(task.id); setView('chat'); }}
        onNewTask={() => { setSchedule(true); setView('chat'); requestAnimationFrame(() => composerRef.current?.focus()); }}
        onAddWatch={addScheduledWatch} />}
      {view === 'profile' && <Profile state={state} auth={authContext} onError={setError} />}
      {view === 'computer' && <ComputerView dotName={state.profile.name} onError={setError} />}
    </main>
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
  return <div className={`task-controls ${compact ? 'compact' : ''}`}>
    {!compact && <span className={`pill ${task.status}`}>{statusText[task.status]}</span>}
    {['working', 'queued', 'scheduled'].includes(task.status) && <button onClick={() => void act(task, 'pause')}>暂停</button>}
    {['paused', 'failed'].includes(task.status) && <button onClick={() => void act(task, task.status === 'failed' ? 'retry' : 'resume')}>{task.status === 'failed' ? '重试' : '继续'}</button>}
    {!compact && <>
      <button onClick={() => void act(task, 'priority', { priority: task.priority + 1 })}>提高优先级</button>
      <div className="redirect">
        <input aria-label={task.status === 'waiting' ? '回复 dot 的问题' : '调整这项工作的要求'} value={redirect} onChange={e => setRedirect(e.target.value)} placeholder={task.status === 'waiting' ? '回复 dot 的问题…' : '调整这项工作的要求'} />
        <button disabled={!redirect.trim()} onClick={() => {
          const action = task.status === 'waiting' ? 'reply' : 'redirect';
          const extra = task.status === 'waiting' ? { message: redirect } : { instruction: redirect };
          void act(task, action, extra);
          setRedirect('');
        }}>{task.status === 'waiting' ? '回复并继续' : '更新'}</button>
      </div>
    </>}
  </div>;
}

function Profile({ state, auth, onError }: { state: Snapshot; auth: AuthContext; onError: (s: string) => void }) {
  const [name, setName] = useState(state.profile.name);
  const [shape, setShape] = useState(state.profile.shape);
  const [color, setColor] = useState(state.profile.color);
  const [baseUrl, setBaseUrl] = useState(state.modelSettings.baseUrl || 'https://api.openai.com/v1');
  const [model, setModel] = useState(state.modelSettings.model);
  const [apiKey, setApiKey] = useState('');
  const [desktopNotifications, setDesktopNotifications] = useState(state.preferences.desktopNotifications);
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [memberEmail, setMemberEmail] = useState('');
  const [members, setMembers] = useState<TenantMember[]>([]);
  const [membersError, setMembersError] = useState('');
  const refreshMembers = async () => {
    const response = await fetch(`/api/tenants/${auth.tenant.id}/members`);
    if (!response.ok) throw new Error((await response.json()).error || `HTTP ${response.status}`);
    setMembers(await response.json() as TenantMember[]);
  };
  useEffect(() => { setName(state.profile.name); setShape(state.profile.shape); setColor(state.profile.color); }, [state.profile.name, state.profile.shape, state.profile.color]);
  useEffect(() => { setDesktopNotifications(state.preferences.desktopNotifications); }, [state.preferences.desktopNotifications]);
  useEffect(() => { if (state.modelSettings.baseUrl) setBaseUrl(state.modelSettings.baseUrl); if (state.modelSettings.model) setModel(state.modelSettings.model); }, [state.modelSettings.baseUrl, state.modelSettings.model]);
  useEffect(() => { void refreshMembers().catch(error => setMembersError(String(error))); }, [auth.tenant.id]);
  return <section className="content profile-content"><div className="section-heading"><h1>你的 dot</h1><p>给它起个名字，选择一个外观。</p></div><div className="profile-card"><Avatar shape={shape} color={color} /><label>名字<input maxLength={40} value={name} onChange={e => setName(e.target.value)} /></label><div className="field-label">形状</div><div className="choices">{['circle', 'square', 'triangle'].map(item => <button key={item} className={shape === item ? 'chosen' : ''} onClick={() => setShape(item)}>{item === 'circle' ? '圆形' : item === 'square' ? '方形' : '三角形'}</button>)}</div><label>颜色<input type="color" value={color} onChange={e => setColor(e.target.value)} /></label><button className="primary" onClick={async () => { try { await request('/profile', 'PATCH', { name, shape, color }); } catch (e) { onError(String(e)); } }}>保存更改</button></div><div className="section-heading model-heading"><h2>通知</h2><p>后台工作需要你处理或完成时，在这台 Mac 上提醒你。</p></div><div className="profile-card model-card notification-card"><label className="notification-toggle"><input aria-label="桌面通知" type="checkbox" checked={desktopNotifications} disabled={notificationBusy} onChange={async event => { const enabled = event.currentTarget.checked; setNotificationBusy(true); setDesktopNotifications(enabled); try { await request('/preferences', 'PATCH', { desktopNotifications: enabled }); } catch (error) { setDesktopNotifications(!enabled); onError(String(error)); } finally { setNotificationBusy(false); } }} /><span><strong>桌面通知</strong><small>{desktopNotifications ? '此工作区已开启任务和网页监控提醒。' : '此工作区的提醒目前关闭。'}</small></span></label><small className="notification-note">通知只显示 Dot 名称和事项状态，不包含任务结果正文。</small></div><div className="section-heading model-heading"><h2>工作区成员</h2><p>添加已登录 Coke Dots 的 Google 账号。当前角色：{auth.tenant.role}。</p></div><div className="profile-card model-card"><div className="member-list">{members.map(member => <div className="member-row" key={member.id}><span><strong>{member.name}</strong><small>{member.email}</small></span><span className="member-role">{member.role === 'owner' ? '所有者' : member.role === 'admin' ? '管理员' : '成员'}</span>{['owner', 'admin'].includes(auth.tenant.role) && member.role !== 'owner' && <button onClick={async () => { try { const response = await fetch(`/api/tenants/${auth.tenant.id}/members/${member.id}`, { method: 'DELETE' }); const data = await response.json(); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); await refreshMembers(); } catch (error) { setMembersError(String(error)); } }}>移除</button>}</div>)}</div><label>Google 账号邮箱<input type="email" value={memberEmail} onChange={event => setMemberEmail(event.target.value)} placeholder="teammate@example.com" /></label><button className="primary" disabled={!['owner', 'admin'].includes(auth.tenant.role) || !memberEmail.trim()} onClick={async () => { try { await request(`/tenants/${auth.tenant.id}/members`, 'POST', { email: memberEmail, role: 'member' }); setMemberEmail(''); setMembersError(''); await refreshMembers(); } catch (e) { onError(String(e)); } }}>添加工作区成员</button>{membersError && <small className="member-error">{membersError}</small>}{!['owner', 'admin'].includes(auth.tenant.role) && <small>只有工作区所有者或管理员可以添加成员。</small>}</div><div className="section-heading model-heading"><h2>模型 API</h2><p>此 API 密钥只用于当前工作区，并保存在 macOS 钥匙串。</p></div><div className="profile-card model-card"><label>API 地址<input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} /></label><label>模型名称<input value={model} onChange={e => setModel(e.target.value)} /></label><label>API 密钥<input type="password" autoComplete="off" placeholder={state.modelSettings.hasKey ? '已保存；留空则保持不变' : '输入密钥'} value={apiKey} onChange={e => setApiKey(e.target.value)} /></label><button className="primary" onClick={async () => { try { await request('/model-settings', 'PATCH', { baseUrl, model, apiKey }); setApiKey(''); } catch (e) { onError(String(e)); } }}>保存模型设置</button></div></section>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
