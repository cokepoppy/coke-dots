import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
    const edited = store.createTask('Update this schedule while paused', 60);
    assert.equal(daily.notifyOnCompletion, true, 'Scheduled tasks should enable completion notices by default');
    assert.equal(interval.notifyOnCompletion, true, 'Legacy interval tasks should enable completion notices by default');
    store.updateTask(daily.id, { notifyOnCompletion: false });
    store.updateTask(edited.id, { scheduleSpec: { frequency: 'weekly', weekdays: [1, 3], time: '10:30', timeZone: 'Asia/Shanghai', endDate: '2026-12-31' }, scheduleMinutes: null, status: 'paused', nextRunAt: null });
    store.close();
    store = new Store(directory);
    assert.deepEqual(store.getTask(daily.id)?.scheduleSpec, { frequency: 'daily', time: '09:00', timeZone: 'Asia/Shanghai', endDate: '2026-12-31' });
    assert.equal(store.getTask(daily.id)?.notifyOnCompletion, false, 'A disabled completion notice must survive a database reopen');
    assert.deepEqual(store.getTask(interval.id)?.scheduleSpec, { frequency: 'interval', intervalMinutes: 60 });
    assert.equal(store.getTask(interval.id)?.notifyOnCompletion, true, 'A task setting change must not leak to another task');
    assert.deepEqual(store.getTask(edited.id)?.scheduleSpec, { frequency: 'weekly', weekdays: [1, 3], time: '10:30', timeZone: 'Asia/Shanghai', endDate: '2026-12-31' }, 'An edited calendar schedule must survive a database reopen');
    assert.equal(store.getTask(edited.id)?.scheduleMinutes, null);
    assert.equal(store.getTask(edited.id)?.status, 'paused');
    assert.equal(store.getTask(edited.id)?.nextRunAt, null);
    assert.deepEqual(scheduleForTask(null, 60), { frequency: 'interval', intervalMinutes: 60 });
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('old task tables migrate completion notices on without changing existing schedules', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-schedule-migration-'));
  try {
    let store = new Store(directory);
    const task = store.createTask('Keep the legacy hourly check', 60);
    store.close();
    const database = new DatabaseSync(join(directory, 'dots.db'));
    try { database.exec('ALTER TABLE tasks DROP COLUMN notify_on_completion'); }
    finally { database.close(); }
    store = new Store(directory);
    const migrated = store.getTask(task.id);
    assert.equal(migrated?.notifyOnCompletion, true, 'Existing tasks must receive the enabled default when the column is added');
    assert.deepEqual(migrated?.scheduleSpec, { frequency: 'interval', intervalMinutes: 60 });
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
