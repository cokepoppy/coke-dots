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

test('background worker stores real model result and schedules a future run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-'));
  const modelServer = createServer(async (req, res) => {
    assert.equal(req.url, '/chat/completions');
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
  const task = store.createTask('Check supplied information', 60);
  store.setSetting('desktopNotifications', 'true');
  const notifications: { title: string; body: string }[] = [];
  const worker = new Worker(store, () => {}, undefined, (title, body) => notifications.push({ title, body }));
  try {
    worker.start();
    await waitFor(() => store.getTask(task.id)?.status === 'scheduled');
    const completed = store.getTask(task.id)!;
    assert.equal(completed.result, 'Checked the supplied information.');
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

async function waitFor(predicate: () => boolean, timeout = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for worker');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
