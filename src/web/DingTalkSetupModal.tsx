import { useEffect, useMemo, useState } from 'react';
import { appFetch } from './api.ts';
import './dingtalk-setup.css';

interface DingTalkAccount {
  state: 'not-configured' | 'not-installed' | 'identity-verified' | 'expired' | 'starting' | 'awaiting-user' | 'verifying' | 'failed' | 'cancelled';
  id?: string;
  authorizationUrl?: string;
  userCode?: string;
  reason?: string;
  testOnly?: boolean;
  accountName?: string;
  organizationName?: string;
  expiresAt?: string;
}

interface DingTalkStatus {
  configured: boolean;
  testOnly?: boolean;
  account: DingTalkAccount;
}

interface AuthorizationFlow {
  id: string;
  state: 'starting' | 'awaiting-user' | 'verifying' | 'authorized' | 'failed' | 'cancelled' | 'expired';
  authorizationUrl?: string;
  userCode?: string;
  expiresAt?: string;
  reason?: string;
  testOnly?: boolean;
  installation?: { accountName?: string; organizationName?: string; expiresAt?: string };
}

interface DingTalkGroup { conversationId: string; name: string }
interface GroupSearch { groups: DingTalkGroup[]; hasMore: boolean; nextCursor?: string }
interface DingTalkMonitorGroup { conversationId: string; groupName: string; enabled: boolean; canEnable: boolean; reason?: string }
interface DingTalkMonitors { stream: { configured: boolean; connected: boolean; ready: boolean; testOnly?: boolean }; groups: DingTalkMonitorGroup[] }

