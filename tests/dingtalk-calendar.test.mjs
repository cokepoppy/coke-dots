import assert from 'node:assert/strict';
import test from 'node:test';
import { createDwsCalendarOperations, validateCalendarRange } from '../deploy/dingtalk-connector/lib/dws-calendar.mjs';

test('DWS calendar query defaults to the next seven days and validates bounded timezone-aware ranges', () => {
  const now = Date.parse('2026-10-16T00:00:00.000Z');
  const defaults = validateCalendarRange({}, now);
  assert.equal(defaults.start, '2026-10-16T00:00:00.000Z');
  assert.equal(defaults.end, '2026-10-23T00:00:00.000Z');
  const explicit = validateCalendarRange({ start: '2026-10-16T09:00:00+08:00', end: '2026-10-17T09:00:00+08:00' });
  assert.equal(explicit.start, '2026-10-16T01:00:00.000Z');
  assert.equal(explicit.end, '2026-10-17T01:00:00.000Z');
  assert.throws(() => validateCalendarRange({ start: '2026-10-16', end: '2026-10-17' }), /DWS_CALENDAR_RANGE_INVALID/);
  assert.throws(() => validateCalendarRange({ start: '2026-10-16T00:00:00Z' }), /DWS_CALENDAR_RANGE_INVALID/);
  assert.throws(() => validateCalendarRange({ start: '2026-10-17T00:00:00Z', end: '2026-10-16T00:00:00Z' }), /DWS_CALENDAR_RANGE_INVALID/);
  assert.throws(() => validateCalendarRange({ start: '2026-10-01T00:00:00Z', end: '2026-11-15T00:00:00Z' }), /DWS_CALENDAR_RANGE_INVALID/);
  assert.throws(() => validateCalendarRange({ cursor: 'x'.repeat(2049) }), /DWS_CALENDAR_CURSOR_INVALID/);
});

test('DWS calendar listing uses the isolated profile, explicit dates, bounded pagination, and redacts sensitive event fields', async () => {
  const calls = [];
  const pages = [
    { success: true, result: { events: [{ eventId: 'event-1', title: '值班交接', description: 'check logs', accessToken: 'must-not-leak' }], hasMore: true, nextCursor: 'page-2' } },
    { success: true, result: [{ eventId: 'event-2', summary: '周会', credentials: { password: 'must-not-leak' } }] },
  ];
  const operation = createDwsCalendarOperations({
    async withAuthenticatedProfile(principal, work) {
      assert.equal(principal.tenantId, 'tenant-a');
      return work({ profile: { selector: 'tenant-a-profile' }, call: async args => { calls.push(args); return pages.shift(); } });
    },
  });
  const result = await operation.listEvents({ tenantId: 'tenant-a', userId: 'user-a' }, {
    start: '2026-10-16T00:00:00Z', end: '2026-10-18T00:00:00Z',
  });
  assert.equal(result.count, 2);
  assert.equal(result.complete, true);
  assert.equal(result.events[0].title, '值班交接');
  assert.equal('accessToken' in result.events[0], false);
  assert.equal('credentials' in result.events[1], false);
  assert.deepEqual(calls.map(args => args.slice(0, 3)), [['calendar', 'event', 'list'], ['calendar', 'event', 'list']]);
  assert(calls[0].includes('--start') && calls[0].includes('--end') && calls[0].includes('--profile') && calls[0].includes('tenant-a-profile'));
  assert(calls[1].includes('--cursor') && calls[1].includes('page-2'));
});

test('DWS calendar listing rejects incomplete and repeated pagination cursors', async () => {
  const operation = createDwsCalendarOperations({
    async withAuthenticatedProfile(_principal, work) {
      let calls = 0;
      return work({ profile: { selector: 'profile' }, call: async () => {
        calls += 1;
        return calls === 1 ? { success: true, result: { events: [], hasMore: true, nextCursor: 'same' } } : { success: true, result: { events: [], hasMore: true, nextCursor: 'same' } };
      } });
    },
  });
  await assert.rejects(operation.listEvents({ tenantId: 't', userId: 'u' }, {}), /DWS_CALENDAR_LIST_FAILED/);
});

test('DWS calendar listing rejects a response that promises another page without a cursor', async () => {
  const operation = createDwsCalendarOperations({
    async withAuthenticatedProfile(_principal, work) {
      return work({ profile: { selector: 'profile' }, call: async () => ({ success: true, result: { events: [], hasMore: true } }) });
    },
  });
  await assert.rejects(operation.listEvents({ tenantId: 't', userId: 'u' }, {}), /DWS_CALENDAR_LIST_FAILED/);
});
