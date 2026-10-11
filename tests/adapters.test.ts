import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapters, formatAgentPrompt, parseDecision } from '../src/server/adapters.ts';
import { Store } from '../src/server/store.ts';
import { Worker } from '../src/server/worker.ts';

test('agent output must specify a real task state', () => {
  assert.equal(parseDecision('{"status":"waiting","message":"Need access"}').status, 'waiting');
  assert.throws(() => parseDecision('I probably finished the work'));
  assert.throws(() => parseDecision('{"status":"done","message":""}'));
});

test('proactive research accepts only an explicit read-only finding decision', () => {
  const decision = parseDecision(JSON.stringify({ status: 'done', message: 'Two active plans disagree about the release date.', proactiveFinding: true }), undefined, { allowDelegation: false, allowProactiveFinding: true });
  assert.equal(decision.proactiveFinding, true);
  assert.equal(parseDecision(JSON.stringify({ status: 'done', message: 'No useful connection.', proactiveFinding: false, notifyUser: false }), undefined, { allowProactiveFinding: true }).notifyUser, false);
  assert.throws(() => parseDecision('{"status":"done","message":"Maybe"}', undefined, { allowProactiveFinding: true }), /明确的发现标记/);
  assert.throws(() => parseDecision('{"status":"waiting","message":"Need access","proactiveFinding":false}', undefined, { allowProactiveFinding: true }), /明确的发现标记/);
  assert.throws(() => parseDecision('{"status":"done","message":"Updated it","proactiveFinding":true,"pageAction":{"action":"create","title":"Notes","content":"Changed"}}', undefined, { allowProactiveFinding: true }), /不能写入页面/);
  assert.throws(() => parseDecision('{"status":"done","message":"Found one","proactiveFinding":true}', undefined, { allowProactiveFinding: false }), /普通任务不能返回/);

  const prompt = formatAgentPrompt({ executionMode: 'proactive-research', prompt: '{"sourceTask":{"result":"October 22"}}', priorResult: null, sessionId: null, workspace: '/tmp/review', onEvent: () => {} });
  assert.match(prompt, /Proactive research constraints/);
  assert.match(prompt, /Do not browse, control a computer, read or modify files/);
  assert.match(prompt, /do not infer or recalculate weekdays or time zones/);
  assert.match(prompt, /explicitly state that you made no changes and did not send or publish anything/);
  assert.match(prompt, /October 22/);
});

test('agent Scratchpad actions require bounded page content and a valid tenant page ID', () => {
  const id = '01234567-89ab-cdef-0123-456789abcdef';
  const created = parseDecision(JSON.stringify({ status: 'done', message: 'I created your page.', pageAction: { action: 'create', title: 'Launch notes', content: '# Outline\n- Draft the intro' } }));
  assert.deepEqual(created.pageAction, { action: 'create', title: 'Launch notes', content: '# Outline\n- Draft the intro' });
  const updated = parseDecision(JSON.stringify({ status: 'done', message: 'I updated the page.', pageAction: { action: 'update', pageId: id, title: 'Launch notes', content: 'Updated outline' } }));
  assert.deepEqual(updated.pageAction, { action: 'update', pageId: id, title: 'Launch notes', content: 'Updated outline' });
  assert.throws(() => parseDecision(JSON.stringify({ status: 'done', message: 'Invalid', pageAction: { action: 'update', pageId: '../other-tenant', title: 'Notes', content: 'Body' } })), /页面操作无效/);
  assert.throws(() => parseDecision(JSON.stringify({ status: 'done', message: 'Invalid', pageAction: { action: 'create', title: 'Notes', content: 'x'.repeat(24001) } })), /页面内容无效/);
  assert.throws(() => parseDecision(JSON.stringify({ status: 'waiting', message: 'Which page?', pageAction: { action: 'create', title: 'Notes', content: 'Draft' } })), /不能同时写入/);
});

test('agent can create at most three bounded delegated tasks and children cannot delegate', () => {
  assert.equal(parseDecision(JSON.stringify({ status: 'done', message: 'Finished.', delegations: [] })).status, 'done');
  const decision = parseDecision(JSON.stringify({ status: 'delegating', message: 'Split the research into independent questions.', delegations: [
    { title: 'Market size', instruction: 'Estimate the addressable market from the supplied sources.' },
    { title: 'Competitors', instruction: 'Compare competitors using the supplied criteria.' },
  ] }));
  assert.equal(decision.status, 'delegating');
  assert.equal(decision.delegations?.length, 2);
  const routed = parseDecision(JSON.stringify({ status: 'delegating', message: 'Route cloud execution to DeepSeek Harness.', delegations: [{ title: 'Cloud task', instruction: 'Use the tenant cloud computer.', engine: 'dsh' }] }), undefined, { availableEngines: ['model', 'pi', 'dsh'] });
  assert.equal(routed.delegations?.[0].engine, 'dsh');
  assert.throws(() => parseDecision(JSON.stringify({ status: 'delegating', message: 'Route to an unsupported engine.', delegations: [{ title: 'Review', instruction: 'Review the local changes.', engine: 'claude' }] })), /不可用的内核/);
  assert.throws(() => parseDecision(JSON.stringify({ status: 'delegating', message: 'Route to Pi.', delegations: [{ title: 'Review', instruction: 'Review the task.', engine: 'pi' }] }), undefined, { availableEngines: ['model'] }), /不可用的内核/);
  assert.throws(() => parseDecision(JSON.stringify({ status: 'delegating', message: 'Too many', delegations: Array.from({ length: 4 }, (_, index) => ({ title: `Child ${index}`, instruction: 'Work independently.' })) })), /数量无效/);
  assert.throws(() => parseDecision(JSON.stringify({ status: 'delegating', message: 'Invalid child', delegations: [{ title: 'Child', instruction: 'x'.repeat(5001) }] })), /内容无效/);
  assert.throws(() => parseDecision(JSON.stringify({ status: 'delegating', message: 'Recursive', delegations: [{ title: 'Child', instruction: 'Run recursively.' }] }), undefined, { allowDelegation: false }), /不能继续委派/);
});

test('Pi selection persists and historical Claude tasks remain readable but are not selectable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-engines-'));
  try {
    let store = new Store(directory);
    const task = store.createTask('Review code', null, 'pi');
    store.db.prepare('UPDATE tasks SET engine=? WHERE id=?').run('claude', task.id);
    store.close();
    store = new Store(directory);
    assert.equal(store.getTask(task.id)?.engine, 'claude');
    assert.deepEqual(Object.keys(adapters), ['model', 'pi', 'dsh']);
    assert.throws(() => store.createTask('Use a disabled engine', null, 'claude' as never), /任务内核无效/);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a queued historical Claude task fails clearly without losing its history', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-legacy-engine-'));
  const store = new Store(directory);
  const task = store.createTask('Legacy task', null, 'pi');
  store.db.prepare('UPDATE tasks SET engine=? WHERE id=?').run('claude', task.id);
  const worker = new Worker(store, () => {});
  try {
    await worker.tick();
    const deadline = Date.now() + 2_000;
    while (store.getTask(task.id)?.status !== 'failed' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const failed = store.getTask(task.id);
    assert.equal(failed?.status, 'failed');
    assert.match(failed?.error || '', /Claude Code 内核已停用/);
    assert.equal(failed?.engine, 'claude', 'The historical kernel identity should remain visible for audit');
    assert.match(store.snapshot(false, [], undefined, task.tenantId).entries.filter(entry => entry.taskId === task.id).map(entry => entry.body).join('\n'), /原任务历史已保留/);
  } finally {
    worker.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
