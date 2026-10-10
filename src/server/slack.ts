import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Entry } from '@napi-rs/keyring';
import type { AuthSession } from './store.ts';
import { Store, type SlackDirectMessage } from './store.ts';

const cookieName = 'coke_dots_slack_state';
const flowLifetimeMs = 10 * 60_000;
const linkLifetimeMs = 15 * 60_000;
const keychainService = process.env.DOTS_KEYCHAIN_SERVICE?.trim() || 'com.cokepoppy.coke-dots';

export class SlackService {
  private clientId = process.env.SLACK_CLIENT_ID?.trim() || '';
  private clientSecret = process.env.SLACK_CLIENT_SECRET?.trim() || '';
  private redirectUri = process.env.SLACK_REDIRECT_URI?.trim() || '';
  private signingSecret = process.env.SLACK_SIGNING_SECRET?.trim() || '';
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;

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

  start() {
    this.timer = setInterval(() => void this.flushOutbox(), 10_000);
    void this.flushOutbox();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  verifyEventRequest(rawBody: Buffer, timestamp: string | string[] | undefined, signature: string | string[] | undefined, nowSeconds = Date.now() / 1000) {
    const timestampValue = Array.isArray(timestamp) ? timestamp[0] || '' : timestamp || '';
    const signatureValue = Array.isArray(signature) ? signature[0] || '' : signature || '';
    if (!this.signingSecret || !/^\d{9,12}$/.test(timestampValue) || Math.abs(nowSeconds - Number(timestampValue)) > 300 || !/^v0=[a-f0-9]{64}$/.test(signatureValue)) return false;
    const digest = createHmac('sha256', this.signingSecret).update(`v0:${timestampValue}:`).update(rawBody).digest('hex');
    return safeEqual(`v0=${digest}`, signatureValue);
  }

  receiveEvent(rawBody: Buffer): { kind: 'challenge'; challenge: string } | { kind: 'ignored' | 'duplicate' } |
    { kind: 'link-required'; tenantId: string; teamName: string; eventId: string } | { kind: 'task'; tenantId: string; taskId: string } {
    let parsed: unknown;
    try { parsed = JSON.parse(rawBody.toString('utf8')); }
    catch { return { kind: 'ignored' }; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'ignored' };
    const payload = parsed as SlackEventPayload;
    if (payload.type === 'url_verification' && typeof payload.challenge === 'string' && payload.challenge.length <= 512) {
      return { kind: 'challenge', challenge: payload.challenge };
    }
    const event = payload.event;
    const isDirectMessage = event?.type === 'message' && event.channel_type === 'im' && validId(event.channel, /^D[A-Z0-9]{2,32}$/);
    const isAppMention = event?.type === 'app_mention' && validId(event.channel, /^[CG][A-Z0-9]{2,32}$/);
    if (payload.type !== 'event_callback' || !validId(payload.event_id, /^Ev[A-Z0-9]{6,80}$/) || !validId(payload.team_id, /^[A-Z0-9]{2,32}$/) ||
        !event || (!isDirectMessage && !isAppMention) || event.subtype || event.bot_id ||
        !validId(event.user, /^U[A-Z0-9]{2,32}$/) || !validSlackTimestamp(event.ts) ||
        (event.thread_ts !== undefined && !validSlackTimestamp(event.thread_ts))) return { kind: 'ignored' };
    const text = typeof event.text === 'string' ? event.text.trim() : '';
    if (!text || text.length > 10_000) return { kind: 'ignored' };
    const message: SlackDirectMessage = {
      eventId: payload.event_id!, teamId: payload.team_id!, userId: event.user!, channelId: event.channel!,
      threadTs: event.thread_ts || event.ts!, threadReply: Boolean(event.thread_ts),
      replyThreadTs: isDirectMessage ? event.thread_ts || null : null,
      privateReplyUserId: isAppMention ? event.user : undefined, text,
    };
    const challengeCode = this.linkCode(message.eventId, message.teamId, message.userId);
    const result = this.store.ingestSlackDirectMessage(message, hash(challengeCode), new Date(Date.now() + linkLifetimeMs).toISOString());
    if (result.kind === 'task') return { kind: 'task', tenantId: result.tenantId, taskId: result.taskId };
    return result;
  }

  claimAccount(session: AuthSession, code: string) {
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(code)) return 'expired' as const;
    return this.store.claimSlackAccount(hash(code), session.tenant.id, session.user.id);
  }

