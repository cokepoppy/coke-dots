import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDingTalkMinutesAgentBridge, requestsDingTalkMinutesRead, verifyDingTalkMinutesAgentGrant } from '../src/server/dingtalk-minutes-agent-bridge.ts';
import { DingTalkService } from '../src/server/dingtalk.ts';

const secret = 'test-only-dingtalk-minutes-bridge-secret-long-enough';
const taskId = '11111111-1111-4111-8111-111111111111';
const baseInput = { tenantId: 'tenant-a', userId: '012448396205618534358', taskId, publicOrigin: 'https://dots.example.test', basePath: '/dots-demo', secret, now: Date.parse('2026-10-18T00:00:00Z') };

test('minutes read intent produces only short-lived search and detail tools', () => {
  const instruction = '查找 10 月 19 日的北交所评审，读取这次会议实际生成的 AI 听记和关联待办。';
  assert.equal(requestsDingTalkMinutesRead(instruction), true);
  const bridge = createDingTalkMinutesAgentBridge({ ...baseInput, instruction });
  assert(bridge);
  assert.equal(bridge.url, 'https://dots.example.test/dots-demo/api/agent/dingtalk/minutes');
  assert.deepEqual(bridge.actions, ['search', 'detail']);
  assert.deepEqual(verifyDingTalkMinutesAgentGrant(bridge.token, secret, baseInput.now)?.actions, ['search', 'detail']);
  assert.equal(verifyDingTalkMinutesAgentGrant(bridge.token, secret, baseInput.now + 16 * 60_000), null);
});

test('minutes bridge does not grant writes or activate for unrelated todo/calendar requests', () => {
  assert.equal(createDingTalkMinutesAgentBridge({ ...baseInput, instruction: '告诉我明天有哪些钉钉日程和待办' }), null);
  assert.equal(createDingTalkMinutesAgentBridge({ ...baseInput, instruction: '上传一段会议录音并生成AI听记' }), null);
  assert.deepEqual(createDingTalkMinutesAgentBridge({ ...baseInput, instruction: '读取会议纪要并把它发到群里' })?.actions, ['search', 'detail']);
});

test('minutes bridge rejects invalid origins, base paths, and short signing secrets', () => {
  assert.equal(createDingTalkMinutesAgentBridge({ ...baseInput, instruction: '读取会议纪要', publicOrigin: 'http://dots.example.test' }), null);
  assert.equal(createDingTalkMinutesAgentBridge({ ...baseInput, instruction: '读取会议纪要', basePath: '/../api' }), null);
  assert.equal(createDingTalkMinutesAgentBridge({ ...baseInput, instruction: '读取会议纪要', secret: 'short' }), null);
});

test('minutes Agent operations remain task-scoped and read-only', async () => {
  const service = new DingTalkService({ NODE_ENV: 'test', DOTS_E2E_AUTH: '1', DOTS_E2E_DINGTALK: '1', DOTS_PUBLIC_ORIGIN: 'https://dots.example.test', DOTS_BASE_PATH: '/dots-demo' });
  const session = {
    tokenHash: 'ignored', user: { id: baseInput.userId, email: 'a@example.test', name: 'A' },
    tenant: { id: 'tenant-a', name: 'A workspace', role: 'member' as const, kind: 'workspace' as const },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const flow = await service.startAuthorization(session) as { id: string };
  await service.saveTestAuthorization(session, flow.id);
  const bridge = service.agentMinutesBridge('tenant-a', baseInput.userId, taskId, '读取北交所会议 AI 听记并总结');
  assert(bridge);
  const grant = service.verifyAgentMinutesGrant(bridge.token);
  assert(grant);
  const result = await service.runAgentMinutesOperation(grant, { action: 'search', query: '北交所会议', scope: 'all' }) as { complete: boolean; count: number; minutes: unknown[]; testOnly: boolean };
  assert.deepEqual(result, { scope: 'all', query: '北交所会议', count: 0, minutes: [], complete: true, testOnly: true });
  const partial = await service.runAgentMinutesOperation(grant, { action: 'detail', taskUuid: 'task_1' }) as { taskUuid: string; complete: boolean; failureCount: number; testOnly: boolean };
  assert.deepEqual(partial, { taskUuid: 'task_1', complete: false, failureCount: 1, testOnly: true });
  await assert.rejects(service.runAgentMinutesOperation(grant, { action: 'upload', query: '录音' }), /没有此钉钉听记操作权限/);
  await assert.rejects(service.runAgentMinutesOperation(grant, { action: 'detail', taskUuid: '../other' }), /无效/);
});