export function DingTalkSetupModal({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<DingTalkStatus | null>(null);
  const [flow, setFlow] = useState<AuthorizationFlow | null>(null);
  const [selected, setSelected] = useState<DingTalkGroup[]>([]);
  const [monitors, setMonitors] = useState<DingTalkMonitors | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DingTalkGroup[]>([]);
  const [cursor, setCursor] = useState('0');
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const selectedIds = useMemo(() => new Set(selected.map(group => group.conversationId)), [selected]);

  async function readJson<T>(response: Response): Promise<T> {
    const body = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw new Error(body.error || `请求失败（${response.status}）`);
    return body;
  }

  async function refresh() {
    setLoading(true);
    setError('');
    try {
      const [nextStatus, nextSelected, nextMonitors] = await Promise.all([
        appFetch('/api/dingtalk').then(response => readJson<DingTalkStatus>(response)),
        appFetch('/api/dingtalk/groups/selected').then(response => readJson<DingTalkGroup[]>(response)),
        appFetch('/api/dingtalk/monitors').then(response => readJson<DingTalkMonitors>(response)),
      ]);
      setStatus(nextStatus);
      setSelected(nextSelected);
      setMonitors(nextMonitors);
      const account = nextStatus.account;
      if (account.id && (account.state === 'starting' || account.state === 'awaiting-user' || account.state === 'verifying')) {
        setFlow({
          id: account.id,
          state: account.state,
          authorizationUrl: account.authorizationUrl,
          userCode: account.userCode,
          expiresAt: account.expiresAt,
          reason: account.reason,
          testOnly: account.testOnly || nextStatus.testOnly,
        });
      } else setFlow(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '读取钉钉连接状态失败。'); }
    finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    if (!flow || !['starting', 'awaiting-user', 'verifying'].includes(flow.state)) return;
    let disposed = false;
    const poll = async () => {
      try {
        const next = await appFetch(`/api/dingtalk/authorization/${encodeURIComponent(flow.id)}`).then(response => readJson<AuthorizationFlow>(response));
        if (disposed) return;
        setFlow(next);
        if (next.state === 'authorized') {
          setNotice('钉钉账号已连接。你可以为已保存的群单独开启 @机器人 事件监听。');
          await refresh();
        } else if (['failed', 'cancelled', 'expired'].includes(next.state)) {
          setError(next.reason || authorizationError(next.state));
          await refresh();
        }
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : '检查钉钉授权状态失败。');
      }
    };
    const timer = window.setInterval(() => { void poll(); }, 1500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [flow?.id, flow?.state]);

  async function beginAuthorization() {
    if (!status?.configured || working) return;
    setWorking(true); setError(''); setNotice('');
    try {
      const next = await appFetch('/api/dingtalk/authorization/start', { method: 'POST' }).then(response => readJson<AuthorizationFlow>(response));
      setFlow(next);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法开始钉钉授权。'); }
    finally { setWorking(false); }
  }

  async function completeTestAuthorization() {
    if (!flow?.testOnly) return;
    setWorking(true); setError('');
    try {
      const next = await appFetch('/api/dingtalk/e2e/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: flow.id }) }).then(response => readJson<AuthorizationFlow>(response));
      setFlow(next); setNotice('这是浏览器自动化测试模拟授权，不代表真实钉钉账号已授权。');
      await refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '模拟授权失败。'); }
    finally { setWorking(false); }
  }

  async function cancelAuthorization() {
    if (!flow) return;
    setWorking(true);
    try {
      const next = await appFetch(`/api/dingtalk/authorization/${encodeURIComponent(flow.id)}`, { method: 'DELETE' }).then(response => readJson<AuthorizationFlow>(response));
      setFlow(next); setNotice('已取消钉钉授权。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '取消授权失败。'); }
    finally { setWorking(false); }
  }

  async function searchGroups(nextCursor = '0', append = false) {
    const cleanQuery = query.trim();
    if (!cleanQuery || working) return;
    setWorking(true); setError(''); setNotice('');
    try {
      const page = await appFetch('/api/dingtalk/groups/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: cleanQuery, cursor: nextCursor }) }).then(response => readJson<GroupSearch>(response));
      setResults(current => append ? mergeGroups(current, page.groups) : page.groups);
      setCursor(page.nextCursor || '0'); setHasMore(page.hasMore);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '钉钉群搜索失败。'); }
    finally { setWorking(false); }
  }

  function toggleGroup(group: DingTalkGroup) {
    setSelected(current => {
      if (current.some(item => item.conversationId === group.conversationId)) return current.filter(item => item.conversationId !== group.conversationId);
      if (current.length >= 20) { setError('最多可以选择 20 个群。'); return current; }
      setError('');
      return [...current, group];
    });
  }

  async function saveGroups() {
    if (working) return;
    setWorking(true); setError(''); setNotice('');
    try {
      const saved = await appFetch('/api/dingtalk/groups/selected', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ groups: selected }) }).then(response => readJson<DingTalkGroup[]>(response));
      setSelected(saved);
      const nextMonitors = await appFetch('/api/dingtalk/monitors').then(response => readJson<DingTalkMonitors>(response));
      setMonitors(nextMonitors);
      setNotice('已保存群选择。是否开始监听，需要为每个群单独开启。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存群选择失败。'); }
    finally { setWorking(false); }
  }

  async function toggleMonitor(group: DingTalkMonitorGroup) {
    if (working || (!group.enabled && !group.canEnable)) return;
    setWorking(true); setError(''); setNotice('');
    try {
      const updated = await appFetch('/api/dingtalk/monitors', { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: group.conversationId, enabled: !group.enabled }) })
        .then(response => readJson<{ conversationId: string; enabled: boolean }>(response));
      setMonitors(current => current ? { ...current, groups: current.groups.map(item => item.conversationId === updated.conversationId ? { ...item, enabled: updated.enabled } : item) } : current);
      setNotice(updated.enabled ? '已开启此群的实时告警排查。机器人需要已加入群，且仅处理 @机器人的文本消息。' : '已暂停此群监听。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '更新群监听失败。'); }
    finally { setWorking(false); }
  }

  async function disconnect() {
    if (working) return;
    setWorking(true); setError(''); setNotice('');
    try {
      await appFetch('/api/dingtalk/account', { method: 'DELETE' }).then(response => readJson<{ disconnected: boolean }>(response));
      setFlow(null); setResults([]); setSelected([]); setStatus(current => current ? { ...current, account: { state: 'not-installed' } } : current);
      setNotice('已从此工作区移除钉钉凭据。服务端可能仍保留授权，需要在钉钉账号安全设置中撤销。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '断开钉钉连接失败。'); }
    finally { setWorking(false); }
  }

  const account = status?.account;
  const isConnected = account?.state === 'identity-verified';
  const activeFlow = flow && ['starting', 'awaiting-user', 'verifying'].includes(flow.state);

  return <div className="dingtalk-setup-backdrop" data-testid="dingtalk-setup-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="dingtalk-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="dingtalk-setup-title" onKeyDown={event => { if (event.key === 'Escape') onClose(); }}>
      <button className="dingtalk-setup-close" type="button" aria-label="关闭钉钉设置" onClick={onClose}>×</button>
      <div className="dingtalk-setup-heading"><span className="dingtalk-logo" aria-hidden="true">钉</span><div><h2 id="dingtalk-setup-title">连接钉钉</h2><p>把 Dot 连接到你的钉钉账号</p></div></div>
      {loading ? <p className="dingtalk-setup-status" role="status">正在读取连接状态…</p> : <>
        {status && !status.configured && <div className="dingtalk-setup-notice-box" role="status"><strong>钉钉连接服务尚未配置</strong><span>当前版本没有连接到隔离的 DWS 连接服务，暂时不能开始账号授权。</span></div>}
        {account?.state === 'not-installed' && status?.configured && !activeFlow && <div className="dingtalk-setup-card">
          <span className="dingtalk-setup-kicker">账号连接</span><h3>使用钉钉设备授权登录</h3>
          <p>点击后会生成一次性验证码。请在钉钉官方页面确认登录；凭据保存在独立连接服务，不会写入聊天或任务记录。</p>
          <button className="dingtalk-setup-primary" type="button" data-testid="dingtalk-authorize" disabled={working} onClick={() => void beginAuthorization()}>{working ? '正在启动…' : '连接钉钉账号'}</button>
        </div>}
        {account?.state === 'expired' && !activeFlow && <div className="dingtalk-setup-notice-box" role="status"><strong>钉钉授权已过期</strong><span>请重新连接账号后再搜索群聊。</span><button className="dingtalk-setup-primary" type="button" disabled={working || !status?.configured} onClick={() => void beginAuthorization()}>重新连接</button></div>}
        {activeFlow && <div className="dingtalk-setup-card dingtalk-authorization-card" data-testid="dingtalk-authorization-flow">
          <span className="dingtalk-setup-kicker">等待你在钉钉确认</span><h3>{flow.state === 'verifying' ? '正在确认账号身份…' : '在钉钉中完成登录'}</h3>
          {flow.userCode && <div className="dingtalk-device-code"><span>一次性验证码</span><strong data-testid="dingtalk-user-code">{flow.userCode}</strong></div>}
          {flow.authorizationUrl && <a className="dingtalk-setup-primary dingtalk-authorization-link" href={flow.authorizationUrl} target="_blank" rel="noreferrer">打开钉钉授权页面</a>}
          <p>本页面会自动检查授权结果。验证码有效期有限，请勿转发给他人。</p>
          {flow.testOnly && <button className="dingtalk-setup-secondary" data-testid="dingtalk-e2e-authorize" type="button" disabled={working} onClick={() => void completeTestAuthorization()}>仅浏览器测试：模拟授权完成</button>}
          <button className="dingtalk-setup-secondary" type="button" disabled={working} onClick={() => void cancelAuthorization()}>取消授权</button>
        </div>}
        {isConnected && <div className="dingtalk-setup-connected" data-testid="dingtalk-connected-state">
          <span className="dingtalk-connected-mark" aria-hidden="true">✓</span><div><strong>{account.accountName || '钉钉账号已连接'}</strong><span>{account.organizationName || '已确认钉钉账号身份'}</span></div>
          {account.expiresAt && <small>凭据有效期至 {new Date(account.expiresAt).toLocaleString()}</small>}
        </div>}
        {isConnected && <div className="dingtalk-groups-section">
          <div className="dingtalk-section-title"><div><h3>选择群聊</h3><p>按群名称搜索你有权访问的会话</p></div><span>{selected.length}/20</span></div>
          <form className="dingtalk-search" onSubmit={event => { event.preventDefault(); void searchGroups(); }}>
            <input aria-label="搜索钉钉群聊" data-testid="dingtalk-group-query" value={query} onChange={event => setQuery(event.currentTarget.value)} placeholder="输入群名称关键词" maxLength={100} />
            <button type="submit" data-testid="dingtalk-group-search" disabled={working || !query.trim()}>搜索</button>
          </form>
          {results.length > 0 && <div className="dingtalk-group-results" role="group" aria-label="钉钉群搜索结果">
            {results.map(group => <label className="dingtalk-group-row" key={group.conversationId}>
              <input type="checkbox" checked={selectedIds.has(group.conversationId)} onChange={() => toggleGroup(group)} />
              <span><strong>{group.name}</strong><small>保存后可在下方单独开启监听</small></span>
            </label>)}
            {hasMore && <button className="dingtalk-setup-secondary" type="button" disabled={working} onClick={() => void searchGroups(cursor, true)}>加载更多</button>}
          </div>}
          {results.length === 0 && query && <p className="dingtalk-empty-results">搜索结果会显示在这里。</p>}
          {selected.length > 0 && <div className="dingtalk-selected-groups"><strong>待保存群聊</strong>{selected.map(group => <span key={group.conversationId}>{group.name}<button type="button" aria-label={`移除群 ${group.name}`} onClick={() => toggleGroup(group)}>×</button></span>)}</div>}
          <button className="dingtalk-setup-primary" type="button" data-testid="dingtalk-groups-save" disabled={working || !status?.configured} onClick={() => void saveGroups()}>{working ? '处理中…' : '保存群选择'}</button>
          {monitors && <div className="dingtalk-monitor-section" data-testid="dingtalk-monitor-section">
            <div className="dingtalk-section-title"><div><h3>实时告警监听</h3><p>{monitors.stream.ready ? '机器人 Stream 已连接' : monitors.stream.configured ? '机器人 Stream 正在等待连接' : '实例尚未配置机器人 Stream'}</p></div><span>{monitors.groups.filter(group => group.enabled).length} 个启用</span></div>
            {monitors.stream.testOnly && <p className="dingtalk-monitor-note">当前为浏览器自动化测试模拟状态，不代表生产钉钉机器人已经连接。</p>}
            {monitors.groups.length === 0 ? <p className="dingtalk-empty-results">先搜索并保存至少一个群聊。</p> : monitors.groups.map(group => <label className="dingtalk-monitor-row" key={group.conversationId}>
              <span><strong>{group.groupName}</strong><small>{group.enabled ? (monitors.stream.ready ? '已开启 · 仅响应 @机器人' : '已开启，但机器人连接中断') : group.reason || '关闭'}</small></span>
              <input type="checkbox" role="switch" aria-label={`监听群 ${group.groupName}`} data-testid={`dingtalk-monitor-${group.conversationId}`}
                checked={group.enabled} disabled={working || (!group.enabled && !group.canEnable)} onChange={() => void toggleMonitor(group)} />
            </label>)}
            <p className="dingtalk-setup-footnote">开启后，钉钉 Stream 会把 @机器人的群文本实时推送到服务端，并为本工作区创建 Pi 云电脑只读排查任务。不同工作区的任务和群监听相互隔离；不会自动回复钉钉群。</p>
          </div>}
          <button className="dingtalk-setup-secondary dingtalk-disconnect" type="button" disabled={working} onClick={() => void disconnect()}>断开钉钉账号</button>
        </div>}
      </>}
      {error && <p className="dingtalk-setup-error" role="alert">{error}<button type="button" aria-label="重试读取钉钉状态" onClick={() => void refresh()}>重试</button></p>}
      {notice && <p className="dingtalk-setup-success" role="status">{notice}</p>}
    </section>
  </div>;
}

function mergeGroups(current: DingTalkGroup[], next: DingTalkGroup[]) {
  const items = new Map(current.map(group => [group.conversationId, group]));
  for (const group of next) items.set(group.conversationId, group);
  return [...items.values()];
}

function authorizationError(state: AuthorizationFlow['state']) {
  if (state === 'expired') return '钉钉授权已过期，请重新开始。';
  if (state === 'cancelled') return '已取消钉钉授权。';
  return '钉钉授权失败，请检查组织是否允许 DWS CLI 登录。';
}
