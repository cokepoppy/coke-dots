import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TeamsService, verifyBotConnectorToken } from '../src/server/teams.ts';
import { Store } from '../src/server/store.ts';

const botAppId = '1a96dc34-47e1-49a4-8e81-d83e39f5219a';
const microsoftTenantId = '2a96dc34-47e1-49a4-8e81-d83e39f5219a';
const aadObjectId = '3a96dc34-47e1-49a4-8e81-d83e39f5219a';
const serviceUrl = 'https://smba.trafficmanager.net/teams/';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: 'dots-test-key', use: 'sig', alg: 'RS256' };
const mockFetch: typeof fetch = async input => {
  const url = String(input);
  if (url === 'https://login.botframework.com/v1/.well-known/openidconfiguration') return new Response(JSON.stringify({
    issuer: 'https://api.botframework.com', jwks_uri: 'https://login.botframework.com/v1/.well-known/keys', id_token_signing_alg_values_supported: ['RS256'],
  }));
  if (url === 'https://login.botframework.com/v1/.well-known/keys') return new Response(JSON.stringify({ keys: [jwk] }));
  if (url === 'https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token') return new Response(JSON.stringify({ access_token: 'mock-bot-token', expires_in: 3600 }));
  if (url.startsWith(serviceUrl)) return new Response('{}', { status: 200 });
  throw new Error(`Unexpected Teams API URL: ${url}`);
};

function connectorToken(claims: Record<string, unknown> = {}, signingKey = privateKey) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', typ: 'JWT', kid: 'dots-test-key' });
  const payload = encode({ iss: 'https://api.botframework.com', aud: botAppId, serviceUrl, exp: Math.floor(Date.now() / 1000) + 300, nbf: Math.floor(Date.now() / 1000) - 5, ...claims });
  const input = `${header}.${payload}`;
  return `Bearer ${input}.${sign('RSA-SHA256', Buffer.from(input), signingKey).toString('base64url')}`;
}

function activity(eventId: string, text: string, conversationId = 'a:personal-chat') {
  return Buffer.from(JSON.stringify({
    type: 'message', id: eventId, channelId: 'msteams', serviceUrl,
    from: { id: '29:teams-user', aadObjectId, name: 'Teams Owner' },
    recipient: { id: '28:dots-bot' },
    conversation: { id: conversationId, conversationType: 'personal', tenantId: microsoftTenantId },
    text,
  }));
}

test('Bot Connector JWT verification requires Microsoft signature, issuer, audience, dates, and matching serviceUrl', async () => {
  const token = connectorToken();
  assert.equal(await verifyBotConnectorToken(token, botAppId, serviceUrl, mockFetch), true);
  assert.equal(await verifyBotConnectorToken(token, '9a96dc34-47e1-49a4-8e81-d83e39f5219a', serviceUrl, mockFetch), false);
  assert.equal(await verifyBotConnectorToken(connectorToken({ aud: 'wrong-audience' }), botAppId, serviceUrl, mockFetch), false);
  assert.equal(await verifyBotConnectorToken(connectorToken({ exp: Math.floor(Date.now() / 1000) - 600 }), botAppId, serviceUrl, mockFetch), false);
  assert.equal(await verifyBotConnectorToken(token, botAppId, 'https://smba.trafficmanager.net/other/', mockFetch), false);
  assert.equal(await verifyBotConnectorToken(connectorToken({}, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey), botAppId, serviceUrl, mockFetch), false);
  assert.equal(await verifyBotConnectorToken(token, botAppId, 'http://127.0.0.1:4317/', mockFetch), false);
  assert.equal(await verifyBotConnectorToken('Bearer malformed', botAppId, serviceUrl, mockFetch), false);
});

