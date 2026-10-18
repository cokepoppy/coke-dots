import assert from 'node:assert/strict';
import test from 'node:test';
import { createDwsMinutesOperations } from '../deploy/dingtalk-connector/lib/dws-minutes.mjs';

test('DWS minutes search is read-only, scoped to the selected profile, complete, and strips URL metadata', async () => {
  const calls = [];
  const operation = createDwsMinutesOperations({
    async withAuthenticatedProfile(principal, work) {
      assert.deepEqual(principal, { tenantId: 'tenant-a', userId: 'user-a' });
      return work({ profile: { selector: 'cms-profile' }, call: async (args, options) => {
        calls.push({ args, options });
        return {
          ok: true, outcome: 'success',
          data: { complete: true, count: 1, pages: 2, scannedCount: 1, scopeLedger: [{ scope: 'mine', complete: true, count: 1 }, { scope: 'shared', complete: true, count: 0 }], minutes: [{ taskUuid: 'task_uuid-1', title: '规则评审听记', startTime: 1792269863000, duration: 134191, status: 14, orgName: 'cms', url: 'https://example.test/private?access_token=secret', secret: 'must-not-leak' }] },
          meta: { pagination: { endpoint_exhausted: true } },
        };
      }, });
    },
  });
  const result = await operation.search({ tenantId: 'tenant-a', userId: 'user-a' }, { query: '规则评审', scope: 'all' });
  assert.equal(result.complete, true);
  assert.equal(result.count, 1);
  assert.equal(result.minutes[0].taskUuid, 'task_uuid-1');
  assert.equal('url' in result.minutes[0], false);
  assert.equal('secret' in result.minutes[0], false);
  assert.deepEqual(calls[0].args.slice(0, 7), ['minutes', '+search', '--scope', 'all', '--query', '规则评审', '--page-all']);
  assert(calls[0].args.includes('--profile') && calls[0].args.includes('cms-profile'));
  assert.equal(calls[0].options.timeoutMs, 90_000);
});

test('DWS minutes search preserves an incomplete page-all result and rejects empty/invalid query', async () => {
  const operation = createDwsMinutesOperations({
    async withAuthenticatedProfile(_principal, work) {
      return work({ profile: { selector: 'profile' }, call: async () => ({
        ok: true, outcome: 'success', data: { complete: false, count: 1, minutes: [{ taskUuid: 'task-1', title: '候选' }] },
      }) });
    },
  });
  assert.equal((await operation.search({ tenantId: 't', userId: 'u' }, { query: '候选' })).complete, false);
  await assert.rejects(operation.search({ tenantId: 't', userId: 'u' }, { query: ' ' }), /DWS_MINUTES_QUERY_INVALID/);
  await assert.rejects(operation.search({ tenantId: 't', userId: 'u' }, { query: '候选', scope: 'unbounded' }), /DWS_MINUTES_QUERY_INVALID/);
});

test('DWS minutes detail returns the real summary without signed URLs and preserves partial state', async () => {
  const calls = [];
  const payloads = [
    {
      complete: true, failureCount: 0,
      basic: { success: true, result: { taskUuid: 'task_uuid-1', title: '规则评审', startTime: 1792269863000, duration: 134191, url: 'https://example.test/?signature=hidden' } },
      summary: { success: 'true', result: { fullSummary: '结论：规则于 10 月 26 日生效。参考 https://example.test/?token=hidden' } },
      keywords: { success: true, result: { keywords: ['规则', '交易终端'] } },
    },
    { complete: false, failureCount: 1, basic: { success: true, result: { title: '规则评审' } }, summary: { success: false, result: {} } },
  ];
  const operation = createDwsMinutesOperations({
    async withAuthenticatedProfile(_principal, work) {
      return work({ profile: { selector: 'profile' }, call: async args => { calls.push(args); return payloads.shift(); } });
    },
  });
  const detail = await operation.detail({ tenantId: 't', userId: 'u' }, { taskUuid: 'task_uuid-1' });
  assert.equal(detail.complete, true);
  assert.match(detail.summary, /规则于 10 月 26 日生效/);
  assert.equal(detail.summary.includes('https://'), false);
  assert.deepEqual(detail.keywords, ['规则', '交易终端']);
  assert.deepEqual(calls[0].slice(0, 6), ['minutes', '+detail', '--id', 'task_uuid-1', '--artifacts', 'basic,summary,keywords']);
  const partial = await operation.detail({ tenantId: 't', userId: 'u' }, { taskUuid: 'task-2' });
  assert.equal(partial.complete, false);
  assert.equal(partial.failureCount, 1);
  await assert.rejects(operation.detail({ tenantId: 't', userId: 'u' }, { taskUuid: 'not valid' }), /DWS_MINUTES_ID_INVALID/);
});
