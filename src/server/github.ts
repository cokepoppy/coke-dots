import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Entry } from '@napi-rs/keyring';
import { githubPullRequestActions, type GitHubPullRequestAction } from '../shared/types.ts';
import type { Store } from './store.ts';

const keychainService = () => process.env.DOTS_KEYCHAIN_SERVICE?.trim() || 'com.cokepoppy.coke-dots';
const secretEntry = (tenantId: string, triggerId: string) => new Entry(keychainService(), `tenant-${tenantId}-github-webhook-${triggerId}`);

export interface GitHubIngressResult {
  status: number;
  body: { ok?: boolean; status?: string; error?: string };
  taskCreated?: boolean;
}

export class GitHubWebhookService {
  constructor(private store: Store) {}

  createTrigger(input: Omit<Parameters<Store['createGitHubPullRequestTrigger']>[0], 'id'>) {
    const id = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const entry = secretEntry(input.tenantId, id);
    entry.setPassword(secret);
    try {
      const trigger = this.store.createGitHubPullRequestTrigger({ ...input, id });
      return { trigger, secret };
    } catch (error) {
      try { entry.deletePassword(); } catch { /* Do not leave a secret behind after a failed creation. */ }
      throw error;
    }
  }

  deleteTrigger(id: string, tenantId: string) {
    const trigger = this.store.githubPullRequestTrigger(id, tenantId);
    if (!trigger) return false;
    const deleted = this.store.deleteGitHubPullRequestTrigger(id, tenantId);
    if (deleted) {
      try { secretEntry(tenantId, id).deletePassword(); } catch { /* The database row is authoritative after deletion. */ }
    }
    return deleted;
  }

  clearTenant(tenantId: string) {
    for (const trigger of this.store.githubPullRequestTriggers(tenantId)) {
      try { secretEntry(tenantId, trigger.id).deletePassword(); } catch { /* Continue clearing other tenant-owned secrets. */ }
    }
    this.store.clearGitHubPullRequestTriggers(tenantId);
  }

  acceptEvent(triggerId: string, rawBody: Uint8Array, eventName: string, deliveryId: string, signature: string): GitHubIngressResult {
    const trigger = this.store.githubPullRequestTriggerForWebhook(triggerId);
    if (!trigger) return { status: 404, body: { error: 'GitHub trigger not found' } };
    let secret: string | null = null;
    try { secret = secretEntry(trigger.tenantId, trigger.id).getPassword(); }
    catch { return { status: 503, body: { error: 'GitHub webhook secret is unavailable' } }; }
    if (!secret) return { status: 503, body: { error: 'GitHub webhook secret is unavailable' } };
    if (!verifyGitHubSignature(secret, rawBody, signature)) return { status: 401, body: { error: 'GitHub webhook signature is invalid' } };

    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(Buffer.from(rawBody).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      payload = parsed as Record<string, unknown>;
    } catch { return { status: 400, body: { error: 'GitHub webhook JSON is invalid' } }; }
    if (eventName !== 'pull_request') return { status: 202, body: { ok: true, status: 'ignored' } };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deliveryId)) {
      return { status: 400, body: { error: 'GitHub delivery ID is invalid' } };
    }

    const repositoryData = payload.repository;
    const repository = repositoryData && typeof repositoryData === 'object' && !Array.isArray(repositoryData)
      ? (repositoryData as Record<string, unknown>).full_name
      : null;
    if (typeof repository !== 'string' || repository.toLowerCase() !== trigger.repository.toLowerCase()) {
      return { status: 202, body: { ok: true, status: 'ignored' } };
    }
    const action = payload.action;
    if (typeof action !== 'string' || !githubPullRequestActions.includes(action as GitHubPullRequestAction)) {
      return { status: 202, body: { ok: true, status: 'ignored' } };
    }
    const prData = payload.pull_request;
    if (!prData || typeof prData !== 'object' || Array.isArray(prData)) return { status: 400, body: { error: 'GitHub pull request payload is invalid' } };
    const pullRequest = prData as Record<string, unknown>;
    const number = pullRequest.number;
    const title = typeof pullRequest.title === 'string' ? pullRequest.title.trim().slice(0, 300) : '';
    if (!Number.isSafeInteger(number) || Number(number) < 1 || !title) return { status: 400, body: { error: 'GitHub pull request identity is invalid' } };
    const body = typeof pullRequest.body === 'string' ? pullRequest.body.slice(0, 6000) : '';
    const user = pullRequest.user;
    const author = user && typeof user === 'object' && !Array.isArray(user) && typeof (user as Record<string, unknown>).login === 'string'
      ? String((user as Record<string, unknown>).login).slice(0, 100)
      : 'unknown';
    const queued = this.store.createGitHubPullRequestEventTask({
      triggerId, deliveryId, action: action as GitHubPullRequestAction, repository: trigger.repository,
      number: Number(number), title, body, draft: pullRequest.draft === true, author,
    });
    if (queued.status === 'not-found') return { status: 404, body: { error: 'GitHub trigger not found' } };
    return {
      status: 202,
      body: { ok: true, status: queued.status },
      taskCreated: queued.status === 'queued',
    };
  }
}

export function verifyGitHubSignature(secret: string, rawBody: Uint8Array, signatureHeader: string): boolean {
  if (!/^sha256=[a-f0-9]{64}$/i.test(signatureHeader) || !secret) return false;
  const actual = Buffer.from(signatureHeader.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function signGitHubPayload(secret: string, rawBody: Uint8Array): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}
