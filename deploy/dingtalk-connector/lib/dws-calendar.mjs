const maximumRangeMs = 31 * 24 * 60 * 60 * 1000;
const maximumPages = 5;
const pageSize = 100;
const sensitiveKey = /(access.?token|refresh.?token|authorization|credential|client.?secret|device.?code|password|secret|cookie)/i;

function fail(code) { throw new Error(code); }

export function validateCalendarRange(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('DWS_CALENDAR_RANGE_INVALID');
  const hasStart = input.start !== undefined;
  const hasEnd = input.end !== undefined;
  if (hasStart !== hasEnd) fail('DWS_CALENDAR_RANGE_INVALID');
  const start = hasStart ? parseTimestamp(input.start) : now;
  const end = hasEnd ? parseTimestamp(input.end) : now + 7 * 24 * 60 * 60 * 1000;
  if (end <= start || end - start > maximumRangeMs) fail('DWS_CALENDAR_RANGE_INVALID');
  const cursor = input.cursor === undefined ? '' : String(input.cursor);
  if (cursor.length > 2048 || cursor.includes('\0')) fail('DWS_CALENDAR_CURSOR_INVALID');
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), cursor };
}

function parseTimestamp(value) {
  if (typeof value !== 'string' || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) fail('DWS_CALENDAR_RANGE_INVALID');
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() === 'Invalid Date') fail('DWS_CALENDAR_RANGE_INVALID');
  return parsed;
}

function safeValue(value, depth = 0) {
  if (depth > 8) return '[truncated]';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.slice(0, 4000);
  if (Array.isArray(value)) return value.slice(0, 100).map(item => safeValue(item, depth + 1)).filter(item => item !== undefined);
  if (!value || typeof value !== 'object') return undefined;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveKey.test(key)) continue;
    const safe = safeValue(child, depth + 1);
    if (safe !== undefined) result[key.slice(0, 100)] = safe;
  }
  return result;
}

function parsePage(payload) {
  const page = payload?.result && !Array.isArray(payload.result) ? payload.result : payload;
  const events = Array.isArray(payload?.result) ? payload.result :
    Array.isArray(page?.events) ? page.events : Array.isArray(page?.items) ? page.items : null;
  if (payload?.success !== true || !events) fail('DWS_CALENDAR_LIST_FAILED');
  const nextCursor = page?.nextCursor ?? page?.next_cursor;
  const hasMore = page?.hasMore ?? page?.has_more;
  if (hasMore !== undefined && typeof hasMore !== 'boolean') fail('DWS_CALENDAR_LIST_FAILED');
  if (nextCursor !== undefined && (typeof nextCursor !== 'string' && typeof nextCursor !== 'number')) fail('DWS_CALENDAR_LIST_FAILED');
  if (hasMore === true && (nextCursor === undefined || nextCursor === '')) fail('DWS_CALENDAR_LIST_FAILED');
  return { events, nextCursor: nextCursor === undefined || nextCursor === '' ? undefined : String(nextCursor).slice(0, 2048) };
}

export function createDwsCalendarOperations({ withAuthenticatedProfile }) {
  return {
    async listEvents(principal, input) {
      const range = validateCalendarRange(input);
      return withAuthenticatedProfile(principal, async ({ call, profile }) => {
        const events = [];
        let cursor = range.cursor;
        let pages = 0;
        while (pages < maximumPages && events.length < maximumPages * pageSize) {
          const args = ['calendar', 'event', 'list', '--start', range.start, '--end', range.end, '--limit', String(pageSize)];
          if (cursor) args.push('--cursor', cursor);
          args.push('--profile', profile.selector);
          const payload = await call(args, { timeoutMs: 60_000, maxBytes: 1024 * 1024 });
          const page = parsePage(payload);
          for (const event of page.events.slice(0, pageSize)) {
            const safe = safeValue(event);
            if (safe && typeof safe === 'object' && !Array.isArray(safe)) events.push(safe);
          }
          pages += 1;
          if (!page.nextCursor) return { events, count: events.length, complete: true, start: range.start, end: range.end };
          if (page.nextCursor === cursor) fail('DWS_CALENDAR_LIST_FAILED');
          cursor = page.nextCursor;
        }
        return { events: events.slice(0, maximumPages * pageSize), count: events.length, complete: false, nextCursor: cursor, start: range.start, end: range.end };
      });
    },
  };
}
