import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Entry } from '@napi-rs/keyring';
import type { AuthSession } from './store.ts';
import { Store } from './store.ts';

const cookieName = 'coke_dots_slack_state';
const flowLifetimeMs = 10 * 60_000;
const keychainService = process.env.DOTS_KEYCHAIN_SERVICE?.trim() || 'com.cokepoppy.coke-dots';

export class SlackService {
  private clientId = process.env.SLACK_CLIENT_ID?.trim() || '';
  private clientSecret = process.env.SLACK_CLIENT_SECRET?.trim() || '';
  private redirectUri = process.env.SLACK_REDIRECT_URI?.trim() || '';

  constructor(private store: Store, private port: number) {}

  configured() {
    if (!this.clientId || !this.clientSecret) return false;
    const redirect = this.redirectUri || this.defaultRedirectUri();
    try {
      const uri = new URL(redirect);
      if (uri.protocol === 'https:') return true;
      return this.e2eProviderOrigin() !== '' && uri.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(uri.hostname);
    } catch { return false; }
  }

  snapshot(tenantId: string) {
    return { configured: this.configured(), installations: this.store.slackInstallations(tenantId) };
  }

  async begin(req: IncomingMessage, res: ServerResponse, session: AuthSession) {
    if (!canManage(session)) return json(res, 403, { error: '只有工作区所有者或管理员可以连接 Slack' });
    if (!this.configured()) return json(res, 503, { error: 'Slack 连接尚未配置，请设置 Slack OAuth 应用信息。' });

    const state = randomBytes(32).toString('base64url');
    const stateHash = hash(state);
    const returnTo = appOrigin(req);
    this.store.createSlackOAuthFlow({
      stateHash, tenantId: session.tenant.id, userId: session.user.id,
      expiresAt: new Date(Date.now() + flowLifetimeMs).toISOString(), returnTo,
    });
    const redirectUri = this.redirectUri || this.defaultRedirectUri();
    setStateCookie(res, stateHash, redirectUri.startsWith('https://'));
    const authorizeUrl = new URL(`${this.slackOrigin()}/oauth/v2/authorize`);
    authorizeUrl.searchParams.set('client_id', this.clientId);
    authorizeUrl.searchParams.set('scope', 'chat:write');
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    res.writeHead(302, { Location: authorizeUrl.toString(), 'Cache-Control': 'no-store' });
    res.end();
  }

  async finish(req: IncomingMessage, res: ServerResponse, url: URL, session: AuthSession | null) {
    const rawState = url.searchParams.get('state') || '';
    const stateHash = rawState.length <= 200 ? hash(rawState) : '';
    const flow = stateHash ? this.store.consumeSlackOAuthFlow(stateHash) : null;
    const returnTo = flow?.returnTo || appOrigin(req);
    const cookieState = cookieValue(req.headers.cookie || '', cookieName);
    clearStateCookie(res, (this.redirectUri || this.defaultRedirectUri()).startsWith('https://'));

    if (url.searchParams.has('error')) return redirect(res, `${returnTo}/?slackError=cancelled`);
    if (!flow || !safeEqual(cookieState, stateHash) || !session || session.user.id !== flow.userId || session.tenant.id !== flow.tenantId) {
      return redirect(res, `${returnTo}/?slackError=expired`);
    }
    const code = url.searchParams.get('code') || '';
    if (!code || code.length > 4096) return redirect(res, `${returnTo}/?slackError=invalid`);

    try {
      const response = await fetch(this.accessUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: this.clientId, client_secret: this.clientSecret, redirect_uri: this.redirectUri || this.defaultRedirectUri() }),
        signal: AbortSignal.timeout(15_000),
      });
      const grant = await response.json() as SlackOAuthGrant;
      const teamId = grant.team?.id?.trim() || '';
      const teamName = grant.team?.name?.trim() || '';
      const accessToken = grant.access_token?.trim() || '';
      const scopes = (grant.scope || '').split(',').map(scope => scope.trim()).filter(Boolean);
      if (!response.ok || grant.ok !== true || !/^[A-Z0-9]{2,32}$/.test(teamId) || !teamName || !accessToken) {
        return redirect(res, `${returnTo}/?slackError=connection_failed`);
      }
      const installation = {
        tenantId: flow.tenantId, teamId, teamName: teamName.slice(0, 160),
        scopes, installedAt: new Date().toISOString(),
      };
      tokenEntry(flow.tenantId, teamId).setPassword(accessToken);
      try { this.store.installSlackWorkspace(installation); }
      catch (error) { deleteToken(flow.tenantId, teamId); throw error; }
      return redirect(res, `${returnTo}/?slack=connected`);
    } catch (error) {
      console.error('Slack OAuth exchange failed:', error instanceof Error ? error.message.slice(0, 160) : 'unknown error');
      return redirect(res, `${returnTo}/?slackError=connection_failed`);
    }
  }

  setContactWorkspace(session: AuthSession, teamId: string) {
    if (!canManage(session)) return { status: 403, error: '只有工作区所有者或管理员可以更改 Slack 联系方式' };
    if (!/^[A-Z0-9]{2,32}$/.test(teamId) || !this.store.setSlackContactWorkspace(session.tenant.id, teamId)) {
      return { status: 404, error: 'Slack 工作区不存在' };
    }
    return { status: 200, value: this.snapshot(session.tenant.id) };
  }

  clearTenant(tenantId: string) {
    for (const installation of this.store.slackInstallations(tenantId)) deleteToken(tenantId, installation.teamId);
  }

  private defaultRedirectUri() {
    const hostname = process.env.DOTS_PUBLIC_ORIGIN?.trim() || `http://127.0.0.1:${this.port}`;
    return `${hostname.replace(/\/$/, '')}${normalizeBasePath(process.env.DOTS_BASE_PATH || '')}/auth/slack/callback`;
  }

  private slackOrigin() { return this.e2eProviderOrigin() || 'https://slack.com'; }

  private accessUrl() {
    const provider = this.e2eProviderOrigin();
    return `${provider || 'https://slack.com'}/api/oauth.v2.access`;
  }

  private e2eProviderOrigin() {
    if (process.env.NODE_ENV !== 'test' || process.env.DOTS_E2E_AUTH !== '1') return '';
    try {
      const url = new URL(process.env.DOTS_E2E_SLACK_PROVIDER_URL || '');
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return '';
      return url.origin;
    } catch { return ''; }
  }
}

