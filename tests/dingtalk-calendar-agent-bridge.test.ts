import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DingTalkService } from '../src/server/dingtalk.ts';
import { createDingTalkCalendarAgentBridge, requestsDingTalkCalendarCreate, requestsDingTalkCalendarRead, verifyDingTalkCalendarAgentGrant } from '../src/server/dingtalk-calendar-agent-bridge.ts';

const secret = 'test-only-dingtalk-calendar-secret-long-enough';
const now = Date.parse('2026-10-16T00:00:00.000Z');
const baseInput = {
  tenantId: 'tenant-a', userId: 'user-a', taskId: '11111111-1111-4111-8111-111111111111',
  instruction: '读取我本周的钉钉日程并准备会议', publicOrigin: 'https://dots.example.test', basePath: '/dots-demo', secret, now,
};

test('calendar capability is read-only, explicit-intent, short-lived, and bound to one tenant/user/task', () => {
  assert.equal(requestsDingTalkCalendarRead('读取我本周的钉钉日程'), true);
  assert.equal(requestsDingTalkCalendarRead('帮我准备今天的会议'), true);
  assert.equal(requestsDingTalkCalendarRead('读取明天的会议日程并写一份钉钉会议准备文档'), true, 'Calendar reads must remain available when the requested output is a document');
  assert.equal(requestsDingTalkCalendarRead("What's on my schedule?"), true);
  assert.equal(requestsDingTalkCalendarRead('请在钉钉日历创建一个会议'), false, 'A write-only meeting request does not need a read grant');
  assert.equal(requestsDingTalkCalendarRead('Cancel my calendar meeting'), false);
  assert.equal(requestsDingTalkCalendarRead('读取钉钉文档里的日历操作说明'), false);
  assert.equal(requestsDingTalkCalendarRead('搜索公开网页'), false);
  assert.equal(requestsDingTalkCalendarCreate('帮我安排一个钉钉日历会议'), true);
  assert.equal(requestsDingTalkCalendarCreate('读取本周钉钉日程'), false);
  assert.equal(requestsDingTalkCalendarCreate('取消并重新安排钉钉会议'), false);

  const bridge = createDingTalkCalendarAgentBridge(baseInput);
  assert(bridge);
  assert.equal(bridge.url, 'https://dots.example.test/dots-demo/api/agent/dingtalk/calendar');
  assert.deepEqual(bridge.actions, ['list']);
  const grant = verifyDingTalkCalendarAgentGrant(bridge.token, secret, now);
  assert.deepEqual(grant && { tenantId: grant.tenantId, userId: grant.userId, taskId: grant.taskId, actions: grant.actions }, {
    tenantId: 'tenant-a', userId: 'user-a', taskId: baseInput.taskId, actions: ['list'],
  });
  assert.equal(verifyDingTalkCalendarAgentGrant(`x${bridge.token.slice(1)}`, secret, now), null);
  assert.equal(verifyDingTalkCalendarAgentGrant(bridge.token, secret, now + 16 * 60_000), null);
});

test('calendar bridge refuses public HTTP and grants only explicitly requested create', () => {
  assert.equal(createDingTalkCalendarAgentBridge({ ...baseInput, publicOrigin: 'http://dots.example.test' }), null);
  assert.deepEqual(createDingTalkCalendarAgentBridge({ ...baseInput, instruction: '创建一个钉钉日历会议' })?.actions, ['create']);
  assert.equal(createDingTalkCalendarAgentBridge({ ...baseInput, instruction: '读取钉钉日程', secret: 'short' }), null);
});

test('calendar create grant is explicit, fixed to create/list capabilities, and server-side write is bounded', async () => {
  const service = new DingTalkService({ NODE_ENV: 'test', DOTS_E2E_AUTH: '1', DOTS_E2E_DINGTALK: '1', DOTS_PUBLIC_ORIGIN: 'https://dots.example.test', DOTS_BASE_PATH: '/dots-demo' });
  const session = {
    tokenHash: 'ignored', user: { id: 'user-a', email: 'a@example.test', name: 'A' },
    tenant: { id: 'tenant-a', name: 'A workspace', role: 'member' as const, kind: 'workspace' as const },
    expiresAt: new Date(now + 60_000).toISOString(),
  };
  const flow = await service.startAuthorization(session) as { id: string };
  await service.saveTestAuthorization(session, flow.id);
  const bridge = service.agentCalendarBridge(session.tenant.id, session.user.id, baseInput.taskId, '安排一个钉钉日历会议');
  assert(bridge);
  assert.deepEqual(bridge.actions, ['create']);
  const grant = service.verifyAgentCalendarGrant(bridge.token);
  assert(grant);
  const event = await service.runAgentCalendarOperation(grant, {
    action: 'create', title: '规则准备会', start: '2026-10-19T10:00:00+08:00', end: '2026-10-19T10:45:00+08:00',
  }) as { eventId: string; title: string; verified: boolean; testOnly: boolean };
  assert.equal(event.title, '规则准备会');
  assert.equal(event.verified, true);
  assert.equal(event.testOnly, true);
  await assert.rejects(service.runAgentCalendarOperation(grant, { action: 'list' }), /没有此钉钉日历操作权限/);
  await assert.rejects(service.runAgentCalendarOperation(grant, {
    action: 'create', title: '不允许的超长会议', start: '2026-10-19T10:00:00+08:00', end: '2026-10-19T15:00:01+08:00',
  }), /时间范围无效/);
});

test('scoped calendar operation lists only for the test user, defaults to seven days, and rejects mutations and unsafe ranges', async () => {
  const service = new DingTalkService({ NODE_ENV: 'test', DOTS_E2E_AUTH: '1', DOTS_E2E_DINGTALK: '1', DOTS_PUBLIC_ORIGIN: 'https://dots.example.test', DOTS_BASE_PATH: '/dots-demo' });
  const session = {
    tokenHash: 'ignored',
    user: { id: 'user-a', email: 'a@example.test', name: 'A' },
    tenant: { id: 'tenant-a', name: 'A workspace', role: 'member' as const, kind: 'workspace' as const },
    expiresAt: new Date(now + 60_000).toISOString(),
  };
  const flow = await service.startAuthorization(session) as { id: string };
  await service.saveTestAuthorization(session, flow.id);
  const bridge = service.agentCalendarBridge(session.tenant.id, session.user.id, baseInput.taskId, '读取本周钉钉日程');
  assert(bridge);
  const grant = service.verifyAgentCalendarGrant(bridge.token);
  assert(grant);
  const result = await service.runAgentCalendarOperation(grant, { action: 'list' }) as { events: unknown[]; count: number; start: string; end: string; testOnly: boolean };
  assert.equal(result.count, 0);
  assert.equal(result.events.length, 0);
  assert.equal(result.end === result.start, false);
  assert.equal(Date.parse(result.end) - Date.parse(result.start) <= 7 * 24 * 60 * 60 * 1000 + 1000, true);
  assert.equal(result.testOnly, true);
  await assert.rejects(service.runAgentCalendarOperation(grant, { action: 'create' }), /没有此钉钉日历操作权限/);
  await assert.rejects(service.runAgentCalendarOperation(grant, { action: 'list', start: '2026-10-01T00:00:00Z', end: '2026-11-15T00:00:00Z' }), /时间范围无效/);
  await assert.rejects(service.runAgentCalendarOperation(grant, { action: 'list', start: '2026-10-16', end: '2026-10-17' }), /时间范围无效/);
});
