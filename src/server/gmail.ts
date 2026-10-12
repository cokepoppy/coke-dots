import { Entry } from '@napi-rs/keyring';
import { OAuth2Client } from 'google-auth-library';
import type { GmailConnection, GmailEventTrigger, GmailSnapshot } from '../shared/types.ts';
import type { AuthSession } from './store.ts';
import { Store } from './store.ts';

const gmailReadonly = 'https://www.googleapis.com/auth/gmail.readonly';
const keychainService = process.env.DOTS_KEYCHAIN_SERVICE?.trim() || 'com.cokepoppy.coke-dots';

export class GmailService {
  private clientId = process.env.GOOGLE_CLIENT_ID?.trim() || '';
  private clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() || '';
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private onTasksCreated: () => void = () => undefined;

  constructor(private store: Store) {}

  configured() { return Boolean(this.clientId && this.clientSecret); }
  pollIntervalSeconds() {
    const requested = Number(process.env.DOTS_GMAIL_POLL_INTERVAL_MS || 60_000);
    const safe = process.env.NODE_ENV === 'test' && process.env.DOTS_E2E_AUTH === '1' ? Math.max(100, requested) : Math.max(30_000, requested);
    return Math.round(safe / 1000);
  }

  snapshot(tenantId: string, userId: string): GmailSnapshot {
    return {
      configured: this.configured(), pollIntervalSeconds: this.pollIntervalSeconds(),
      connection: this.store.gmailConnection(tenantId, userId), triggers: this.store.gmailEventTriggers(tenantId, userId),
    };
  }

  setOnTasksCreated(callback: () => void) { this.onTasksCreated = callback; }

  async saveConnection(input: { tenantId: string; userId: string; email: string; scopes: string[]; refreshToken: string }) {
    if (!this.configured()) throw new Error('Google OAuth is not configured');
    if (!input.scopes.includes(gmailReadonly)) throw new Error('Google did not grant Gmail read access');
    const client = this.oauthClient(input.refreshToken);
    const profile = await this.googleRequest<{ emailAddress?: string; historyId?: string }>(client, '/users/me/profile');
    const historyId = profile.historyId?.trim() || '';
    if (!/^[0-9]{1,40}$/.test(historyId)) throw new Error('Gmail did not return a mailbox history cursor');
    const email = (profile.emailAddress || input.email).trim().toLowerCase();
    if (!/^[^\s@]{1,254}@[^\s@]{1,254}$/.test(email)) throw new Error('Gmail returned an invalid account address');
    try {
      gmailTokenEntry(input.tenantId, input.userId).setPassword(input.refreshToken);
      this.store.saveGmailConnection({ tenantId: input.tenantId, userId: input.userId, email, scopes: input.scopes, historyId });
    } catch (error) {
      deleteGmailToken(input.tenantId, input.userId);
      throw error;
    }
  }

  connection(tenantId: string, userId: string) { return this.store.gmailConnection(tenantId, userId); }
  existingRefreshToken(tenantId: string, userId: string) { return gmailTokenEntry(tenantId, userId).getPassword() || ''; }

  createTrigger(session: AuthSession, input: { fromFilter: string; subjectFilter: string; condition: string; prompt: string; engine: Extract<GmailEventTrigger['engine'], 'pi' | 'dsh'> }) {
    return this.store.createGmailEventTrigger({ tenantId: session.tenant.id, userId: session.user.id, ...input });
  }

  updateTrigger(session: AuthSession, id: string, action: 'pause' | 'resume') {
    return this.store.updateGmailEventTrigger(id, session.tenant.id, session.user.id, action);
  }

  deleteTrigger(session: AuthSession, id: string) {
    return this.store.deleteGmailEventTrigger(id, session.tenant.id, session.user.id);
  }

  disconnect(tenantId: string, userId: string) {
    this.store.clearGmailUser(tenantId, userId);
    deleteGmailToken(tenantId, userId);
  }

