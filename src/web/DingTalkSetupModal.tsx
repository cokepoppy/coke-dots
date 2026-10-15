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
interface GroupSearch { groups: DingTalkGroup[]; hasMore: boolean; nextCursor?: string; complete?: boolean; failureCount?: number }
interface DingTalkMonitorGroup { conversationId: string; groupName: string; enabled: boolean; keywords: string[]; canEnable: boolean; listenerState?: 'off' | 'starting' | 'listening' | 'reconnecting'; listenerIssue?: 'authorization-expired' | 'event-subscription-unavailable' | 'connection-lost'; reason?: string }
interface DingTalkMonitors { stream: { configured: boolean; connected: boolean; ready: boolean; testOnly?: boolean }; groups: DingTalkMonitorGroup[] }

export function DingTalkSetupModal({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<DingTalkStatus | null>(null);
  const [flow, setFlow] = useState<AuthorizationFlow | null>(null);
  const [selected, setSelected] = useState<DingTalkGroup[]>([]);
  const [monitors, setMonitors] = useState<DingTalkMonitors | null>(null);
  const [keywordDrafts, setKeywordDrafts] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DingTalkGroup[]>([]);
  const [searchedQuery, setSearchedQuery] = useState<string | null>(null);
  const [resultMode, setResultMode] = useState<'search' | 'list' | null>(null);
  const [listComplete, setListComplete] = useState<boolean | null>(null);
  const [listFailureCount, setListFailureCount] = useState(0);
  const [cursor, setCursor] = useState('0');
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const selectedIds = useMemo(() => new Set(selected.map(group => group.conversationId)), [selected]);
  const hasEnabledMonitor = monitors?.groups.some(group => group.enabled) || false;

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
      setKeywordDrafts(Object.fromEntries(nextMonitors.groups.map(group => [group.conversationId, group.keywords.join(', ')])));
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
    if (!hasEnabledMonitor) return;
    let disposed = false;
    const refreshMonitorState = async () => {
      try {
        const next = await appFetch('/api/dingtalk/monitors').then(response => readJson<DingTalkMonitors>(response));
        if (!disposed) setMonitors(next);
      } catch { /* Preserve the last known state during a transient status request failure. */ }
    };
    void refreshMonitorState();
    const timer = window.setInterval(() => { void refreshMonitorState(); }, 2000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [hasEnabledMonitor]);

  useEffect(() => {
    if (!flow || !['starting', 'awaiting-user', 'verifying'].includes(flow.state)) return;
    let disposed = false;
    const poll = async () => {
      try {
        const next = await appFetch(`/api/dingtalk/authorization/${encodeURIComponent(flow.id)}`).then(response => readJson<AuthorizationFlow>(response));
        if (disposed) return;
        setFlow(next);
        if (next.state === 'authorized') {
          setNotice('钉钉账号已连接。你可以为已保存的群单独开启个人消息实时监听。');
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
    if (!append) { setResults([]); setSearchedQuery(null); setResultMode(null); setListComplete(null); setListFailureCount(0); }
    try {
      const page = await appFetch('/api/dingtalk/groups/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: cleanQuery, cursor: nextCursor }) }).then(response => readJson<GroupSearch>(response));
      setResults(current => append ? mergeGroups(current, page.groups) : page.groups);
      setSearchedQuery(cleanQuery); setResultMode('search'); setListComplete(null); setListFailureCount(0);
      setCursor(page.nextCursor || '0'); setHasMore(page.hasMore);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '钉钉群搜索失败。'); }
    finally { setWorking(false); }
  }

  async function listGroups(nextCursor = '0', append = false) {
    if (working) return;
    setWorking(true); setError(''); setNotice('');
    if (!append) { setResults([]); setSearchedQuery(null); setResultMode(null); setListComplete(null); setListFailureCount(0); }
    try {
      const page = await appFetch('/api/dingtalk/groups/list', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cursor: nextCursor, pageLimit: 50 }) }).then(response => readJson<GroupSearch>(response));
      setResults(current => append ? mergeGroups(current, page.groups) : page.groups);
      setResultMode('list'); setListComplete(page.complete === true); setListFailureCount(page.failureCount || 0);
      setCursor(page.nextCursor || '0'); setHasMore(page.hasMore);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '加载钉钉群聊失败。'); }
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

  function keywordsForGroup(group: DingTalkMonitorGroup) {
    return (keywordDrafts[group.conversationId] ?? group.keywords.join(', '))
      .split(/[，,\n]+/).map(item => item.trim()).filter(Boolean)
      .filter((item, index, all) => all.findIndex(other => other.toLocaleLowerCase() === item.toLocaleLowerCase()) === index);
  }

  async function saveMonitorConfiguration(group: DingTalkMonitorGroup, enabled = group.enabled) {
    if (working || (enabled && !group.canEnable)) return;
    const keywords = keywordsForGroup(group);
    if (enabled && keywords.length === 0) { setError('请至少填写一个告警关键词后再开启监听。'); return; }
    if (keywords.length > 20 || keywords.some(item => item.length > 80)) { setError('最多可配置 20 个关键词，每个关键词不超过 80 个字符。'); return; }
    setWorking(true); setError(''); setNotice('');
    try {
      const updated = await appFetch('/api/dingtalk/monitors', { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId: group.conversationId, enabled, keywords }) })
        .then(response => readJson<{ conversationId: string; enabled: boolean; keywords: string[] }>(response));
      setMonitors(current => current ? { ...current, groups: current.groups.map(item => item.conversationId === updated.conversationId ? { ...item, enabled: updated.enabled, keywords: updated.keywords } : item) } : current);
      setKeywordDrafts(current => ({ ...current, [updated.conversationId]: updated.keywords.join(', ') }));
      setNotice(enabled ? '已开启此群监听；只有包含所设关键词的消息才会启动 Pi 只读排查。' : '已暂停此群监听。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '更新群监听失败。'); }
    finally { setWorking(false); }
  }

  async function toggleMonitor(group: DingTalkMonitorGroup) {
    if (!group.enabled && (!group.canEnable || group.keywords.length === 0)) return;
    await saveMonitorConfiguration(group, !group.enabled);
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
        {monitors && <section className={`dingtalk-stream-status ${monitors.stream.ready ? 'is-ready' : 'is-unready'}`} data-testid="dingtalk-app-stream-status" aria-label="Dots 应用机器人 Stream 状态">
          <div className="dingtalk-stream-status-heading"><div><strong>Dots 应用机器人 Stream</strong><p>接收连接到此 Dots 应用的机器人回调。</p></div><span className="dingtalk-stream-status-badge" data-testid="dingtalk-app-stream-status-label">{streamStatusText(monitors.stream)}</span></div>
          <p>这与个人账号的 DWS 群监听分开。下方监听只作用于你明确保存并开启的群。</p>
          {monitors.stream.testOnly && <small>这是浏览器自动化测试的模拟 Stream 状态，不代表公网应用连接状态。</small>}
        </section>}
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
          <div className="dingtalk-section-title"><div><h3>选择群聊</h3><p>搜索群名，或加载当前账号加入的群</p></div><span>{selected.length}/20</span></div>
          <form className="dingtalk-search" onSubmit={event => { event.preventDefault(); void searchGroups(); }}>
            <input aria-label="搜索钉钉群聊" data-testid="dingtalk-group-query" value={query} onChange={event => { setQuery(event.currentTarget.value); setResults([]); setSearchedQuery(null); setResultMode(null); setListComplete(null); setListFailureCount(0); setCursor('0'); setHasMore(false); }} placeholder="输入群名称关键词" maxLength={100} />
            <button type="submit" data-testid="dingtalk-group-search" disabled={working || !query.trim()}>搜索</button>
          </form>
          <button className="dingtalk-setup-secondary dingtalk-group-list" type="button" data-testid="dingtalk-group-list" disabled={working} onClick={() => void listGroups()}>{working && resultMode === null ? '正在加载…' : '加载我加入的群'}</button>
          {results.length > 0 && <div className="dingtalk-group-results" role="group" aria-label={resultMode === 'list' ? '我加入的钉钉群聊' : '钉钉群搜索结果'}>
            {results.map(group => <label className="dingtalk-group-row" key={group.conversationId}>
              <input type="checkbox" checked={selectedIds.has(group.conversationId)} onChange={() => toggleGroup(group)} />
              <span><strong>{group.name}</strong><small>保存后可在下方单独开启监听</small></span>
            </label>)}
            {hasMore && <button className="dingtalk-setup-secondary" type="button" disabled={working} onClick={() => void (resultMode === 'list' ? listGroups(cursor, true) : searchGroups(cursor, true))}>{resultMode === 'list' ? '加载更多群聊' : '加载更多搜索结果'}</button>}
          </div>}
          {results.length === 0 && resultMode === 'search' && query && searchedQuery === query.trim()
            ? <p className="dingtalk-empty-results" data-testid="dingtalk-group-empty-state" role="status">没有找到与“{searchedQuery}”匹配的群聊。试试更短的关键词，或确认当前钉钉账号有权访问该群。</p>
            : results.length === 0 && resultMode === 'list' && listComplete === true
              ? <p className="dingtalk-empty-results" data-testid="dingtalk-group-list-empty-state" role="status">当前钉钉账号没有可访问的群聊。</p>
              : results.length === 0 && resultMode === 'list' && listComplete === false
                ? <p className="dingtalk-empty-results" data-testid="dingtalk-group-list-incomplete" role="status">群列表尚未完整加载{listFailureCount > 0 ? `（${listFailureCount} 项失败）` : ''}。请继续加载或稍后重试。</p>
                : results.length === 0 && resultMode === null && <p className="dingtalk-empty-results">可以搜索群名，也可以加载当前账号加入的全部群。</p>}
          {resultMode === 'list' && listComplete === true && results.length > 0 && <p className="dingtalk-empty-results" data-testid="dingtalk-group-list-complete" role="status">已加载当前账号加入的全部群聊，共 {results.length} 个。</p>}
          {resultMode === 'list' && listComplete === false && results.length > 0 && <p className="dingtalk-empty-results" data-testid="dingtalk-group-list-incomplete" role="status">群列表尚未完整加载{listFailureCount > 0 ? `（${listFailureCount} 项失败）` : ''}。请继续加载更多群聊或稍后重试。</p>}
          {selected.length > 0 && <div className="dingtalk-selected-groups"><strong>待保存群聊</strong>{selected.map(group => <span key={group.conversationId}>{group.name}<button type="button" aria-label={`移除群 ${group.name}`} onClick={() => toggleGroup(group)}>×</button></span>)}</div>}
          <button className="dingtalk-setup-primary" type="button" data-testid="dingtalk-groups-save" disabled={working || !status?.configured} onClick={() => void saveGroups()}>{working ? '处理中…' : '保存群选择'}</button>
          {monitors && <div className="dingtalk-monitor-section" data-testid="dingtalk-monitor-section">
            <div className="dingtalk-section-title"><div><h3>实时告警监听</h3><p>通过当前钉钉账号的 DWS 个人 IM 事件流接收指定群消息</p></div><span>{monitors.groups.filter(group => group.enabled).length} 个启用</span></div>
            {status?.testOnly && <p className="dingtalk-monitor-note" data-testid="dingtalk-dws-test-mode">当前为浏览器自动化测试模拟的 DWS 个人事件监听，不代表真实群消息已经接入。</p>}
            {monitors.groups.length === 0 ? <p className="dingtalk-empty-results">先搜索并保存至少一个群聊。</p> : monitors.groups.map(group => <div className="dingtalk-monitor-row" key={group.conversationId}>
              <div className="dingtalk-monitor-heading">
                <span><strong>{group.groupName}</strong><small data-testid={`dingtalk-monitor-status-${group.conversationId}`}>{group.enabled ? listenerStatusText(group.listenerState, group.listenerIssue) : group.keywords.length ? '已配置条件 · 监听已关闭' : group.reason || '先设置关注关键词'}</small></span>
                <label className="dingtalk-monitor-switch"><input type="checkbox" role="switch" aria-label={`监听群 ${group.groupName}`} data-testid={`dingtalk-monitor-${group.conversationId}`}
                  checked={group.enabled} disabled={working || (!group.enabled && (!group.canEnable || group.keywords.length === 0))} onChange={() => void toggleMonitor(group)} /><span>监听</span></label>
              </div>
              <div className="dingtalk-monitor-filter">
                <label htmlFor={`dingtalk-keywords-${group.conversationId}`}>消息包含任一关键词时启动任务</label>
                <input id={`dingtalk-keywords-${group.conversationId}`} data-testid={`dingtalk-keywords-${group.conversationId}`} type="text" maxLength={1800}
                  value={keywordDrafts[group.conversationId] ?? group.keywords.join(', ')} placeholder="告警, 错误, Trace ID"
                  onChange={event => setKeywordDrafts(current => ({ ...current, [group.conversationId]: event.target.value }))} />
                <button className="dingtalk-setup-secondary" type="button" data-testid={`dingtalk-save-keywords-${group.conversationId}`} disabled={working}
                  onClick={() => void saveMonitorConfiguration(group)}>保存条件</button>
              </div>
            </div>)}
            <p className="dingtalk-setup-footnote">只处理匹配条件的消息；收到后会在当前工作区创建 Pi 云电脑只读排查任务。不同工作区相互隔离；不会自动回复群聊。</p>
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

function listenerStatusText(state: DingTalkMonitorGroup['listenerState'], issue?: DingTalkMonitorGroup['listenerIssue']) {
  if (issue === 'authorization-expired') return '钉钉授权已过期 · 请重新连接账号';
  if (issue === 'event-subscription-unavailable') return 'DWS 事件订阅不可用 · 正在重试';
  if (issue === 'connection-lost') return '事件流连接中断 · 正在自动重连';
  if (state === 'listening') return '监听中 · 收到消息后自动启动 Pi 排查';
  if (state === 'reconnecting') return '连接中断 · 正在自动重连';
  return '正在连接 DWS 实时事件流';
}

function streamStatusText(stream: DingTalkMonitors['stream']) {
  if (stream.testOnly) return stream.ready ? '测试模拟 · 已连接' : '测试模拟 · 未就绪';
  if (stream.ready) return '已连接';
  if (stream.configured && stream.connected) return '已连接 · 等待就绪';
  if (stream.configured) return '已配置 · 尚未连接';
  return '未配置';
}
