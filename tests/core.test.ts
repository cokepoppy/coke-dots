import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store } from '../src/server/store.ts';
import { Worker } from '../src/server/worker.ts';

test('tasks, redirects and profile survive database reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-'));
  try {
    let store = new Store(directory);
    const task = store.createTask('Track the design review');
    store.setProfile('Alfred', 'triangle', '#aabbcc');
    store.updateTask(task.id, { instruction: 'Track the updated design review', priority: 2, status: 'working' });
    store.close();
    store = new Store(directory);
    assert.equal(store.getTask(task.id)?.status, 'queued');
    assert.equal(store.getTask(task.id)?.priority, 2);
    assert.equal(store.getTask(task.id)?.instruction, 'Track the updated design review');
    assert.equal(store.snapshot(false).profile.name, 'Alfred');
    assert.equal(store.snapshot(false).entries.filter(e => e.taskId === task.id).length, 2);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a waiting task accepts a tenant-scoped reply without losing its original goal', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-'));
  try {
    const store = new Store(directory);
    const task = store.createTask('Prepare the project launch plan');
    store.updateTask(task.id, { status: 'waiting', nextRunAt: null, result: 'I need a confirmed launch date.' });
    assert.equal(store.replyToTask(task.id, 'Use Friday.', 'another-tenant'), null);
    assert.throws(() => store.replyToTask(task.id, '   '), /Invalid task reply/);
    assert.throws(() => store.replyToTask(task.id, 'x'.repeat(5001)), /Invalid task reply/);
    const resumed = store.replyToTask(task.id, 'Use Friday.');
    assert.equal(resumed?.status, 'queued');
    assert.equal(resumed?.title, task.title);
    assert.equal(resumed?.instruction, 'Prepare the project launch plan\n\nUser reply: Use Friday.');
    assert.ok(resumed?.nextRunAt);
    assert.ok(store.snapshot(false).entries.some(entry => entry.taskId === task.id && entry.kind === 'user' && entry.body === 'Use Friday.'));
    assert.throws(() => store.replyToTask(task.id, 'A second reply'), /not waiting/);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('workspace invitations require a matching signed-in email and are accepted once', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-invitation-'));
  try {
    const store = new Store(directory);
    const owner = store.signInGoogle({ subject: 'owner-sub', email: 'owner@example.test', name: 'Owner' });
    const workspace = store.createWorkspace(owner.user.id, 'Design team');
    const invitee = store.signInGoogle({ subject: 'invitee-sub', email: 'new.member@example.test', name: 'New Member' });
    const invite = store.addWorkspaceMember(workspace.id, owner.user.id, 'new.member@example.test', 'member');
    assert.equal(invite.ok, true);
    if (!invite.ok || invite.kind !== 'invitation') throw new Error('Expected a pending invitation');
    assert.equal(invite.invitation.email, 'new.member@example.test');
    assert.deepEqual(store.pendingWorkspaceInvitations('NEW.MEMBER@example.test').map(item => item.tenantName), ['Design team']);
    assert.equal(store.tenantsForUser(invitee.user.id).some(item => item.id === workspace.id), false, 'A pending invitation granted membership before acceptance');
    const sessionHash = 'invitee-session-hash';
    store.createSession(sessionHash, invitee.user.id, invitee.tenant.id, new Date(Date.now() + 60_000).toISOString());
    assert.equal(store.acceptWorkspaceInvitation(workspace.id, sessionHash, invitee.user.id, 'other@example.test'), null);
    assert.equal(store.pendingWorkspaceInvitations(invitee.user.email).length, 1, 'A mismatched identity consumed the invitation');
    const accepted = store.acceptWorkspaceInvitation(workspace.id, sessionHash, invitee.user.id, invitee.user.email);
    assert.equal(accepted?.id, workspace.id);
    assert.equal(accepted?.role, 'member');
    assert.equal(store.getSession(sessionHash)?.tenant.id, workspace.id, 'Accepting did not switch the session to the joined workspace');
    assert.equal(store.pendingWorkspaceInvitations(invitee.user.email).length, 0);
    assert.equal(store.acceptWorkspaceInvitation(workspace.id, sessionHash, invitee.user.id, invitee.user.email), null, 'The same invitation was accepted twice');
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('activity feed pages in descending order and stays tenant scoped', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-activity-'));
  try {
    const store = new Store(directory);
    store.signInGoogle({ subject: 'activity-alpha', email: 'activity-alpha@example.test', name: 'Activity Alpha' });
    const beta = store.signInGoogle({ subject: 'activity-beta', email: 'activity-beta@example.test', name: 'Activity Beta' });
    const ids = Array.from({ length: 5 }, (_, index) => store.addEntry('system', `Alpha event ${index + 1}`, null, 'legacy').id);
    store.addEntry('user', 'Beta private event', null, beta.tenant.id);

    const firstPage = store.activityPage('legacy', null, 2);
    assert.deepEqual(firstPage.entries.map(entry => entry.id), ids.slice(-2).reverse());
    assert.equal(firstPage.nextCursor, ids[3]);
    const secondPage = store.activityPage('legacy', firstPage.nextCursor, 2);
    assert.deepEqual(secondPage.entries.map(entry => entry.id), ids.slice(1, 3).reverse());
    assert.equal(secondPage.nextCursor, ids[1]);
    const finalPage = store.activityPage('legacy', secondPage.nextCursor, 2);
    assert.deepEqual(finalPage.entries.map(entry => entry.id), [ids[0]]);
    assert.equal(finalPage.nextCursor, null);
    assert.deepEqual(store.activityPage(beta.tenant.id).entries.map(entry => entry.body), ['Beta private event']);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('workspace memories persist, are tenant scoped, and can only be edited by their creator or an admin', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-memory-'));
  try {
    let store = new Store(directory);
    const alpha = store.signInGoogle({ subject: 'memory-alpha', email: 'memory-alpha@example.test', name: 'Memory Alpha' });
    const beta = store.signInGoogle({ subject: 'memory-beta', email: 'memory-beta@example.test', name: 'Memory Beta' });
    const workspace = store.createWorkspace(alpha.user.id, 'Memory Team');
    const invitation = store.addWorkspaceMember(workspace.id, alpha.user.id, beta.user.email, 'member');
    assert.equal(invitation.ok, true);
    if (!invitation.ok || invitation.kind !== 'invitation') throw new Error('Expected Beta workspace invitation');
    const betaSession = 'memory-beta-workspace-session';
    store.createSession(betaSession, beta.user.id, beta.tenant.id, new Date(Date.now() + 60_000).toISOString());
    assert.ok(store.acceptWorkspaceInvitation(workspace.id, betaSession, beta.user.id, beta.user.email));
    const note = store.addTenantMemory(alpha.tenant.id, alpha.user.id, 'Use Mandarin and China Standard Time.');
    const shared = store.addTenantMemory(workspace.id, alpha.user.id, 'The team review happens on Thursday.');
    const betaShared = store.addTenantMemory(workspace.id, beta.user.id, 'Beta added a team note.');
    assert.equal(store.tenantMemories(alpha.tenant.id).length, 1);
    assert.equal(store.tenantMemories(beta.tenant.id).length, 0);
    assert.equal(store.tenantMemories(workspace.id).length, 2);
    assert.equal(store.updateTenantMemory(beta.tenant.id, note.id, beta.user.id, 'Try to cross tenant'), null);
    assert.equal(store.deleteTenantMemory(beta.tenant.id, note.id, beta.user.id), false);
    assert.equal(store.updateTenantMemory(workspace.id, shared.id, beta.user.id, 'Unauthorized edit'), 'forbidden');
    assert.equal(store.deleteTenantMemory(workspace.id, shared.id, beta.user.id), 'forbidden');
    const adminUpdated = store.updateTenantMemory(workspace.id, betaShared.id, alpha.user.id, 'The owner can maintain team notes.');
    assert.equal(adminUpdated && adminUpdated !== 'forbidden' ? adminUpdated.note : null, 'The owner can maintain team notes.');
    assert.throws(() => store.addTenantMemory(alpha.tenant.id, alpha.user.id, '   '), /Invalid memory note/);
    assert.throws(() => store.addTenantMemory(alpha.tenant.id, alpha.user.id, 'x'.repeat(1001)), /Invalid memory note/);
    for (let index = 0; index < 19; index++) store.addTenantMemory(alpha.tenant.id, alpha.user.id, `Memory ${index + 2}`);
    assert.throws(() => store.addTenantMemory(alpha.tenant.id, alpha.user.id, 'Memory 21'), /最多保存 20 条/);
    assert.equal(store.tenantMemories(alpha.tenant.id).length, 20);
    const updated = store.updateTenantMemory(workspace.id, shared.id, alpha.user.id, 'The team review happens Friday.');
    assert.equal(updated && updated !== 'forbidden' ? updated.note : null, 'The team review happens Friday.');
    store.close();
    store = new Store(directory);
    assert.equal(store.tenantMemories(alpha.tenant.id).find(memory => memory.id === note.id)?.note, 'Use Mandarin and China Standard Time.');
    assert.equal(store.tenantMemories(workspace.id).find(memory => memory.id === shared.id)?.note, 'The team review happens Friday.');
    assert.equal(store.deleteTenantMemory(workspace.id, shared.id, alpha.user.id), true);
    assert.equal(store.tenantMemories(workspace.id).length, 1);
    assert.equal(store.tenantMemories(workspace.id)[0]?.note, 'The owner can maintain team notes.');
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Scratchpad pages persist per tenant and an agent task reuses its page on later runs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-pages-'));
  try {
    let store = new Store(directory);
    const alpha = store.signInGoogle({ subject: 'pages-alpha', email: 'pages-alpha@example.test', name: 'Pages Alpha' });
    const beta = store.signInGoogle({ subject: 'pages-beta', email: 'pages-beta@example.test', name: 'Pages Beta' });
    const task = store.createTask('Create project notes', null, 'model', alpha.tenant.id);
    const page = store.createTenantPage(alpha.tenant.id, 'Project notes', '# Plan\n- First step', null, task.id);
    const nextRunPage = store.createTenantPage(alpha.tenant.id, 'Project notes', '# Updated plan\n- Keep the review on Friday', null, task.id);
    assert.equal(nextRunPage.id, page.id, 'A repeated run duplicated the page created by its task');
    assert.equal(store.tenantPages(alpha.tenant.id).length, 1);
    assert.equal(store.tenantPage(beta.tenant.id, page.id), null);
    assert.equal(store.updateTenantPage(beta.tenant.id, page.id, 'Cross tenant', 'Must not update'), null);
    const personalPage = store.createTenantPage(beta.tenant.id, 'Beta notes', 'Private to Beta', beta.user.id);
    assert.equal(personalPage.createdByName, 'Pages Beta');
    assert.equal(store.tenantPages(beta.tenant.id).length, 1);
    assert.throws(() => store.createTenantPage(alpha.tenant.id, ' '.repeat(3), 'body'), /页面标题/);
    assert.throws(() => store.updateTenantPage(alpha.tenant.id, page.id, 'Title', 'x'.repeat(24001)), /正文/);

    store.close(); store = new Store(directory);
    const recovered = store.tenantPage(alpha.tenant.id, page.id);
    assert.equal(recovered?.title, 'Project notes');
    assert.match(recovered?.content || '', /Updated plan/);
    assert.equal(recovered?.sourceTaskId, task.id);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('background worker stores real model result and schedules a future run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-'));
  let receivedPrompt = '';
  const modelServer = createServer(async (req, res) => {
    assert.equal(req.url, '/chat/completions');
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const payload = JSON.parse(raw) as { messages?: { role: string; content: string }[] };
    receivedPrompt = payload.messages?.find(message => message.role === 'user')?.content || '';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'done', message: 'Checked the supplied information.' }) } }] }));
  });
  await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  const address = modelServer.address();
  assert.ok(address && typeof address !== 'string');
  process.env.DOTS_MODEL_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.DOTS_MODEL = 'test-model';
  process.env.DOTS_MODEL_API_KEY = 'test-key';
  const store = new Store(directory);
  const user = store.signInGoogle({ subject: 'worker-memory', email: 'worker-memory@example.test', name: 'Worker Memory' });
  store.addTenantMemory(user.tenant.id, user.user.id, 'Use short Mandarin summaries.');
  const task = store.createTask('Check supplied information', 60);
  store.setSetting('desktopNotifications', 'true');
  const notifications: { title: string; body: string }[] = [];
  const worker = new Worker(store, () => {}, undefined, (title, body) => notifications.push({ title, body }));
  try {
    worker.start();
    await waitFor(() => store.getTask(task.id)?.status === 'scheduled');
    const completed = store.getTask(task.id)!;
    assert.equal(completed.result, 'Checked the supplied information.');
    assert.match(receivedPrompt, /User-approved workspace notes[\s\S]*1\. Use short Mandarin summaries\./, 'The worker failed to include the current tenant\'s approved memory');
    assert.ok(completed.nextRunAt && completed.nextRunAt > new Date().toISOString());
    assert.ok(store.snapshot(true).entries.some(e => e.taskId === task.id && e.kind === 'dot'));
    assert.deepEqual(notifications, [{ title: 'Dot', body: '“Check supplied information”已有新结果。' }]);
  } finally {
    worker.stop(); store.close();
    await new Promise<void>(resolve => modelServer.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
    delete process.env.DOTS_MODEL_BASE_URL;
    delete process.env.DOTS_MODEL;
    delete process.env.DOTS_MODEL_API_KEY;
  }
});

