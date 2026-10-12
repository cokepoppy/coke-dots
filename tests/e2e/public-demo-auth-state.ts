import type { BrowserContext } from 'playwright-core';

type BrowserStorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

/** Keep only the Dots session, narrowed to the exact host and mounted app path. */
export function makeDotsOnlyStorageState(state: BrowserStorageState, origin: URL, basePath: string) {
  const cookiePath = basePath === '/' ? '/' : basePath.replace(/\/$/, '');
  const targetHost = origin.hostname.toLowerCase();
  const session = state.cookies.find(cookie => {
    const cookieHost = cookie.domain.replace(/^\./, '').toLowerCase();
    const domainMatches = targetHost === cookieHost || targetHost.endsWith(`.${cookieHost}`);
    return cookie.name === 'coke_dots_session' && cookie.path === cookiePath && domainMatches;
  });
  if (!session) throw new Error('No Coke Dots session cookie was returned for this host and app path.');
  if (!session.httpOnly || !session.secure || session.sameSite !== 'Lax') {
    throw new Error('The deployed Coke Dots session cookie does not have the expected secure, HttpOnly, SameSite=Lax attributes.');
  }
  return {
    cookies: [{ ...session, domain: targetHost }],
    origins: [],
  };
}
