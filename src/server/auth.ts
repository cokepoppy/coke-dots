import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { Store, type AuthSession } from './store.ts';

const cookieName = 'coke_dots_session';
const oauthCookieName = 'coke_dots_oauth_state';
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;

export class AuthService {
  private clientId = process.env.GOOGLE_CLIENT_ID?.trim() || '';
  private clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() || '';

  constructor(private store: Store, private port: number) {}

  configured() { return Boolean(this.clientId && this.clientSecret); }
  e2eAuthAvailable() { return process.env.NODE_ENV === 'test' && process.env.DOTS_E2E_AUTH === '1'; }

  e2eLogin(email: string, res: ServerResponse) {
    if (!this.e2eAuthAvailable()) return json(res, 404, { error: 'Not found' });
    const normalizedEmail = email.trim().toLowerCase();
    if (!/^[a-z0-9._+-]+@example\.test$/.test(normalizedEmail)) return json(res, 400, { error: 'E2E sign-in only accepts @example.test accounts' });
    const name = normalizedEmail.split('@')[0].replace(/[._+-]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
    const account = this.store.signInGoogle({ subject: `coke-dots-e2e:${normalizedEmail}`, email: normalizedEmail, name: name || normalizedEmail });
    const token = randomToken();
    const expiresAt = new Date(Date.now() + sessionLifetimeMs).toISOString();
    const tokenHash = hash(token);
    this.store.createSession(tokenHash, account.user.id, account.tenant.id, expiresAt);
    setSessionCookie(res, token, sessionLifetimeMs, secureCookies());
    const session = this.store.getSession(tokenHash)!;
    return json(res, 200, { user: session.user, tenant: session.tenant, tenants: this.store.tenantsForUser(session.user.id) });
  }

  async begin(req: IncomingMessage, res: ServerResponse) {
    if (!this.configured()) return json(res, 503, { error: '请先配置 GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET。' });
    const authorizationUrl = await this.createAuthorizationUrl(req, res);
    res.writeHead(302, { Location: authorizationUrl, 'Cache-Control': 'no-store' });
    res.end();
  }

  async beginDesktop(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (!this.configured()) return json(res, 503, { error: '请先配置 GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET。' });
    const handoffToken = url.searchParams.get('handoffToken') || '';
    if (!/^[A-Za-z0-9_-]{40,80}$/.test(handoffToken)) return json(res, 400, { error: '登录接力码无效' });
    const handoffHash = hash(handoffToken);
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    this.store.createDesktopHandoff(handoffHash, expiresAt);
    const authorizationUrl = await this.createAuthorizationUrl(req, res, handoffHash);
    res.writeHead(302, { Location: authorizationUrl, 'Cache-Control': 'no-store' });
    res.end();
  }

  async pollDesktop(res: ServerResponse, handoffToken: string) {
    if (!handoffToken || handoffToken.length > 200) return json(res, 400, { error: '登录接力码无效' });
    const handoff = this.store.claimDesktopHandoff(hash(handoffToken));
    if (!handoff) return json(res, 410, { error: '登录请求已过期，请重试' });
    if (handoff === 'pending') {
      res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ pending: true }));
      return;
    }
    const token = randomToken();
    const expiresAt = new Date(Date.now() + sessionLifetimeMs).toISOString();
    const tokenHash = hash(token);
    this.store.createSession(tokenHash, handoff.userId, handoff.tenantId, expiresAt);
    setSessionCookie(res, token, sessionLifetimeMs, secureCookies());
    const session = this.store.getSession(tokenHash)!;
    return json(res, 200, { user: session.user, tenant: session.tenant, tenants: this.store.tenantsForUser(session.user.id) });
  }

  async finish(req: IncomingMessage, res: ServerResponse, url: URL) {
    const state = url.searchParams.get('state') || '';
    const code = url.searchParams.get('code') || '';
    const flow = state && state.length <= 1024 ? this.store.consumeOAuthFlow(hash(state)) : null;
    const returnTo = flow?.returnTo || appOrigin(req);
    const cookieState = cookieValue(req.headers.cookie || '', oauthCookieName);
    clearOAuthCookie(res);
    if (url.searchParams.has('error')) {
      if (flow?.handoffHash) this.store.cancelDesktopHandoff(flow.handoffHash);
      return redirect(res, `${returnTo}/?authError=cancelled`);
    }
    if (!state || !code || code.length > 4096) return redirect(res, `${returnTo}/?authError=invalid`);
    if (!flow || cookieState !== hash(state)) {
      if (flow?.handoffHash) this.store.cancelDesktopHandoff(flow.handoffHash);
      return redirect(res, `${returnTo}/?authError=expired`);
    }
    try {
      const redirectUri = this.redirectUri(req);
      const client = this.oauthClient();
      disableOAuthCodeExchangeRetries(client);
      const { tokens } = await client.getToken({ code, codeVerifier: flow.codeVerifier, redirect_uri: redirectUri });
      if (!tokens.id_token) return redirect(res, `${returnTo}/?authError=missing_identity`);
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: this.clientId });
      const identity = ticket.getPayload();
      if (!identity || identity.nonce !== flow.nonce || !identity.sub || !identity.email || identity.email_verified !== true) {
        return redirect(res, `${returnTo}/?authError=invalid_identity`);
      }
      const account = this.store.signInGoogle({ subject: identity.sub, email: identity.email, name: identity.name || identity.email });
      const token = randomToken();
      const expiresAt = new Date(Date.now() + sessionLifetimeMs).toISOString();
      this.store.createSession(hash(token), account.user.id, account.tenant.id, expiresAt);
      if (flow.handoffHash) this.store.completeDesktopHandoff(flow.handoffHash, account.user.id, account.tenant.id);
      setSessionCookie(res, token, sessionLifetimeMs, redirectUri.startsWith('https://'));
      redirect(res, `${returnTo}/`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Google sign-in failed:', message.slice(0, 300));
      redirect(res, `${returnTo}/?authError=sign_in_failed`);
    }
  }

  session(req: IncomingMessage): AuthSession | null {
    const token = cookieValue(req.headers.cookie || '', cookieName);
    if (!token || token.length > 200) return null;
    return this.store.getSession(hash(token));
  }

  logout(req: IncomingMessage, res: ServerResponse) {
    const token = cookieValue(req.headers.cookie || '', cookieName);
    if (token) this.store.removeSession(hash(token));
    setSessionCookie(res, '', 0, false);
  }

  private redirectUri(req: IncomingMessage) {
    const configured = process.env.GOOGLE_REDIRECT_URI?.trim();
    if (configured) return configured;
    const hostname = req.headers.host?.split(':')[0] === 'localhost' ? 'localhost' : '127.0.0.1';
    return `http://${hostname}:${this.port}${appBasePath()}/auth/google/callback`;
  }

  private oauthClient() {
    const redirectUri = process.env.GOOGLE_REDIRECT_URI?.trim() || `http://127.0.0.1:${this.port}${appBasePath()}/auth/google/callback`;
    const testProviderOrigin = e2eGoogleProviderOrigin();
    const proxy = googleOAuthProxyUrl();
    return new OAuth2Client({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      redirectUri,
      transporterOptions: { timeout: 15_000, ...(proxy ? { proxy } : {}) },
      ...(testProviderOrigin ? {
        endpoints: {
          oauth2AuthBaseUrl: `${testProviderOrigin}/authorize`,
          oauth2TokenUrl: `${testProviderOrigin}/token`,
          oauth2FederatedSignonPemCertsUrl: `${testProviderOrigin}/certs`,
          oauth2FederatedSignonJwkCertsUrl: `${testProviderOrigin}/certs`,
          tokenInfoUrl: `${testProviderOrigin}/tokeninfo`,
        },
      } : {}),
    });
  }

  private async createAuthorizationUrl(req: IncomingMessage, res: ServerResponse, handoffHash?: string) {
    const state = randomToken();
    const nonce = randomToken();
    const client = this.oauthClient();
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    this.store.createOAuthFlow({ stateHash: hash(state), nonce, codeVerifier, expiresAt, handoffHash, returnTo: appOrigin(req) });
    setOAuthCookie(res, hash(state));
    const authorizationUrl = new URL(client.generateAuthUrl({
      response_type: 'code', access_type: 'online', scope: ['openid', 'email', 'profile'],
      state, prompt: 'select_account', code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    }));
    authorizationUrl.searchParams.set('nonce', nonce);
    return authorizationUrl.toString();
  }
}

