import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { appFetch, appPath } from './api.ts';
import dotsFilesIcon from './assets/dots-files.svg';
import './computer.css';

interface ComputerState { ready: boolean; owner: 'agent' | 'user'; url: string; title: string; backend?: 'local' | 'linux-desktop'; width?: number; height?: number }

export function ComputerView({ dotName, localComputerEnabled, onManageAccess, onError }: { dotName: string; localComputerEnabled: boolean; onManageAccess: () => void; onError: (message: string) => void }) {
  const [state, setState] = useState<ComputerState>({ ready: false, owner: 'agent', url: '', title: '' });
  const [url, setUrl] = useState('');
  const [frame, setFrame] = useState(0);
  const [busy, setBusy] = useState(false);
  const keyboardQueue = useRef<Promise<void>>(Promise.resolve());

  async function refresh() {
    try {
      const response = await appFetch('/api/computer');
      if (!response.ok) return;
      const next = await response.json() as ComputerState;
      setState(next);
      if (next.ready) setFrame(Date.now());
    } catch { /* The main UI reports service connectivity. */ }
  }
  useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 2000); return () => clearInterval(timer); }, [dotName]);

  async function action(path: string, body: object = {}) {
    setBusy(true);
    try {
      const response = await appFetch(`/api/computer/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json() as ComputerState & { error?: string };
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      setState(result); setFrame(Date.now());
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  function queueKeyboardAction(path: string, body: object) {
    keyboardQueue.current = keyboardQueue.current.then(() => action(path, body));
  }

  function click(event: MouseEvent<HTMLImageElement>) {
    if (state.owner !== 'user') return;
    const image = event.currentTarget;
    const rect = image.getBoundingClientRect();
    const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
    const offsetX = (rect.width - image.naturalWidth * scale) / 2;
    const offsetY = (rect.height - image.naturalHeight * scale) / 2;
    const localX = event.clientX - rect.left - offsetX;
    const localY = event.clientY - rect.top - offsetY;
    if (localX < 0 || localY < 0 || localX > image.naturalWidth * scale || localY > image.naturalHeight * scale) return;
    void action('click', { x: Math.round(localX / scale), y: Math.round(localY / scale) });
  }

  function keyDown(event: KeyboardEvent<HTMLImageElement>) {
    if (state.owner !== 'user' || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.length === 1) {
      event.preventDefault();
      queueKeyboardAction('type', { text: event.key });
      return;
    }
    const key = event.key === ' ' ? 'Space' : event.key;
    if (['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space'].includes(key)) {
      event.preventDefault();
      queueKeyboardAction('press', { key });
    }
  }

  if (!localComputerEnabled && state.backend !== 'linux-desktop') return <section className="computer-view"><div className="computer-empty" data-testid="computer-access-disabled"><div className="computer-icon">▣</div><h2>本机 Chrome 工作区已关闭</h2><p>此工作区尚未允许 Dot 使用本机上的隔离 Chrome 浏览器。</p><button onClick={onManageAccess}>更改电脑访问</button></div></section>;

  return <section className="computer-view" aria-label={`${dotName} 的电脑`}>
      {!state.ready && busy && state.backend === 'linux-desktop' ? <div className="computer-boot-stage" data-testid="computer-boot-screen" role="status" aria-label="正在打开云电脑"><span aria-hidden="true" /></div> : !state.ready ? <div className="computer-empty"><div className="computer-icon">▣</div><h2>打开独立电脑</h2><p>{state.backend === 'linux-desktop' ? '这台 Debian 云电脑和 Agent 运行时在独立工作区内持续运行。' : '工作区会话保存在 Coke Dots 专用 Chrome 配置中。'}</p><button disabled={busy} onClick={() => void action('open', { dotName })}>打开电脑</button></div> : <div className={`computer-workspace${state.owner === 'user' ? ' has-user-control' : ''}${state.backend === 'linux-desktop' ? ' is-linux-desktop-workspace' : ''}`} data-testid="computer-workspace">
      {state.backend === 'linux-desktop' ? <div className="computer-stage is-linux-desktop" data-testid="linux-desktop-stage">
        {state.owner === 'user'
          ? <iframe title="Linux 云桌面" data-testid="linux-desktop-view" src={`${appPath('/api/computer/novnc/vnc_lite.html')}?scale=1&autoconnect=1&path=${appPath('/api/computer/novnc/websockify').slice(1)}`} />
          : <img src={appPath(`/api/computer/screenshot?t=${frame}`)} alt="Linux 云桌面画面" />}
      </div> : <div className="computer-stage">
        <div className="computer-browser-window">
          <div className="browser-window-chrome">
            <div className="browser-tab-strip"><span className="browser-tab-menu" aria-hidden="true">⌄</span><span className="browser-tab-favicon" aria-hidden="true" /><span className="browser-tab-title" title={state.title || 'New tab'}>{state.url === 'about:blank' ? '' : state.title || 'New tab'}</span><span className="browser-tab-close" aria-hidden="true">×</span><span className="browser-tab-add" aria-hidden="true">＋</span><span className="browser-window-controls" aria-hidden="true"><i>−</i><i>□</i><i>×</i></span></div>
            <div className="browser-toolbar">
              <button type="button" className="browser-nav-icon" aria-label="后退" disabled>‹</button>
              <button type="button" className="browser-nav-icon" aria-label="前进" disabled>›</button>
              <span className="browser-nav-icon browser-refresh-icon" aria-hidden="true">↻</span>
              <form onSubmit={event => { event.preventDefault(); if (state.owner === 'user') void action('navigate', { url }); }}>
                <input aria-label="电脑网址" value={url} onChange={event => setUrl(event.target.value)} placeholder={state.url && state.url !== 'about:blank' ? state.url : ''} disabled={state.owner !== 'user'} />
              </form>
              <span className="browser-toolbar-menu" aria-hidden="true">⋮</span>
            </div>
          </div>
          <div className="browser-page-frame"><img src={appPath(`/api/computer/screenshot?t=${frame}`)} alt="独立浏览器画面" tabIndex={state.owner === 'user' ? 0 : -1} onClick={click} onKeyDown={keyDown} /></div>
        </div>
        <div className="computer-dock" aria-hidden="true"><span className="dock-chrome">◉</span><span className="dock-terminal">›_</span><span className="dock-files"><img src={dotsFilesIcon} alt="" /></span></div>
      </div>}
      <div className={`computer-controlbar${state.owner === 'user' ? ' is-user-control' : ''}`}>
        <span className="computer-owner" role="status"><i />{state.owner === 'user' ? 'You have control' : `${dotName} has control`}</span>
        <button className="take-button" disabled={busy} onClick={() => void action(state.owner === 'user' ? 'return-control' : 'take-over')}>{state.owner === 'user' ? 'Return control' : 'Take over'}</button>
      </div>
    </div>}
  </section>;
}
