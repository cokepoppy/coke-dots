import { createHash, createPublicKey, createVerify, randomBytes } from 'node:crypto';
import { Entry } from '@napi-rs/keyring';
import type { AuthSession, TeamsDeliveryCandidate, TeamsInboundMessage } from './store.ts';
import { Store } from './store.ts';

const connectorMetadataUrl = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
const botTokenUrl = 'https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token';
const keychainService = process.env.DOTS_KEYCHAIN_SERVICE?.trim() || 'com.cokepoppy.coke-dots';
const tokenSkewSeconds = 300;
const codeLifetimeMs = 10 * 60_000;
const connectorKeyCache = new WeakMap<Function, { keys: ConnectorKey[]; expiresAt: number }>();

interface ConnectorKey { kid?: string; x5t?: string; kty?: string; use?: string; alg?: string; n?: string; e?: string }
interface ConnectorMetadata { issuer?: string; jwks_uri?: string; id_token_signing_alg_values_supported?: string[] }
interface BotConnectorClaims { iss?: string; aud?: string | string[]; exp?: number; nbf?: number; serviceUrl?: string }
interface TeamsActivity {
  type?: string; id?: string; channelId?: string; serviceUrl?: string; timestamp?: string;
  from?: { id?: string; aadObjectId?: string; name?: string; role?: string };
  recipient?: { id?: string };
  conversation?: { id?: string; conversationType?: string; tenantId?: string };
  channelData?: { tenant?: { id?: string } };
  text?: string;
}

export interface TeamsIngressResult { status: number; body: Record<string, unknown>; taskCreated?: boolean }

export class TeamsService {
  private deliveryTimer: NodeJS.Timeout | null = null;
  private delivering = false;
  private bearerToken: { value: string; expiresAt: number } | null = null;

  constructor(private store: Store, private appId = process.env.TEAMS_BOT_APP_ID?.trim() || '', private appSecret = botAppSecret(), private fetcher: typeof fetch = teamsFetcher()) {}

  configured() { return isGuid(this.appId) && Boolean(this.appSecret); }

  snapshot(session: Pick<AuthSession, 'user' | 'tenant'>) {
    const identity = this.store.teamsIdentity(session.tenant.id, session.user.id);
    return { configured: this.configured(), connectAllowed: session.tenant.kind === 'personal', endpoint: '/teams/messages', linked: identity ? { displayName: identity.displayName, linkedAt: identity.linkedAt } : null };
  }

