export function appPath(path: string) {
  return pathForBase(import.meta.env.BASE_URL, path);
}

export function pathForBase(baseUrl: string, path: string) {
  const base = baseUrl === '/' ? '' : baseUrl.replace(/\/$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * noVNC resolves its `path` setting from the public origin root, even when the
 * viewer itself is mounted below a base path. Keep the mount prefix while
 * removing the leading slash that noVNC adds itself.
 */
export function appOriginRelativePath(path: string) {
  return appPath(path).replace(/^\/+/, '');
}

export function originRelativePathForBase(baseUrl: string, path: string) {
  return pathForBase(baseUrl, path).replace(/^\/+/, '');
}

export function appFetch(input: RequestInfo | URL, init?: RequestInit) {
  return fetch(typeof input === 'string' ? appPath(input) : input, init);
}

export function appWebSocketUrl(path: string) {
  const url = new URL(appPath(path), window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