  async flushOutbox() {
    if (!this.signingSecret || this.flushing) return;
    this.flushing = true;
    try {
      for (const prompt of this.store.pendingSlackLinkChallenges()) {
        if (Date.parse(prompt.expiresAt) <= Date.now()) continue;
        const code = this.linkCode(prompt.eventId, prompt.teamId, prompt.slackUserId);
        const link = `${this.appBaseUrl()}/#slackLink=${encodeURIComponent(code)}`;
        const text = `请连接你的 Coke Dots 账号后再开始私信任务：<${link}|连接账号>。链接将在 15 分钟后失效；完成连接前不会创建任务。`;
        const result = await this.postSlackUserMessage(prompt.tenantId, prompt.teamId, prompt.slackUserId, text);
        const retryAt = result.ok ? new Date().toISOString() : new Date(Date.now() + (result.retryAfterMs ?? retryDelay(prompt.attempts + 1))).toISOString();
        this.store.finishSlackLinkPrompt(prompt.eventId, result.ok, retryAt, result.ok ? null : result.error);
      }
      for (const item of this.store.pendingSlackTaskReplies()) {
        if (!this.store.claimSlackTaskReply(item.eventId)) continue;
        const text = item.status === 'failed'
          ? '这项工作没有完成。请打开 Coke Dots 查看 Activity 中的失败原因并重试。'
          : item.status === 'stopped'
            ? '这项工作已停止。'
            : item.dotReply?.trim() || '我需要你补充一些信息。请在此 Slack 线程中回复。';
        const result = item.replyUserId
          ? await this.postSlackUserMessage(item.tenantId, item.teamId, item.replyUserId, text)
          : await this.postSlackMessage(item.tenantId, item.teamId, item.channelId, item.replyThreadTs || '', text);
        const permanent = Boolean(result.error && ['invalid_auth', 'token_revoked', 'missing_scope', 'channel_not_found', 'not_in_channel'].includes(result.error));
        const retryAt = new Date(Date.now() + (result.retryAfterMs ?? retryDelay(1))).toISOString();
        this.store.finishSlackTaskReply(item.eventId, result.ok, permanent, retryAt, result.ok ? null : result.error);
      }
    } finally { this.flushing = false; }
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
    authorizeUrl.searchParams.set('scope', 'chat:write,im:history,im:write,app_mentions:read');
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

  private linkCode(eventId: string, teamId: string, slackUserId: string) {
    return createHmac('sha256', this.signingSecret).update(`link:${eventId}\0${teamId}\0${slackUserId}`).digest('base64url');
  }

  private appBaseUrl() {
    const configured = process.env.DOTS_APP_URL?.trim() || process.env.DOTS_PUBLIC_ORIGIN?.trim();
    if (configured) {
      try {
        const url = new URL(configured);
        if (url.protocol === 'https:' || (process.env.NODE_ENV === 'test' && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) {
          const path = url.pathname === '/' ? normalizeBasePath(process.env.DOTS_BASE_PATH || '') : url.pathname.replace(/\/$/, '');
          return `${url.origin}${path}`;
        }
      } catch { /* Fall back to the local app URL. */ }
    }
    return `http://127.0.0.1:${this.port}${normalizeBasePath(process.env.DOTS_BASE_PATH || '')}`;
  }

  private async postSlackUserMessage(tenantId: string, teamId: string, userId: string, text: string): Promise<SlackDeliveryResult> {
    let token: string | null = null;
    try { token = tokenEntry(tenantId, teamId).getPassword(); } catch { /* Treat a missing credential like a retryable send error. */ }
    if (!token) return { ok: false, error: 'credential_unavailable' };
    const provider = this.e2eProviderOrigin();
    try {
      const response = await fetch(`${provider || 'https://slack.com'}/api/conversations.open`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ users: userId }), signal: AbortSignal.timeout(5_000),
      });
      const body = await response.json() as { ok?: boolean; error?: string; channel?: { id?: string } };
      if (!response.ok || body.ok !== true || !validId(body.channel?.id, /^D[A-Z0-9]{2,32}$/)) {
        return { ok: false, error: body.error || `http_${response.status}`, retryAfterMs: retryAfterMs(response) };
      }
      return this.postSlackMessage(tenantId, teamId, body.channel!.id!, '', text);
    } catch { return { ok: false, error: 'transport_error' }; }
  }

  private async postSlackMessage(tenantId: string, teamId: string, channel: string, threadTs: string, text: string): Promise<SlackDeliveryResult> {
    let token: string | null = null;
    try { token = tokenEntry(tenantId, teamId).getPassword(); } catch { /* Treat a missing credential like a retryable send error. */ }
    if (!token) return { ok: false, error: 'credential_unavailable' };
    const provider = this.e2eProviderOrigin();
    try {
      const response = await fetch(`${provider || 'https://slack.com'}/api/chat.postMessage`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel, ...(threadTs ? { thread_ts: threadTs } : {}), text }), signal: AbortSignal.timeout(5_000),
      });
      const body = await response.json() as { ok?: boolean; error?: string };
      return { ok: response.ok && body.ok === true, error: body.ok === true ? null : (body.error || `http_${response.status}`), retryAfterMs: retryAfterMs(response) };
    } catch { return { ok: false, error: 'transport_error' }; }
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

interface SlackEventPayload {
  type?: string; challenge?: string; event_id?: string; team_id?: string;
  event?: { type?: string; subtype?: string; bot_id?: string; channel_type?: string; user?: string; channel?: string; text?: string; ts?: string; thread_ts?: string };
}

interface SlackDeliveryResult { ok: boolean; error: string | null; retryAfterMs?: number }

function validId(value: string | undefined, pattern: RegExp) { return typeof value === 'string' && pattern.test(value); }
function validSlackTimestamp(value: string | undefined) { return typeof value === 'string' && /^\d{10}\.\d{6}$/.test(value); }
function retryAfterMs(response: Response) {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(60 * 60_000, seconds * 1000) : undefined;
}
function retryDelay(attempt: number) { return Math.min(60 * 60_000, 5_000 * (2 ** Math.min(attempt, 7))); }