function googleOAuthProxyUrl() {
  const configured = process.env.DOTS_GOOGLE_OAUTH_PROXY_URL?.trim();
  if (!configured) return '';
  try {
    const proxy = new URL(configured);
    if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash) throw new Error();
    return proxy.origin;
  } catch { throw new Error('DOTS_GOOGLE_OAUTH_PROXY_URL must be an HTTP(S) proxy origin without credentials or a path'); }
}

function disableOAuthCodeExchangeRetries(client: OAuth2Client) {
  const originalRequest = client.transporter.request.bind(client.transporter);
  client.transporter.request = options => {
    if (!options) return originalRequest(options);
    const requestUrl = options.url ? new URL(String(options.url)) : null;
    if (options.method?.toUpperCase() === 'POST' && requestUrl?.pathname.endsWith('/token')) {
      return originalRequest({ ...options, retry: false, retryConfig: { retry: 0, httpMethodsToRetry: [] } });
    }
    return originalRequest(options);
  };
}

function e2eGoogleProviderOrigin() {
  if (process.env.NODE_ENV !== 'test' || process.env.DOTS_E2E_AUTH !== '1') return '';
  try {
    const url = new URL(process.env.DOTS_E2E_GOOGLE_PROVIDER_URL || '');
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/' || url.search || url.hash) return '';
    return url.origin;
  } catch { return ''; }
}

