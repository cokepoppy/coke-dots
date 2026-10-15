import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DingTalkService } from '../src/server/dingtalk.ts';
import { createDingTalkAgentBridge, deterministicDingTalkCreateRequestId, requestedDingTalkDocumentActions, verifyDingTalkAgentGrant } from '../src/server/dingtalk-agent-bridge.ts';

const secret = 'test-only-dingtalk-ticket-secret-that-is-long-enough';
const now = Date.parse('2026-10-15T12:00:00.000Z');

test('DingTalk agent bridge grants only explicit document intent and binds it to a tenant user and task', () => {
  assert.deepEqual(requestedDingTalkDocumentActions('请搜索钉钉文档：值班手册'), ['search', 'fetch']);
  assert.deepEqual(requestedDingTalkDocumentActions('请把排障报告写入钉钉文档'), ['search', 'fetch', 'create']);
  assert.deepEqual(requestedDingTalkDocumentActions('不要创建钉钉文档，只搜索值班手册'), ['search', 'fetch']);
  assert.deepEqual(requestedDingTalkDocumentActions('请总结钉钉文档里写着“创建一个账号”的内容'), ['search', 'fetch'], 'Quoted document content must not independently authorize a write');
  assert.deepEqual(requestedDingTalkDocumentActions('请搜索公开网页并总结'), []);
  assert.equal(createDingTalkAgentBridge({
    tenantId: 'tenant-a', userId: 'user-a', taskId: '11111111-1111-4111-8111-111111111111',
    instruction: '请搜索钉钉文档：值班手册', publicOrigin: 'https://dots.example.test', basePath: '/dots-demo', secret, now,
  })?.url, 'https://dots.example.test/dots-demo/api/agent/dingtalk/documents');
  const bridge = createDingTalkAgentBridge({
    tenantId: 'tenant-a', userId: 'user-a', taskId: '11111111-1111-4111-8111-111111111111',
    instruction: '请把排障报告写入钉钉文档', publicOrigin: 'https://dots.example.test', basePath: '/dots-demo', secret, now,
  });
  assert(bridge);
  assert.deepEqual(bridge.actions, ['search', 'fetch', 'create']);
  const grant = verifyDingTalkAgentGrant(bridge.token, secret, now);
  assert.deepEqual(grant && { tenantId: grant.tenantId, userId: grant.userId, taskId: grant.taskId, actions: grant.actions }, {
    tenantId: 'tenant-a', userId: 'user-a', taskId: '11111111-1111-4111-8111-111111111111', actions: ['search', 'fetch', 'create'],
  });
});

test('DingTalk agent bridge rejects a changed signature, expired grant, unsafe origin, and malformed base path', () => {
  const bridge = createDingTalkAgentBridge({
    tenantId: 'tenant-a', userId: 'user-a', taskId: '11111111-1111-4111-8111-111111111111',
    instruction: '读取钉钉文档', publicOrigin: 'https://dots.example.test', secret, now,
  });
  assert(bridge);
  assert.equal(verifyDingTalkAgentGrant(`x${bridge.token.slice(1)}`, secret, now), null);
  assert.equal(verifyDingTalkAgentGrant(bridge.token, secret, now + 16 * 60_000), null);
  assert.equal(createDingTalkAgentBridge({
    tenantId: 'tenant-a', userId: 'user-a', taskId: '11111111-1111-4111-8111-111111111111',
    instruction: '读取钉钉文档', publicOrigin: 'https://dots.example.test/path', secret, now,
  }), null);
  assert.equal(createDingTalkAgentBridge({
    tenantId: 'tenant-a', userId: 'user-a', taskId: '11111111-1111-4111-8111-111111111111',
    instruction: '读取钉钉文档', publicOrigin: 'http://dots.example.test', secret, now,
  }), null, 'Delegated capabilities must not send their bearer token over public plaintext HTTP');
  assert.equal(createDingTalkAgentBridge({
    tenantId: 'tenant-a', userId: 'user-a', taskId: '11111111-1111-4111-8111-111111111111',
    instruction: '读取钉钉文档', publicOrigin: 'https://dots.example.test', basePath: '/../admin', secret, now,
  }), null);
});

test('one task has a stable DingTalk create idempotency key so an ambiguous write is not duplicated by a retry', () => {
  const first = deterministicDingTalkCreateRequestId('11111111-1111-4111-8111-111111111111', secret);
  assert.equal(first, deterministicDingTalkCreateRequestId('11111111-1111-4111-8111-111111111111', secret));
  assert.notEqual(first, deterministicDingTalkCreateRequestId('22222222-2222-4222-8222-222222222222', secret));
  assert.match(first, /^[a-f0-9-]{36}$/);
});

test('the scoped DWS bridge reads and creates only for the bound test identity and refuses writes outside its grant', async () => {
  const service = new DingTalkService({ NODE_ENV: 'test', DOTS_E2E_AUTH: '1', DOTS_E2E_DINGTALK: '1', DOTS_PUBLIC_ORIGIN: 'https://dots.example.test', DOTS_BASE_PATH: '/dots-demo' });
  const session = {
    tokenHash: 'ignored',
    user: { id: 'user-a', email: 'a@example.test', name: 'A' },
    tenant: { id: 'tenant-a', name: 'A workspace', role: 'member', kind: 'workspace' },
    expiresAt: new Date(now + 60_000).toISOString(),
  };
  const flow = await service.startAuthorization(session) as { id: string };
  await service.saveTestAuthorization(session, flow.id);
  const taskId = '11111111-1111-4111-8111-111111111111';
  const bridge = service.agentDocumentBridge(session.tenant.id, session.user.id, taskId, 'Create a report in a DingTalk document');
  assert(bridge);
  assert.equal(bridge.url, 'https://dots.example.test/dots-demo/api/agent/dingtalk/documents');
  const grant = service.verifyAgentDocumentGrant(bridge.token);
  assert(grant);
  const created = await service.runAgentDocumentOperation(grant, { action: 'create', name: '排障报告', content: 'Trace ID: trace-test' }) as { nodeId: string; url: string };
  const replayed = await service.runAgentDocumentOperation(grant, { action: 'create', name: '排障报告', content: 'Trace ID: trace-test' }) as { nodeId: string };
  assert.equal(replayed.nodeId, created.nodeId, 'The same task cannot duplicate a document after an ambiguous response');
  const search = await service.runAgentDocumentOperation(grant, { action: 'search', query: '排障报告' }) as { documents: Array<{ nodeId: string }> };
  assert.equal(search.documents[0]?.nodeId, created.nodeId);
  const fetched = await service.runAgentDocumentOperation(grant, { action: 'fetch', node: created.nodeId }) as { content: string };
  assert.equal(fetched.content, 'Trace ID: trace-test');
  await assert.rejects(service.runAgentDocumentOperation(grant, { action: 'create', name: '不同内容', content: 'different' }), /请求 ID 被用于不同的文档内容/);

  const readOnlyBridge = service.agentDocumentBridge(session.tenant.id, session.user.id, '22222222-2222-4222-8222-222222222222', 'Search the DingTalk document for the on-call guide');
  assert(readOnlyBridge);
  const readOnlyGrant = service.verifyAgentDocumentGrant(readOnlyBridge.token);
  assert(readOnlyGrant);
  await assert.rejects(service.runAgentDocumentOperation(readOnlyGrant, { action: 'create', name: '禁止', content: 'no' }), /没有此钉钉文档操作权限/);
});