test('Teams one-time linking and task messages remain scoped to the Coke Dots tenant and verified Teams identity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-teams-'));
  try {
    const store = new Store(directory);
    const alpha = store.signInGoogle({ subject: 'teams-alpha', email: 'teams-alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'teams-beta', email: 'teams-beta@example.test', name: 'Beta' });
    const teams = new TeamsService(store, botAppId, 'mock-bot-secret', mockFetch);
    const sharedTenant = store.createWorkspace(alpha.user.id, 'Shared workspace');
    assert.equal(teams.createLinkCode({ user: alpha.user, tenant: sharedTenant }).status, 403, 'private Teams messages must not enter a shared workspace history');
    const alphaCode = teams.createLinkCode(alpha);
    const betaCode = teams.createLinkCode(beta);
    assert.equal(alphaCode.status, 200);
    assert.equal(betaCode.status, 200);
    if (alphaCode.status !== 200 || betaCode.status !== 200) throw new Error('test configuration should allow Teams link codes');
    const linkMessage = await teams.acceptActivity(activity('activity-link-alpha', `connect ${alphaCode.value.code}`), connectorToken());
    assert.equal(linkMessage.status, 200);
    assert.deepEqual(teams.snapshot(alpha).linked?.displayName, 'Teams Owner');
    assert.equal(teams.snapshot(beta).linked, null);
    assert.equal(store.db.prepare('SELECT 1 FROM teams_link_codes WHERE code_hash=?').get(createHash('sha256').update(alphaCode.value.code).digest('hex')), undefined, 'redeemed link codes must be deleted');

    const assigned = await teams.acceptActivity(activity('activity-task-alpha', 'Review the launch timeline'), connectorToken());
    assert.equal(assigned.taskCreated, true);
    const taskId = store.db.prepare('SELECT task_id AS id FROM teams_inbox_events WHERE event_id=?').get('activity-task-alpha') as { id: string };
    assert.equal(store.getTask(taskId.id, alpha.tenant.id)?.title, 'Review the launch timeline');
    assert.equal(store.getTask(taskId.id, beta.tenant.id), null);
    assert.equal((await teams.acceptActivity(activity('activity-task-alpha', 'Repeat this message'), connectorToken())).taskCreated, false, 'duplicate activity IDs must not enqueue twice');
    assert.equal((await teams.acceptActivity(activity('activity-task-alpha', 'Same message ID in a separate conversation', 'a:second-personal-chat'), connectorToken())).taskCreated, true, 'deduplication keys must include the Teams conversation');
    store.db.prepare("UPDATE tasks SET status='done',result='Verified launch date: October 22.' WHERE id=? AND tenant_id=?").run(taskId.id, alpha.tenant.id);
    const delivery = store.teamsDeliveryCandidates().find(item => item.eventId === 'activity-task-alpha');
    assert.equal(delivery?.task.result, 'Verified launch date: October 22.');
    store.markTeamsDeliveryFailed(delivery!.eventKey, 'temporary failure', '2099-01-01T00:00:00.000Z');
    const retries = store.db.prepare('SELECT event_key,attempts,status FROM teams_inbox_events WHERE event_id=? ORDER BY event_key').all('activity-task-alpha') as { event_key: string; attempts: number; status: string }[];
    assert.equal(retries.length, 2, 'the same activity ID in separate Teams conversations needs distinct inbox rows');
    assert.deepEqual(retries.map(row => [row.attempts, row.status]).sort(), [[0, 'pending'], [1, 'pending']], 'a failed delivery must update only its scoped conversation event');

    const betaLinked = await teams.acceptActivity(activity('activity-link-beta', `connect ${betaCode.value.code}`), connectorToken());
    assert.equal(betaLinked.status, 200);
    const ambiguous = await teams.acceptActivity(activity('activity-task-ambiguous', 'Do not dispatch ambiguously'), connectorToken());
    assert.equal(ambiguous.taskCreated, false);
    const status = store.db.prepare('SELECT status FROM teams_inbox_events WHERE event_id=?').get('activity-task-ambiguous') as { status: string };
    assert.equal(status.status, 'ignored');
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Teams ingress ignores channel/group messages and rejects unsigned connector traffic', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-teams-ingress-'));
  try {
    const store = new Store(directory);
    const owner = store.signInGoogle({ subject: 'teams-ingress-owner', email: 'teams-ingress@example.test', name: 'Owner' });
    const teams = new TeamsService(store, botAppId, 'mock-bot-secret', mockFetch);
    const linkCode = teams.createLinkCode(owner);
    assert.equal(linkCode.status, 200);
    if (linkCode.status !== 200) throw new Error('test configuration should allow Teams link codes');
    assert.equal((await teams.acceptActivity(activity('unsigned-event', `connect ${linkCode.value.code}`), 'Bearer invalid')).status, 401);
    const group = JSON.parse(activity('group-event', `connect ${linkCode.value.code}`).toString('utf8')) as Record<string, unknown>;
    group.conversation = { id: 'a:group-chat', conversationType: 'group', tenantId: microsoftTenantId };
    const ignored = await teams.acceptActivity(Buffer.from(JSON.stringify(group)), connectorToken());
    assert.equal(ignored.taskCreated, undefined);
    assert.equal(teams.snapshot(owner).linked, null);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
