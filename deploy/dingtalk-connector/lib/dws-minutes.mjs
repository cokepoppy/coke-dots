const maximumQueryLength = 200;
const maximumMinutes = 50;
const maximumSummaryLength = 24_000;
const sensitiveKey = /(access.?token|refresh.?token|authorization|credential|client.?secret|password|cookie|signature|signed.?url)/i;

function fail(code) { throw new Error(code); }

function requiredQuery(value) {
  if (typeof value !== 'string' || value.includes('\0')) fail('DWS_MINUTES_QUERY_INVALID');
  const query = value.trim();
  if (query.length < 2 || query.length > maximumQueryLength) fail('DWS_MINUTES_QUERY_INVALID');
  return query;
}

function requiredTaskUuid(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._~-]{1,512}$/.test(value)) fail('DWS_MINUTES_ID_INVALID');
  return value;
}

function cleanText(value) {
  return value.slice(0, maximumSummaryLength)
    .replace(/https?:\/\/[^\s)\]>]+/gi, '[链接已省略]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|app[_-]?secret)\s*[:=]\s*[^\s,;]+/gi, '[凭据已隐藏]');
}

function safeMetadata(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const taskUuid = typeof item.taskUuid === 'string' ? requiredTaskUuid(item.taskUuid) : '';
  const title = typeof item.title === 'string' ? cleanText(item.title) : '';
  if (!taskUuid || !title) return null;
  return {
    taskUuid,
    title,
    ...(typeof item.startTime === 'number' && Number.isFinite(item.startTime) ? { startTime: item.startTime } : {}),
    ...(typeof item.duration === 'number' && Number.isFinite(item.duration) ? { duration: item.duration } : {}),
    ...(typeof item.status === 'number' || typeof item.status === 'string' ? { status: item.status } : {}),
    ...(typeof item.orgName === 'string' ? { orgName: cleanText(item.orgName) } : {}),
  };
}

export function createDwsMinutesOperations({ withAuthenticatedProfile }) {
  if (typeof withAuthenticatedProfile !== 'function') throw new Error('DWS_MINUTES_RUNTIME_REQUIRED');
  return {
    async search(principal, input = {}) {
      const query = requiredQuery(input.query);
      const scope = input.scope === undefined ? 'all' : input.scope;
      if (!['mine', 'shared', 'all'].includes(scope)) fail('DWS_MINUTES_QUERY_INVALID');
      return withAuthenticatedProfile(principal, async ({ call, profile }) => {
        const payload = await call(['minutes', '+search', '--scope', scope, '--query', query, '--page-all', '--profile', profile.selector], { timeoutMs: 90_000, maxBytes: 2 * 1024 * 1024 });
        if (payload?.ok !== true || payload?.outcome !== 'success' || !payload.data || !Array.isArray(payload.data.minutes)) fail('DWS_MINUTES_SEARCH_FAILED');
        const source = payload.data.minutes;
        const minutes = source.slice(0, maximumMinutes).map(safeMetadata);
        if (minutes.some(item => item === null)) fail('DWS_MINUTES_SEARCH_FAILED');
        const complete = payload.data.complete === true && source.length <= maximumMinutes;
        return {
          scope,
          query,
          count: Number.isSafeInteger(payload.data.count) ? payload.data.count : source.length,
          minutes,
          complete,
          ...(payload.data.complete !== undefined ? { sourceComplete: payload.data.complete === true } : {}),
          ...(Number.isSafeInteger(payload.data.pages) ? { pages: payload.data.pages } : {}),
          ...(Number.isSafeInteger(payload.data.scannedCount) ? { scannedCount: payload.data.scannedCount } : {}),
          ...(Array.isArray(payload.data.scopeLedger) ? { scopeLedger: payload.data.scopeLedger.slice(0, 3).map(item => ({ scope: String(item?.scope || '').slice(0, 16), complete: item?.complete === true, count: Number.isSafeInteger(item?.count) ? item.count : 0 })) } : {}),
          ...(payload.meta?.pagination && typeof payload.meta.pagination.endpoint_exhausted === 'boolean' ? { endpointExhausted: payload.meta.pagination.endpoint_exhausted } : {}),
        };
      });
    },
    async detail(principal, input = {}) {
      const taskUuid = requiredTaskUuid(input.taskUuid);
      return withAuthenticatedProfile(principal, async ({ call, profile }) => {
        const payload = await call(['minutes', '+detail', '--id', taskUuid, '--artifacts', 'basic,summary,keywords', '--profile', profile.selector], { timeoutMs: 60_000, maxBytes: 2 * 1024 * 1024 });
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('DWS_MINUTES_DETAIL_FAILED');
        const basic = payload.basic?.result;
        const summaryResult = payload.summary?.result;
        const summary = typeof summaryResult?.fullSummary === 'string' ? cleanText(summaryResult.fullSummary) : '';
        const summaryReady = (payload.summary?.success === true || payload.summary?.success === 'true') && summary.length > 0;
        const failureCount = Number.isSafeInteger(payload.failureCount) && payload.failureCount >= 0 ? payload.failureCount : (summaryReady ? 0 : 1);
        const keywordsValue = payload.keywords?.result?.keywords;
        const keywords = Array.isArray(keywordsValue)
          ? keywordsValue.filter(item => typeof item === 'string').slice(0, 30).map(item => cleanText(item))
          : [];
        return {
          taskUuid,
          ...(typeof basic?.title === 'string' ? { title: cleanText(basic.title) } : {}),
          ...(typeof basic?.startTime === 'number' && Number.isFinite(basic.startTime) ? { startTime: basic.startTime } : {}),
          ...(typeof basic?.duration === 'number' && Number.isFinite(basic.duration) ? { duration: basic.duration } : {}),
          ...(summaryReady ? { summary } : {}),
          ...(keywords.length ? { keywords } : {}),
          complete: payload.complete === true && summaryReady && failureCount === 0,
          failureCount,
          ...(payload.complete !== true ? { sourceComplete: false } : {}),
        };
      });
    },
  };
}