export function slackStateCookieName() { return cookieName; }

function canManage(session: AuthSession) { return session.tenant.role === 'owner' || session.tenant.role === 'admin'; }
function tokenEntry(tenantId: string, teamId: string) {
  const scope = createHash('sha256').update(`${tenantId}\0${teamId}`).digest('hex');
  return new Entry(keychainService, `tenant-${scope}-slack-bot-token`);
}
function deleteToken(tenantId: string, teamId: string) {
  try { tokenEntry(tenantId, teamId).deletePassword(); } catch { /* It may already be absent. */ }
}
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function safeEqual(left: string, right: string) {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function cookieValue(header: string, name: string) {
  const prefix = `${name}=`;
  const item = header.split(';').map(part => part.trim()).find(part => part.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : '';
}
function setStateCookie(res: ServerResponse, stateHash: string, secure: boolean) {
  res.setHeader('Set-Cookie', `${cookieName}=${stateHash}; HttpOnly; SameSite=Lax; Path=${normalizeBasePath(process.env.DOTS_BASE_PATH || '')}/auth/slack/callback; Max-Age=600${secure ? '; Secure' : ''}`);
}
function clearStateCookie(res: ServerResponse, secure: boolean) {
  res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Lax; Path=${normalizeBasePath(process.env.DOTS_BASE_PATH || '')}/auth/slack/callback; Max-Age=0${secure ? '; Secure' : ''}`);
}
function appOrigin(req: IncomingMessage) {
  const configured = process.env.DOTS_APP_URL?.trim();
  if (configured) {
    try { const url = new URL(configured); if (['http:', 'https:'].includes(url.protocol)) return url.toString().replace(/\/$/, ''); } catch { /* Use the public origin below. */ }
  }
  const referer = req.headers.referer;
  if (referer) {
    try {
      const url = new URL(referer);
      if (/^http:\/\/(127\.0\.0\.1|localhost):(5173|4317)$/.test(url.origin)) return `${url.origin}${normalizeBasePath(process.env.DOTS_BASE_PATH || '')}`;
    } catch { /* Ignore malformed referrers. */ }
  }
  const publicOrigin = process.env.DOTS_PUBLIC_ORIGIN?.trim().replace(/\/$/, '');
  return `${publicOrigin || `http://127.0.0.1:${process.env.DOTS_PORT || 4317}`}${normalizeBasePath(process.env.DOTS_BASE_PATH || '')}`;
}
function normalizeBasePath(value: string) {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) return '';
  if (!/^[a-zA-Z0-9/_-]+$/.test(trimmed) || trimmed.split('/').some(part => !part || part === '.' || part === '..')) return '';
  return `/${trimmed}`;
}
function redirect(res: ServerResponse, location: string) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
interface SlackOAuthGrant {
  ok?: boolean; access_token?: string; scope?: string; team?: { id?: string; name?: string };
}
