import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDwsSecretaryOperations } from '../deploy/dingtalk-connector/lib/dws-secretary.mjs';

const principal = { issuer: 'coke-dots', subject: 'tenant-a:user-a' };

test('DWS secretary reads todos and creates one short meeting, one self todo, and one fixed cokeclaw report', async () => {
  const calls = [];
  const operations = createDwsSecretaryOperations({
    withAuthenticatedProfile: async (_principal, work) => work({ call: async args => {
      calls.push(args);
      const action = args[0] === 'calendar' ? 'calendar' : args[0] === 'todo' ? 'todo' : 'chat';
      if (args[0] === 'todo' && args[1] !== '+create') return { ok: true, outcome: 'success', data: { count: 1, tasks: [{ taskId: 'todo-123', title: '核对公告', accessToken: 'must-not-escape' }] } };
      return { ok: true, outcome: 'success', data: action === 'calendar' ? { eventId: 'event-123' } : action === 'todo' ? { taskId: 'todo-123' } : { messageId: 'message-123' } };
    }, profile: { selector: 'cms-user' }, ownerKey: 'tenant-a:user-a' }),
    writeOnce: async ({ ownerKey, requestId, operation, input, work }) => work({ ownerKey, requestId, operation, input }),
  });
  const meeting = await operations.createCalendarEvent(principal, { confirmed: true, requestId: '11111111-1111-4111-8111-111111111111', title: '规则准备会', start: '2026-10-19T10:00:00+08:00', end: '2026-10-19T10:45:00+08:00', description: '核对实施事项' });
  assert.equal(meeting.verified, true);
  const todos = await operations.listPersonalTodos(principal, { scope: 'due-today' });
  assert.deepEqual(todos, { scope: 'due-today', count: 1, tasks: [{ taskId: 'todo-123', title: '核对公告' }], complete: true });
  assert.deepEqual(calls[1].slice(0, 2), ['todo', '+due-today']);
  assert(calls[1].includes('--profile') && calls[1].includes('cms-user'));
  const todo = await operations.createPersonalTodo(principal, { confirmed: true, requestId: '22222222-2222-4222-8222-222222222222', title: '完成测试', executorId: '012448396205618534358', due: '2026-10-20T17:00:00+08:00', priority: 30 });
  assert.equal(todo.taskId, 'todo-123');
  const message = await operations.sendCokeclawReport(principal, { confirmed: true, requestId: '33333333-3333-4333-8333-333333333333', content: '报告已完成' });
  assert.deepEqual(message, { group: 'cokeclaw', messageId: 'message-123', sent: true });
  assert.deepEqual(calls.filter(args => args[1] !== '+due-today').map(args => args.slice(0, 2)), [['calendar', '+book'], ['todo', '+create'], ['chat', '+send-to-group']]);
  assert(calls[0].includes('--start') && calls[0].includes('2026-10-19T10:00:00+08:00'));
  assert(calls[0].includes('--end') && calls[0].includes('2026-10-19T10:45:00+08:00'));
  assert(calls[2].includes('--executors') && calls[2].includes('012448396205618534358'));
  assert(calls[3].includes('--group') && calls[3].includes('cokeclaw'));
  assert.deepEqual(calls.slice(0, 2).map(args => args.includes('--yes')), [true, false], 'Only the requested calendar write receives confirmation; todo reads stay read-only');
  assert(calls.slice(2).every(args => args.includes('--yes')));
});

test('DWS secretary validates write confirmations, self-only todo, safe time range, and message bounds', async () => {
  let calls = 0;
  const operations = createDwsSecretaryOperations({
    withAuthenticatedProfile: async (_principal, work) => work({ call: async () => { calls++; return { ok: true, outcome: 'success', data: { eventId: 'event-123' } }; }, profile: { selector: 'cms-user' }, ownerKey: 'tenant-a:user-a' }),
    writeOnce: async ({ work }) => work({}),
  });
  await assert.rejects(operations.createCalendarEvent(principal, { title: 'x', start: '2026-10-19T10:00:00+08:00', end: '2026-10-19T10:45:00+08:00', requestId: '11111111-1111-4111-8111-111111111111' }), /DWS_CALENDAR_CONFIRMATION_REQUIRED/);
  await assert.rejects(operations.createCalendarEvent(principal, { confirmed: true, title: 'x', start: '2026-10-19T10:00:00+08:00', end: '2026-10-19T15:00:00+08:00', requestId: '11111111-1111-4111-8111-111111111111' }), /DWS_CALENDAR_RANGE_INVALID/);
  await assert.rejects(operations.createPersonalTodo(principal, { confirmed: true, title: 'x', executorId: 'other-user', due: '2026-10-20T10:00:00+08:00', requestId: '22222222-2222-4222-8222-222222222222' }), /DWS_TODO_EXECUTOR_INVALID/);
  await assert.rejects(operations.sendCokeclawReport(principal, { confirmed: true, content: 'x'.repeat(4001), requestId: '33333333-3333-4333-8333-333333333333' }), /DWS_CHAT_CONTENT_INVALID/);
  await assert.rejects(operations.listPersonalTodos(principal, { scope: 'all-org-tasks' }), /DWS_TODO_LIST_FAILED/);
  assert.equal(calls, 0, 'Invalid requests must stop before the DWS CLI is invoked');
});

test('related todo reads expose their incomplete-status filter separately from pagination completeness', async () => {
  const calls = [];
  const operations = createDwsSecretaryOperations({
    withAuthenticatedProfile: async (_principal, work) => work({ call: async args => {
      calls.push(args);
      return { ok: true, outcome: 'success', data: { count: 2, tasks: [{ taskId: 'todo-1' }, { taskId: 'todo-2' }], complete: true } };
    }, profile: { selector: 'cms-user' }, ownerKey: 'tenant-a:user-a' }),
    writeOnce: async () => { throw new Error('read-only todo lookup must not enter write flow'); },
  });

  const result = await operations.listPersonalTodos(principal, { scope: 'related' });
  assert.equal(result.taskStatusFilter, 'incomplete');
  assert.match(result.taskStatusExplanation, /status=false.*every task.*incomplete/);
  assert.match(result.taskStatusExplanation, /complete field.*pagination only/);
  assert.equal(result.complete, true, 'complete describes pagination, not todo completion');
  assert.deepEqual(result.tasks, [{ taskId: 'todo-1' }, { taskId: 'todo-2' }]);
  assert.deepEqual(calls[0].slice(0, 4), ['todo', '+get-related-tasks', '--status', 'false']);
});

