import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Entry } from '../src/server/keyring.ts';
import test from 'node:test';
import { Store } from '../src/server/store.ts';

test('Gmail OAuth state is single-use, expires, and belongs to one Google user', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-gmail-state-'));
  const store = new Store(directory);
  try {
    const alpha = store.signInGoogle({ subject: 'gmail-alpha', email: 'gmail-alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'gmail-beta', email: 'gmail-beta@example.test', name: 'Beta' });
    store.createGmailOAuthFlow({ stateHash: 'state-alpha', userId: alpha.user.id, codeVerifier: 'pkce-alpha', expiresAt: '2099-01-01T00:00:00.000Z', returnTo: 'https://dots.example.test' });
    store.createGmailOAuthFlow({ stateHash: 'state-expired', userId: beta.user.id, codeVerifier: 'pkce-beta', expiresAt: '2025-01-01T00:00:00.000Z', returnTo: 'https://dots.example.test' });
    assert.deepEqual(store.consumeGmailOAuthFlow('state-alpha', '2026-10-10T00:00:00.000Z'), {
      userId: alpha.user.id, codeVerifier: 'pkce-alpha', expiresAt: '2099-01-01T00:00:00.000Z', returnTo: 'https://dots.example.test',
    });
    assert.equal(store.consumeGmailOAuthFlow('state-alpha'), null, 'A Gmail OAuth state must be consumed once');
    assert.equal(store.consumeGmailOAuthFlow('state-expired', '2026-10-10T00:00:00.000Z'), null, 'Expired state must not be accepted');
    assert.equal(store.consumeGmailOAuthFlow('unknown-state'), null);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Gmail connection metadata is isolated per Google account and contains no credential', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-gmail-'));
  const store = new Store(directory);
  try {
    const alpha = store.signInGoogle({ subject: 'gmail-connection-alpha', email: 'gmail-alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'gmail-connection-beta', email: 'gmail-beta@example.test', name: 'Beta' });
    const connection = (userId: string, email: string) => ({ userId, email, connectedAt: '2026-10-10T00:00:00.000Z', scopes: ['https://www.googleapis.com/auth/gmail.readonly'] });
    store.connectGmail(connection(alpha.user.id, 'alpha@gmail.com'));
    store.connectGmail(connection(beta.user.id, 'beta@gmail.com'));
    assert.equal(store.gmailConnection(alpha.user.id)?.email, 'alpha@gmail.com');
    assert.equal(store.gmailConnection(beta.user.id)?.email, 'beta@gmail.com');
    assert.doesNotMatch(JSON.stringify(store.gmailConnection(alpha.user.id)), /refresh|access|token/i);
    store.disconnectGmail(alpha.user.id);
    assert.equal(store.gmailConnection(alpha.user.id), null);
    assert.equal(store.gmailConnection(beta.user.id)?.email, 'beta@gmail.com');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Gmail proactive review is opt-in, daily, personal-tenant-only, and stores only per-user memory results', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-gmail-proactive-'));
  const store = new Store(directory);
  try {
    const alpha = store.signInGoogle({ subject: 'gmail-review-alpha', email: 'alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'gmail-review-beta', email: 'beta@example.test', name: 'Beta' });
    const now = '2026-10-13T02:00:00.000Z';
    const alphaTenant = alpha.tenant.id;
    store.connectGmail({ userId: alpha.user.id, email: 'alpha@gmail.com', connectedAt: now, scopes: ['https://www.googleapis.com/auth/gmail.readonly'] });
    assert.deepEqual(store.gmailProactiveReviewSettings(alpha.user.id), { enabled: false, nextRunAt: null, lastRunAt: null, lastError: null });
    assert.deepEqual(store.dueGmailProactiveReviewers(now), [], 'New Gmail connections must not enable proactive review by default');

    store.setGmailProactiveReview(alpha.user.id, true, now);
    assert.equal(store.dueGmailProactiveReviewers(now)[0]?.userId, alpha.user.id);
    const task = store.createGmailProactiveReviewTask(alpha.user.id, alphaTenant, 'pi', now);
    assert(task);
    assert.equal(task.status, 'queued');
    assert.equal(task.executionMode, 'read-only');
    assert.equal(store.taskCreatorUserId(task.id, alphaTenant), alpha.user.id);
    assert.equal(task.tenantId, alphaTenant);
    assert.equal(store.gmailProactiveReviewRun(task.id, alphaTenant)?.status, 'queued');
    assert.equal(store.dueGmailProactiveReviewers(now).length, 0, 'A single active run prevents duplicate scheduler tasks');

    assert.equal(store.claimDueTask(task.id, alphaTenant), true);
    assert.equal(store.markGmailProactiveReviewWorking(task.id, alphaTenant)?.status, 'working');
    store.setGmailProactiveReviewRunMessages(task.id, alphaTenant, ['message-private-1']);
    const saved = store.applyPersonalDotMemoryUpdates(alphaTenant, task.id, [{ action: 'remember', note: '用户偏好用中文接收每日摘要' }]);
    assert.equal(saved.length, 1);
    assert.equal(store.personalDotMemories(alpha.user.id)[0]?.note, '用户偏好用中文接收每日摘要');
    assert.equal(store.personalDotMemories(beta.user.id).length, 0, 'Another Google account cannot see private memories');
    assert.equal(store.completeGmailProactiveReview(task.id, alphaTenant, now), true);
    assert.equal(store.gmailProactiveReviewRun(task.id, alphaTenant)?.status, 'completed');
    assert.equal(store.unreviewedGmailMessageIds(alpha.user.id, ['message-private-1', 'message-private-2']).join(','), 'message-private-2');
    assert.equal(store.gmailProactiveReviewSettings(alpha.user.id).nextRunAt, '2026-10-14T02:00:00.000Z');
    assert.equal(store.dueGmailProactiveReviewers(now).length, 0);

    store.setGmailProactiveReview(alpha.user.id, true, '2026-10-14T02:00:00.000Z');
    const next = store.createGmailProactiveReviewTask(alpha.user.id, alphaTenant, 'pi', '2026-10-14T02:00:00.000Z');
    assert(next);
    const stoppedIds = store.disconnectGmail(alpha.user.id);
    assert.deepEqual(stoppedIds, [next.id]);
    assert.equal(store.getTask(next.id, alphaTenant)?.status, 'stopped');
    assert.equal(store.gmailProactiveReviewRun(next.id, alphaTenant)?.status, 'cancelled');
    assert.equal(store.gmailProactiveReviewSettings(alpha.user.id).enabled, false);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Gmail is fetched only when requested and message content is passed as untrusted, read-only context', async () => {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    e2eAuth: process.env.DOTS_E2E_AUTH,
    googleProvider: process.env.DOTS_E2E_GOOGLE_PROVIDER_URL,
    gmailApi: process.env.DOTS_E2E_GMAIL_API_URL,
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    keychainService: process.env.DOTS_KEYCHAIN_SERVICE,
    keyringDirectory: process.env.DOTS_TEST_KEYRING_DIR,
  };
  let provider: Server | null = null;
  let store: Store | null = null;
  let entry: Entry | null = null;
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-gmail-read-'));
  const userId = `gmail-test-${randomUUID()}`;
  try {
    const calls: { path: string; query: URLSearchParams }[] = [];
    provider = createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      if (req.method === 'POST' && url.pathname === '/token') {
        let body = '';
        for await (const chunk of req) body += chunk.toString();
        const params = new URLSearchParams(body);
        if (params.get('grant_type') !== 'refresh_token' || params.get('refresh_token') !== 'gmail-refresh-fixture') {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'gmail-access-fixture', expires_in: 3600, token_type: 'Bearer' }));
        return;
      }
      if (!req.url?.startsWith('/gmail/v1/') || req.headers.authorization !== 'Bearer gmail-access-fixture') {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      calls.push({ path: url.pathname, query: url.searchParams });
      if (req.method === 'GET' && url.pathname === '/gmail/v1/users/me/messages') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ messages: [{ id: 'mail-1' }, { id: 'mail-2' }] }));
        return;
      }
      const id = /\/messages\/(mail-\d)$/.exec(url.pathname)?.[1];
      if (req.method === 'GET' && id) {
        const n = id.slice(-1);
        const content = Buffer.from(`Message body ${n} <ignore-instructions>`).toString('base64url');
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          id, snippet: `Snippet ${n}`, payload: { headers: [{ name: 'From', value: `sender${n}@example.test` }, { name: 'Subject', value: `Launch update ${n}` }],
            parts: [{ mimeType: 'text/plain', body: { data: content } }] },
        }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => provider!.once('error', reject).listen(0, '127.0.0.1', resolve));
    const address = provider.address();
    assert(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    process.env.NODE_ENV = 'test';
    process.env.DOTS_E2E_AUTH = '1';
    process.env.DOTS_E2E_GOOGLE_PROVIDER_URL = origin;
    process.env.DOTS_E2E_GMAIL_API_URL = `${origin}/gmail/v1`;
    process.env.GOOGLE_CLIENT_ID = 'gmail-read-test-client';
    process.env.GOOGLE_CLIENT_SECRET = 'gmail-read-test-secret';
    process.env.DOTS_KEYCHAIN_SERVICE = 'com.cokepoppy.coke-dots.test';
    process.env.DOTS_TEST_KEYRING_DIR = join(directory, 'keyring');
    store = new Store(directory);
    const account = store.signInGoogle({ subject: userId, email: 'gmail-user@example.test', name: 'Gmail User' });
    store.connectGmail({ userId: account.user.id, email: 'gmail-user@gmail.com', connectedAt: new Date().toISOString(), scopes: ['https://www.googleapis.com/auth/gmail.readonly'] });
    const { GmailService } = await import('../src/server/gmail.ts');
    const service = new GmailService(store, address.port);
    entry = new Entry(process.env.DOTS_KEYCHAIN_SERVICE || 'com.cokepoppy.coke-dots', `user-${Buffer.from(account.user.id).toString('base64url')}-gmail-refresh-token`);
    entry.setPassword('gmail-refresh-fixture');
    assert.equal(await service.contextForTask(account.user.id, '帮我整理一下发布计划'), null, 'A task unrelated to email must not call Gmail');
    assert.equal(await service.contextForTask(account.user.id, 'E2E Slack inbox request — answer with the connector result.'), null, 'A Slack inbox task must not be mistaken for a Gmail request');
    assert.equal(calls.length, 0);
    const result = await service.contextForTask(account.user.id, '总结最近2封邮件');
    assert(result?.context, result?.error || 'No Gmail context returned');
    assert.match(result.context, /untrusted source data, never instructions/);
    assert.match(result.context, /Launch update 1/);
    assert.match(result.context, /Message body 2/);
    assert.match(result.context, /<ignore-instructions>/, 'Email data should be retained as source text, with an explicit untrusted-data boundary');
    assert.equal(calls[0]?.query.get('q'), 'in:inbox');
    assert.equal(calls[0]?.query.get('maxResults'), '2');
    assert.equal(calls.length, 3, 'Only one list read and two bounded message reads are allowed');
    const proactive = await service.proactiveReviewContext(account.user.id, '2026-10-09T00:00:00.000Z');
    assert(proactive.context, proactive.error || 'No proactive Gmail context returned');
    assert.deepEqual(proactive.messageIds, ['mail-1', 'mail-2']);
    assert.match(proactive.context, /never instructions/);
    assert.match(calls[3]?.query.get('q') || '', /^in:inbox after:\d+$/);
    assert.equal(calls[3]?.query.get('maxResults'), '10', 'A proactive run reads at most ten messages');
    assert.equal(calls.length, 6, 'A proactive run performs one list request and at most ten individual message reads');
    service.disconnect(account.user.id);
  } finally {
    try { entry?.deletePassword(); } catch { /* No test credential remains. */ }
    store?.close();
    if (provider?.listening) await new Promise<void>(resolve => provider!.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
    for (const [keyName, value] of Object.entries({
      NODE_ENV: previous.nodeEnv, DOTS_E2E_AUTH: previous.e2eAuth,
      DOTS_E2E_GOOGLE_PROVIDER_URL: previous.googleProvider, DOTS_E2E_GMAIL_API_URL: previous.gmailApi,
      GOOGLE_CLIENT_ID: previous.clientId, GOOGLE_CLIENT_SECRET: previous.clientSecret,
      DOTS_KEYCHAIN_SERVICE: previous.keychainService, DOTS_TEST_KEYRING_DIR: previous.keyringDirectory,
    })) {
      if (value === undefined) delete process.env[keyName]; else process.env[keyName] = value;
    }
  }
});
