import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Entry } from '@napi-rs/keyring';
import type { Task } from '../shared/types.ts';
import type { AuthSession, SlackDeliveryCandidate, SlackInboundMessage, SlackMonitorEvent } from './store.ts';
import { Store } from './store.ts';

const cookieName = 'coke_dots_slack_state';
const flowLifetimeMs = 10 * 60_000;
const keychainService = process.env.DOTS_KEYCHAIN_SERVICE?.trim() || 'com.cokepoppy.coke-dots';

export class SlackService {
  private clientId = process.env.SLACK_CLIENT_ID?.trim() || '';
  private clientSecret = process.env.SLACK_CLIENT_SECRET?.trim() || '';
  private redirectUri = process.env.SLACK_REDIRECT_URI?.trim() || '';
  private signingSecret = process.env.SLACK_SIGNING_SECRET?.trim() || '';
  private deliveryTimer: NodeJS.Timeout | null = null;
  private delivering = false;

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
    return { configured: this.configured(), eventsConfigured: Boolean(this.signingSecret), installations: this.store.slackInstallations(tenantId), monitors: this.store.slackEventMonitors(tenantId) };
  }

  async publicChannels(tenantId: string, teamId: string, session: AuthSession) {
    if (!canManage(session) || session.tenant.id !== tenantId) return { status: 403, error: '只有当前工作区所有者或管理员可以读取 Slack 频道列表' };
    const installation = this.store.slackInstallation(tenantId, teamId);
    if (!installation) return { status: 404, error: 'Slack workspace is not connected to this tenant' };
    if (!installation.scopes.includes('channels:read') || !installation.scopes.includes('channels:history')) {
      return { status: 409, error: 'Reconnect Slack to grant channels:read and channels:history for public-channel monitoring' };
    }
    const token = tokenEntry(tenantId, teamId).getPassword();
    if (!token) return { status: 409, error: 'Slack bot token is unavailable; reconnect this workspace' };
    const channels: { id: string; name: string }[] = [];
    let cursor = '';
    try {
      for (let page = 0; page < 5; page++) {
        const url = new URL(this.webApiUrl('conversations.list'));
        url.searchParams.set('exclude_archived', 'true');
        url.searchParams.set('limit', '200');
        url.searchParams.set('types', 'public_channel');
        if (cursor) url.searchParams.set('cursor', cursor);
        const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
        let result: SlackChannelListResponse = {};
        try { result = await response.json() as SlackChannelListResponse; } catch { /* Return a bounded provider error below. */ }
        if (!response.ok || result.ok !== true) {
          const missingScope = result.error === 'missing_scope';
          return { status: missingScope ? 409 : 502, error: missingScope ? 'Reconnect Slack to grant channels:read and channels:history for public-channel monitoring' : `Slack could not list public channels${result.error ? `: ${result.error}` : ''}` };
        }
        for (const channel of result.channels || []) {
          if (typeof channel.id === 'string' && /^[A-Z0-9]{2,32}$/.test(channel.id) && typeof channel.name === 'string' && channel.name.length <= 80 && channel.is_archived !== true && channel.is_private !== true) {
            channels.push({ id: channel.id, name: channel.name });
          }
        }
        cursor = result.response_metadata?.next_cursor?.trim() || '';
        if (!cursor) break;
      }
      channels.sort((left, right) => left.name.localeCompare(right.name));
      return { status: 200, value: channels };
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'Slack channel list timed out' : 'Slack channel list request failed';
      return { status: 502, error: reason };
    }
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
    authorizeUrl.searchParams.set('scope', 'chat:write,app_mentions:read,im:history,im:write,channels:read,channels:history');
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
      const slackUserId = grant.authed_user?.id?.trim() || '';
      const scopes = (grant.scope || '').split(',').map(scope => scope.trim()).filter(Boolean);
      if (!response.ok || grant.ok !== true || !/^[A-Z0-9]{2,32}$/.test(teamId) || !teamName || !accessToken || !/^[A-Z0-9]{2,32}$/.test(slackUserId)) {
        return redirect(res, `${returnTo}/?slackError=connection_failed`);
      }
      const installation = {
        tenantId: flow.tenantId, teamId, teamName: teamName.slice(0, 160),
        scopes, installedAt: new Date().toISOString(),
      };
      tokenEntry(flow.tenantId, teamId).setPassword(accessToken);
      try {
        this.store.installSlackWorkspace(installation);
        this.store.linkSlackUser(flow.tenantId, teamId, slackUserId, flow.userId);
      }
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
    this.store.clearSlackWorkspace(tenantId);
  }

  start() {
    if (this.deliveryTimer) return;
    this.deliveryTimer = setInterval(() => void this.deliverPendingReplies(), 1_000);
    void this.deliverPendingReplies();
  }

  stop() { if (this.deliveryTimer) clearInterval(this.deliveryTimer); this.deliveryTimer = null; }

  acceptEvent(rawBody: Uint8Array, timestamp: string, signature: string): SlackIngressResult {
    if (!this.signingSecret) return { status: 503, body: { error: 'Slack Events API 尚未配置 signing secret' } };
    if (!verifySlackSignature(this.signingSecret, rawBody, timestamp, signature)) return { status: 401, body: { error: 'Slack request signature is invalid' } };
    let envelope: Record<string, unknown>;
    try { envelope = JSON.parse(Buffer.from(rawBody).toString('utf8')) as Record<string, unknown>; }
    catch { return { status: 400, body: { error: 'Slack event JSON is invalid' } }; }
    if (envelope.type === 'url_verification') {
      const challenge = typeof envelope.challenge === 'string' ? envelope.challenge : '';
      return challenge && challenge.length <= 200 ? { status: 200, body: { challenge } } : { status: 400, body: { error: 'Slack URL verification challenge is invalid' } };
    }
    if (envelope.type !== 'event_callback') return { status: 200, body: { ok: true } };
    const eventId = typeof envelope.event_id === 'string' ? envelope.event_id : '';
    const teamId = typeof envelope.team_id === 'string' ? envelope.team_id : '';
    const event = envelope.event && typeof envelope.event === 'object' ? envelope.event as Record<string, unknown> : {};
    const eventType = event.type === 'app_mention' ? 'app_mention'
      : event.type === 'message' && event.channel_type === 'im' ? 'message.im'
        : event.type === 'message' && event.channel_type === 'channel' ? 'message.channels' : '';
    if (!/^[A-Za-z0-9_-]{4,120}$/.test(eventId) || !/^[A-Z0-9]{2,32}$/.test(teamId) || !eventType) return { status: 200, body: { ok: true } };
    if (event.subtype || event.bot_id) return { status: 200, body: { ok: true } };
    const slackUserId = typeof event.user === 'string' ? event.user : '';
    const channelId = typeof event.channel === 'string' ? event.channel : '';
    const text = typeof event.text === 'string' ? event.text.replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/g, '').trim() : '';
    if (!/^[A-Z0-9]{2,32}$/.test(slackUserId) || !/^[A-Z0-9]{2,32}$/.test(channelId) || text.length > 4000) return { status: 200, body: { ok: true } };
    const message: SlackInboundMessage = {
      eventId, teamId, slackUserId, sourceChannelId: channelId,
      replyChannelId: eventType === 'message.im' ? channelId : slackUserId,
      eventType, text,
    };
    try {
      if (eventType === 'message.channels') {
        const accepted = this.store.createSlackMonitorTasks({
          eventId, teamId, channelId: channelId, slackUserId, text,
          ...(typeof event.ts === 'string' && event.ts.length <= 32 ? { timestamp: event.ts } : {}),
        } satisfies SlackMonitorEvent);
        return { status: 200, body: { ok: true }, taskCreated: accepted.status === 'queued' };
      }
      const accepted = this.store.createSlackInboxTask(message);
      return { status: 200, body: { ok: true }, taskCreated: accepted.status === 'queued' };
    } catch (error) {
      console.error('Slack event could not be queued:', error instanceof Error ? error.message.slice(0, 160) : 'unknown error');
      return { status: 500, body: { error: 'Slack event could not be queued' } };
    }
  }

  private async deliverPendingReplies() {
    if (this.delivering) return;
    this.delivering = true;
    try {
      for (const candidate of this.store.slackDeliveryCandidates()) {
        try {
          const installation = this.store.slackInstallation(candidate.tenantId, candidate.teamId);
          if (!installation) throw new SlackApiFailure('Slack workspace connection was removed');
          const token = tokenEntry(candidate.tenantId, candidate.teamId).getPassword();
          if (!token) throw new SlackApiFailure('Slack bot token is unavailable');
          const message = replyForTask(candidate.task);
          if (!message) throw new SlackApiFailure('Slack task produced no reply');
          let channel = candidate.replyChannelId;
          if (channel.startsWith('U')) {
            const openedResponse = await fetch(this.webApiUrl('conversations.open'), {
              method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
              body: JSON.stringify({ users: channel }), signal: AbortSignal.timeout(10_000),
            });
            let opened: { ok?: boolean; error?: string; channel?: { id?: string } } = {};
            try { opened = await openedResponse.json() as typeof opened; } catch { /* Handle invalid Slack responses as a delivery failure. */ }
            if (!openedResponse.ok || opened.ok !== true || !opened.channel?.id) {
              throw new SlackApiFailure(opened.error || `Slack could not open a private DM (HTTP ${openedResponse.status})`, openedResponse.status === 429 ? openedResponse.headers.get('retry-after') : null);
            }
            channel = opened.channel.id;
          }
          const response = await fetch(this.webApiUrl('chat.postMessage'), {
            method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ channel, text: message.slice(0, 4000), client_msg_id: candidate.task.id }),
            signal: AbortSignal.timeout(10_000),
          });
          let result: { ok?: boolean; error?: string } = {};
          try { result = await response.json() as typeof result; } catch { /* Handle invalid Slack responses as a delivery failure. */ }
          if (!response.ok || result.ok !== true) throw new SlackApiFailure(result.error || `Slack API returned HTTP ${response.status}`, response.status === 429 ? response.headers.get('retry-after') : null);
          this.store.markSlackDeliverySent(candidate.eventId);
        } catch (error) {
          const failure = error instanceof SlackApiFailure ? error : new SlackApiFailure('Slack API request failed');
          const attempts = candidate.attempts + 1;
          const backoffSeconds = failure.retryAfterSeconds ?? Math.min(300, 2 ** Math.min(attempts, 8));
          this.store.markSlackDeliveryFailed(candidate.eventId, failure.message, new Date(Date.now() + backoffSeconds * 1000).toISOString());
        }
      }
    } catch (error) {
      console.error('Slack delivery queue failed:', error instanceof Error ? error.message.slice(0, 160) : 'unknown error');
    } finally { this.delivering = false; }
  }

  private webApiUrl(method: string) {
    const provider = this.e2eProviderOrigin();
    return `${provider || 'https://slack.com'}/api/${method}`;
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

export interface SlackIngressResult { status: number; body: unknown; taskCreated?: boolean }

export function verifySlackSignature(signingSecret: string, rawBody: Uint8Array, timestamp: string, signature: string, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!signingSecret || rawBody.byteLength > 128 * 1024 || !/^\d{1,12}$/.test(timestamp) || !/^v0=[a-f0-9]{64}$/i.test(signature)) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > 300) return false;
  const base = `v0:${timestamp}:${Buffer.from(rawBody).toString('utf8')}`;
  const expected = `v0=${createHmac('sha256', signingSecret).update(base).digest('hex')}`;
  return safeEqual(expected, signature.toLowerCase());
}

class SlackApiFailure extends Error {
  constructor(message: string, retryAfter: string | null = null) {
    super(message.slice(0, 300));
    const seconds = retryAfter && /^\d{1,5}$/.test(retryAfter) ? Number(retryAfter) : 0;
    this.retryAfterSeconds = seconds > 0 ? Math.min(3600, seconds) : null;
  }
  readonly retryAfterSeconds: number | null;
}

function replyForTask(task: Task) {
  const content = task.status === 'failed'
    ? `Task failed: ${task.error || 'The agent could not complete this task.'}`
    : task.status === 'waiting'
      ? task.result || 'I need more information before I can continue.'
      : task.result || 'The task finished without a text result.';
  return content.trim().slice(0, 4000);
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
  ok?: boolean; access_token?: string; scope?: string; team?: { id?: string; name?: string }; authed_user?: { id?: string };
}
interface SlackChannelListResponse {
  ok?: boolean;
  error?: string;
  channels?: { id?: unknown; name?: unknown; is_archived?: unknown; is_private?: unknown }[];
  response_metadata?: { next_cursor?: string };
}
