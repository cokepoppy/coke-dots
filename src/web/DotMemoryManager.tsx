import { useEffect, useState } from 'react';
import type { DotMemory } from '../shared/types.ts';
import { appFetch } from './api.ts';

export function DotMemoryManager({ tenantId, userId }: { tenantId: string; userId: string }) {
  const [memories, setMemories] = useState<DotMemory[]>([]);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setMemories([]); setDraft(''); setEditingId(null); setEditingDraft(''); setError('');
    void appFetch('/api/dot-memories').then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      if (active) setMemories(data as DotMemory[]);
    }).catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; };
  }, [tenantId, userId]);

  async function addMemory() {
    setBusy(true); setError('');
    try {
      const response = await appFetch('/api/dot-memories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: draft }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const memory = data as DotMemory;
      setMemories(current => [memory, ...current.filter(item => item.id !== memory.id)]);
      setDraft('');
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  async function saveMemory(memory: DotMemory) {
    setBusy(true); setError('');
    try {
      const response = await appFetch(`/api/dot-memories/${memory.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: editingDraft }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const updated = data as DotMemory;
      setMemories(current => current.map(item => item.id === updated.id ? updated : item));
      setEditingId(null); setEditingDraft('');
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  async function deleteMemory(memory: DotMemory) {
    setBusy(true); setError('');
    try {
      const response = await appFetch(`/api/dot-memories/${memory.id}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setMemories(current => current.filter(item => item.id !== memory.id));
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  return <>
    <div className="section-heading model-heading"><h2>Dot 私人记忆</h2><p>Dot 会记住你明确要求保存的内容，以及清楚表达的长期偏好、决定和持续事项。只有当前账号可见；资料页可随时编辑或删除。</p></div>
    <div className="profile-card model-card memory-card" data-testid="dot-memory-manager">
      <div className="memory-list" aria-label="已保存的 Dot 私人记忆">
        {memories.map(memory => <article className="memory-row" data-testid="dot-memory-row" key={memory.id}>
          {editingId === memory.id ? <>
            <label>编辑这条私人记忆<textarea aria-label="编辑这条私人记忆" maxLength={1000} value={editingDraft} onChange={event => setEditingDraft(event.target.value)} /></label>
            <div className="memory-actions"><button className="primary" disabled={busy || !editingDraft.trim()} onClick={() => void saveMemory(memory)}>保存更改</button><button disabled={busy} onClick={() => { setEditingId(null); setEditingDraft(''); }}>取消</button></div>
          </> : <>
            <p>{memory.note}</p><small>Dot 私人记忆 · 仅你可见</small>
            <div className="memory-actions"><button aria-label={`编辑私人记忆：${memory.note}`} disabled={busy} onClick={() => { setEditingId(memory.id); setEditingDraft(memory.note); }}>编辑</button><button aria-label={`删除私人记忆：${memory.note}`} disabled={busy} onClick={() => void deleteMemory(memory)}>删除</button></div>
          </>}
        </article>)}
        {memories.length === 0 && <small data-testid="empty-dot-memory-list">Dot 还没有保存私人记忆。</small>}
      </div>
      <label>添加一条私人记忆<textarea aria-label="添加 Dot 私人记忆" maxLength={1000} value={draft} onChange={event => setDraft(event.target.value)} placeholder="例如：回答时优先使用中文，日期按北京时间表达。" /></label>
      <button className="primary" disabled={busy || !draft.trim() || memories.length >= 20} onClick={() => void addMemory()}>保存私人记忆</button>
      <small>每个 Dot 最多保存 20 条，每条最多 1000 个字符。不会保存密钥、令牌或密码。</small>
      {error && <small role="alert" className="member-error">{error}</small>}
    </div>
  </>;
}