export function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function randomToken() { return randomBytes(32).toString('base64url'); }
function cookieValue(header: string, name: string) {
  const prefix = `${name}=`;
  const item = header.split(';').map(part => part.trim()).find(part => part.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : '';
}
function setSessionCookie(res: ServerResponse, token: string, maxAgeMs: number, secure: boolean) {
  const securePart = secure ? '; Secure' : '';
  appendCookie(res, `${cookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=${appBasePath() || '/'}; Max-Age=${Math.floor(maxAgeMs / 1000)}${securePart}`);
}
function setOAuthCookie(res: ServerResponse, stateHash: string) {
  appendCookie(res, `${oauthCookieName}=${stateHash}; HttpOnly; SameSite=Lax; Path=${appBasePath()}/auth/google/callback; Max-Age=600${secureCookies() ? '; Secure' : ''}`);
}
function clearOAuthCookie(res: ServerResponse) {
  appendCookie(res, `${oauthCookieName}=; HttpOnly; SameSite=Lax; Path=${appBasePath()}/auth/google/callback; Max-Age=0${secureCookies() ? '; Secure' : ''}`);
}
function secureCookies() { return (process.env.GOOGLE_REDIRECT_URI || '').startsWith('https://'); }
function appendCookie(res: ServerResponse, value: string) {
  const old = res.getHeader('Set-Cookie');
  const current = Array.isArray(old) ? old.map(String) : typeof old === 'string' ? [old] : [];
  res.setHeader('Set-Cookie', [...current, value]);
}
function redirect(res: ServerResponse, location: string) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}
function appOrigin(req: IncomingMessage) {
  const appPath = appBasePath();
  const configured = process.env.DOTS_APP_URL?.trim();
  if (configured) {
    try { const url = new URL(configured); if (['http:', 'https:'].includes(url.protocol)) return url.toString().replace(/\/$/, ''); } catch { /* Use the local request origin. */ }
  }
  const referer = req.headers.referer;
  if (referer) {
    try {
      const url = new URL(referer);
      if (/^http:\/\/(127\.0\.0\.1|localhost):(5173|4317)$/.test(url.origin)) return `${url.origin}${appPath}`;
    } catch { /* Ignore malformed referrers. */ }
  }
  const host = req.headers.host || '';
  const match = host.match(/^(127\.0\.0\.1|localhost):(5173|4317)$/);
  if (match) return `http://${match[1]}:${match[2]}${appPath}`;
  const publicOrigin = process.env.DOTS_PUBLIC_ORIGIN?.trim().replace(/\/$/, '');
  return publicOrigin ? `${publicOrigin}${appPath}` : `http://127.0.0.1:4317${appPath}`;
}
function normalizePath(value: string) {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) return '';
  if (!/^[a-zA-Z0-9/_-]+$/.test(trimmed) || trimmed.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('DOTS_BASE_PATH must be a safe URL path');
  return `/${trimmed}`;
}
function appBasePath() { return normalizePath(process.env.DOTS_BASE_PATH || ''); }
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
