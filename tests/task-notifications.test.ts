import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../src/server/store.ts';
import { browserNotificationAllowed, findTaskNotificationAlerts, taskNotificationCopy, type TaskNotificationState } from '../src/web/task-notifications.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const task = (change: Partial<TaskNotificationState> = {}): TaskNotificationState => ({
  id: 'task-1', status: 'working', isOwnedByCurrentUser: true, notifyUser: true, unreadScheduledRunCount: 0, ...change,
});

test('task notification alerts honor task ownership, attention rules, and recurring unread runs', () => {
  assert.deepEqual(findTaskNotificationAlerts([task()], [task({ status: 'done' })]), [{ taskId: 'task-1', kind: 'completed' }]);
  assert.deepEqual(findTaskNotificationAlerts([task()], [task({ status: 'done', notifyUser: false })]), [], 'A quiet completion stays quiet');
  assert.deepEqual(findTaskNotificationAlerts([task()], [task({ status: 'waiting', notifyUser: false })]), [{ taskId: 'task-1', kind: 'waiting' }], 'A user decision cannot be hidden by a quiet preference');
  assert.deepEqual(findTaskNotificationAlerts([task()], [task({ status: 'failed', notifyUser: false })]), [{ taskId: 'task-1', kind: 'failed' }], 'A task failure must be surfaced');
  assert.deepEqual(findTaskNotificationAlerts([task({ status: 'scheduled' })], [task({ status: 'scheduled', unreadScheduledRunCount: 1 })]), [{ taskId: 'task-1', kind: 'scheduled-result' }]);
  assert.deepEqual(findTaskNotificationAlerts([task()], [task({ status: 'done', isOwnedByCurrentUser: false })]), [], 'A shared task does not notify a non-owner');
  assert.deepEqual(findTaskNotificationAlerts(null, [task({ status: 'done' })]), [], 'The first loaded state establishes a baseline without old alerts');
  assert.equal(taskNotificationCopy('completed'), '有一项工作已完成。');
});

test('browser notification mode follows the selected page visibility', () => {
  assert.equal(browserNotificationAllowed('never', true), false);
  assert.equal(browserNotificationAllowed('background', false), false);
  assert.equal(browserNotificationAllowed('background', true), true);
  assert.equal(browserNotificationAllowed('always', false), true);
});

test('browser notification preference follows a Google account across workspaces and stays private', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-browser-notifications-'));
  try {
    let store = new Store(directory);
    const alpha = store.signInGoogle({ subject: 'browser-notify-alpha', email: 'browser-alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'browser-notify-beta', email: 'browser-beta@example.test', name: 'Beta' });
    const shared = store.createWorkspace(alpha.user.id, 'Notification workspace');
    assert.equal(store.addWorkspaceMember(shared.id, alpha.user.id, beta.user.email, 'member').ok, true);
    const betaHash = 'browser-notification-beta-session';
    store.createSession(betaHash, beta.user.id, beta.tenant.id, '2099-01-01T00:00:00.000Z');
    assert.ok(store.acceptWorkspaceInvitation(shared.id, betaHash, beta.user.id, beta.user.email));
    store.setUserSetting('browserNotifications', 'background', alpha.user.id);

    const alphaShared = store.snapshot(true, [], { baseUrl: '', model: '', hasKey: false }, shared.id, [], [], alpha.user.id);
    const betaShared = store.snapshot(true, [], { baseUrl: '', model: '', hasKey: false }, shared.id, [], [], beta.user.id);
    assert.equal(alphaShared.preferences.browserNotifications, 'background');
    assert.equal(betaShared.preferences.browserNotifications, 'never');
    const task = store.createTask('Alpha private browser notification task', null, 'model', shared.id, null, null, [], alpha.user.id);
    const alphaTask = alphaShared.tasks.find(item => item.id === task.id) || store.snapshot(true, [], { baseUrl: '', model: '', hasKey: false }, shared.id, [], [], alpha.user.id).tasks.find(item => item.id === task.id);
    const betaTask = betaShared.tasks.find(item => item.id === task.id) || store.snapshot(true, [], { baseUrl: '', model: '', hasKey: false }, shared.id, [], [], beta.user.id).tasks.find(item => item.id === task.id);
    assert.equal(alphaTask?.isOwnedByCurrentUser, true);
    assert.equal(betaTask?.isOwnedByCurrentUser, false);
    store.close();

    store = new Store(directory);
    assert.equal(store.browserNotificationMode(alpha.user.id), 'background', 'The account preference must survive a service restart');
    assert.equal(store.browserNotificationMode(beta.user.id), 'never');
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