  createLinkCode(session: Pick<AuthSession, 'user' | 'tenant'>) {
    if (!this.configured()) return { status: 503, error: 'Microsoft Teams bot 尚未配置。' } as const;
    if (session.tenant.kind !== 'personal') return { status: 403, error: 'Teams 私聊目前只支持个人 Dot 工作区，以免把私聊内容暴露给共享工作区成员。' } as const;
    const code = randomBytes(12).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + codeLifetimeMs).toISOString();
    this.store.createTeamsLinkCode(sha256(code), session.tenant.id, session.user.id, expiresAt);
    return { status: 200, value: { code, expiresAt } } as const;
  }

  async acceptActivity(rawBody: Uint8Array, authorization: string): Promise<TeamsIngressResult> {
    if (!this.configured()) return { status: 503, body: { error: 'Microsoft Teams bot is not configured' } };
    let activity: TeamsActivity;
    try { activity = JSON.parse(Buffer.from(rawBody).toString('utf8')) as TeamsActivity; }
    catch { return { status: 400, body: { error: 'Microsoft Teams activity JSON is invalid' } }; }
    const serviceUrl = typeof activity.serviceUrl === 'string' ? activity.serviceUrl : '';
    if (!await verifyBotConnectorToken(authorization, this.appId, serviceUrl, this.fetcher)) {
      return { status: 401, body: { error: 'Microsoft Bot Connector signature is invalid' } };
    }
    return this.handleAuthenticatedActivity(activity);
  }

  acceptE2EActivity(rawBody: Uint8Array): TeamsIngressResult {
    if (process.env.NODE_ENV !== 'test' || process.env.DOTS_E2E_AUTH !== '1' || !this.configured()) {
      return { status: 404, body: { error: 'Not found' } };
    }
    let activity: TeamsActivity;
    try { activity = JSON.parse(Buffer.from(rawBody).toString('utf8')) as TeamsActivity; }
    catch { return { status: 400, body: { error: 'Microsoft Teams activity JSON is invalid' } }; }
    return this.handleAuthenticatedActivity(activity);
  }

  private handleAuthenticatedActivity(activity: TeamsActivity): TeamsIngressResult {
    const serviceUrl = typeof activity.serviceUrl === 'string' ? activity.serviceUrl : '';
    if (activity.type !== 'message' || activity.channelId !== 'msteams') return { status: 200, body: { ok: true } };
    const conversationType = activity.conversation?.conversationType;
    if (conversationType !== 'personal') return { status: 200, body: { ok: true } };

    const eventId = bounded(activity.id, 160);
    const microsoftTenantId = bounded(activity.conversation?.tenantId || activity.channelData?.tenant?.id, 80);
    const microsoftUserId = bounded(activity.from?.id, 180);
    const aadObjectId = bounded(activity.from?.aadObjectId, 80);
    const conversationId = bounded(activity.conversation?.id, 240);
    const displayName = bounded(activity.from?.name || 'Microsoft Teams user', 160);
    if (!eventId || !isGuid(microsoftTenantId) || !microsoftUserId || !isGuid(aadObjectId) || !conversationId || !safeServiceUrl(serviceUrl)) {
      return { status: 200, body: { ok: true } };
    }
    if (activity.from?.id === activity.recipient?.id || activity.from?.role === 'bot') return { status: 200, body: { ok: true } };
    const text = cleanTeamsText(typeof activity.text === 'string' ? activity.text : '');
    if (text.length > 4000) return { status: 200, body: { ok: true } };
    const eventKey = sha256(`${microsoftTenantId}\u0000${conversationId}\u0000${eventId}`);
    const message: TeamsInboundMessage = { eventId, eventKey, microsoftTenantId, microsoftUserId, aadObjectId, displayName, conversationId, serviceUrl, text };

    const linkCommand = /^connect\s+([A-F0-9]{24})$/i.exec(text);
    try {
      if (linkCommand) {
        const linked = this.store.connectTeamsIdentity(sha256(linkCommand[1].toUpperCase()), message);
        if (linked.status === 'linked') {
          this.replyWithoutWaiting(serviceUrl, conversationId, 'This Microsoft Teams account is now connected to your Dot. You can message me here to assign work.');
        } else if (linked.status === 'ignored') {
          this.replyWithoutWaiting(serviceUrl, conversationId, 'That connection code is invalid or expired. Create a new code from your Dot settings and try again.');
        }
        return { status: 200, body: { ok: true } };
      }
      const result = this.store.createTeamsInboxTask(message);
      return { status: 200, body: { ok: true }, taskCreated: result.status === 'queued' };
    } catch (error) {
      console.error('Microsoft Teams activity could not be queued:', error instanceof Error ? error.message.slice(0, 160) : 'unknown error');
      return { status: 500, body: { error: 'Microsoft Teams activity could not be queued' } };
    }
  }

  start() {
    if (this.deliveryTimer) return;
    this.deliveryTimer = setInterval(() => void this.deliverPendingReplies(), 1_000);
    void this.deliverPendingReplies();
  }

  stop() { if (this.deliveryTimer) clearInterval(this.deliveryTimer); this.deliveryTimer = null; }

  clearTenant(tenantId: string) { this.store.clearTeamsWorkspace(tenantId); }

  private replyWithoutWaiting(serviceUrl: string, conversationId: string, text: string) {
    void this.sendMessage(serviceUrl, conversationId, text).catch(error => {
      console.error('Microsoft Teams reply could not be delivered:', error instanceof TeamsApiFailure ? error.message : 'request failed');
    });
  }

  private async deliverPendingReplies() {
    if (this.delivering || !this.configured()) return;
    this.delivering = true;
    try {
      for (const candidate of this.store.teamsDeliveryCandidates()) {
        try {
          const message = replyForTask(candidate.task);
          if (!message) throw new TeamsApiFailure('Task produced no reply');
          await this.sendMessage(candidate.serviceUrl, candidate.conversationId, message);
          this.store.markTeamsDeliverySent(candidate.eventKey);
        } catch (error) {
          const failure = error instanceof TeamsApiFailure ? error : new TeamsApiFailure('Microsoft Teams delivery failed');
          const attempts = candidate.attempts + 1;
          const waitSeconds = failure.retryAfterSeconds ?? Math.min(300, 2 ** Math.min(attempts, 8));
          this.store.markTeamsDeliveryFailed(candidate.eventKey, failure.message, new Date(Date.now() + waitSeconds * 1000).toISOString());
        }
      }
    } finally { this.delivering = false; }
  }

  private async sendMessage(serviceUrl: string, conversationId: string, text: string) {
    if (!this.configured() || !safeServiceUrl(serviceUrl) || !conversationId || conversationId.length > 240) throw new TeamsApiFailure('Microsoft Teams connection is unavailable');
    const token = await this.accessToken();
    const url = `${serviceUrl.replace(/\/$/, '')}/v3/conversations/${encodeURIComponent(conversationId)}/activities`;
    const response = await this.fetcher(url, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'message', text: text.slice(0, 4000) }), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new TeamsApiFailure(`Microsoft Teams returned HTTP ${response.status}`, response.status === 429 ? parseRetryAfter(response.headers.get('retry-after')) : null);
  }

  private async accessToken() {
    if (this.bearerToken && this.bearerToken.expiresAt > Date.now() + 60_000) return this.bearerToken.value;
    const response = await this.fetcher(botTokenUrl, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.appId, client_secret: this.appSecret, scope: 'https://api.botframework.com/.default' }),
      signal: AbortSignal.timeout(10_000),
    });
    const grant = await response.json() as { access_token?: string; expires_in?: number };
    if (!response.ok || !grant.access_token || !Number.isFinite(grant.expires_in)) throw new TeamsApiFailure('Microsoft Teams bot authentication failed');
    this.bearerToken = { value: grant.access_token, expiresAt: Date.now() + Number(grant.expires_in) * 1000 };
    return grant.access_token;
  }
}

