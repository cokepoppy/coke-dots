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
    const executionId = task.nextRunAt;
    store.setProfile('Alfred', 'triangle', '#aabbcc');
    store.updateTask(task.id, { instruction: 'Track the updated design review', priority: 2, status: 'working' });
    store.close();
    store = new Store(directory);
    assert.equal(store.getTask(task.id)?.status, 'queued');
    assert.equal(store.getTask(task.id)?.nextRunAt, executionId, 'Restart recovery must preserve the scheduled execution identity for idempotent cloud dispatch');
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
    store.setProfile('dot', 'triangle', '#f18ac0', alpha.tenant.id, 'classic', 'none', 'none', 'triangle', 'moss', true);
    const setupAt = store.getProfile(alpha.tenant.id).avatarSetupCompletedAt;
    assert(setupAt, 'Saving the first-run appearance editor should persist its own stage');
    assert.equal(store.getProfile(alpha.tenant.id).onboardingCompletedAt, null, 'The first appearance editor must not finish the later conversation stage');
    assert.deepEqual({ ...store.getProfile(alpha.tenant.id) }, { name: 'dot', shape: 'triangle', color: '#f18ac0', eyes: 'classic', glasses: 'none', accessory: 'none', character: 'triangle', pet: 'moss', avatarSetupCompletedAt: setupAt, onboardingCompletedAt: null, onboardingCompletedName: null });
    assert.deepEqual({ ...store.getProfile(beta.tenant.id) }, { name: 'Dot', shape: 'circle', color: '#c8cbd5', eyes: 'dot', glasses: 'none', accessory: 'none', character: 'ring', pet: 'moss', avatarSetupCompletedAt: null, onboardingCompletedAt: null, onboardingCompletedName: null });
    store.setProfile('Roger', 'heart', '#f58e70', alpha.tenant.id, 'sparkle', 'round', 'crown', 'blue', 'moss', false, true);
    const completedAt = store.getProfile(alpha.tenant.id).onboardingCompletedAt;
    assert(completedAt, 'Saving the advanced customizer should persist completion of the expanded onboarding transcript');
    assert.deepEqual({ ...store.getProfile(alpha.tenant.id) }, { name: 'Roger', shape: 'heart', color: '#f58e70', eyes: 'sparkle', glasses: 'round', accessory: 'crown', character: 'blue', pet: 'moss', avatarSetupCompletedAt: setupAt, onboardingCompletedAt: completedAt, onboardingCompletedName: 'Roger' });
    assert.deepEqual({ ...store.getProfile(beta.tenant.id) }, { name: 'Dot', shape: 'circle', color: '#c8cbd5', eyes: 'dot', glasses: 'none', accessory: 'none', character: 'ring', pet: 'moss', avatarSetupCompletedAt: null, onboardingCompletedAt: null, onboardingCompletedName: null });
    store.close();

    store = new Store(directory);
    assert.deepEqual({ ...store.getProfile(alpha.tenant.id) }, { name: 'Roger', shape: 'heart', color: '#f58e70', eyes: 'sparkle', glasses: 'round', accessory: 'crown', character: 'blue', pet: 'moss', avatarSetupCompletedAt: setupAt, onboardingCompletedAt: completedAt, onboardingCompletedName: 'Roger' });
    assert.deepEqual({ ...store.getProfile(beta.tenant.id) }, { name: 'Dot', shape: 'circle', color: '#c8cbd5', eyes: 'dot', glasses: 'none', accessory: 'none', character: 'ring', pet: 'moss', avatarSetupCompletedAt: null, onboardingCompletedAt: null, onboardingCompletedName: null });
    store.setProfile('Dolly', 'heart', '#f58e70', alpha.tenant.id, 'sparkle', 'round', 'crown', 'blue', 'moss');
    assert.equal(store.getProfile(alpha.tenant.id).onboardingCompletedName, 'Roger', 'The first-run acknowledgement keeps the name saved during setup if the profile is renamed later');
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('profile migration preserves already-completed customization as the earlier setup stage', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-profile-migration-'));
  try {
    const database = new DatabaseSync(join(directory, 'dots.db'));
    database.exec(`
      CREATE TABLE tenants(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,created_at TEXT NOT NULL);
      INSERT INTO tenants VALUES('legacy','Personal workspace','personal','2026-01-01T00:00:00.000Z');
      CREATE TABLE tenant_profiles(
        tenant_id TEXT PRIMARY KEY REFERENCES tenants(id), name TEXT NOT NULL, shape TEXT NOT NULL, color TEXT NOT NULL,
        eyes TEXT NOT NULL DEFAULT 'classic', glasses TEXT NOT NULL DEFAULT 'none', accessory TEXT NOT NULL DEFAULT 'none',
        character TEXT NOT NULL DEFAULT 'custom', pet TEXT NOT NULL DEFAULT 'moss', onboarding_completed_at TEXT, onboarding_completed_name TEXT
      );
      INSERT INTO tenant_profiles(tenant_id,name,shape,color,eyes,character,pet,onboarding_completed_at,onboarding_completed_name)
      VALUES('legacy','Roger','scallop','#f58e70','wide','custom','moss','2026-02-01T12:00:00.000Z','Roger');
    `);
    database.close();
    const store = new Store(directory);
    const profile = store.getProfile('legacy');
    assert.equal(profile.avatarSetupCompletedAt, profile.onboardingCompletedAt);
    assert.equal(profile.onboardingCompletedName, 'Roger');
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

test('reasoning-effort preference and task selection persist separately per workspace', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-reasoning-effort-'));
  let store = new Store(directory);
  try {
    const alpha = store.signInGoogle({ subject: 'reasoning-alpha', email: 'reasoning-alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'reasoning-beta', email: 'reasoning-beta@example.test', name: 'Beta' });
    assert.equal(store.snapshot(false, [], undefined, alpha.tenant.id).preferences.reasoningEffort, 'high');
    store.setSetting('reasoningEffort', 'xhigh', alpha.tenant.id);
    const task = store.createTask('Use the extra reasoning level', null, 'model', alpha.tenant.id, null, null, [], '', 'standard', 'xhigh');
    assert.equal(task.reasoningEffort, 'xhigh');
    assert.equal(store.snapshot(false, [], undefined, alpha.tenant.id).preferences.reasoningEffort, 'xhigh');
    assert.equal(store.snapshot(false, [], undefined, beta.tenant.id).preferences.reasoningEffort, 'high', 'A different workspace inherited the Alpha preference');
    store.close();

    store = new Store(directory);
    assert.equal(store.getTask(task.id, alpha.tenant.id)?.reasoningEffort, 'xhigh', 'The selected effort did not survive reopening the database');
    assert.equal(store.snapshot(false, [], undefined, alpha.tenant.id).preferences.reasoningEffort, 'xhigh');
    assert.equal(store.snapshot(false, [], undefined, beta.tenant.id).preferences.reasoningEffort, 'high');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('delegated tasks persist, recover after restart, and aggregate only inside their tenant', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-delegation-'));
  try {
    let store = new Store(directory);
    const owner = store.signInGoogle({ subject: 'delegation-owner', email: 'delegate@example.test', name: 'Delegate' });
    const other = store.signInGoogle({ subject: 'delegation-other', email: 'other@example.test', name: 'Other' });
    const parent = store.createTask('Prepare a research brief', null, 'model', owner.tenant.id, null, null, [], '', 'standard', 'xhigh');
    store.updateTask(parent.id, { status: 'working' }, owner.tenant.id);
    const children = store.createDelegatedTasks(parent.id, owner.tenant.id, [
      { title: 'Market sizing', instruction: 'Estimate market size from supplied material.' },
      { title: 'Competitor review', instruction: 'Compare the named competitors.', engine: 'pi' },
      { title: 'Risk list', instruction: 'Identify the main risks.' },
    ], 'I split the research into three parallel questions.');
    assert.deepEqual(children.map(task => task.engine), ['model', 'pi', 'model'], 'Children must retain a selected engine or inherit the parent engine');
    assert.deepEqual(children.map(task => task.reasoningEffort), ['xhigh', 'xhigh', 'xhigh'], 'Delegated work must inherit the parent reasoning selection');
    assert.throws(() => store.createDelegatedTasks(parent.id, owner.tenant.id, [{ title: 'Invalid engine', instruction: 'Do not insert this task.', engine: 'unknown' as never }], 'Invalid engine test'), /内核无效/);
    assert.throws(() => store.createDelegatedTasks(parent.id, owner.tenant.id, [{ title: 'Unsupported engine', instruction: 'Do not insert this task.', engine: 'claude' }], 'Unsupported engine test'), /内核无效/);
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

test('text attachments persist with tasks and are isolated by tenant and uploader', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-attachments-'));
  try {
    let store = new Store(directory);
    const alpha = store.signInGoogle({ subject: 'attachment-alpha', email: 'attachment-alpha@example.test', name: 'Attachment Alpha' });
    const beta = store.signInGoogle({ subject: 'attachment-beta', email: 'attachment-beta@example.test', name: 'Attachment Beta' });
    const workspace = store.createWorkspace(alpha.user.id, 'Attachment Team');
    const invitation = store.addWorkspaceMember(workspace.id, alpha.user.id, beta.user.email, 'member');
    assert.equal(invitation.ok, true);
    if (!invitation.ok || invitation.kind !== 'invitation') throw new Error('Expected an attachment workspace invitation');
    const betaSession = 'attachment-beta-workspace-session';
    store.createSession(betaSession, beta.user.id, beta.tenant.id, new Date(Date.now() + 60_000).toISOString());
    assert.ok(store.acceptWorkspaceInvitation(workspace.id, betaSession, beta.user.id, beta.user.email));

    const content = new TextEncoder().encode('Quarterly plan: review supplier risk before Friday.');
    const attachment = store.addPendingAttachment(workspace.id, alpha.user.id, 'plan.md', 'text/markdown', content);
    assert.deepEqual(store.pendingAttachments(workspace.id, alpha.user.id).map(item => ({ ...item })), [attachment]);
    assert.deepEqual(store.pendingAttachments(workspace.id, beta.user.id), [], 'A workspace member must not see another user’s unsent uploads');
    assert.deepEqual(store.pendingAttachments(beta.tenant.id, alpha.user.id), [], 'A different tenant must not see the pending upload');
    assert.equal(store.deletePendingAttachment(workspace.id, beta.user.id, attachment.id), false);
    assert.throws(() => store.createTask('Review the attached plan', null, 'model', workspace.id, null, null, [attachment.id], beta.user.id), /不属于当前工作区/);

    const task = store.createTask('Review the attached plan', null, 'model', workspace.id, null, null, [attachment.id], alpha.user.id);
    assert.deepEqual(store.pendingAttachments(workspace.id, alpha.user.id), [], 'Task-bound files must leave the pending queue');
    assert.equal(new TextDecoder().decode(store.taskAttachments(task.id, workspace.id)[0]?.content), 'Quarterly plan: review supplier risk before Friday.');
    const alphaSnapshot = store.snapshot(false, [], undefined, workspace.id);
    assert.deepEqual(alphaSnapshot.entries.find(entry => entry.taskId === task.id && entry.kind === 'user')?.attachments?.map(item => ({ ...item })), [attachment]);
    assert.equal(store.taskAttachments(task.id, beta.tenant.id).length, 0, 'A different tenant must not retrieve the task file');

    store.close(); store = new Store(directory);
    assert.deepEqual(store.snapshot(false, [], undefined, workspace.id).entries.find(entry => entry.taskId === task.id && entry.kind === 'user')?.attachments?.map(item => ({ ...item })), [attachment]);
    assert.equal(new TextDecoder().decode(store.taskAttachments(task.id, workspace.id)[0]?.content), 'Quarterly plan: review supplier risk before Friday.');
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

test('private Dot notes auto-update only for the personal tenant owner and survive a database reopen', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-personal-memory-'));
  try {
    let store = new Store(directory);
    const alpha = store.signInGoogle({ subject: 'dot-memory-alpha', email: 'dot-memory-alpha@example.test', name: 'Dot Memory Alpha' });
    const beta = store.signInGoogle({ subject: 'dot-memory-beta', email: 'dot-memory-beta@example.test', name: 'Dot Memory Beta' });
    const shared = store.createWorkspace(alpha.user.id, 'Private-memory boundary');
    const context = store.personalDotMemoryContext(alpha.tenant.id);
    assert.equal(context?.userId, alpha.user.id);
    assert.deepEqual(context?.memories, []);
    assert.equal(store.personalDotMemoryContext(shared.id), null, 'Shared workspaces must never receive private Dot notes');

    const task = store.createTask('Remember my response preference', null, 'model', alpha.tenant.id);
    store.updateTask(task.id, { status: 'working' }, alpha.tenant.id);
    const created = store.applyPersonalDotMemoryUpdates(alpha.tenant.id, task.id, [
      { action: 'remember', note: 'Prefers brief Mandarin updates.' },
    ]);
    assert.equal(created.length, 1);
    assert.equal(created[0]?.action, 'remember');
    assert.equal(store.personalDotMemories(alpha.user.id)[0]?.note, 'Prefers brief Mandarin updates.');
    assert.deepEqual(store.personalDotMemories(beta.user.id), [], 'Another Google account must not read this note');
    assert.equal(store.updatePersonalDotMemory(beta.user.id, created[0]!.id, 'Cross-account edit'), null);
    assert.equal(store.deletePersonalDotMemory(beta.user.id, created[0]!.id), false);

    const sharedTask = store.createTask('Check workspace task boundary', null, 'model', shared.id);
    store.updateTask(sharedTask.id, { status: 'working' }, shared.id);
    assert.deepEqual(store.applyPersonalDotMemoryUpdates(shared.id, sharedTask.id, [
      { action: 'remember', note: 'This cannot enter personal memory.' },
    ]), []);

    const updateTask = store.createTask('Correct my preference', null, 'model', alpha.tenant.id);
    store.updateTask(updateTask.id, { status: 'working' }, alpha.tenant.id);
    const updated = store.applyPersonalDotMemoryUpdates(alpha.tenant.id, updateTask.id, [
      { action: 'update', memoryId: created[0]!.id, note: 'Prefers concise Mandarin updates.' },
    ]);
    assert.deepEqual(updated.map(change => change.action), ['update']);
    assert.equal(store.personalDotMemories(alpha.user.id)[0]?.note, 'Prefers concise Mandarin updates.');
    assert.deepEqual(store.applyPersonalDotMemoryUpdates(alpha.tenant.id, updateTask.id, [
      { action: 'remember', note: 'Prefers concise Mandarin updates.' },
    ]), [], 'Equivalent notes must not be duplicated');

    store.close(); store = new Store(directory);
    assert.equal(store.personalDotMemories(alpha.user.id)[0]?.note, 'Prefers concise Mandarin updates.');
    assert.equal(store.personalDotMemoryContext(beta.tenant.id)?.memories.length, 0);
    assert.equal(store.deletePersonalDotMemory(alpha.user.id, created[0]!.id), true);
    assert.deepEqual(store.personalDotMemories(alpha.user.id), []);
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
  let receivedReasoningEffort = '';
  const modelServer = createServer(async (req, res) => {
    assert.equal(req.url, '/chat/completions');
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const payload = JSON.parse(raw) as { messages?: { role: string; content: string }[]; reasoning_effort?: string };
    receivedPrompt = payload.messages?.find(message => message.role === 'user')?.content || '';
    receivedReasoningEffort = payload.reasoning_effort || '';
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
  const task = store.createTask('Check supplied information', 60, 'model', 'legacy', null, null, [], '', 'standard', 'xhigh');
  store.setSetting('desktopNotifications', 'true');
  const notifications: { title: string; body: string }[] = [];
  const worker = new Worker(store, () => {}, undefined, (title, body) => notifications.push({ title, body }));
  try {
    worker.start();
    await waitFor(() => store.getTask(task.id)?.status === 'scheduled');
    const completed = store.getTask(task.id)!;
    assert.equal(completed.result, 'Checked the supplied information.');
    assert.equal(receivedReasoningEffort, 'xhigh', 'The worker did not send the task-specific reasoning selection to the model');
    assert.match(receivedPrompt, /User-approved workspace notes[\s\S]*1\. Use short Mandarin summaries\./, 'The worker failed to include the current tenant\'s approved memory');
    assert.match(receivedPrompt, /When the user asks for automation ideas, keep them as inactive proposals and choose done; do not schedule them unless the user chooses an idea and asks to set it up with its sources, timing, and review requirements\./, 'The model prompt must keep automation brainstorming separate from active schedules');
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

test('routine notification preferences never hide work that needs a user reply', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-notification-criteria-'));
  const envKeys = ['NODE_ENV', 'DOTS_E2E_AUTH', 'DOTS_MODEL_BASE_URL', 'DOTS_MODEL', 'DOTS_MODEL_API_KEY'] as const;
  const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  const modelServer = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(raw) as { messages?: { role: string; content: string }[] };
      const prompt = payload.messages?.find(message => message.role === 'user')?.content || '';
      const needsReply = prompt.includes('E2E notification criteria — ask the user');
      const decision = needsReply
        ? { status: 'waiting', message: 'Should I continue or pause?', notifyUser: false }
        : { status: 'done', message: 'Routine check completed.', notifyUser: false };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }));
    });
  });
  await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  const address = modelServer.address();
  assert.ok(address && typeof address !== 'string');
  process.env.NODE_ENV = 'test'; process.env.DOTS_E2E_AUTH = '1';
  process.env.DOTS_MODEL_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.DOTS_MODEL = 'test-model'; process.env.DOTS_MODEL_API_KEY = 'local-test-key';
  const store = new Store(directory);
  const user = store.signInGoogle({ subject: 'notification-criteria', email: 'notification-criteria@example.test', name: 'Notification Criteria' });
  store.setSetting('desktopNotifications', 'true', user.tenant.id);
  store.setSetting('modelBaseUrl', `http://127.0.0.1:${address.port}`, user.tenant.id);
  store.setSetting('modelName', 'test-model', user.tenant.id);
  const quietTask = store.createTask('E2E notification criteria — routine success', null, 'model', user.tenant.id);
  const replyTask = store.createTask('E2E notification criteria — ask the user', null, 'model', user.tenant.id);
  const notifications: { title: string; body: string }[] = [];
  const worker = new Worker(store, () => {}, undefined, (title, body) => notifications.push({ title, body }));
  try {
    worker.start();
    await waitFor(() => ['done', 'waiting'].includes(store.getTask(quietTask.id, user.tenant.id)?.status || '')
      && ['done', 'waiting'].includes(store.getTask(replyTask.id, user.tenant.id)?.status || ''));
    const quietResult = store.getTask(quietTask.id, user.tenant.id);
    const replyResult = store.getTask(replyTask.id, user.tenant.id);
    assert.equal(quietResult?.status, 'done');
    assert.equal(quietResult?.result, 'Routine check completed.');
    assert.equal(replyResult?.status, 'waiting');
    assert.equal(replyResult?.result, null);
    assert.deepEqual(notifications, [{ title: 'Dot', body: '“E2E notification criteria — ask the user”正在等待你的回复。' }], 'A conditional quiet preference may suppress routine success, but not a required user reply');
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

test('Dot pause is tenant scoped, durable, and resumes only work interrupted by that pause', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-global-pause-'));
  let store = new Store(directory);
  try {
    const alpha = store.signInGoogle({ subject: 'dot-pause-alpha', email: 'dot-pause-alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'dot-pause-beta', email: 'dot-pause-beta@example.test', name: 'Beta' });
    const active = store.createTask('Interrupted Alpha task', null, 'model', alpha.tenant.id);
    const queued = store.createTask('Queued Alpha task', null, 'model', alpha.tenant.id);
    const recurring = store.createTask('Recurring Alpha task', null, 'model', alpha.tenant.id, { frequency: 'daily', time: '09:00', timeZone: 'Asia/Shanghai', endDate: null });
    const otherTenant = store.createTask('Beta task', null, 'model', beta.tenant.id);
    const activeRunAt = active.nextRunAt;
    store.updateTask(active.id, { status: 'working' }, alpha.tenant.id);
    store.updateTask(recurring.id, { status: 'working' }, alpha.tenant.id);
    store.updateTask(otherTenant.id, { status: 'working' }, beta.tenant.id);

    assert.deepEqual(store.pauseDot(alpha.tenant.id, [active.id, recurring.id, otherTenant.id]), [active.id, recurring.id]);
    assert.equal(store.isDotPaused(alpha.tenant.id), true);
    assert.equal(store.isDotPaused(beta.tenant.id), false);
    assert.equal(store.snapshot(false, [], undefined, alpha.tenant.id).dotPaused, true);
    assert.equal(store.getTask(active.id, alpha.tenant.id)?.status, 'paused');
    assert.equal(store.getTask(queued.id, alpha.tenant.id)?.status, 'queued', 'Queued work stays queued while the workspace is paused');
    assert.equal(store.getTask(recurring.id, alpha.tenant.id)?.status, 'paused');
    assert.equal(store.getTask(otherTenant.id, beta.tenant.id)?.status, 'working', 'Pausing Alpha did not change Beta task state');
    assert.deepEqual(store.pauseDot(alpha.tenant.id, [otherTenant.id]), [], 'Repeated pause is idempotent');

    store.close();
    store = new Store(directory);
    assert.equal(store.isDotPaused(alpha.tenant.id), true, 'Dot pause survives service restart');
    assert.equal(store.getTask(active.id, alpha.tenant.id)?.status, 'paused');
    const resumed = store.resumeDot(alpha.tenant.id);
    assert.deepEqual(new Set(resumed), new Set([active.id, recurring.id]));
    assert.equal(store.isDotPaused(alpha.tenant.id), false);
    assert.equal(store.getTask(active.id, alpha.tenant.id)?.status, 'queued');
    assert.equal(store.getTask(active.id, alpha.tenant.id)?.nextRunAt, activeRunAt);
    assert.equal(store.getTask(recurring.id, alpha.tenant.id)?.status, 'scheduled', 'Interrupted recurring work returns to Scheduled');
    assert.equal(store.getTask(queued.id, alpha.tenant.id)?.status, 'queued');
    assert.equal(store.getTask(otherTenant.id, beta.tenant.id)?.status, 'queued', 'Restart recovery remains isolated from the pause record');
    assert.deepEqual(store.resumeDot(alpha.tenant.id), [], 'Resume is idempotent');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('paused workspace holds due tasks while an unpaused tenant continues', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-worker-pause-'));
  const envKeys = ['NODE_ENV', 'DOTS_E2E_AUTH', 'DOTS_MODEL_BASE_URL', 'DOTS_MODEL', 'DOTS_MODEL_API_KEY'] as const;
  const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  const prompts: string[] = [];
  const modelServer = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(raw) as { messages?: { role: string; content: string }[] };
      prompts.push(payload.messages?.find(message => message.role === 'user')?.content || '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ status: 'done', message: 'Tenant task completed.' }) } }] }));
    });
  });
  await new Promise<void>(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  const address = modelServer.address();
  assert.ok(address && typeof address !== 'string');
  process.env.NODE_ENV = 'test'; process.env.DOTS_E2E_AUTH = '1';
  process.env.DOTS_MODEL_BASE_URL = `http://127.0.0.1:${address.port}`; process.env.DOTS_MODEL = 'test-model'; process.env.DOTS_MODEL_API_KEY = 'local-test-key';
  const store = new Store(directory);
  const alpha = store.signInGoogle({ subject: 'dot-pause-worker-alpha', email: 'dot-pause-worker-alpha@example.test', name: 'Alpha' });
  const beta = store.signInGoogle({ subject: 'dot-pause-worker-beta', email: 'dot-pause-worker-beta@example.test', name: 'Beta' });
  store.setSetting('dotPaused', 'true', alpha.tenant.id);
  store.setSetting('modelBaseUrl', `http://127.0.0.1:${address.port}`, alpha.tenant.id);
  store.setSetting('modelName', 'test-model', alpha.tenant.id);
  store.setSetting('modelBaseUrl', `http://127.0.0.1:${address.port}`, beta.tenant.id);
  store.setSetting('modelName', 'test-model', beta.tenant.id);
  const alphaTask = store.createTask('Paused Alpha must wait', null, 'model', alpha.tenant.id);
  const betaTask = store.createTask('Unpaused Beta continues', null, 'model', beta.tenant.id);
  const worker = new Worker(store, () => {});
  try {
    worker.start();
    await waitFor(() => store.getTask(betaTask.id, beta.tenant.id)?.status === 'done');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(store.getTask(alphaTask.id, alpha.tenant.id)?.status, 'queued');
    assert.equal(prompts.some(prompt => prompt.includes('Paused Alpha must wait')), false, 'Paused tenant work reached the model');
    assert.equal(prompts.filter(prompt => prompt.includes('Unpaused Beta continues')).length, 1);

    worker.resumeWorkspace(alpha.tenant.id);
    await worker.tick();
    await waitFor(() => store.getTask(alphaTask.id, alpha.tenant.id)?.status === 'done');
    assert.equal(prompts.filter(prompt => prompt.includes('Paused Alpha must wait')).length, 1, 'The queued task did not run exactly once after resume');
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

async function waitFor(predicate: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for worker');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
