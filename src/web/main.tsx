import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Engine, Snapshot, Task, TaskStatus } from '../shared/types.ts';
import './style.css';
import './watch.css';

const initial: Snapshot = { profile: { name: 'Dot', shape: 'circle', color: '#ba9af7' }, tasks: [], watches: [], entries: [], configured: false, availableEngines: [], modelSettings: { baseUrl: '', model: '', hasKey: false } };
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
  const [state, setState] = useState<Snapshot>(initial);
  const [view, setView] = useState<'chat' | 'activity' | 'scheduled' | 'profile'>('chat');
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [schedule, setSchedule] = useState(false);
  const [minutes, setMinutes] = useState(60);
  const [watchUrl, setWatchUrl] = useState('');
  const [watchMinutes, setWatchMinutes] = useState(60);
  const [engine, setEngine] = useState<Engine>('model');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const stream = new EventSource('/api/events');
    stream.onmessage = event => setState(JSON.parse(event.data));
    stream.onerror = () => setError('与本机服务的连接已断开，正在重连。');
    return () => stream.close();
  }, []);

  const selectedTask = state.tasks.find(t => t.id === selected) || null;
  const entries = useMemo(() => selected ? state.entries.filter(e => e.taskId === selected) : state.entries, [state.entries, selected]);
  const active = state.tasks.filter(t => ['queued', 'working', 'waiting', 'scheduled'].includes(t.status));

  async function submit() {
    if (!draft.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const task = await request('/tasks', 'POST', { instruction: draft, scheduleMinutes: schedule ? minutes : null, engine }) as Task;
      setDraft(''); setSelected(task.id); setView('chat');
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  async function act(task: Task, action: string, extra: object = {}) {
    try { setError(''); await request(`/tasks/${task.id}`, 'PATCH', { action, ...extra }); }
    catch (e) { setError(String(e)); }
  }

  async function addWatch() {
    try { setError(''); await request('/watches', 'POST', { url: watchUrl, intervalMinutes: watchMinutes }); setWatchUrl(''); }
    catch (e) { setError(String(e)); }
  }

  async function actWatch(id: string, action: 'pause' | 'resume') {
    try { setError(''); await request(`/watches/${id}`, 'PATCH', { action }); }
    catch (e) { setError(String(e)); }
  }

  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">●</span> Coke Dots</div>
      <button className={`nav ${view === 'chat' ? 'selected' : ''}`} onClick={() => { setView('chat'); setSelected(null); }}>✦ <span>你的 dot</span></button>
      <button className={`nav ${view === 'activity' ? 'selected' : ''}`} onClick={() => setView('activity')}>▤ <span>Activity</span><em>{active.length || ''}</em></button>
      <button className={`nav ${view === 'scheduled' ? 'selected' : ''}`} onClick={() => setView('scheduled')}>◷ <span>Scheduled</span></button>
      <div className="side-caption">正在负责</div>
      <div className="task-links">{state.tasks.slice(0, 12).map(task => <button key={task.id} className={selected === task.id ? 'on' : ''} onClick={() => { setView('chat'); setSelected(task.id); }}><span className={`status-dot ${task.status}`} />{task.title}</button>)}</div>
      <button className="profile-link" onClick={() => setView('profile')}><Avatar {...state.profile} small /><span><strong>{state.profile.name}</strong><small>个人代理</small></span><span>⌄</span></button>
    </aside>
    <main className="main">
      <header className="topbar"><span>{view === 'chat' ? selectedTask?.title || state.profile.name : view === 'activity' ? 'Activity' : view === 'scheduled' ? 'Scheduled' : '你的 dot'}</span><span className="top-status"><span className="online" />本机运行中</span></header>
      {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError('')}>×</button></div>}
      {view === 'chat' && <section className="chat-panel">
        {!selectedTask && entries.length === 0 ? <div className="welcome"><Avatar {...state.profile} /><h1>认识你的 {state.profile.name}</h1><p>交给它一项持续的责任。工作和进度会保存在本机，离开这个窗口后仍可继续。</p><div className="suggestions"><button onClick={() => setDraft('帮我整理这个项目的待办，并告诉我下一步需要什么信息。')}>整理一个项目 →</button><button onClick={() => { setSchedule(true); setDraft('每小时检查这项工作的进度，有变化时提醒我。'); }}>安排定期检查 →</button></div></div> : <div className="timeline">
          {!selectedTask && <div className="timeline-title">最近的对话和进度</div>}
          {entries.map(entry => <article key={entry.id} className={`message ${entry.kind}`}><div className="message-avatar">{entry.kind === 'user' ? '你' : entry.kind === 'dot' ? <Avatar {...state.profile} small /> : '·'}</div><div><div className="message-name">{entry.kind === 'user' ? '你' : entry.kind === 'dot' ? state.profile.name : '系统'} <time>{new Date(entry.createdAt).toLocaleString('zh-CN')}</time></div><p>{entry.body}</p></div></article>)}
          {selectedTask && <TaskControls task={selectedTask} act={act} />}
        </div>}
        <div className="composer-wrap"><div className="composer"><textarea value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); } }} placeholder="告诉 dot 接下来要负责什么…" /><div className="composer-bottom"><label>内核 <select value={engine} onChange={e => setEngine(e.target.value as Engine)}>{(['model', 'claude', 'pi', 'dsh'] as Engine[]).map(id => <option key={id} value={id}>{id === 'model' ? '模型 API' : id === 'claude' ? 'Claude Code' : id === 'pi' ? 'Pi' : 'DeepSeek Harness'}{state.availableEngines.includes(id) ? '' : ' · 未配置'}</option>)}</select></label><label className="schedule-toggle"><input type="checkbox" checked={schedule} onChange={e => setSchedule(e.target.checked)} /> 定期检查</label>{schedule && <label>每 <input className="minutes" type="number" min="1" max="10080" value={minutes} onChange={e => setMinutes(Number(e.target.value))} /> 分钟</label>}<button className="send" disabled={busy || !draft.trim()} onClick={() => void submit()}>↑</button></div></div><small className="hint">{state.availableEngines.includes(engine) ? '任务由本机后台处理。' : '所选内核未配置；新任务会显示失败并可在配置后重试。'}</small></div>
      </section>}
      {view === 'activity' && <section className="content"><div className="section-heading"><h1>Activity</h1><p>查看 dot 正在处理的工作、结果和需要你决定的事项。</p></div><div className="cards">{state.tasks.length ? state.tasks.map(task => <div className="task-card" key={task.id}><div className="task-card-head"><span className={`pill ${task.status}`}>{statusText[task.status]}</span><time>{new Date(task.updatedAt).toLocaleString('zh-CN')}</time></div><h2>{task.title}</h2><p>{task.error || task.result || task.instruction}</p><div className="card-actions"><button onClick={() => { setSelected(task.id); setView('chat'); }}>查看详情 →</button><TaskControls task={task} act={act} compact /></div></div>) : <div className="empty">还没有任务。回到对话，交给 dot 第一项工作。</div>}</div></section>}
      {view === 'scheduled' && <section className="content"><div className="section-heading"><h1>Scheduled</h1><p>查看和停止定期工作。网址检查只读取页面内容，有变化时在对话中提醒你。</p></div><div className="watch-form"><input aria-label="HTTPS 网址" placeholder="https://example.com/page" value={watchUrl} onChange={e => setWatchUrl(e.target.value)} /><label>每 <input type="number" min="5" max="10080" value={watchMinutes} onChange={e => setWatchMinutes(Number(e.target.value))} /> 分钟</label><button disabled={!watchUrl.trim()} onClick={() => void addWatch()}>添加检查</button></div><div className="cards">{state.watches.map(watch => <div className="task-card" key={watch.id}><span className={`pill ${watch.status === 'active' ? 'scheduled' : 'paused'}`}>{watch.status === 'active' ? '检查中' : '已暂停'}</span><h2>{watch.url}</h2><p>每 {watch.intervalMinutes} 分钟 · {watch.lastStatus || '尚未检查'}{watch.error ? ` · ${watch.error}` : ''}</p><div className="card-actions"><button onClick={() => void actWatch(watch.id, watch.status === 'active' ? 'pause' : 'resume')}>{watch.status === 'active' ? '暂停' : '继续'}</button></div></div>)}{state.tasks.filter(t => t.scheduleMinutes !== null).map(task => <div className="task-card" key={task.id}><span className={`pill ${task.status}`}>{statusText[task.status]}</span><h2>{task.title}</h2><p>每 {task.scheduleMinutes} 分钟 · 下次运行：{task.nextRunAt ? new Date(task.nextRunAt).toLocaleString('zh-CN') : '待定'}</p><div className="card-actions"><button onClick={() => { setSelected(task.id); setView('chat'); }}>查看详情 →</button><button onClick={() => void act(task, 'cancelSchedule')}>取消安排</button></div></div>)}{state.watches.length === 0 && !state.tasks.some(t => t.scheduleMinutes !== null) && <div className="empty">还没有定期工作。</div>}</div></section>}
      {view === 'profile' && <Profile state={state} onError={setError} />}
    </main>
  </div>;
}