export async function verifyBotConnectorToken(authorization: string, appId: string, serviceUrl: string, fetcher: typeof fetch = fetch, nowSeconds = Date.now() / 1000): Promise<boolean> {
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization);
  if (!match || !isGuid(appId) || !safeServiceUrl(serviceUrl)) return false;
  const parts = match[1].split('.');
  if (parts.length !== 3) return false;
  try {
    const header = parseJwtPart(parts[0]) as { alg?: string; kid?: string; x5t?: string };
    const claims = parseJwtPart(parts[1]) as BotConnectorClaims;
    const keyId = bounded(header.kid || header.x5t, 200);
    if (header.alg !== 'RS256' || !keyId || claims.iss !== 'https://api.botframework.com' || claims.aud !== appId || claims.serviceUrl !== serviceUrl) return false;
    if (!Number.isFinite(claims.exp) || !Number.isFinite(claims.nbf) || Number(claims.exp) < nowSeconds - tokenSkewSeconds || Number(claims.nbf) > nowSeconds + tokenSkewSeconds) return false;
    let keys = await loadConnectorKeys(fetcher);
    let jwk = keys?.find(key => key.kid === keyId || key.x5t === keyId);
    if (!jwk) {
      keys = await loadConnectorKeys(fetcher, true);
      jwk = keys?.find(key => key.kid === keyId || key.x5t === keyId);
    }
    if (!jwk || jwk.kty !== 'RSA' || (jwk.use && jwk.use !== 'sig') || (jwk.alg && jwk.alg !== 'RS256')) return false;
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${parts[0]}.${parts[1]}`);
    verifier.end();
    return verifier.verify(createPublicKey({ key: jwk as unknown as import('node:crypto').JsonWebKey, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  } catch { return false; }
}

async function loadConnectorKeys(fetcher: typeof fetch, force = false) {
  const cached = connectorKeyCache.get(fetcher);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.keys;
  try {
    const metadataResponse = await fetcher(connectorMetadataUrl, { signal: AbortSignal.timeout(5_000) });
    if (!metadataResponse.ok) return null;
    const metadata = await metadataResponse.json() as ConnectorMetadata;
    if (metadata.issuer !== 'https://api.botframework.com' || metadata.id_token_signing_alg_values_supported?.includes('RS256') !== true) return null;
    const keyUrl = new URL(metadata.jwks_uri || '');
    if (keyUrl.protocol !== 'https:' || keyUrl.hostname !== 'login.botframework.com' || keyUrl.pathname !== '/v1/.well-known/keys' || keyUrl.search || keyUrl.hash) return null;
    const keysResponse = await fetcher(keyUrl, { signal: AbortSignal.timeout(5_000) });
    if (!keysResponse.ok) return null;
    const jwks = await keysResponse.json() as { keys?: ConnectorKey[] };
    if (!Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.length > 100) return null;
    connectorKeyCache.set(fetcher, { keys: jwks.keys, expiresAt: Date.now() + 60 * 60_000 });
    return jwks.keys;
  } catch { return null; }
}

function botAppSecret() {
  try { return new Entry(keychainService, 'teams-bot-app-secret').getPassword() || process.env.TEAMS_BOT_APP_SECRET?.trim() || ''; }
  catch { return process.env.TEAMS_BOT_APP_SECRET?.trim() || ''; }
}

function teamsFetcher(): typeof fetch {
  if (process.env.NODE_ENV !== 'test' || process.env.DOTS_E2E_AUTH !== '1') return fetch;
  try {
    const origin = new URL(process.env.DOTS_E2E_TEAMS_PROVIDER_URL || '');
    if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return fetch;
    return (input, init) => {
      const source = String(input);
      let target: string;
      if (source === botTokenUrl) target = new URL('/token', origin).toString();
      else {
        const upstream = new URL(source);
        if (!safeServiceUrl(upstream.origin) || !upstream.pathname.includes('/v3/conversations/')) return fetch(input, init);
        target = new URL(`/connector${upstream.pathname}`, origin).toString();
      }
      const headers = new Headers(init?.headers);
      headers.set('x-dots-e2e-upstream-url', source);
      return fetch(target, { ...init, headers });
    };
  } catch { return fetch; }
}

function isGuid(value: string | undefined) { return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)); }
function bounded(value: unknown, maxLength: number) { return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength ? value.trim() : ''; }
function sha256(value: string) { return createHash('sha256').update(value).digest('hex'); }
function parseJwtPart(value: string) { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown; }
function cleanTeamsText(value: string) { return value.replace(/<at>[^<]{0,160}<\/at>/gi, ' ').replace(/\s+/g, ' ').trim(); }
function safeServiceUrl(value: string) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const approvedHost = ['.trafficmanager.net', '.teams.microsoft.com', '.teams.microsoft.us', '.skype.com', '.botframework.com'].some(suffix => hostname.endsWith(suffix));
    return url.protocol === 'https:' && approvedHost && !url.username && !url.password && (!url.port || url.port === '443') && !url.search && !url.hash && !url.hostname.endsWith('.');
  } catch { return false; }
}
function replyForTask(task: TeamsDeliveryCandidate['task']) {
  if (task.status === 'waiting') return task.result || 'Your Dot needs an answer before continuing.';
  if (task.status === 'failed') return task.error ? `I couldn't finish this task: ${task.error}` : 'I could not finish this task.';
  return task.result || '';
}
function parseRetryAfter(value: string | null) { if (!value) return null; const seconds = Number(value); return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 3600) : null; }

class TeamsApiFailure extends Error {
  constructor(message: string, readonly retryAfterSeconds: number | null = null) { super(message); }
}
