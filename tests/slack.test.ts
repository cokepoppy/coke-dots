import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifySlackSignature } from '../src/server/slack.ts';
import { Store } from '../src/server/store.ts';

test('Slack request signatures require a valid HMAC and a fresh timestamp', () => {
  const secret = 'slack-signing-secret-for-test';
  const body = Buffer.from('{"type":"url_verification","challenge":"dots-test"}');
  const timestamp = '1791421200';
  const signature = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body.toString('utf8')}`).digest('hex')}`;
  assert.equal(verifySlackSignature(secret, body, timestamp, signature, Number(timestamp)), true);
  assert.equal(verifySlackSignature(secret, body, timestamp, `${signature.slice(0, -1)}0`, Number(timestamp)), false);
  assert.equal(verifySlackSignature(secret, Buffer.from(`${body.toString('utf8')} `), timestamp, signature, Number(timestamp)), false);
  assert.equal(verifySlackSignature(secret, body, timestamp, signature, Number(timestamp) + 301), false);
  assert.equal(verifySlackSignature(secret, body, '1e9', signature, Number(timestamp)), false);
});

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

test('Slack installations and selected contact workspace stay isolated between Coke Dots tenants', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-slack-tenant-'));
  try {
    const store = new Store(directory);
    const alpha = store.signInGoogle({ subject: 'slack-alpha', email: 'slack-alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'slack-beta', email: 'slack-beta@example.test', name: 'Beta' });
    const installation = (tenantId: string, teamName: string) => ({
      tenantId, teamId: 'TASPI', teamName, scopes: ['chat:write'], installedAt: '2026-10-08T00:00:00.000Z',
    });
    store.installSlackWorkspace(installation(alpha.tenant.id, 'Alpha Slack'));
    store.installSlackWorkspace(installation(beta.tenant.id, 'Beta Slack'));
    assert.equal(store.setSlackContactWorkspace(alpha.tenant.id, 'TASPI'), true);
    assert.equal(store.setSlackContactWorkspace(beta.tenant.id, 'TASPI'), true);
    assert.equal(store.setSlackContactWorkspace(alpha.tenant.id, 'TOTHER'), false, 'A tenant cannot select a Slack workspace installed in another tenant');
    assert.equal(store.slackInstallations(alpha.tenant.id)[0]?.teamName, 'Alpha Slack');
    assert.equal(store.slackInstallations(alpha.tenant.id)[0]?.contactEnabled, true);
    assert.equal(store.slackInstallations(beta.tenant.id)[0]?.teamName, 'Beta Slack');
    assert.equal(store.slackInstallations(beta.tenant.id)[0]?.contactEnabled, true);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('scheduled Slack results are durable, idempotent, delivered to the task creator, and tenant scoped', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-scheduled-slack-'));
  try {
    let store = new Store(directory);
    const alpha = store.signInGoogle({ subject: 'scheduled-slack-alpha', email: 'scheduled-slack-alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'scheduled-slack-beta', email: 'scheduled-slack-beta@example.test', name: 'Beta' });
    for (const tenantId of [alpha.tenant.id, beta.tenant.id]) {
      store.installSlackWorkspace({ tenantId, teamId: 'TASPI', teamName: 'ASPI', scopes: ['chat:write', 'im:write'], installedAt: '2026-10-09T00:00:00.000Z' });
      store.setSlackContactWorkspace(tenantId, 'TASPI');
    }
    store.linkSlackUser(alpha.tenant.id, 'TASPI', 'UALPHA', alpha.user.id);
    const target = store.slackTaskDeliveryTarget(alpha.tenant.id, alpha.user.id, 'TASPI');
    assert.deepEqual(target, { type: 'slack', teamId: 'TASPI', teamName: 'ASPI' });
    assert.equal(store.slackTaskDeliveryTarget(beta.tenant.id, beta.user.id, 'TASPI'), null, 'A Slack identity linked in one Coke Dots tenant cannot be reused by another tenant');

    assert.throws(() => store.createTask('Private Beta schedule', 60, 'model', beta.tenant.id, null, null, [], beta.user.id, 'standard', 'high', { type: 'slack', teamId: 'TASPI', teamName: 'ASPI' }, 'every-run'), /Slack delivery requires/,
      'A caller cannot target a workspace without linking their own Slack identity');
    const task = store.createTask('Check the release status', 60, 'model', alpha.tenant.id, null, null, [], alpha.user.id, 'standard', 'high', target!, 'every-run');
    const firstKey = '2026-10-09T01:00:00.000Z';
    const firstRun = store.recordScheduledTaskRun(alpha.tenant.id, task.id, firstKey, {
      status: 'complete', result: 'Release remains on track.', needsAttention: false, startedAt: firstKey, finishedAt: firstKey,
    });
    assert.equal(firstRun.needsAttention, true, 'Every-run notification preference keeps each run unread in Scheduled');
    assert.equal(firstRun.deliveryStatus, 'pending', 'The run and its durable delivery are committed together');
    const firstDelivery = store.scheduledTaskDeliveryCandidates().find(candidate => candidate.executionKey === firstKey);
    assert(firstDelivery);
    assert.equal(firstDelivery.slackUserId, 'UALPHA', 'Delivery resolves to the linked identity of the task creator');
    assert.equal(firstDelivery.task.result, 'Release remains on track.');

    const attentionTask = store.createTask('Notify only on meaningful changes', 60, 'model', alpha.tenant.id, null, null, [], alpha.user.id, 'standard', 'high', target!, 'attention');
    const quietKey = '2026-10-09T01:30:00.000Z';
    const quietRun = store.recordScheduledTaskRun(alpha.tenant.id, attentionTask.id, quietKey, {
      status: 'complete', result: 'No change found.', needsAttention: false, startedAt: quietKey,
    });
    assert.equal(quietRun.deliveryStatus, null, 'Attention-only schedules must not enqueue ordinary unchanged results');
    assert.equal(store.scheduledTaskDeliveryCandidates().some(candidate => candidate.taskId === attentionTask.id), false);
    const attentionKey = '2026-10-09T02:30:00.000Z';
    const attentionRun = store.recordScheduledTaskRun(alpha.tenant.id, attentionTask.id, attentionKey, {
      status: 'waiting', result: 'I need your decision.', needsAttention: true, startedAt: attentionKey,
    });
    assert.equal(attentionRun.deliveryStatus, 'pending', 'Attention-only schedules must deliver results that need the user');
    assert.equal(store.scheduledTaskDeliveryCandidates().find(candidate => candidate.taskId === attentionTask.id)?.task.result, 'I need your decision.');

    store.updateTask(task.id, { status: 'scheduled', result: 'A later run has a different result.' }, alpha.tenant.id);
    assert.equal(store.scheduledTaskDeliveryCandidates().find(candidate => candidate.executionKey === firstKey)?.task.result, 'Release remains on track.',
      'A delayed delivery must use its own run result instead of a newer task result');
    const secondKey = '2026-10-09T02:00:00.000Z';
    store.recordScheduledTaskRun(alpha.tenant.id, task.id, secondKey, {
      status: 'complete', result: 'A later run has a different result.', needsAttention: false, startedAt: secondKey, finishedAt: secondKey,
    });
    store.recordScheduledTaskRun(alpha.tenant.id, task.id, firstKey, {
      status: 'complete', result: 'Release remains on track.', needsAttention: false, startedAt: firstKey, finishedAt: firstKey,
    });
    assert.equal(store.scheduledTaskDeliveryCandidates().filter(candidate => candidate.taskId === task.id).length, 2,
      'Replaying one scheduled execution must not enqueue a duplicate Slack message');
    assert.deepEqual(store.scheduledTaskRuns(beta.tenant.id, task.id), [], 'Run and delivery history cannot cross tenant boundaries');

    store.markScheduledTaskDeliverySent(firstDelivery.id);
    for (let attempt = 0; attempt < 5; attempt++) {
      const retry = store.scheduledTaskDeliveryCandidates().find(candidate => candidate.executionKey === secondKey);
      assert(retry, `Retry ${attempt + 1} should remain available before the dead-letter limit`);
      store.markScheduledTaskDeliveryFailed(retry.id, 'Slack rate limit', new Date(Date.now() - 1_000).toISOString());
    }
    const runs = store.scheduledTaskRuns(alpha.tenant.id, task.id);
    assert.equal(runs.find(run => run.startedAt === firstKey)?.deliveryStatus, 'sent');
    assert.equal(runs.find(run => run.startedAt === secondKey)?.deliveryStatus, 'dead');
    assert.equal(runs.find(run => run.startedAt === secondKey)?.deliveryError, 'Slack rate limit');
    assert.deepEqual(store.scheduledTaskDeliveryCandidates().filter(candidate => candidate.taskId === task.id), [], 'Dead-lettered deliveries must stop retrying');
    store.close();

    store = new Store(directory);
    assert.deepEqual(store.getTask(task.id, alpha.tenant.id)?.deliveryDestination, target, 'Destination and policy survive SQLite reopen');
    assert.equal(store.getTask(task.id, alpha.tenant.id)?.notificationPolicy, 'every-run');
    assert.equal(store.scheduledTaskRuns(alpha.tenant.id, task.id).find(run => run.startedAt === firstKey)?.deliveryStatus, 'sent');
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Slack inbound events map only linked users to one selected tenant, deduplicate, and wait for the actual task result', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-slack-inbox-'));
  try {
    const store = new Store(directory);
    const alpha = store.signInGoogle({ subject: 'slack-inbox-alpha', email: 'slack-inbox-alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'slack-inbox-beta', email: 'slack-inbox-beta@example.test', name: 'Beta' });
    const install = (tenantId: string) => store.installSlackWorkspace({
      tenantId, teamId: 'TASPI', teamName: 'Shared Slack', scopes: ['chat:write', 'app_mentions:read', 'im:history'], installedAt: '2026-10-08T00:00:00.000Z',
    });
    install(alpha.tenant.id); install(beta.tenant.id);
    store.setSlackContactWorkspace(alpha.tenant.id, 'TASPI');
    store.setSlackContactWorkspace(beta.tenant.id, 'TASPI');
    store.linkSlackUser(alpha.tenant.id, 'TASPI', 'UALPHA', alpha.user.id);
    store.linkSlackUser(beta.tenant.id, 'TASPI', 'UBETA', beta.user.id);
    const event = (eventId: string, slackUserId: string, text = 'Check the launch status') => ({
      eventId, teamId: 'TASPI', slackUserId, sourceChannelId: 'DTEST', replyChannelId: 'DTEST', eventType: 'message.im' as const, text,
    });

    const alphaResult = store.createSlackInboxTask(event('EvAlpha0001', 'UALPHA'));
    const betaResult = store.createSlackInboxTask(event('EvBeta00001', 'UBETA'));
    assert.equal(alphaResult.status, 'queued');
    assert.equal(betaResult.status, 'queued');
    assert.equal(store.getTask(alphaResult.taskId!, alpha.tenant.id)?.tenantId, alpha.tenant.id);
    assert.equal(store.getTask(betaResult.taskId!, beta.tenant.id)?.tenantId, beta.tenant.id);
    assert.equal(store.createSlackInboxTask(event('EvAlpha0001', 'UALPHA')).status, 'duplicate');
    assert.equal(store.createSlackInboxTask(event('EvUnknown001', 'UUNKNOWN')).status, 'ignored');

    store.linkSlackUser(alpha.tenant.id, 'TASPI', 'USHARED', alpha.user.id);
    store.linkSlackUser(beta.tenant.id, 'TASPI', 'USHARED', beta.user.id);
    assert.equal(store.createSlackInboxTask(event('EvAmbiguous1', 'USHARED')).status, 'ignored', 'A sender linked to multiple selected tenants must never dispatch ambiguously');

    const database = store.db;
    database.prepare("UPDATE tasks SET status='done',result='Verified launch date: October 22.' WHERE id=? AND tenant_id=?").run(alphaResult.taskId!, alpha.tenant.id);
    const delivery = store.slackDeliveryCandidates().find(item => item.eventId === 'EvAlpha0001');
    assert.equal(delivery?.task.result, 'Verified launch date: October 22.');
    assert.equal(delivery?.tenantId, alpha.tenant.id);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Slack public-channel monitors create tenant-scoped read-only tasks only for opted-in channels', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-slack-monitor-'));
  try {
    const store = new Store(directory);
    const alpha = store.signInGoogle({ subject: 'slack-monitor-alpha', email: 'slack-monitor-alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'slack-monitor-beta', email: 'slack-monitor-beta@example.test', name: 'Beta' });
    const install = (tenantId: string, scopes: string[]) => store.installSlackWorkspace({
      tenantId, teamId: 'TASPI', teamName: 'Shared public Slack', scopes, installedAt: '2026-10-08T00:00:00.000Z',
    });
    install(alpha.tenant.id, ['channels:read']);
    install(beta.tenant.id, ['channels:read', 'channels:history']);
    assert.throws(() => store.createSlackEventMonitor({
      tenantId: alpha.tenant.id, teamId: 'TASPI', channelId: 'CBUGS', channelName: 'incidents', instructions: 'Find release blocking bugs',
    }), /channels:read and channels:history/);

    install(alpha.tenant.id, ['channels:read', 'channels:history']);
    const alphaMonitor = store.createSlackEventMonitor({
      tenantId: alpha.tenant.id, teamId: 'TASPI', channelId: 'CBUGS', channelName: 'incidents', instructions: 'Find release blocking bugs',
    });
    const betaMonitor = store.createSlackEventMonitor({
      tenantId: beta.tenant.id, teamId: 'TASPI', channelId: 'CBUGS', channelName: 'incidents', instructions: 'Find security incidents',
    });
    assert.throws(() => store.createSlackEventMonitor({
      tenantId: alpha.tenant.id, teamId: 'TASPI', channelId: 'CBUGS', channelName: 'incidents', instructions: 'Duplicate subscription',
    }), /already monitored/);
    assert.equal(store.slackEventMonitors(alpha.tenant.id).length, 1);
    assert.equal(store.slackEventMonitors(beta.tenant.id).length, 1);
    assert.equal(store.updateSlackEventMonitor(alphaMonitor.id, beta.tenant.id, 'pause'), null, 'A tenant cannot change another tenant monitor');

    const event = { eventId: 'EvMonitorTest0001', teamId: 'TASPI', channelId: 'CBUGS', slackUserId: 'UREPORTER', text: 'Checkout is blocked by a release regression', timestamp: '1791421200.000001' };
    const queued = store.createSlackMonitorTasks(event);
    assert.equal(queued.status, 'queued');
    assert.equal(queued.taskIds.length, 2, 'Each tenant that explicitly configured the channel receives an independent task');
    const alphaTask = store.getTask(queued.taskIds.find(id => store.getTask(id, alpha.tenant.id))!, alpha.tenant.id);
    const betaTask = store.getTask(queued.taskIds.find(id => store.getTask(id, beta.tenant.id))!, beta.tenant.id);
    assert(alphaTask && betaTask);
    for (const task of [alphaTask, betaTask]) {
      assert.equal(task.executionMode, 'read-only');
      assert.equal(task.priority, -1, 'A background channel review must stay behind user-assigned work');
      assert.match(task.instruction, /Do not reply to Slack or modify any external source/);
      const entryBodies = store.db.prepare('SELECT body FROM entries WHERE tenant_id=? AND task_id=? ORDER BY id').all(task.tenantId, task.id) as { body: string }[];
      assert.match(entryBodies.map(entry => entry.body).join('\n'), /No Slack reply will be sent/);
      assert.equal(JSON.parse(store.taskContext(task.id, task.tenantId)).message, event.text);
    }
    assert.deepEqual(store.slackDeliveryCandidates(), [], 'Proactive monitor work must never enter the outbound Slack reply queue');
    assert.equal(store.createSlackMonitorTasks(event).status, 'duplicate');
    assert.deepEqual(store.createSlackMonitorTasks({ ...event, eventId: 'EvUnmonitored0001', channelId: 'CGENERAL' }), { status: 'ignored', taskIds: [] });

    assert.equal(store.updateSlackEventMonitor(alphaMonitor.id, alpha.tenant.id, 'pause')?.status, 'paused');
    const afterPause = store.createSlackMonitorTasks({ ...event, eventId: 'EvMonitorTest0002' });
    assert.equal(afterPause.status, 'queued');
    assert.equal(afterPause.taskIds.length, 1);
    assert.equal(store.getTask(afterPause.taskIds[0]!, beta.tenant.id)?.tenantId, beta.tenant.id);
    assert.equal(store.slackEventMonitor(alphaMonitor.id, alpha.tenant.id)?.lastTaskId, queued.taskIds.find(id => store.getTask(id, alpha.tenant.id)));
    assert.equal(store.slackEventMonitor(betaMonitor.id, beta.tenant.id)?.lastTaskId, afterPause.taskIds[0]);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
