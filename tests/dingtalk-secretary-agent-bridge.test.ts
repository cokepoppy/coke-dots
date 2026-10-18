import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDingTalkSecretaryAgentBridge, deterministicDingTalkSecretaryRequestId, verifyDingTalkSecretaryAgentGrant } from '../src/server/dingtalk-secretary-agent-bridge.ts';
import { DingTalkService } from '../src/server/dingtalk.ts';

const secret = 'test-only-dingtalk-secretary-secret-long-enough';
const e2eSecret = 'dots-e2e-only-dingtalk-agent-grant-secret-32-bytes';
const taskId = '11111111-1111-4111-8111-111111111111';
const baseInput = { tenantId: 'tenant-a', userId: '012448396205618534358', taskId, publicOrigin: 'https://dots.example.test', basePath: '/dots-demo', secret, now: Date.parse('2026-10-16T00:00:00Z') };

test('secretary grants only explicit self-todo and fixed cokeclaw delivery actions', () => {
  assert.equal(createDingTalkSecretaryAgentBridge({ ...baseInput, instruction: '帮我安排日程并创建两个个人待办，然后把报告发送到 cokeclaw 群' })?.actions.length, 2);
  const bridge = createDingTalkSecretaryAgentBridge({ ...baseInput, instruction: '创建个人待办并把最终报告发送到 cokeclaw 群' });
  assert(bridge);
  assert.equal(bridge.url, 'https://dots.example.test/dots-demo/api/agent/dingtalk/secretary');
  assert.deepEqual(bridge.actions, ['todo-create', 'cokeclaw-send']);
  assert.deepEqual(verifyDingTalkSecretaryAgentGrant(bridge.token, secret, baseInput.now)?.actions, bridge.actions);
  const read = createDingTalkSecretaryAgentBridge({ ...baseInput, instruction: '告诉我今天有哪些未完成的钉钉待办' });
  assert.deepEqual(read?.actions, ['todo-list']);
  assert.deepEqual(createDingTalkSecretaryAgentBridge({ ...baseInput, instruction: '我明天有哪些日程和待办？' })?.actions, ['todo-list'], 'The same spoken request must also grant list-only todo access');
  assert.deepEqual(createDingTalkSecretaryAgentBridge({ ...baseInput, instruction: '创建一个个人钉钉待办' })?.actions, ['todo-create']);
  assert.equal(createDingTalkSecretaryAgentBridge({ ...baseInput, instruction: '删除 cokeclaw 群里的待办' }), null);
  assert.equal(createDingTalkSecretaryAgentBridge({ ...baseInput, instruction: '更新监控群里的内容' }), null);
  assert.equal(verifyDingTalkSecretaryAgentGrant(bridge.token, secret, baseInput.now + 16 * 60_000), null);
});

test('secretary write requests are task-bound, self-only, fixed-group, and idempotent in the test adapter', async () => {
  const service = new DingTalkService({ NODE_ENV: 'test', DOTS_E2E_AUTH: '1', DOTS_E2E_DINGTALK: '1', DOTS_PUBLIC_ORIGIN: 'https://dots.example.test', DOTS_BASE_PATH: '/dots-demo' });
  const session = {
    tokenHash: 'ignored', user: { id: baseInput.userId, email: 'a@example.test', name: 'A' },
    tenant: { id: 'tenant-a', name: 'A workspace', role: 'member' as const, kind: 'workspace' as const },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const flow = await service.startAuthorization(session) as { id: string };
  await service.saveTestAuthorization(session, flow.id);
  const bridge = service.agentSecretaryBridge('tenant-a', baseInput.userId, taskId, '创建个人待办并把报告发送到 cokeclaw 群');
  assert(bridge);
  const grant = service.verifyAgentSecretaryGrant(bridge.token);
  assert(grant);
  const todo = await service.runAgentSecretaryOperation(grant, { action: 'todo-create', title: '完成规则核验', due: '2026-10-20T17:00:00+08:00', priority: 30 }) as { taskId: string; verified: boolean; testOnly: boolean };
  assert.equal(todo.taskId, `e2e-todo-${deterministicDingTalkSecretaryRequestId(taskId, 'todo-create', e2eSecret)}`);
  assert.equal(todo.verified, true);
  assert.equal(todo.testOnly, true);
  await assert.rejects(service.runAgentSecretaryOperation(grant, { action: 'todo-create', title: '转给其他人', executorId: '012448396205618534359', due: '2026-10-20T17:00:00+08:00' }), /无效/);
  const send = await service.runAgentSecretaryOperation(grant, { action: 'cokeclaw-send', content: '规则核验报告已完成' }) as { group: string; messageId: string; sent: boolean; testOnly: boolean };
  assert.equal(send.group, 'cokeclaw');
  assert.equal(send.sent, true);
  assert.equal(send.testOnly, true);
  await assert.rejects(service.runAgentSecretaryOperation(grant, { action: 'cokeclaw-send', group: 'other-group', content: 'wrong target' }), /无效/);
  await assert.rejects(service.runAgentSecretaryOperation(grant, { action: 'cokeclaw-send', content: 'x'.repeat(4001) }), /无效/);

  const readBridge = service.agentSecretaryBridge('tenant-a', baseInput.userId, taskId, '告诉我今天有哪些钉钉待办');
  assert(readBridge);
  const readGrant = service.verifyAgentSecretaryGrant(readBridge.token);
  assert(readGrant);
  const listed = await service.runAgentSecretaryOperation(readGrant, { action: 'todo-list', scope: 'due-today' }) as { scope: string; count: number; tasks: unknown[]; complete: boolean; testOnly: boolean };
  assert.deepEqual(listed, { scope: 'due-today', count: 0, tasks: [], complete: true, testOnly: true });
  const detail = await service.runAgentSecretaryOperation(readGrant, { action: 'todo-detail', taskId: 'todo-123' }) as { taskId: string; statusAvailable: boolean; isDone: boolean; testOnly: boolean };
  assert.deepEqual(detail, { taskId: 'todo-123', statusAvailable: true, isDone: false, testOnly: true });
  await assert.rejects(service.runAgentSecretaryOperation(readGrant, { action: 'todo-detail', taskId: 'bad/id' }), /无效/);
  await assert.rejects(service.runAgentSecretaryOperation(readGrant, { action: 'todo-create', title: '没有写权限', due: '2026-10-20T17:00:00+08:00' }), /没有此钉钉个人助理操作权限/);
  await assert.rejects(service.runAgentSecretaryOperation(grant, { action: 'todo-detail', taskId: 'todo-123' }), /没有此钉钉个人助理操作权限/,
    'Create and group-send grants do not imply todo read access');
});
