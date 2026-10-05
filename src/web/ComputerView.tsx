import { useEffect, useState, type MouseEvent } from 'react';
import './computer.css';

interface ComputerState { ready: boolean; owner: 'agent' | 'user'; url: string; title: string }

export function ComputerView({ dotName, onError }: { dotName: string; onError: (message: string) => void }) {
  const [state, setState] = useState<ComputerState>({ ready: false, owner: 'agent', url: '', title: '' });
  const [url, setUrl] = useState('');
  const [input, setInput] = useState('');
  const [frame, setFrame] = useState(0);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const response = await fetch('/api/computer');
      if (!response.ok) return;
      const next = await response.json() as ComputerState;
      setState(next);
      if (next.ready) setFrame(Date.now());
    } catch { /* The main UI reports service connectivity. */ }
  }
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 2000); return () => clearInterval(timer); }, []);

  async function action(path: string, body: object = {}) {
    setBusy(true);
    try {
      const response = await fetch(`/api/computer/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json() as ComputerState & { error?: string };
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      setState(result); setFrame(Date.now());
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  function click(event: MouseEvent<HTMLImageElement>) {
    if (state.owner !== 'user') return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.round((event.clientX - rect.left) * 1280 / rect.width);
    const y = Math.round((event.clientY - rect.top) * 720 / rect.height);
    void action('click', { x, y });
  }

  return <section className="computer-view"><div className="computer-heading"><div><h1>{dotName} 的电脑</h1><p>独立的浏览器工作区。打开画面后选择“接管”才能使用鼠标和键盘。</p></div>{state.ready && <button className="take-button" disabled={busy} onClick={() => void action(state.owner === 'user' ? 'return-control' : 'take-over')}>{state.owner === 'user' ? '交还控制' : '接管'}</button>}</div>
    {!state.ready ? <div className="computer-empty"><div className="computer-icon">▣</div><h2>打开独立浏览器</h2><p>网站会话保存在 Coke Dots 专用工作区，不沿用你的个人 Chrome 登录。</p><button disabled={busy} onClick={() => void action('open')}>打开电脑</button></div> : <><div className="browser-toolbar"><span className="browser-dots"><i /><i /><i /></span><form onSubmit={event => { event.preventDefault(); if (state.owner === 'user') void action('navigate', { url }); }}><input value={url} onChange={event => setUrl(event.target.value)} placeholder={state.url || '输入网址并回车'} disabled={state.owner !== 'user'} /></form><span className="owner" role="status">{state.owner === 'user' ? '你正在控制' : `${dotName} 正在控制`}</span></div><div className="browser-frame"><img src={`/api/computer/screenshot?t=${frame}`} alt="独立浏览器画面" onClick={click} /></div><div className="computer-footer"><span>{state.title || state.url || '空白页'}</span>{state.owner === 'user' && <form onSubmit={event => { event.preventDefault(); if (input) { void action('type', { text: input }); setInput(''); } }}><input value={input} onChange={event => setInput(event.target.value)} placeholder="向当前焦点输入文字" /><button>输入</button></form>}</div><p className="computer-note">代理浏览器操作尚未接入；交还控制后，工作区保持原状态，供后续任务使用。</p></>}
  </section>;
}
