import React, { useEffect, useState } from 'react';
import { appFetch, appPath } from './api.ts';

interface GmailSnapshot {
  configured: boolean;
  connected: boolean;
  connection: { email: string; connectedAt: string; scopes: string[] } | null;
}

export function GmailSetup({ onError }: { onError: (message: string) => void }) {
  const [snapshot, setSnapshot] = useState<GmailSnapshot | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const response = await appFetch('/api/gmail');
    const data = await response.json() as GmailSnapshot & { error?: string };
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    setSnapshot(data);
  };

  useEffect(() => { void refresh().catch(error => onError(error instanceof Error ? error.message : String(error))); }, []);

  async function disconnect() {
    setBusy(true);
    try {
      const response = await appFetch('/api/gmail', { method: 'DELETE' });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      await refresh();
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return <>
    <div className="section-heading model-heading"><h2>Gmail</h2><p>连接个人邮箱后，Dot 只会在你明确要求读取邮件时搜索和总结；不会发送、修改或删除邮件。</p></div>
    <div className="profile-card model-card gmail-connection-card" data-testid="gmail-connection-card">
      {snapshot === null ? <p role="status">正在读取 Gmail 连接状态…</p> : snapshot.connected && snapshot.connection ? <>
        <p role="status"><strong>已连接</strong> · {snapshot.connection.email}</p>
        <small>权限：只读邮件。令牌保存在这台 Mac 的系统钥匙串中。</small>
        <button type="button" disabled={busy} onClick={() => void disconnect()} data-testid="gmail-disconnect">{busy ? '正在断开…' : '断开 Gmail'}</button>
      </> : <>
        <p role="status">尚未连接 Gmail</p>
        <small>{snapshot.configured ? 'Google 会单独询问邮件只读权限；登录 Coke Dots 不会自动获得邮箱访问权限。' : '此构建尚未配置 Google OAuth。'}</small>
        {snapshot.configured && <button type="button" className="primary" disabled={busy} data-testid="gmail-connect" onClick={() => { window.location.assign(appPath('/api/gmail/oauth/start')); }}>连接 Gmail（只读）</button>}
      </>}
    </div>
  </>;
}
