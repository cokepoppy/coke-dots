import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';

test('reset deletes one owner’s personal Dot data and retains account and provider setup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-reset-'));
  const store = new Store(directory);
  try {
    const alpha = store.signInGoogle({ subject: 'reset-alpha', email: 'reset-alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'reset-beta', email: 'reset-beta@example.test', name: 'Beta' });
    const personalId = alpha.tenant.id;
    const shared = store.createWorkspace(alpha.user.id, 'Alpha Shared');
    assert.equal(store.addWorkspaceMember(shared.id, alpha.user.id, beta.user.email, 'member').ok, true);

    store.setProfile('Reset Me', 'triangle', '#abcdef', personalId, 'star', 'round', 'hat', 'custom', 'moss', true, true);
    store.setSetting('modelBaseUrl', 'https://api.deepseek.com/v1', personalId);
    store.setSetting('modelName', 'deepseek-chat', personalId);
    store.setSetting('desktopNotifications', 'true', personalId);
    store.setSetting('computerChoiceConfigured', 'true', personalId);
    const future = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
    const scheduled = store.createTask('Review the weekly launch plan', null, 'model', personalId,
      { frequency: 'weekly', weekdays: [1], time: '09:00', timeZone: 'Asia/Shanghai', endDate: null }, future);
    const active = store.createTask('Wait for the page approval', null, 'model', personalId, null, future);
    store.updateTask(active.id, { status: 'working' }, personalId);
    store.requestPageActionApproval(personalId, active.id,
      { action: 'create', title: 'Pending page', content: 'This approval is private to the Dot.' },
      'Review this page first.', 'done', null);
    const signInTask = store.createTask('Wait for website sign-in', null, 'model', personalId, null, future);
    store.updateTask(signInTask.id, { status: 'working' }, personalId);
    store.createWebsiteSignInRequest(personalId, signInTask.id, 'https://accounts.example.test/sign-in', 'Open the account dashboard.');
    const pauseTask = store.createTask('Pause this background task', null, 'model', personalId, null, future);
    store.updateTask(pauseTask.id, { status: 'working' }, personalId);
    assert.deepEqual(store.pauseDot(personalId, [pauseTask.id]), [pauseTask.id]);
    store.createWatch('https://example.test/reset-watch', 60, personalId);
    store.createVoiceCall(personalId, alpha.user.id);
    store.addTenantMemory(personalId, alpha.user.id, 'Private workspace note');
    store.addPersonalDotMemory(alpha.user.id, 'Personal preference to forget');
    store.createTenantPage(personalId, 'Dot page', 'Delete this page on reset.', alpha.user.id);
    store.saveTenantActionRule(personalId, alpha.user.id, 'Ask before writing pages.', 'ask-before');
    const attachment = store.addPendingAttachment(personalId, alpha.user.id, 'brief.txt', 'text/plain', Buffer.from('private file'));
    assert.equal(store.pendingAttachments(personalId, alpha.user.id).some(item => item.id === attachment.id), true);

    const betaTask = store.createTask('Keep Beta personal task', null, 'model', beta.tenant.id, null, future);
    store.addPersonalDotMemory(beta.user.id, 'Beta memory stays');
    const sharedTask = store.createTask('Keep shared task', null, 'model', shared.id, null, future);
    store.addTenantMemory(shared.id, alpha.user.id, 'Shared note stays');

    const sessionHash = 'reset-session-hash';
    store.createSession(sessionHash, alpha.user.id, personalId, new Date(Date.now() + 60_000).toISOString());
    assert.equal(store.personalDotResetEligibility(personalId, alpha.user.id), 'ok');
    assert.equal(store.resetPersonalDot(personalId, alpha.user.id), 'ok');

    const reset = store.snapshot(false, [], undefined, personalId);
    assert.deepEqual(reset.tasks, []);
    assert.deepEqual(reset.watches, []);
    assert.deepEqual(reset.entries, []);
    assert.deepEqual(store.tenantPages(personalId), []);
    assert.deepEqual(store.tenantMemories(personalId), []);
    assert.deepEqual(store.personalDotMemories(alpha.user.id), []);
    assert.deepEqual(store.voiceCalls(personalId, alpha.user.id), []);
    assert.deepEqual(store.pendingAttachments(personalId, alpha.user.id), []);
    assert.equal(store.pageActionApproval(personalId, active.id), null);
    assert.equal(store.websiteSignInRequest(personalId, signInTask.id), null);
    assert.equal(store.tenantActionRule(personalId), null);
    assert.equal(store.getTask(scheduled.id, personalId), null);
    assert.equal(store.getTask(active.id, personalId), null);
    assert.equal(store.getTask(signInTask.id, personalId), null);
    assert.deepEqual((store.db.prepare('SELECT key,value FROM tenant_settings WHERE tenant_id=? ORDER BY key').all(personalId) as { key: string; value: string }[]).map(row => ({ key: row.key, value: row.value })), [
      { key: 'modelBaseUrl', value: 'https://api.deepseek.com/v1' },
      { key: 'modelName', value: 'deepseek-chat' },
    ]);
    assert.equal(reset.profile.name, 'Dot');
    assert.equal(reset.profile.shape, 'circle');
    assert.equal(reset.profile.color, '#c8cbd5');
    assert.equal(reset.profile.avatarSetupCompletedAt, null);
    assert.equal(reset.profile.onboardingCompletedAt, null);
    assert.equal(reset.dotPaused, false);
    assert.equal(store.getSession(sessionHash)?.tenant.id, personalId, 'Reset keeps the signed-in account and tenant membership');
    assert.equal(store.getTask(betaTask.id, beta.tenant.id)?.instruction, 'Keep Beta personal task');
    assert.equal(store.personalDotMemories(beta.user.id)[0]?.note, 'Beta memory stays');
    assert.equal(store.getTask(sharedTask.id, shared.id)?.instruction, 'Keep shared task');
    assert.equal(store.tenantMemories(shared.id)[0]?.note, 'Shared note stays');
    assert.equal(store.tenantsForUser(alpha.user.id).some(tenant => tenant.id === shared.id), true);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('reset refuses shared workspaces, multi-member personal workspaces, and other users', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-reset-scope-'));
  const store = new Store(directory);
  try {
    const alpha = store.signInGoogle({ subject: 'reset-scope-alpha', email: 'reset-scope-alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'reset-scope-beta', email: 'reset-scope-beta@example.test', name: 'Beta' });
    const personalId = alpha.tenant.id;
    const shared = store.createWorkspace(alpha.user.id, 'Shared');
    store.createTask('Shared data must remain', null, 'model', shared.id);
    assert.equal(store.personalDotResetEligibility(shared.id, alpha.user.id), 'not-personal');
    assert.equal(store.resetPersonalDot(shared.id, alpha.user.id), 'not-personal');
    assert.equal(store.getTask(store.snapshot(false, [], undefined, shared.id).tasks[0].id, shared.id)?.instruction, 'Shared data must remain');

    store.db.prepare('INSERT INTO memberships(tenant_id,user_id,role,created_at) VALUES (?,?,?,?)')
      .run(personalId, beta.user.id, 'member', new Date().toISOString());
    assert.equal(store.personalDotResetEligibility(personalId, alpha.user.id), 'shared');
    assert.equal(store.resetPersonalDot(personalId, alpha.user.id), 'shared');
    assert.equal(store.personalDotResetEligibility(personalId, beta.user.id), 'not-owner');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