  clearUser(tenantId: string, userId: string) { this.disconnect(tenantId, userId); }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollNow(), this.pollIntervalSeconds() * 1000);
    void this.pollNow();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async pollNow() {
    if (this.polling || !this.configured()) return;
    this.polling = true;
    try {
      for (const mailbox of this.store.gmailMailboxesToPoll()) {
        const refreshToken = gmailTokenEntry(mailbox.tenantId, mailbox.userId).getPassword();
        if (!refreshToken) {
          this.store.setGmailConnectionError(mailbox.tenantId, mailbox.userId, 'Gmail token is missing. Reconnect this mailbox.', true);
          continue;
        }
        try {
          const client = this.oauthClient(refreshToken);
          let sync: GmailSyncResult;
          try {
            sync = await this.readHistory(client, mailbox, mailbox.historyId);
          } catch (error) {
            if (!(error instanceof GmailHistoryCursorExpiredError)) throw error;
            sync = await this.reconcileExpiredHistory(client, mailbox);
          }
          this.store.updateGmailHistory(mailbox.tenantId, mailbox.userId, sync.historyId);
          if (sync.createdCount) this.onTasksCreated();
        } catch (error) {
          const status = httpStatus(error);
          if (error instanceof GmailHistoryOverflowError) {
            this.store.setGmailConnectionError(mailbox.tenantId, mailbox.userId, 'Gmail 历史游标已过期，待补扫邮件超过自动恢复上限。为避免重复派工，监控已暂停；请重新连接后检查触发器。', true);
          } else if (status === 401 || status === 403) {
            this.store.setGmailConnectionError(mailbox.tenantId, mailbox.userId, 'Gmail authorization expired or was revoked. Reconnect the mailbox.', true);
          } else {
            this.store.setGmailConnectionError(mailbox.tenantId, mailbox.userId, 'Gmail sync failed. Coke Dots will retry automatically.');
          }
        }
      }
    } finally { this.polling = false; }
  }

  private async readHistory(client: OAuth2Client, mailbox: GmailMailbox, startHistoryId: string): Promise<GmailSyncResult> {
    let pageToken = '';
    let latestHistoryId = startHistoryId;
    let pages = 0;
    let createdCount = 0;
    do {
      const params = new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded', labelId: 'INBOX', maxResults: '100' });
      if (pageToken) params.set('pageToken', pageToken);
      let history: GmailHistoryResponse;
      try {
        history = await this.googleRequest<GmailHistoryResponse>(client, `/users/me/history?${params.toString()}`);
      } catch (error) {
        if (httpStatus(error) === 404) throw new GmailHistoryCursorExpiredError();
        throw error;
      }
      latestHistoryId = history.historyId || latestHistoryId;
      const messageIds = [...new Set((history.history || []).flatMap(record => (record.messagesAdded || []).map(item => item.message?.id || '')).filter(Boolean))];
      createdCount += await this.readMessages(client, mailbox, messageIds);
      pageToken = history.nextPageToken || '';
      pages++;
      if (pages >= 20 && pageToken) throw new GmailHistoryOverflowError();
    } while (pageToken);
    return { historyId: latestHistoryId, createdCount };
  }

  private async reconcileExpiredHistory(client: OAuth2Client, mailbox: GmailMailbox): Promise<GmailSyncResult> {
    const profile = await this.googleRequest<{ historyId?: string }>(client, '/users/me/profile');
    const baselineHistoryId = profile.historyId?.trim() || '';
    if (!/^[0-9]{1,40}$/.test(baselineHistoryId)) throw new Error('Gmail did not return a valid history cursor for recovery');

    const activeTriggers = this.store.gmailEventTriggers(mailbox.tenantId, mailbox.userId).filter(trigger => trigger.status === 'active');
    const triggerStarts = activeTriggers.map(trigger => Date.parse(trigger.createdAt)).filter(Number.isFinite);
    let createdCount = 0;
    if (triggerStarts.length) {
      // Search from one second before the earliest trigger; the store applies the exact per-trigger timestamp gate.
      const after = Math.floor((Math.min(...triggerStarts) - 1000) / 1000);
      let pageToken = '';
      let pages = 0;
      do {
        const params = new URLSearchParams({ q: `in:inbox after:${after}`, maxResults: '100' });
        if (pageToken) params.set('pageToken', pageToken);
        const page = await this.googleRequest<GmailMessagesPage>(client, `/users/me/messages?${params.toString()}`);
        const messageIds = (page.messages || []).map(message => message.id || '').filter(Boolean);
        createdCount += await this.readMessages(client, mailbox, messageIds);
        pageToken = page.nextPageToken || '';
        pages++;
        if (pages >= 20 && pageToken) throw new GmailHistoryOverflowError();
      } while (pageToken);
    }

    // Capture changes that arrived while the bounded inbox scan was running before advancing the cursor.
    const catchUp = await this.readHistory(client, mailbox, baselineHistoryId);
    return { historyId: catchUp.historyId, createdCount: createdCount + catchUp.createdCount };
  }

  private async readMessages(client: OAuth2Client, mailbox: GmailMailbox, messageIds: string[]): Promise<number> {
    let createdCount = 0;
    for (const messageId of messageIds) {
      let message: GmailMessageResponse;
      try {
        message = await this.googleRequest<GmailMessageResponse>(client, `/users/me/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
      } catch (error) {
        if (httpStatus(error) === 404) continue; // History may refer to mail deleted before its metadata read.
        throw error;
      }
      const headers = new Map((message.payload?.headers || []).map(header => [header.name.toLowerCase(), header.value.slice(0, 500)]));
      const result = this.store.createGmailMessageEventTasks({
        tenantId: mailbox.tenantId, userId: mailbox.userId, messageId,
        from: headers.get('from') || '', subject: headers.get('subject') || '',
        snippet: message.snippet || '', receivedAt: toIsoDate(message.internalDate) || toIsoDateFromHeader(headers.get('date')) || new Date().toISOString(),
      });
      createdCount += result.taskIds.length;
    }
    return createdCount;
  }

  private oauthClient(refreshToken: string) {
    const proxy = googleOAuthProxyUrl();
    const testProvider = e2eGoogleProviderOrigin();
    const testGmailApi = e2eGmailApiOrigin();
    const client = new OAuth2Client({
      clientId: this.clientId, clientSecret: this.clientSecret,
      transporterOptions: { timeout: 15_000, ...(proxy ? { proxy } : {}), ...(testGmailApi ? { noProxy: [testGmailApi] } : {}) },
      ...(testProvider ? { endpoints: {
        oauth2AuthBaseUrl: `${testProvider}/authorize`, oauth2TokenUrl: `${testProvider}/token`,
        oauth2FederatedSignonPemCertsUrl: `${testProvider}/certs`, oauth2FederatedSignonJwkCertsUrl: `${testProvider}/certs`,
        tokenInfoUrl: `${testProvider}/tokeninfo`,
      } } : {}),
    });
    client.setCredentials({ refresh_token: refreshToken });
    return client;
  }

  private async googleRequest<T>(client: OAuth2Client, path: string): Promise<T> {
    const response = await client.request<T>({ url: `${gmailApiOrigin()}/gmail/v1${path}`, method: 'GET' });
    return response.data;
  }
}

interface GmailHistoryResponse {
  historyId?: string;
  nextPageToken?: string;
  history?: { messagesAdded?: { message?: { id?: string } }[] }[];
}
interface GmailMessagesPage { messages?: { id?: string }[]; nextPageToken?: string }
interface GmailMessageResponse {
  id?: string;
  snippet?: string;
  internalDate?: string;
  payload?: { headers?: { name: string; value: string }[] };
}
class GmailHistoryOverflowError extends Error {}
class GmailHistoryCursorExpiredError extends Error {}
type GmailMailbox = { tenantId: string; userId: string; email: string; historyId: string };
type GmailSyncResult = { historyId: string; createdCount: number };

function gmailTokenEntry(tenantId: string, userId: string) {
  return new Entry(keychainService, `tenant-${tenantId}-user-${userId}-gmail-refresh-token`);
}
function deleteGmailToken(tenantId: string, userId: string) {
  try { gmailTokenEntry(tenantId, userId).deletePassword(); } catch { /* It may already be absent. */ }
}
function toIsoDate(value: string | undefined) {
  if (!value || !/^\d{1,16}$/.test(value)) return null;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) ? new Date(timestamp).toISOString() : null;
}
function toIsoDateFromHeader(value: string | undefined) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}
function httpStatus(error: unknown) {
  if (!error || typeof error !== 'object') return 0;
  const item = error as { response?: { status?: unknown }; code?: unknown };
  if (typeof item.response?.status === 'number') return item.response.status;
  if (item.code === 'GaxiosError') return 0;
  return 0;
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
function e2eGoogleProviderOrigin() {
  if (process.env.NODE_ENV !== 'test' || process.env.DOTS_E2E_AUTH !== '1') return '';
  return safeLocalOrigin(process.env.DOTS_E2E_GOOGLE_PROVIDER_URL || '');
}
function e2eGmailApiOrigin() {
  if (process.env.NODE_ENV !== 'test' || process.env.DOTS_E2E_AUTH !== '1') return '';
  return safeLocalOrigin(process.env.DOTS_E2E_GMAIL_API_URL || '');
}
function gmailApiOrigin() {
  return e2eGmailApiOrigin() || 'https://gmail.googleapis.com';
}
function safeLocalOrigin(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return '';
    return url.origin;
  } catch { return ''; }
}