function TaskControls({ task, act, compact = false }: { task: Task; act: (task: Task, action: string, extra?: object) => Promise<void>; compact?: boolean }) {
  const [redirect, setRedirect] = useState('');
  return <div className={`task-controls ${compact ? 'compact' : ''}`}>
    {!compact && <span className={`pill ${task.status}`}>{statusText[task.status]}</span>}
    {['working', 'queued', 'scheduled'].includes(task.status) && <button onClick={() => void act(task, 'pause')}>暂停</button>}
    {['paused', 'waiting', 'failed'].includes(task.status) && <button onClick={() => void act(task, task.status === 'failed' ? 'retry' : 'resume')}>{task.status === 'failed' ? '重试' : '继续'}</button>}
    {!compact && <><button onClick={() => void act(task, 'priority', { priority: task.priority + 1 })}>提高优先级</button><div className="redirect"><input value={redirect} onChange={e => setRedirect(e.target.value)} placeholder="调整这项工作的要求" /><button disabled={!redirect.trim()} onClick={() => { void act(task, 'redirect', { instruction: redirect }); setRedirect(''); }}>更新</button></div></>}
  </div>;
}

function Profile({ state, onError }: { state: Snapshot; onError: (s: string) => void }) {
  const [name, setName] = useState(state.profile.name);
  const [shape, setShape] = useState(state.profile.shape);
  const [color, setColor] = useState(state.profile.color);
  const [baseUrl, setBaseUrl] = useState(state.modelSettings.baseUrl || 'https://api.openai.com/v1');
  const [model, setModel] = useState(state.modelSettings.model);
  const [apiKey, setApiKey] = useState('');
  useEffect(() => { setName(state.profile.name); setShape(state.profile.shape); setColor(state.profile.color); }, [state.profile.name, state.profile.shape, state.profile.color]);
  useEffect(() => { if (state.modelSettings.baseUrl) setBaseUrl(state.modelSettings.baseUrl); if (state.modelSettings.model) setModel(state.modelSettings.model); }, [state.modelSettings.baseUrl, state.modelSettings.model]);
  return <section className="content profile-content"><div className="section-heading"><h1>你的 dot</h1><p>给它起个名字，选择一个外观。</p></div><div className="profile-card"><Avatar shape={shape} color={color} /><label>名字<input maxLength={40} value={name} onChange={e => setName(e.target.value)} /></label><div className="field-label">形状</div><div className="choices">{['circle', 'square', 'triangle'].map(item => <button key={item} className={shape === item ? 'chosen' : ''} onClick={() => setShape(item)}>{item === 'circle' ? '圆形' : item === 'square' ? '方形' : '三角形'}</button>)}</div><label>颜色<input type="color" value={color} onChange={e => setColor(e.target.value)} /></label><button className="primary" onClick={async () => { try { await request('/profile', 'PATCH', { name, shape, color }); } catch (e) { onError(String(e)); } }}>保存更改</button></div><div className="section-heading model-heading"><h2>模型 API</h2><p>密钥保存在 macOS 钥匙串，不写入项目或 SQLite。</p></div><div className="profile-card model-card"><label>API 地址<input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} /></label><label>模型名称<input value={model} onChange={e => setModel(e.target.value)} /></label><label>API 密钥<input type="password" autoComplete="off" placeholder={state.modelSettings.hasKey ? '已保存；留空则保持不变' : '输入密钥'} value={apiKey} onChange={e => setApiKey(e.target.value)} /></label><button className="primary" onClick={async () => { try { await request('/model-settings', 'PATCH', { baseUrl, model, apiKey }); setApiKey(''); } catch (e) { onError(String(e)); } }}>保存模型设置</button></div></section>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
