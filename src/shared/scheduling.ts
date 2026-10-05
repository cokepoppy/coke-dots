export type ScheduleSpec =
  | { frequency: 'interval'; intervalMinutes: number }
  | { frequency: 'daily'; time: string; timeZone: string; endDate?: string | null }
  | { frequency: 'weekly'; weekdays: number[]; time: string; timeZone: string; endDate?: string | null };

interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

const weekdayNumber: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function validateScheduleSpec(value: unknown): ScheduleSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid schedule');
  const input = value as Record<string, unknown>;
  if (input.frequency === 'interval') {
    const intervalMinutes = Number(input.intervalMinutes);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10080) throw new Error('Interval must be 1–10080 minutes');
    return { frequency: 'interval', intervalMinutes };
  }
  if (input.frequency !== 'daily' && input.frequency !== 'weekly') throw new Error('Invalid schedule frequency');
  const time = typeof input.time === 'string' ? input.time : '';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Schedule time must use HH:mm');
  const timeZone = typeof input.timeZone === 'string' ? input.timeZone.trim() : '';
  if (!timeZone || timeZone.length > 100) throw new Error('A valid time zone is required');
  try { new Intl.DateTimeFormat('en-US', { timeZone }).format(0); }
  catch { throw new Error('Invalid time zone'); }
  const endDate = input.endDate == null || input.endDate === '' ? null : String(input.endDate);
  if (endDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw new Error('End date must be a valid calendar date');
    const parsedEndDate = new Date(`${endDate}T00:00:00.000Z`);
    if (Number.isNaN(parsedEndDate.getTime()) || parsedEndDate.toISOString().slice(0, 10) !== endDate) throw new Error('End date must be a valid calendar date');
  }
  if (input.frequency === 'daily') return { frequency: 'daily', time, timeZone, endDate };
  if (!Array.isArray(input.weekdays)) throw new Error('Select at least one weekday');
  const weekdays = [...new Set(input.weekdays.map(Number))];
  if (!weekdays.length || weekdays.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error('Select at least one weekday');
  return { frequency: 'weekly', weekdays: weekdays.sort((a, b) => a - b), time, timeZone, endDate };
}

export function scheduleForTask(scheduleSpec: ScheduleSpec | null | undefined, scheduleMinutes: number | null): ScheduleSpec | null {
  if (scheduleSpec) return scheduleSpec;
  return scheduleMinutes === null ? null : { frequency: 'interval', intervalMinutes: scheduleMinutes };
}

export function describeSchedule(spec: ScheduleSpec): string {
  if (spec.frequency === 'interval') return `Every ${spec.intervalMinutes} minutes`;
  const suffix = spec.endDate ? ` · until ${spec.endDate}` : '';
  if (spec.frequency === 'daily') return `Daily at ${spec.time} (${spec.timeZone})${suffix}`;
  const days = spec.weekdays.map(day => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]).join(', ');
  return `Weekly on ${days} at ${spec.time} (${spec.timeZone})${suffix}`;
}

export function nextScheduleOccurrence(spec: ScheduleSpec, after: Date): string | null {
  const valid = validateScheduleSpec(spec);
  if (valid.frequency === 'interval') return new Date(after.getTime() + valid.intervalMinutes * 60_000).toISOString();
  const start = zonedParts(after, valid.timeZone);
  const today = `${start.year.toString().padStart(4, '0')}-${start.month.toString().padStart(2, '0')}-${start.day.toString().padStart(2, '0')}`;
  for (let offset = 0; offset <= 7; offset++) {
    const date = addCalendarDays(today, offset);
    if (valid.endDate && date > valid.endDate) return null;
    if (valid.frequency === 'weekly' && !valid.weekdays.includes(weekdayAt(date))) continue;
    const candidate = localDateTimeToInstant(date, valid.time, valid.timeZone);
    if (candidate && candidate.getTime() > after.getTime()) return candidate.toISOString();
  }
  return null;
}

function localDateTimeToInstant(date: string, time: string, timeZone: string): Date | null {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const intendedWallTime = Date.UTC(year, month - 1, day, hour, minute);
  // During the spring DST jump, a requested wall-clock minute may not exist. Move it
  // forward to the first valid local minute instead of silently dropping that run.
  for (let gapMinutes = 0; gapMinutes <= 180; gapMinutes++) {
    const targetWallTime = intendedWallTime + gapMinutes * 60_000;
    let guess = targetWallTime;
    for (let attempt = 0; attempt < 8; attempt++) {
      const actual = zonedParts(new Date(guess), timeZone);
      const actualWallTime = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
      const adjustment = targetWallTime - actualWallTime;
      if (adjustment === 0) break;
      guess += adjustment;
    }
    const result = new Date(guess);
    const actual = zonedParts(result, timeZone);
    const targetDate = new Date(targetWallTime);
    if (actual.year === targetDate.getUTCFullYear() && actual.month === targetDate.getUTCMonth() + 1 && actual.day === targetDate.getUTCDate()
      && actual.hour === targetDate.getUTCHours() && actual.minute === targetDate.getUTCMinutes()) return result;
  }
  return null;
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
    formatterCache.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), weekday: weekdayNumber[parts.weekday] };
}

function addCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return `${next.getUTCFullYear().toString().padStart(4, '0')}-${(next.getUTCMonth() + 1).toString().padStart(2, '0')}-${next.getUTCDate().toString().padStart(2, '0')}`;
}

function weekdayAt(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}
