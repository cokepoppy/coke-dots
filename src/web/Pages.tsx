import { useEffect, useRef, useState } from 'react';
import type { WorkspacePage } from '../shared/types.ts';
import { appFetch } from './api.ts';

async function readResponse<T>(response: Response): Promise<T> {
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

export function PagesView({ tenantId, onOpen }: { tenantId: string; onOpen: (id: string) => void }) {
  const [pages, setPages] = useState<WorkspacePage[]>([]);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const loadGeneration = useRef(0);

  async function refresh() {
    const generation = ++loadGeneration.current;
    setLoading(true); setError('');
    try {
      const next = await readResponse<WorkspacePage[]>(await appFetch('/api/pages'));
      if (generation === loadGeneration.current) setPages(next);
    } catch (reason) { if (generation === loadGeneration.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (generation === loadGeneration.current) setLoading(false); }
  }
  useEffect(() => { setPages([]); void refresh(); return () => { loadGeneration.current += 1; }; }, [tenantId]);

  async function createPage(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !title.trim() || !content.trim()) return;
    setBusy(true); setError('');
    try {
      const page = await readResponse<WorkspacePage>(await appFetch('/api/pages', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, content }),
      }));
      setTitle(''); setContent(''); setPages(current => [page, ...current]); onOpen(page.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  return <section className="pages-view content" data-testid="scratchpad-library">
    <header className="scratchpad-library-heading"><div><div className="scratchpad-connected"><i /> Connected</div><h1>Your Personal Scratchpad</h1><p>Pages created by you or your dot, saved in this workspace.</p></div><span className="scratchpad-count">{pages.length} pages</span></header>
    {error && <p role="alert" className="scratchpad-error">{error}</p>}
    <div className="scratchpad-library-grid">
      <form className="scratchpad-create" onSubmit={event => void createPage(event)} data-testid="scratchpad-create-form">
        <div className="scratchpad-card-icon">＋</div><h2>New page</h2><p>Start a note or let your dot create one from a task.</p>
        <label>Page title<input aria-label="页面标题" maxLength={120} value={title} onChange={event => setTitle(event.target.value)} placeholder="Give this page a name" /></label>
        <label>Content<textarea aria-label="页面内容" maxLength={24000} value={content} onChange={event => setContent(event.target.value)} placeholder="Write a few notes…" /></label>
        <button className="primary" disabled={busy || !title.trim() || !content.trim() || pages.length >= 50}>{busy ? 'Creating…' : 'Create page'}</button>
      </form>
      <div className="scratchpad-page-list" aria-label="Scratchpad 页面">
        {loading ? <div className="scratchpad-list-empty" role="status">Loading pages…</div> : pages.length === 0 ? <div className="scratchpad-list-empty">Your Scratchpad pages will appear here.</div> : pages.map(page => <button key={page.id} className="scratchpad-page-row" onClick={() => onOpen(page.id)} data-testid="scratchpad-page-row">
          <span className="scratchpad-page-icon">▤</span><span className="scratchpad-page-copy"><strong>{page.title}</strong><small>{page.content.replace(/[#*`>-]/g, '').slice(0, 120)}</small><small>Updated {new Date(page.updatedAt).toLocaleString()}</small></span><span className="scratchpad-page-chevron">›</span>
        </button>)}
      </div>
    </div>
    <p className="scratchpad-sharing-note">Pages are visible to members of this workspace. Personal and shared workspaces keep separate pages.</p>
  </section>;
}

export function ScratchpadNavigationPane({ tenantId, selectedPageId, refreshKey, onOpen, onBack }: { tenantId: string; selectedPageId: string; refreshKey: number; onOpen: (id: string) => void; onBack: () => void }) {
  const [pages, setPages] = useState<WorkspacePage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const loadGeneration = useRef(0);

  useEffect(() => {
    const generation = ++loadGeneration.current;
    let active = true;
    setPages([]); setLoading(true); setError('');
    void appFetch('/api/pages').then(response => readResponse<WorkspacePage[]>(response)).then(next => {
      if (active && generation === loadGeneration.current) setPages(next);
    }).catch(reason => {
      if (active && generation === loadGeneration.current) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (active && generation === loadGeneration.current) setLoading(false);
    });
    return () => { active = false; loadGeneration.current += 1; };
  }, [tenantId, refreshKey]);

  return <aside className="scratchpad-navigation-pane" aria-label="Scratchpad page navigation" data-testid="scratchpad-navigation">
    <header><button className="scratchpad-navigation-root" onClick={onBack} aria-label="Back to Your Personal Scratchpad"><span aria-hidden="true">‹</span>Your Personal Scratchpad</button></header>
    {error && <p role="alert" className="scratchpad-navigation-error">{error}</p>}
    <nav aria-label="Scratchpad pages">
      {loading ? <p className="scratchpad-navigation-empty" role="status">Loading pages…</p> : pages.map(page => <button key={page.id} className={`scratchpad-navigation-page ${selectedPageId === page.id ? 'selected' : ''}`} aria-current={selectedPageId === page.id ? 'page' : undefined} onClick={() => onOpen(page.id)} data-testid="scratchpad-nav-page-row">
        <span className="scratchpad-navigation-icon" aria-hidden="true">▤</span><span className="scratchpad-navigation-copy"><strong>{page.title}</strong><small>Updated {new Date(page.updatedAt).toLocaleDateString()}</small></span><span className="scratchpad-navigation-chevron" aria-hidden="true">›</span>
      </button>)}
      {!loading && !error && pages.length === 0 && <p className="scratchpad-navigation-empty">Your pages will appear here.</p>}
    </nav>
  </aside>;
}

export function PagePane({ pageId, tenantId, full = false, onBack, onPageUpdated }: { pageId: string; tenantId: string; full?: boolean; onBack: () => void; onPageUpdated?: () => void }) {
  const [page, setPage] = useState<WorkspacePage | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [contentDraft, setContentDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const loadGeneration = useRef(0);
  useEffect(() => {
    const generation = ++loadGeneration.current;
    setEditing(false); setPage(null); setLoading(true); setError('');
    void appFetch(`/api/pages/${pageId}`).then(response => readResponse<WorkspacePage>(response)).then(next => {
      if (generation !== loadGeneration.current) return;
      setPage(next); setTitleDraft(next.title); setContentDraft(next.content);
    }).catch(reason => {
      if (generation !== loadGeneration.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => { if (generation === loadGeneration.current) setLoading(false); });
    return () => { loadGeneration.current += 1; };
  }, [tenantId, pageId]);

  async function save() {
    if (!page || busy || !titleDraft.trim() || !contentDraft.trim()) return;
    setBusy(true); setError('');
    try {
      const updated = await readResponse<WorkspacePage>(await appFetch(`/api/pages/${page.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: titleDraft, content: contentDraft }),
      }));
      setPage(updated); setTitleDraft(updated.title); setContentDraft(updated.content); setEditing(false); onPageUpdated?.();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  return <section className={`scratchpad-page-pane ${full ? 'full' : 'split'}`} data-testid="scratchpad-page">
    <header className="scratchpad-page-toolbar"><button className="scratchpad-back" onClick={onBack}>‹ <span>Your Personal Scratchpad</span></button><span className="scratchpad-connected"><i /> Connected</span>{page && !editing && <button className="scratchpad-edit" onClick={() => setEditing(true)}>Edit</button>}</header>
    {error && <p role="alert" className="scratchpad-error">{error}</p>}
    {loading ? <p className="scratchpad-page-loading" role="status">Opening page…</p> : !page ? <div className="scratchpad-page-missing"><h2>Page unavailable</h2><p>This page may belong to another workspace.</p><button onClick={onBack}>Back to Scratchpad</button></div> : editing ? <div className="scratchpad-page-editor">
      <label>Page title<input aria-label="编辑页面标题" maxLength={120} value={titleDraft} onChange={event => setTitleDraft(event.target.value)} /></label>
      <label>Content<textarea aria-label="编辑页面内容" maxLength={24000} value={contentDraft} onChange={event => setContentDraft(event.target.value)} /></label>
      <div className="scratchpad-page-actions"><button className="primary" disabled={busy || !titleDraft.trim() || !contentDraft.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save changes'}</button><button disabled={busy} onClick={() => { setEditing(false); setTitleDraft(page.title); setContentDraft(page.content); }}>Cancel</button></div>
    </div> : <article className="scratchpad-document">
      <h1>{page.title}</h1><MarkdownContent content={page.content} /><footer>Updated {new Date(page.updatedAt).toLocaleString()}</footer>
    </article>}
  </section>;
}

function MarkdownContent({ content }: { content: string }) {
  return <div className="scratchpad-markdown">{content.split('\n').map((line, index) => {
    if (!line.trim()) return <div className="scratchpad-blank" key={index} />;
    if (line.startsWith('### ')) return <h3 key={index}>{line.slice(4)}</h3>;
    if (line.startsWith('## ')) return <h2 key={index}>{line.slice(3)}</h2>;
    if (line.startsWith('# ')) return <h2 key={index}>{line.slice(2)}</h2>;
    if (/^[-*] /.test(line)) return <div className="scratchpad-bullet" key={index}><i />{line.slice(2)}</div>;
    return <p key={index}>{line}</p>;
  })}</div>;
}
