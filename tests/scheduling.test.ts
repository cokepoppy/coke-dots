import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { nextScheduleOccurrence, scheduleForTask, validateScheduleSpec } from '../src/shared/scheduling.ts';

test('daily recurrence is calculated in the requested time zone', () => {
  const schedule = validateScheduleSpec({ frequency: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' });
  assert.equal(nextScheduleOccurrence(schedule, new Date('2026-10-04T23:00:00.000Z')), '2026-10-05T01:00:00.000Z');
});

test('weekly recurrence picks the next selected local weekday', () => {
  const schedule = validateScheduleSpec({ frequency: 'weekly', weekdays: [1], time: '09:00', timeZone: 'Asia/Shanghai' });
  assert.equal(nextScheduleOccurrence(schedule, new Date('2026-10-04T23:00:00.000Z')), '2026-10-05T01:00:00.000Z');
  assert.equal(nextScheduleOccurrence(schedule, new Date('2026-10-05T02:00:00.000Z')), '2026-10-12T01:00:00.000Z');
});

test('a nonexistent daylight-saving wall time advances to the first valid minute', () => {
  const schedule = validateScheduleSpec({ frequency: 'weekly', weekdays: [0], time: '02:30', timeZone: 'America/New_York' });
  assert.equal(nextScheduleOccurrence(schedule, new Date('2025-03-08T12:00:00.000Z')), '2025-03-09T07:00:00.000Z');
});

test('a schedule has no next occurrence past its inclusive end date', () => {
  const schedule = validateScheduleSpec({ frequency: 'daily', time: '08:00', timeZone: 'Asia/Shanghai', endDate: '2026-10-05' });
  assert.equal(nextScheduleOccurrence(schedule, new Date('2026-10-05T01:00:01.000Z')), null);
});

test('invalid calendar recurrence fields are rejected', () => {
  assert.throws(() => validateScheduleSpec({ frequency: 'weekly', weekdays: [], time: '09:00', timeZone: 'UTC' }), /weekday/);
  assert.throws(() => validateScheduleSpec({ frequency: 'daily', time: '25:00', timeZone: 'UTC' }), /HH:mm/);
  assert.throws(() => validateScheduleSpec({ frequency: 'daily', time: '09:00', timeZone: 'Mars/Olympus' }), /time zone/);
  assert.throws(() => validateScheduleSpec({ frequency: 'daily', time: '09:00', timeZone: 'UTC', endDate: '2026-02-31' }));
});

test('calendar recurrence survives SQLite reopen and old interval records remain readable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-schedule-'));
  try {
    let store = new Store(directory);
    const daily = store.createTask('Review the daily launch notes', null, 'model', 'legacy', {
      frequency: 'daily', time: '09:00', timeZone: 'Asia/Shanghai', endDate: '2026-12-31',
    }, '2026-10-06T01:00:00.000Z');
    const interval = store.createTask('Check the page every hour', 60);
    store.close();
    store = new Store(directory);
    assert.deepEqual(store.getTask(daily.id)?.scheduleSpec, { frequency: 'daily', time: '09:00', timeZone: 'Asia/Shanghai', endDate: '2026-12-31' });
    assert.deepEqual(store.getTask(interval.id)?.scheduleSpec, { frequency: 'interval', intervalMinutes: 60 });
    assert.deepEqual(scheduleForTask(null, 60), { frequency: 'interval', intervalMinutes: 60 });
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
