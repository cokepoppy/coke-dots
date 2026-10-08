const supportedActions = new Set(['inspect', 'navigate', 'click']);

export function toPublicComputerActionRecord(action, pageUrl) {
  if (!supportedActions.has(action) || typeof pageUrl !== 'string') return null;
  let url;
  try { url = new URL(pageUrl); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
  const host = url.hostname.toLowerCase();
  if (host.length > 253) return null;
  return { action, host };
}
