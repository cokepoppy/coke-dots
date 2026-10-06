import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
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

test('dot appearance is durable and isolated to its tenant', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-appearance-'));
  try {
    let store = new Store(directory);
    const alpha = store.signInGoogle({ subject: 'appearance-alpha', email: 'appearance-alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'appearance-beta', email: 'appearance-beta@example.test', name: 'Beta' });
    store.setProfile('Roger', 'heart', '#f58e70', alpha.tenant.id, 'sparkle', 'round', 'crown', 'blue', 'moss');
    assert.deepEqual({ ...store.getProfile(alpha.tenant.id) }, { name: 'Roger', shape: 'heart', color: '#f58e70', eyes: 'sparkle', glasses: 'round', accessory: 'crown', character: 'blue', pet: 'moss' });
    assert.deepEqual({ ...store.getProfile(beta.tenant.id) }, { name: 'Dot', shape: 'circle', color: '#c8cbd5', eyes: 'dot', glasses: 'none', accessory: 'none', character: 'ring', pet: 'moss' });
    store.close();

    store = new Store(directory);
    assert.deepEqual({ ...store.getProfile(alpha.tenant.id) }, { name: 'Roger', shape: 'heart', color: '#f58e70', eyes: 'sparkle', glasses: 'round', accessory: 'crown', character: 'blue', pet: 'moss' });
    assert.deepEqual({ ...store.getProfile(beta.tenant.id) }, { name: 'Dot', shape: 'circle', color: '#c8cbd5', eyes: 'dot', glasses: 'none', accessory: 'none', character: 'ring', pet: 'moss' });
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('computer access onboarding is durable and isolated to its workspace', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-computer-choice-'));
  try {
    let store = new Store(directory);
    const alpha = store.signInGoogle({ subject: 'computer-choice-alpha', email: 'computer-choice-alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'computer-choice-beta', email: 'computer-choice-beta@example.test', name: 'Beta' });
    assert.deepEqual(store.snapshot(false, [], undefined, alpha.tenant.id).computerAccess, { dotComputer: true, localComputer: true, configured: false });
    store.setSetting('localComputerEnabled', 'false', alpha.tenant.id);
    store.setSetting('computerChoiceConfigured', 'true', alpha.tenant.id);
    assert.deepEqual(store.snapshot(false, [], undefined, alpha.tenant.id).computerAccess, { dotComputer: true, localComputer: false, configured: true });
    assert.deepEqual(store.snapshot(false, [], undefined, beta.tenant.id).computerAccess, { dotComputer: true, localComputer: true, configured: false });
    store.close();

    store = new Store(directory);
    assert.deepEqual(store.snapshot(false, [], undefined, alpha.tenant.id).computerAccess, { dotComputer: true, localComputer: false, configured: true });
    assert.deepEqual(store.snapshot(false, [], undefined, beta.tenant.id).computerAccess, { dotComputer: true, localComputer: true, configured: false });
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('delegated tasks persist, recover after restart, and aggregate only inside their tenant', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-delegation-'));
  try {
    let store = new Store(directory);
    const owner = store.signInGoogle({ subject: 'delegation-owner', email: 'delegate@example.test', name: 'Delegate' });
    const other = store.signInGoogle({ subject: 'delegation-other', email: 'other@example.test', name: 'Other' });
    const parent = store.createTask('Prepare a research brief', null, 'model', owner.tenant.id);
    store.updateTask(parent.id, { status: 'working' }, owner.tenant.id);
    const children = store.createDelegatedTasks(parent.id, owner.tenant.id, [
      { title: 'Market sizing', instruction: 'Estimate market size from supplied material.' },
      { title: 'Competitor review', instruction: 'Compare the named competitors.', engine: 'claude' },
      { title: 'Risk list', instruction: 'Identify the main risks.' },
    ], 'I split the research into three parallel questions.');
    assert.deepEqual(children.map(task => task.engine), ['model', 'claude', 'model'], 'Children must retain a selected engine or inherit the parent engine');
    assert.throws(() => store.createDelegatedTasks(parent.id, owner.tenant.id, [{ title: 'Invalid engine', instruction: 'Do not insert this task.', engine: 'unknown' as never }], 'Invalid engine test'), /内核无效/);
    assert.equal(store.getTask(parent.id, owner.tenant.id)?.status, 'delegating');
    assert.equal(store.getTask(children[0].id, other.tenant.id), null, 'A different tenant read a child task by guessing its ID');
    assert.equal(store.delegatedTasks(parent.id, other.tenant.id).length, 0, 'A different tenant saw the parent’s children');
    store.updateTask(children[0].id, { status: 'done', result: 'Market is growing.' }, owner.tenant.id);
    store.updateTask(children[1].id, { status: 'working' }, owner.tenant.id);
    assert.equal(store.releaseReadyDelegations(), 0, 'Parent resumed before every child became terminal');
    store.close();

    store = new Store(directory);
    assert.equal(store.getTask(parent.id, owner.tenant.id)?.status, 'delegating', 'Parent delegation state did not survive restart');
    assert.equal(store.getTask(children[1].id, owner.tenant.id)?.status, 'queued', 'Active child was not safely requeued after restart');
    store.updateTask(children[1].id, { status: 'failed', error: 'Source unavailable.' }, owner.tenant.id);
    const stopped = store.stopTask(children[2].id, owner.tenant.id, owner.user.id);
    assert.equal(stopped?.task.status, 'stopped');
    assert.equal(store.getTask(parent.id, owner.tenant.id)?.status, 'delegating', 'Stopping one child prematurely stopped the parent');
    assert.equal(store.releaseReadyDelegations(), 1, 'Parent did not resume after each child reached a terminal state');
    const resumed = store.getTask(parent.id, owner.tenant.id);
    assert.equal(resumed?.status, 'queued');
    assert.deepEqual(store.delegatedTasks(parent.id, owner.tenant.id).map(task => task.status), ['done', 'failed', 'stopped']);
    assert.equal(store.releaseReadyDelegations(), 0, 'Parent was released more than once');
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

test('tenant action rules are admin managed and page approvals do not write until approved', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-rules-'));
  try {
    const store = new Store(directory);
    const alpha = store.signInGoogle({ subject: 'rules-alpha', email: 'rules-alpha@example.test', name: 'Rules Alpha' });
    const beta = store.signInGoogle({ subject: 'rules-beta', email: 'rules-beta@example.test', name: 'Rules Beta' });
    const workspace = store.createWorkspace(alpha.user.id, 'Rules team');
    const added = store.addWorkspaceMember(workspace.id, alpha.user.id, beta.user.email, 'member');
    assert.equal(added.ok, true);
    if (!added.ok || added.kind !== 'invitation') throw new Error('Expected a pending Beta workspace invitation');
    const betaSession = 'rules-beta-workspace-session';
    store.createSession(betaSession, beta.user.id, beta.tenant.id, new Date(Date.now() + 60_000).toISOString());
    assert.ok(store.acceptWorkspaceInvitation(workspace.id, betaSession, beta.user.id, beta.user.email));
    assert.equal(store.isWorkspaceAdmin(workspace.id, alpha.user.id), true);
    assert.equal(store.isWorkspaceAdmin(workspace.id, beta.user.id), false);
    assert.throws(() => store.saveTenantActionRule(workspace.id, beta.user.id, 'Update release notes', 'ask-before'), /only workspaces owners|管理员/i);
    const rule = store.saveTenantActionRule(workspace.id, alpha.user.id, 'Update release notes', 'ask-before');
    assert.equal(rule.mode, 'ask-before');
    assert.equal(store.tenantActionRule(alpha.tenant.id), null, 'The shared-workspace rule leaked into the owner personal tenant');
    assert.throws(() => store.saveTenantActionRule(workspace.id, alpha.user.id, 'x'.repeat(1001), 'ask-before'), /规则说明/);

    const task = store.createTask('Create a page with release notes', null, 'model', workspace.id);
    store.updateTask(task.id, { status: 'working' }, workspace.id);
    const proposal = { action: 'create' as const, title: 'Release notes', content: '# Draft\n- Publish Friday' };
    const approval = store.requestPageActionApproval(workspace.id, task.id, proposal, 'Prepare the release notes page.', 'done', null);
    assert.equal(approval.status, 'pending');
    assert.equal(store.getTask(task.id, workspace.id)?.status, 'waiting');
    assert.equal(store.tenantPages(workspace.id).length, 0, 'A page was written before approval');
    assert.equal(store.pageActionApproval(alpha.tenant.id, task.id), null, 'Another tenant retrieved a pending approval');
    assert.equal(store.resolvePageActionApproval(alpha.tenant.id, task.id, alpha.user.id, 'approve'), null, 'A different tenant resolved an approval by guessing its task ID');

    const resolved = store.resolvePageActionApproval(workspace.id, task.id, beta.user.id, 'approve');
    assert.equal(resolved?.approval.status, 'approved');
    assert.equal(resolved?.page?.title, 'Release notes');
    assert.equal(store.getTask(task.id, workspace.id)?.status, 'done');
    assert.equal(store.tenantPages(workspace.id)[0]?.content, '# Draft\n- Publish Friday');
    assert.ok(store.snapshot(false, [], { baseUrl: '', model: '', hasKey: false }, workspace.id).entries.some(entry => entry.taskId === task.id && /批准/.test(entry.body)));

    const declinedTask = store.createTask('Create an unapproved page', null, 'model', workspace.id);
    store.updateTask(declinedTask.id, { status: 'working' }, workspace.id);
    store.requestPageActionApproval(workspace.id, declinedTask.id, { ...proposal, title: 'Never saved' }, 'Proposed page.', 'done', null);
    const declined = store.resolvePageActionApproval(workspace.id, declinedTask.id, alpha.user.id, 'decline');
    assert.equal(declined?.approval.status, 'declined');
    assert.equal(declined?.page, null);
    assert.equal(store.tenantPage(workspace.id, declinedTask.id), null);
    assert.equal(store.tenantPages(workspace.id).length, 1, 'Declining the proposed write created page data');
    assert.equal(store.deleteTenantActionRule(workspace.id, beta.user.id), 'forbidden');
    assert.equal(store.deleteTenantActionRule(workspace.id, alpha.user.id), true);

    const stoppableTask = store.createTask('Prepare notes and wait for Scratchpad approval', null, 'model', workspace.id);
    store.updateTask(stoppableTask.id, { status: 'working' }, workspace.id);
    store.requestPageActionApproval(workspace.id, stoppableTask.id, { ...proposal, title: 'Cancelled notes' }, 'Proposed page.', 'done', null);
    const stopped = store.stopTask(stoppableTask.id, workspace.id, beta.user.id);
    assert.equal(stopped?.task.status, 'stopped');
    assert.equal(stopped?.cancelledApprovals, 1);
    assert.equal(store.pageActionApproval(workspace.id, stoppableTask.id)?.status, 'cancelled');
    assert.equal(store.resolvePageActionApproval(workspace.id, stoppableTask.id, alpha.user.id, 'approve'), null, 'A stopped task left its Scratchpad proposal actionable');
    assert.equal(store.tenantPages(workspace.id).length, 1, 'Stopping a pending approval wrote a page');
    assert.equal(store.stopTask(stoppableTask.id, alpha.tenant.id, alpha.user.id), null, 'A different tenant stopped a task by guessing its ID');

    const recurringTask = store.createTask('Continue the weekly release review', 60, 'model', workspace.id);
    assert.throws(() => store.stopTask(recurringTask.id, workspace.id, alpha.user.id), /Scheduled/);
    assert.equal(store.getTask(recurringTask.id, workspace.id)?.status, 'queued', 'Task stop removed a recurring schedule outside Scheduled');
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('existing approval tables migrate without losing pending proposals before a task is stopped', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-approval-migration-'));
  try {
    const original = new Store(directory);
    const owner = original.signInGoogle({ subject: 'approval-migration-owner', email: 'approval-migration@example.test', name: 'Migration Owner' });
    const task = original.createTask('Prepare an approval proposal', null, 'model', owner.tenant.id);
    original.updateTask(task.id, { status: 'working' }, owner.tenant.id);
    original.requestPageActionApproval(owner.tenant.id, task.id, { action: 'create', title: 'Migration draft', content: '# Pending' }, 'Review this draft.', 'done', null);
    original.close();

    const db = new DatabaseSync(join(directory, 'dots.db'));
    db.exec(`
      DROP INDEX IF EXISTS page_action_approvals_task;
      DROP INDEX IF EXISTS page_action_approvals_one_pending;
      ALTER TABLE page_action_approvals RENAME TO page_action_approvals_current;
      CREATE TABLE page_action_approvals (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), task_id TEXT NOT NULL REFERENCES tasks(id),
        action_json TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','approved','declined')),
        resume_status TEXT NOT NULL CHECK (resume_status IN ('done','scheduled')), next_run_at TEXT,
        created_at TEXT NOT NULL, decided_at TEXT
      );
      INSERT INTO page_action_approvals(id,tenant_id,task_id,action_json,message,status,resume_status,next_run_at,created_at,decided_at)
        SELECT id,tenant_id,task_id,action_json,message,status,resume_status,next_run_at,created_at,decided_at FROM page_action_approvals_current;
      DROP TABLE page_action_approvals_current;
      CREATE INDEX page_action_approvals_task ON page_action_approvals(tenant_id,task_id,created_at DESC);
      CREATE UNIQUE INDEX page_action_approvals_one_pending ON page_action_approvals(tenant_id,task_id) WHERE status='pending';
    `);
    db.close();

    const migrated = new Store(directory);
    assert.equal(migrated.pageActionApproval(owner.tenant.id, task.id)?.status, 'pending');
    assert.equal(migrated.stopTask(task.id, owner.tenant.id, owner.user.id)?.task.status, 'stopped');
    assert.equal(migrated.pageActionApproval(owner.tenant.id, task.id)?.status, 'cancelled');
    migrated.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Scratchpad write rules enforce no-ask, explicit-request, and hand-off modes in the worker', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-rule-worker-'));
  const envKeys = ['NODE_ENV', 'DOTS_E2E_AUTH', 'DOTS_MODEL_BASE_URL', 'DOTS_MODEL', 'DOTS_MODEL_API_KEY'] as const;
  const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  let requestNumber = 0;
  const modelServer = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(raw) as { messages?: { role: string; content: string }[] };
      const prompt = payload.messages?.find(message => message.role === 'user')?.content || '';
      prompts.push(prompt);
      requestNumber += 1;
      const title = ['Allowed draft', 'Explicit gate draft', 'Hand-off draft'][requestNumber - 1];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'done', message: 'Page change proposal ready.', pageAction: { action: 'create', title, content: `# ${title}` } }) } }] }));
    });
  });
  const prompts: string[] = [];
  await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  const address = modelServer.address();
  assert.ok(address && typeof address !== 'string');
  process.env.NODE_ENV = 'test'; process.env.DOTS_E2E_AUTH = '1';
  process.env.DOTS_MODEL_BASE_URL = `http://127.0.0.1:${address.port}/v1`; process.env.DOTS_MODEL = 'test-model'; process.env.DOTS_MODEL_API_KEY = 'fixture-key';
  const store = new Store(directory);
  const user = store.signInGoogle({ subject: 'rule-worker-user', email: 'rule-worker@example.test', name: 'Rule Worker' });
  const worker = new Worker(store, () => {});
  try {
    worker.start();
    store.saveTenantActionRule(user.tenant.id, user.user.id, 'Prepare useful project notes.', 'without-asking');
    const noAskTask = store.createTask('E2E permission mode one', null, 'model', user.tenant.id);
    void worker.tick();
    await waitFor(() => store.getTask(noAskTask.id, user.tenant.id)?.status === 'done');
    assert.equal(store.tenantPages(user.tenant.id).length, 1, 'The no-ask mode did not perform its supported page write');
    assert.match(prompts[0], /Take the Scratchpad page action without asking again/);

    store.saveTenantActionRule(user.tenant.id, user.user.id, 'Create a page only if directly requested.', 'when-requested');
    const explicitTask = store.createTask('E2E permission mode two', null, 'model', user.tenant.id);
    void worker.tick();
    await waitFor(() => store.getTask(explicitTask.id, user.tenant.id)?.status === 'waiting');
    assert.equal(store.tenantPages(user.tenant.id).length, 1, 'A non-explicit page write bypassed the runtime check');
    assert.match(prompts[1], /only when the user explicitly requests that action/);
    assert.ok(store.snapshot(false, [], { baseUrl: '', model: '', hasKey: false }, user.tenant.id).entries.some(entry => entry.taskId === explicitTask.id && /明确要求/.test(entry.body)));

    store.saveTenantActionRule(user.tenant.id, user.user.id, 'Hand over page changes for manual editing.', 'hand-off');
    const handoffTask = store.createTask('E2E permission mode three', null, 'model', user.tenant.id);
    void worker.tick();
    await waitFor(() => store.getTask(handoffTask.id, user.tenant.id)?.status === 'waiting');
    assert.equal(store.tenantPages(user.tenant.id).length, 1, 'A hand-off rule allowed the agent page write');
    assert.match(prompts[2], /Do not use pageAction/);
    assert.ok(store.snapshot(false, [], { baseUrl: '', model: '', hasKey: false }, user.tenant.id).entries.some(entry => entry.taskId === handoffTask.id && /自行创建/.test(entry.body)));
  } finally {
    worker.stop(); store.close();
    await new Promise<void>(resolve => modelServer.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
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
