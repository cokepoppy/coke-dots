export function appPath(path: string) {
  const base = import.meta.env.BASE_URL === '/' ? '' : import.meta.env.BASE_URL.replace(/\/$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export function appFetch(input: RequestInfo | URL, init?: RequestInit) {
  return fetch(typeof input === 'string' ? appPath(input) : input, init);
}
