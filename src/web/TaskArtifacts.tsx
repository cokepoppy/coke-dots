import { useEffect, useState } from 'react';
import type { TaskArtifact } from '../shared/types.ts';
import './task-artifacts.css';

function contentUrl(taskId: string, path: string) {
  const safePath = path.split('/').map(part => encodeURIComponent(part)).join('/');
  return `/api/tasks/${encodeURIComponent(taskId)}/artifacts/file/${safePath}`;
}

export function TaskArtifacts({ taskId, onOpenComputer }: { taskId: string; onOpenComputer: () => void }) {
  const [artifacts, setArtifacts] = useState<TaskArtifact[] | null>(null);
  const [error, setError] = useState('');
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [openingPath, setOpeningPath] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setArtifacts(null);
    setError('');
    setPreviewPath(null);
    setPreviewUrls({});
    void (async () => {
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/artifacts`, { signal: controller.signal });
        if (!response.ok) throw new Error('文件暂时无法读取');
        const value = await response.json() as { artifacts: TaskArtifact[] };
        if (controller.signal.aborted) return;
        setArtifacts(value.artifacts);

        // HTML is the most useful task output to see immediately (for example,
        // a small game or interactive report). Keep other files opt-in so a
        // task with many outputs does not flood the conversation.
        const html = value.artifacts.find(artifact => artifact.mediaType === 'text/html' && artifact.previewable);
        if (!html) return;
        try {
          const previewResponse = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/artifacts/preview-url?path=${encodeURIComponent(html.path)}`, { signal: controller.signal });
          const preview = await previewResponse.json() as { url?: string; error?: string };
          if (!previewResponse.ok || !preview.url) throw new Error(preview.error || '无法预览这个文件');
          if (!controller.signal.aborted) {
            setPreviewUrls(current => ({ ...current, [html.path]: preview.url! }));
            setPreviewPath(html.path);
          }
        } catch (reason) {
          if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '无法预览这个文件');
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          setArtifacts([]);
          setError(reason instanceof Error ? reason.message : '文件暂时无法读取');
        }
      }
    })();
    return () => controller.abort();
  }, [taskId]);

  async function togglePreview(artifactPath: string) {
    if (previewPath === artifactPath) { setPreviewPath(null); return; }
    setError('');
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/artifacts/preview-url?path=${encodeURIComponent(artifactPath)}`);
      const value = await response.json() as { url?: string; error?: string };
      if (!response.ok || !value.url) throw new Error(value.error || '无法预览这个文件');
      setPreviewUrls(current => ({ ...current, [artifactPath]: value.url! }));
      setPreviewPath(artifactPath);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法预览这个文件'); }
  }

  async function openInComputer(artifactPath: string) {
    setOpeningPath(artifactPath);
    setError('');
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/artifacts/open-in-computer`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: artifactPath }),
      });
      const value = await response.json() as { error?: string };
      if (!response.ok) throw new Error(value.error || '无法在云电脑中打开文件');
      onOpenComputer();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法在云电脑中打开文件'); }
    finally { setOpeningPath(null); }
  }

  if (artifacts === null) return <section className="task-artifacts" data-testid="task-artifacts-loading" aria-label="任务文件"><span>正在查找生成的文件…</span></section>;
  if (!artifacts.length && !error) return null;

  return <section className="task-artifacts" data-testid="task-artifacts" aria-label="任务文件">
    <div className="task-artifacts-heading"><span aria-hidden="true">▤</span><strong>生成的文件</strong>{artifacts.length > 0 && <small>{artifacts.length}</small>}</div>
    {error && <p className="task-artifact-error" role="status">{error}</p>}
    {artifacts.length > 0 && <div className="task-artifact-list">
      {artifacts.map(artifact => {
        const url = contentUrl(taskId, artifact.path);
        const isPreviewed = previewPath === artifact.path;
        return <article key={artifact.path} className="task-artifact" data-testid="task-artifact" data-artifact-path={artifact.path}>
          <span className="task-artifact-file-icon" aria-hidden="true">{artifact.mediaType.startsWith('image/') ? '▧' : artifact.mediaType === 'text/html' ? '◉' : '▤'}</span>
          <span className="task-artifact-file-copy"><strong title={artifact.path}>{artifact.name}</strong><small>{formatSize(artifact.size)}{artifact.previewable ? ' · 可预览' : ''}</small></span>
          {artifact.previewable && <button type="button" className="task-artifact-action" aria-expanded={isPreviewed} onClick={() => void togglePreview(artifact.path)}>{isPreviewed ? '收起预览' : '预览'}</button>}
          {artifact.mediaType === 'text/html' && <button type="button" className="task-artifact-action" data-testid="open-artifact-in-computer" disabled={openingPath !== null} onClick={() => void openInComputer(artifact.path)}>{openingPath === artifact.path ? '正在打开…' : '在云电脑中打开'}</button>}
          <a className="task-artifact-action" href={url} download={artifact.name}>下载</a>
          {isPreviewed && previewUrls[artifact.path] && <iframe className="task-artifact-preview" data-testid="task-artifact-preview" title={`预览 ${artifact.name}`} src={previewUrls[artifact.path]} sandbox="allow-scripts" referrerPolicy="no-referrer" />}
        </article>;
      })}
    </div>}
  </section>;
}

function formatSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
