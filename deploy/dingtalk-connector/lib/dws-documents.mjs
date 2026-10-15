const maxContentBytes = 512 * 1024;
const allowedDocumentHosts = new Set(['alidocs.dingtalk.com']);
const sensitiveKey = /(access.?token|refresh.?token|authorization|credential|client.?secret|device.?code|password|secret)/i;
const stableIdPattern = /^[a-zA-Z0-9._~-]{1,512}$/;

function fail(code) { throw new Error(code); }

function text(value, code, { maxLength, allowEmpty = false } = {}) {
  if (typeof value !== 'string' || value.includes('\0')) fail(code);
  const result = value.trim();
  if ((!allowEmpty && !result) || result.length > maxLength) fail(code);
  return allowEmpty ? value : result;
}

function content(value) {
  if (typeof value !== 'string' || value.includes('\0')) fail('DWS_DOC_CONTENT_INVALID');
  if (Buffer.byteLength(value, 'utf8') > maxContentBytes) fail('DWS_DOC_CONTENT_TOO_LARGE');
  return value;
}

function documentUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !allowedDocumentHosts.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) return undefined;
    url.hash = '';
    return url.toString();
  } catch { return undefined; }
}

export function validateDocumentNode(value) {
  const candidate = text(value, 'DWS_DOC_NODE_INVALID', { maxLength: 2048 });
  if (stableIdPattern.test(candidate) || documentUrl(candidate)) return candidate;
  fail('DWS_DOC_NODE_INVALID');
}

function safeScalar(value, maxLength = 500) {
  if (typeof value === 'string') return value.slice(0, maxLength);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean' || value === null) return value;
  return undefined;
}

export function redactDwsValue(value, depth = 0) {
  if (depth > 12) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 2000).map(item => redactDwsValue(item, depth + 1));
  if (!value || typeof value !== 'object') return safeScalar(value, 100_000);
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveKey.test(key)) continue;
    const sanitized = redactDwsValue(child, depth + 1);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

function operationFailure(payload) {
  const status = payload?.status;
  const codes = {
    partial_success: 'DWS_DOC_PARTIAL_SUCCESS', unknown: 'DWS_DOC_COMMIT_UNKNOWN',
    retryable: 'DWS_DOC_RETRYABLE_FAILURE', failed: 'DWS_DOC_OPERATION_FAILED',
  };
  const error = new Error(codes[status] || 'DWS_DOC_COMMIT_UNKNOWN');
  const nodeId = payload?.data?.nodeId;
  error.documentRecovery = {
    status: Object.hasOwn(codes, status) ? status : 'unknown', retryable: false,
    ...(typeof nodeId === 'string' && stableIdPattern.test(nodeId) ? { nodeId } : {}),
  };
  throw error;
}

export function parseDocumentOperation(payload) {
  if (payload?.error?.details?.contractVersion === 'doc.operation.v1') payload = payload.error.details;
  if (payload?.contractVersion !== 'doc.operation.v1' || payload?.complete !== true || payload?.status !== 'success') operationFailure(payload);
  const nodeId = payload?.data?.nodeId;
  if (typeof nodeId !== 'string' || !stableIdPattern.test(nodeId) || payload?.data?.verified !== true) fail('DWS_DOC_OPERATION_UNVERIFIED');
  const url = documentUrl(payload.data.documentUrl || payload.data.docUrl || payload.data.url);
  return { nodeId, verified: true, ...(url ? { url } : {}) };
}

export function parseDocumentContent(payload, expectedNode) {
  if (payload?.contractVersion !== 'doc.content.v1' || payload?.complete !== true || payload?.status !== 'success') fail('DWS_DOC_READBACK_FAILED');
  const nodeId = payload?.target?.canonicalId;
  if (typeof nodeId !== 'string' || !stableIdPattern.test(nodeId)) fail('DWS_DOC_READBACK_FAILED');
  if (expectedNode && stableIdPattern.test(expectedNode) && nodeId !== expectedNode) fail('DWS_DOC_READBACK_MISMATCH');
  if (payload.content === undefined) fail('DWS_DOC_READBACK_FAILED');
  return { nodeId, content: redactDwsValue(payload.content) };
}

function documentSummary(item) {
  if (!item || typeof item !== 'object') return null;
  const nodeId = item.nodeId || item.canonicalId || item.id;
  if (typeof nodeId !== 'string' || !stableIdPattern.test(nodeId)) return null;
  const nameValue = item.name || item.title;
  const name = typeof nameValue === 'string' ? nameValue.slice(0, 500) : undefined;
  const url = documentUrl(item.documentUrl || item.docUrl || item.url);
  return { nodeId, ...(name ? { name } : {}), ...(url ? { url } : {}) };
}

