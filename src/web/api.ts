export function appPath(path: string, baseUrl = import.meta.env.BASE_URL) {
  const base = baseUrl === '/' ? '' : baseUrl.replace(/\/$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export function appFetch(input: RequestInfo | URL, init?: RequestInit) {
  return fetch(typeof input === 'string' ? appPath(input) : input, init);
}
