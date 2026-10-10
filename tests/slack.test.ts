import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SlackService } from '../src/server/slack.ts';
import { Store } from '../src/server/store.ts';

test('Slack OAuth state is tenant and user scoped, expires, and can only be consumed once', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-slack-state-'));
  try {
    const store = new Store(directory);
    const owner = store.signInGoogle({ subject: 'slack-flow-owner', email: 'slack-owner@example.test', name: 'Slack Owner' });
    const stateHash = 'state-hash-alpha';
    store.createSlackOAuthFlow({ stateHash, tenantId: owner.tenant.id, userId: owner.user.id, expiresAt: '2099-01-01T00:00:00.000Z', returnTo: 'https://dots.example.test' });
    assert.deepEqual(store.consumeSlackOAuthFlow(stateHash, '2026-10-08T00:00:00.000Z'), {
      tenantId: owner.tenant.id, userId: owner.user.id, expiresAt: '2099-01-01T00:00:00.000Z', returnTo: 'https://dots.example.test',
    });
    assert.equal(store.consumeSlackOAuthFlow(stateHash), null, 'OAuth state must be single use');
    store.createSlackOAuthFlow({ stateHash: 'expired-state', tenantId: owner.tenant.id, userId: owner.user.id, expiresAt: '2025-01-01T00:00:00.000Z', returnTo: 'https://dots.example.test' });
    assert.equal(store.consumeSlackOAuthFlow('expired-state', '2026-10-08T00:00:00.000Z'), null, 'An expired flow must not be consumable');
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('one Slack workspace cannot route messages into more than one Coke Dots tenant', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-slack-tenant-'));
  try {
    const store = new Store(directory);
    const alpha = store.signInGoogle({ subject: 'slack-alpha', email: 'slack-alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'slack-beta', email: 'slack-beta@example.test', name: 'Beta' });
    const installation = (tenantId: string, teamName: string) => ({
      tenantId, teamId: 'TASPI', teamName, scopes: ['chat:write', 'im:history'], installedAt: '2026-10-08T00:00:00.000Z',
    });
    store.installSlackWorkspace(installation(alpha.tenant.id, 'Alpha Slack'));
    store.installSlackWorkspace(installation(beta.tenant.id, 'Beta Slack'));
    assert.equal(store.setSlackContactWorkspace(alpha.tenant.id, 'TASPI'), true);
    assert.equal(store.setSlackContactWorkspace(beta.tenant.id, 'TASPI'), false, 'One Slack team cannot route events to two tenants');
    assert.equal(store.setSlackContactWorkspace(alpha.tenant.id, 'TOTHER'), false, 'A tenant cannot select a Slack workspace installed in another tenant');
    assert.equal(store.slackInstallations(alpha.tenant.id)[0]?.teamName, 'Alpha Slack');
    assert.equal(store.slackInstallations(alpha.tenant.id)[0]?.contactEnabled, true);
    assert.equal(store.slackInstallations(beta.tenant.id)[0]?.teamName, 'Beta Slack');
    assert.equal(store.slackInstallations(beta.tenant.id)[0]?.contactEnabled, false);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Slack DM messages require account binding, create tenant tasks, resume waiting work, and deduplicate events', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-slack-events-'));
  try {
    const store = new Store(directory);
    const alpha = store.signInGoogle({ subject: 'slack-event-alpha', email: 'slack-event-alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'slack-event-beta', email: 'slack-event-beta@example.test', name: 'Beta' });
    store.installSlackWorkspace({ tenantId: alpha.tenant.id, teamId: 'TASPI', teamName: 'ASPI', scopes: ['chat:write', 'im:history'], installedAt: '2026-10-08T00:00:00.000Z' });
    store.setSlackContactWorkspace(alpha.tenant.id, 'TASPI');
    const first = { eventId: 'EvFIRST000001', teamId: 'TASPI', userId: 'UASPIUSER', channelId: 'DASPI1234', threadTs: '1780873800.000001', text: 'Prepare the launch brief.' };
    const challenge = store.ingestSlackDirectMessage(first, 'one-time-code-hash', '2099-01-01T00:00:00.000Z');
    assert.equal(challenge.kind, 'link-required');
    assert.equal(store.snapshot(false, [], undefined, alpha.tenant.id).tasks.length, 0, 'Unlinked Slack users must not create work');
    assert.equal(store.claimSlackAccount('one-time-code-hash', beta.tenant.id, beta.user.id), 'wrong-workspace');
    assert.equal(store.claimSlackAccount('one-time-code-hash', alpha.tenant.id, alpha.user.id), 'linked');

    const taskResult = store.ingestSlackDirectMessage({ ...first, eventId: 'EvTASK0000001' }, 'unused', '2099-01-01T00:00:00.000Z');
    assert.equal(taskResult.kind, 'task');
    if (taskResult.kind !== 'task') throw new Error('Expected a task');
    store.updateTask(taskResult.taskId, { status: 'waiting' }, alpha.tenant.id);
    store.addEntry('dot', 'Which launch date should I use?', taskResult.taskId, alpha.tenant.id);
    const resumed = store.ingestSlackDirectMessage({
      eventId: 'EvREPLY000001', teamId: 'TASPI', userId: 'UASPIUSER', channelId: 'DASPI1234', threadTs: first.threadTs, threadReply: true, text: 'Use Friday.',
    }, 'unused-2', '2099-01-01T00:00:00.000Z');
    assert.deepEqual(resumed, { kind: 'task', tenantId: alpha.tenant.id, taskId: taskResult.taskId, created: false });
    assert.match(store.getTask(taskResult.taskId, alpha.tenant.id)?.instruction || '', /User reply: Use Friday\./);
    assert.equal(store.ingestSlackDirectMessage({
      eventId: 'EvREPLY000001', teamId: 'TASPI', userId: 'UASPIUSER', channelId: 'DASPI1234', threadTs: first.threadTs, threadReply: true, text: 'Use Friday.',
    }, 'unused-2', '2099-01-01T00:00:00.000Z').kind, 'duplicate');
    assert.equal(store.snapshot(false, [], undefined, beta.tenant.id).tasks.length, 0, 'Slack task data must stay in its linked tenant');
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Slack app mentions in a channel thread create a tenant task and route the result privately to the linked requester', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-slack-mention-'));
  const previous = process.env.SLACK_SIGNING_SECRET;
  process.env.SLACK_SIGNING_SECRET = 'unit-test-slack-signing-secret';
  try {
    const store = new Store(directory);
    const alpha = store.signInGoogle({ subject: 'slack-mention-alpha', email: 'slack-mention-alpha@example.test', name: 'Alpha' });
    store.installSlackWorkspace({ tenantId: alpha.tenant.id, teamId: 'TASPI', teamName: 'ASPI', scopes: ['chat:write', 'im:history', 'im:write', 'app_mentions:read'], installedAt: '2026-10-08T00:00:00.000Z' });
    store.setSlackContactWorkspace(alpha.tenant.id, 'TASPI');
    const linked = store.ingestSlackDirectMessage({
      eventId: 'EvLINK000001', teamId: 'TASPI', userId: 'UASPIUSER', channelId: 'DASPI1234', threadTs: '1780873800.000001', text: 'hello',
    }, 'linked-account-code', '2099-01-01T00:00:00.000Z');
    assert.equal(linked.kind, 'link-required');
    assert.equal(store.claimSlackAccount('linked-account-code', alpha.tenant.id, alpha.user.id), 'linked');

    const service = new SlackService(store, 4317);
    const mention = service.receiveEvent(Buffer.from(JSON.stringify({
      type: 'event_callback', event_id: 'EvMENTION0001', team_id: 'TASPI',
      event: { type: 'app_mention', user: 'UASPIUSER', channel: 'CCHANNEL1', ts: '1780873900.000001', thread_ts: '1780873890.000001', text: '<@UBOT> summarize the launch risk' },
    })));
    assert.equal(mention.kind, 'task');
    if (mention.kind !== 'task') throw new Error('Expected the app mention to create a task');
    store.updateTask(mention.taskId, { status: 'done', result: 'The launch risk is an unowned mobile QA task.' }, alpha.tenant.id);
    store.addEntry('dot', 'The launch risk is an unowned mobile QA task.', mention.taskId, alpha.tenant.id);
    const [reply] = store.pendingSlackTaskReplies();
    assert.equal(reply?.replyUserId, 'UASPIUSER', 'An app mention should receive its result in a private DM');
    assert.equal(reply?.channelId, 'CCHANNEL1', 'The incoming mention remains associated with its source channel');
    assert.equal(reply?.replyThreadTs, null, 'The response is not posted into a shared channel thread by default');
    assert.equal(reply?.dotReply, 'The launch risk is an unowned mobile QA task.');
    store.close();
  } finally {
    if (previous === undefined) delete process.env.SLACK_SIGNING_SECRET;
    else process.env.SLACK_SIGNING_SECRET = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Slack Event API signature verification rejects tampering and timestamps outside the replay window', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-slack-signature-'));
  const previous = process.env.SLACK_SIGNING_SECRET;
  process.env.SLACK_SIGNING_SECRET = 'unit-test-slack-signing-secret';
  try {
    const store = new Store(directory);
    const service = new SlackService(store, 4317);
    const body = Buffer.from(JSON.stringify({ type: 'url_verification', challenge: 'challenge-text' }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac('sha256', process.env.SLACK_SIGNING_SECRET).update(`v0:${timestamp}:`).update(body).digest('hex')}`;
    assert.equal(service.verifyEventRequest(body, timestamp, signature), true);
    assert.equal(service.verifyEventRequest(Buffer.from(`${body.toString()} `), timestamp, signature), false);
    assert.equal(service.verifyEventRequest(body, String(Number(timestamp) - 301), signature), false);
    assert.deepEqual(service.receiveEvent(body), { kind: 'challenge', challenge: 'challenge-text' });
    for (const malformed of ['null', '[]', 'true', '"payload"']) {
      assert.deepEqual(service.receiveEvent(Buffer.from(malformed)), { kind: 'ignored' }, `Slack JSON ${malformed} must not crash the event route`);
    }
    store.close();
  } finally {
    if (previous === undefined) delete process.env.SLACK_SIGNING_SECRET;
    else process.env.SLACK_SIGNING_SECRET = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