test('background worker persists the next daily occurrence in the selected time zone', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-calendar-worker-'));
  const modelServer = createServer(async (_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'done', message: 'Daily check completed.' }) } }] }));
  });
  await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  const address = modelServer.address();
  assert.ok(address && typeof address !== 'string');
  process.env.DOTS_MODEL_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.DOTS_MODEL = 'test-model';
  process.env.DOTS_MODEL_API_KEY = 'test-key';
  let store = new Store(directory);
  const scheduleSpec = { frequency: 'daily' as const, time: '23:59', timeZone: 'Asia/Shanghai', endDate: null };
  const task = store.createTask('Run the daily check', null, 'model', 'legacy', scheduleSpec, new Date(Date.now() - 1_000).toISOString());
  const worker = new Worker(store, () => {});
  try {
    worker.start();
    await waitFor(() => store.getTask(task.id)?.status === 'scheduled');
    const completed = store.getTask(task.id)!;
    assert.equal(completed.result, 'Daily check completed.');
    assert.ok(completed.nextRunAt && Date.parse(completed.nextRunAt) > Date.now());
    const localTime = new Intl.DateTimeFormat('en-GB', { timeZone: scheduleSpec.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(completed.nextRunAt!));
    assert.equal(localTime, scheduleSpec.time);
    worker.stop();
    store.close();
    store = new Store(directory);
    const recovered = store.getTask(task.id)!;
    assert.deepEqual(recovered.scheduleSpec, scheduleSpec);
    assert.equal(recovered.nextRunAt, completed.nextRunAt);
  } finally {
    worker.stop(); store.close();
    await new Promise<void>(resolve => modelServer.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
    delete process.env.DOTS_MODEL_BASE_URL;
    delete process.env.DOTS_MODEL;
    delete process.env.DOTS_MODEL_API_KEY;
  }
});

async function waitFor(predicate: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for worker');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
