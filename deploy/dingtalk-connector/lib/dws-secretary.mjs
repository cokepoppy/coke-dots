const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const uuid = /^[a-f0-9-]{36}$/i;
const stableId = /^[A-Za-z0-9._~-]{1,512}$/;

function fail(code) { throw new Error(code); }

function requiredText(value, code, maxLength) {
  if (typeof value !== 'string' || value.includes('\0')) fail(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) fail(code);
  return normalized;
}

function assertRequest(input, confirmationCode, idCode) {
  if (input.confirmed !== true) fail(confirmationCode);
  if (typeof input.requestId !== 'string' || !uuid.test(input.requestId)) fail(idCode);
  return input.requestId;
}

function extractSuccess(payload, code) {
  if (payload?.ok !== true || payload?.outcome !== 'success' || !payload.data || typeof payload.data !== 'object' || payload.data.executed === false) fail(code);
  return payload.data;
}

function writeResultId(data, keys, code) {
  for (const key of keys) {
    const candidate = data[key];
    if (typeof candidate === 'string' && stableId.test(candidate)) return candidate;
  }
  for (const key of ['event', 'task', 'message']) {
    const nested = data[key];
    if (!nested || typeof nested !== 'object') continue;
    for (const idKey of keys) {
      const candidate = nested[idKey];
      if (typeof candidate === 'string' && stableId.test(candidate)) return candidate;
    }
  }
  fail(code);
}

function parseTimestamp(value) {
  if (typeof value !== 'string' || value.length > 64 || !rfc3339.test(value) || !Number.isFinite(Date.parse(value))) fail('DWS_CALENDAR_RANGE_INVALID');
  return new Date(value).toISOString();
}

export function createDwsSecretaryOperations({ withAuthenticatedProfile, writeOnce }) {
  if (typeof withAuthenticatedProfile !== 'function' || typeof writeOnce !== 'function') throw new Error('DWS_SECRETARY_RUNTIME_REQUIRED');

  async function createCalendarEvent(principal, input = {}) {
    const title = requiredText(input.title, 'DWS_CALENDAR_TITLE_INVALID', 200);
    const start = parseTimestamp(input.start);
    const end = parseTimestamp(input.end);
    if (Date.parse(end) <= Date.parse(start) || Date.parse(end) - Date.parse(start) > 4 * 60 * 60_000) fail('DWS_CALENDAR_RANGE_INVALID');
    const description = typeof input.description === 'string' ? input.description.trim().slice(0, 1000) : '';
    const requestId = assertRequest(input, 'DWS_CALENDAR_CONFIRMATION_REQUIRED', 'DWS_CALENDAR_REQUEST_ID_INVALID');
    return withAuthenticatedProfile(principal, async ({ call, profile, ownerKey }) => writeOnce({ ownerKey, requestId, operation: 'calendar-create', input: { title, start, end, description, timezone: 'Asia/Shanghai' }, work: async () => {
      const args = ['calendar', '+book', '--title', title, '--start', input.start, '--end', input.end, '--yes', '--profile', profile.selector];
      if (description) args.push('--desc', description);
      const data = extractSuccess(await call(args, { timeoutMs: 60_000, maxBytes: 256 * 1024 }), 'DWS_CALENDAR_CREATE_FAILED');
      const eventId = writeResultId(data, ['eventId', 'id'], 'DWS_CALENDAR_CREATE_UNVERIFIED');
      return { eventId, title, start, end, verified: true };
    } }));
  }

  async function createPersonalTodo(principal, input = {}) {
    const title = requiredText(input.title, 'DWS_TODO_TITLE_INVALID', 200);
    if (typeof input.executorId !== 'string' || !/^\d{8,32}$/.test(input.executorId)) fail('DWS_TODO_EXECUTOR_INVALID');
    const due = parseTimestamp(input.due);
    const priority = input.priority === undefined ? 20 : input.priority;
    if (![10, 20, 30, 40].includes(priority)) fail('DWS_TODO_PRIORITY_INVALID');
    const requestId = assertRequest(input, 'DWS_TODO_CONFIRMATION_REQUIRED', 'DWS_TODO_REQUEST_ID_INVALID');
    return withAuthenticatedProfile(principal, async ({ call, profile, ownerKey }) => writeOnce({ ownerKey, requestId, operation: 'todo-create', input: { title, executorId: input.executorId, due, priority }, work: async () => {
      const data = extractSuccess(await call(['todo', '+create', '--title', title, '--executors', input.executorId, '--due', input.due, '--priority', String(priority), '--yes', '--profile', profile.selector], { timeoutMs: 60_000, maxBytes: 256 * 1024 }), 'DWS_TODO_CREATE_FAILED');
      const taskId = writeResultId(data, ['taskId', 'id'], 'DWS_TODO_CREATE_UNVERIFIED');
      return { taskId, title, due, priority, verified: true };
    } }));
  }

  async function sendCokeclawReport(principal, input = {}) {
    const content = requiredText(input.content, 'DWS_CHAT_CONTENT_INVALID', 4000);
    const requestId = assertRequest(input, 'DWS_CHAT_CONFIRMATION_REQUIRED', 'DWS_CHAT_REQUEST_ID_INVALID');
    return withAuthenticatedProfile(principal, async ({ call, profile, ownerKey }) => writeOnce({ ownerKey, requestId, operation: 'group-send-cokeclaw', input: { group: 'cokeclaw', content }, work: async () => {
      const data = extractSuccess(await call(['chat', '+send-to-group', '--group', 'cokeclaw', '--content', content, '--yes', '--profile', profile.selector], { timeoutMs: 60_000, maxBytes: 256 * 1024 }), 'DWS_CHAT_SEND_FAILED');
      const messageId = writeResultId(data, ['messageId', 'msgId', 'id'], 'DWS_CHAT_SEND_UNVERIFIED');
      return { group: 'cokeclaw', messageId, sent: true };
    } }));
  }

  return { createCalendarEvent, createPersonalTodo, sendCokeclawReport };
}