export function parseDocumentList(payload) {
  if (payload?.contractVersion !== 'doc.list.v1' || payload?.complete !== true || payload?.status !== 'success' || !Array.isArray(payload.documents) || (Array.isArray(payload.failures) && payload.failures.length)) fail('DWS_DOC_SEARCH_FAILED');
  const documents = payload.documents.map(documentSummary);
  if (documents.some(item => !item)) fail('DWS_DOC_SEARCH_FAILED');
  const nextCursor = typeof payload.nextCursor === 'string' && payload.nextCursor.length <= 2048 ? payload.nextCursor : undefined;
  return { documents, count: documents.length, hasMore: payload.hasMore === true, ...(nextCursor ? { nextCursor } : {}), ...(payload.truncated === true ? { truncated: true } : {}) };
}

function assertRequestId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value)) fail('DWS_DOC_REQUEST_ID_INVALID');
  return value;
}

async function writeWith(call, args, options) {
  let payload;
  try { payload = await call(args, options); }
  catch {
    const error = new Error('DWS_DOC_COMMIT_UNKNOWN');
    error.documentRecovery = { status: 'unknown', retryable: false };
    throw error;
  }
  return parseDocumentOperation(payload);
}

export function createDwsDocumentOperations({ withAuthenticatedProfile, writeOnce } = {}) {
  if (typeof withAuthenticatedProfile !== 'function' || typeof writeOnce !== 'function') throw new Error('DWS_DOC_RUNTIME_REQUIRED');

  async function createDocument(principal, input = {}) {
    const name = text(input.name, 'DWS_DOC_NAME_INVALID', { maxLength: 200 });
    const body = content(input.content);
    const requestId = assertRequestId(input.requestId);
    if (input.confirmed !== true) fail('DWS_DOC_CONFIRMATION_REQUIRED');
    if (input.folder !== undefined && input.workspace !== undefined) fail('DWS_DOC_LOCATION_INVALID');
    const location = input.folder !== undefined ? ['--folder', validateDocumentNode(input.folder)] : input.workspace !== undefined ? ['--workspace', validateDocumentNode(input.workspace)] : [];
    return withAuthenticatedProfile(principal, async ({ call, profile, ownerKey }) => writeOnce({ ownerKey, requestId, operation: 'create', input: { name, body, location }, work: async () => {
      const operation = await writeWith(call, ['doc', '+create', '--name', name, '--content', '-', ...location, '--yes', '--profile', profile.selector], { input: body, maxInputBytes: maxContentBytes });
      return { operation: 'create', ...operation };
    } }));
  }

  async function fetchDocument(principal, input = {}) {
    const node = validateDocumentNode(input.node);
    return withAuthenticatedProfile(principal, ({ call, profile }) => call(['doc', '+fetch', '--node', node, '--scope', 'full', '--profile', profile.selector]).then(payload => parseDocumentContent(payload, node)));
  }

  async function searchDocuments(principal, input = {}) {
    const query = text(input.query, 'DWS_DOC_QUERY_INVALID', { maxLength: 500 });
    const limit = input.limit === undefined ? 10 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 30) fail('DWS_DOC_LIMIT_INVALID');
    return withAuthenticatedProfile(principal, async ({ call, profile }) => parseDocumentList(await call(['doc', '+search', '--query', query, '--limit', String(limit), '--profile', profile.selector])));
  }

  async function updateDocument(principal, input = {}) {
    const node = validateDocumentNode(input.node);
    const requestId = assertRequestId(input.requestId);
    if (input.confirmed !== true) fail('DWS_DOC_CONFIRMATION_REQUIRED');
    if (!['append', 'overwrite'].includes(input.command)) fail('DWS_DOC_UPDATE_COMMAND_INVALID');
    const body = content(input.content);
    return withAuthenticatedProfile(principal, async ({ call, profile, ownerKey }) => writeOnce({ ownerKey, requestId, operation: 'update', input: { node, command: input.command, body }, work: async () => {
      const operation = await writeWith(call, ['doc', '+update', '--node', node, '--command', input.command, '--content', '-', '--yes', '--profile', profile.selector], { input: body, maxInputBytes: maxContentBytes });
      if (operation.nodeId !== node && stableIdPattern.test(node)) fail('DWS_DOC_OPERATION_MISMATCH');
      return { operation: 'update', ...operation };
    } }));
  }

  return { createDocument, fetchDocument, searchDocuments, updateDocument };
}
