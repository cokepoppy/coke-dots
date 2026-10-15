import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';
import {
  createDingtalkConnectorGateway,
  issuePrincipalTicket,
  openProfileBytes,
  parseEncryptionKey,
  sealProfileBytes,
} from '../deploy/dingtalk-connector/gateway.mjs';
import { parseAuthStatus } from '../deploy/dingtalk-connector/lib/dws-runtime.mjs';

test('verified DWS identity carries only the organization identifier needed for Stream matching', () => {
  const profile = { corpId: 'corp-one', userId: 'user-one' };
  const payload = { success: true, authenticated: true, corp_id: 'corp-one', user_id: 'user-one', token_valid: true,
    expires_at: new Date(Date.now() + 60_000).toISOString(), user_name: 'Dot user', corp_name: 'Test org' };
  assert.deepEqual(parseAuthStatus(payload, profile), {
    authenticated: true, corpId: 'corp-one', expiresAt: payload.expires_at, accountName: 'Dot user', organizationName: 'Test org',
  });
  assert.throws(() => parseAuthStatus({ ...payload, corp_id: 'another-corp' }, profile), /DWS_PROFILE_MISMATCH/);
  assert.deepEqual(parseAuthStatus({ success: true, authenticated: false }, profile), { authenticated: false });
});

test('DWS profile archives are authenticated and bound to one tenant/user identity', () => {
  const key = randomBytes(32);
  const archive = Buffer.from('fake-dws-token-that-must-never-be-stored-plaintext');
  const encrypted = sealProfileBytes(archive, 'principal-alpha', key);
  assert.notEqual(encrypted.toString('utf8').includes(archive.toString('utf8')), true);
  assert.deepEqual(openProfileBytes(encrypted, 'principal-alpha', key), archive);
  assert.throws(() => openProfileBytes(encrypted, 'principal-beta', key));
  assert.throws(() => openProfileBytes(encrypted, 'principal-alpha', randomBytes(32)));
  assert.deepEqual(parseEncryptionKey(key.toString('base64')), key);
  assert.throws(() => parseEncryptionKey('not-a-secret'));
});

test('DingTalk gateway completes isolated device authorization, search and encrypted profile recovery', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'coke-dots-dingtalk-gateway-'));
  const binary = path.join(root, 'fake-dws.mjs');
  const profilesFile = 'profiles.json';
  await writeFile(binary, `#!${process.execPath}
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const [group, command] = process.argv.slice(2);
const config = process.env.DWS_CONFIG_DIR;
const profileFile = path.join(config, '${profilesFile}');
const tokenFile = path.join(config, 'credentials.json');
await mkdir(config, { recursive: true });
const readProfiles = async () => { try { return JSON.parse(await readFile(profileFile, 'utf8')); } catch { return []; } };
const args = process.argv.slice(2);
const docsPath = path.join(process.env.XDG_DATA_HOME, 'docs.json');
const readDocs = async () => { try { return JSON.parse(await readFile(docsPath, 'utf8')); } catch { return []; } };
const readStdin = async () => { const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); return Buffer.concat(chunks).toString('utf8'); };
if (group === 'profile' && command === 'list') {
  const profiles = await readProfiles();
  console.log(JSON.stringify({ success: true, profiles }));
} else if (group === 'auth' && command === 'login') {
  process.stderr.write('Open https://login.dingtalk.com/oauth2/device?user_code=E2E-DEVICE&device_code=DO-NOT-LEAK\\n');
  await new Promise(resolve => setTimeout(resolve, 120));
  await writeFile(profileFile, JSON.stringify([{ corpId: 'corp-e2e', userId: 'user-e2e', isCurrent: true, isOrgCurrent: true }]));
  await writeFile(tokenFile, 'fake-dws-token-that-must-never-be-stored-plaintext');
  console.log(JSON.stringify({ success: true, token_valid: true, corp_id: 'corp-e2e', user_id: 'user-e2e' }));
} else if (group === 'auth' && command === 'status') {
  console.log(JSON.stringify({ success: true, authenticated: true, token_valid: true, corp_id: 'corp-e2e', user_id: 'user-e2e', corp_name: '测试组织', user_name: '测试用户', expires_at: '2099-01-01T00:00:00.000Z' }));
} else if (group === 'chat' && command === 'search') {
  console.log(JSON.stringify({ success: true, result: { query: '告警', chats: [{ openConversationId: 'cid-alerts', name: '系统监控告警群' }], hasMore: true, nextCursor: 'next-page', complete: false } }));
} else if (group === 'doc' && command === '+create') {
  const name = args[args.indexOf('--name') + 1];
  const body = await readStdin();
  const docs = await readDocs();
  const nodeId = 'doc-' + (docs.length + 1);
  docs.push({ nodeId, name, content: body });
  await writeFile(docsPath, JSON.stringify(docs));
  if (name === 'unknown-create') { process.stderr.write('simulated response lost after remote write\\n'); process.exitCode = 2; }
  else console.log(JSON.stringify({ contractVersion: 'doc.operation.v1', complete: true, status: 'success', data: { nodeId, verified: true, documentUrl: 'https://alidocs.dingtalk.com/document/edit?docId=' + nodeId } }));
} else if (group === 'doc' && command === '+search') {
  const query = args[args.indexOf('--query') + 1];
  const limit = Number(args[args.indexOf('--limit') + 1]);
  const documents = (await readDocs()).filter(doc => (doc.name + '\\n' + doc.content).toLowerCase().includes(query.toLowerCase())).slice(0, limit);
  console.log(JSON.stringify({ contractVersion: 'doc.list.v1', complete: true, status: 'success', documents, hasMore: false }));
} else if (group === 'doc' && command === '+fetch') {
  const nodeId = args[args.indexOf('--node') + 1];
  const doc = (await readDocs()).find(item => item.nodeId === nodeId);
  if (!doc) { console.log(JSON.stringify({ contractVersion: 'doc.content.v1', complete: false, status: 'failed' })); }
  else console.log(JSON.stringify({ contractVersion: 'doc.content.v1', complete: true, status: 'success', target: { canonicalId: nodeId }, content: { body: doc.content, credentials: { accessToken: 'MUST-NOT-LEAK' } } }));
} else if (group === 'doc' && command === '+update') {
  const nodeId = args[args.indexOf('--node') + 1];
  const action = args[args.indexOf('--command') + 1];
  const body = await readStdin();
  const docs = await readDocs();
  const doc = docs.find(item => item.nodeId === nodeId);
  if (!doc) { console.log(JSON.stringify({ contractVersion: 'doc.operation.v1', complete: true, status: 'failed' })); }
  else {
    doc.content = action === 'append' ? doc.content + '\\n' + body : body;
    await writeFile(docsPath, JSON.stringify(docs));
    console.log(JSON.stringify({ contractVersion: 'doc.operation.v1', complete: true, status: 'success', data: { nodeId, verified: true, documentUrl: 'https://alidocs.dingtalk.com/document/edit?docId=' + nodeId } }));
  }
} else if (group === 'calendar' && command === 'event' && args[2] === 'list') {
  console.log(JSON.stringify({ success: true, result: { events: [{ eventId: 'event-1', title: '排障复盘', description: '讨论 trace-live-1', accessToken: 'MUST-NOT-LEAK' }], hasMore: false } }));
} else if (group === 'event' && command === '+listen-im') {
  if (!args.includes('--flatten')) {
    console.error('flatten is required for a normalized event stream');
    process.exitCode = 2;
  }
  if (process.exitCode) process.exit();
  process.stderr.write('[event] ready event_count=1 bus_pid=7 subscribe_id=sub-test\\n');
  console.log(JSON.stringify({ conversation_id: 'cid-alerts', message_id: 'msg-live-1', sender: '监控机器人', sender_open_dingtalk_id: 'sender-1', content: '支付服务 500 错误，Trace ID: trace-live-1' }));
  setInterval(() => {}, 1000);
} else {
  console.error('unsupported fake dws command');
  process.exitCode = 2;
}
`);
  await chmod(binary, 0o755);
  const serviceToken = randomBytes(32).toString('base64url');
  const ticketSecret = randomBytes(32).toString('base64url');
  const encryptionKey = randomBytes(32);
  const baseEnv = {
    DINGTALK_CONNECTOR_PORT: String(await reservePort()),
    DINGTALK_CONNECTOR_SERVICE_TOKEN: serviceToken,
    DINGTALK_CONNECTOR_TICKET_SECRET: ticketSecret,
    DINGTALK_CONNECTOR_ENCRYPTION_KEY: encryptionKey.toString('base64'),
    DINGTALK_CONNECTOR_STORAGE_ROOT: path.join(root, 'profiles'),
    DINGTALK_CONNECTOR_TMP_ROOT: path.join(root, 'run'),
  };
  const principalAlpha = { tenantId: 'tenant-alpha', userId: 'user-alpha' };
  const principalBeta = { tenantId: 'tenant-beta', userId: 'user-beta' };
  let gateway = createDingtalkConnectorGateway({ env: baseEnv, binary, verifyBinary: async () => {}, macTestOnly: true });
  await gateway.listen('127.0.0.1');
  const origin = `http://127.0.0.1:${baseEnv.DINGTALK_CONNECTOR_PORT}`;

  async function call(route, { principal = principalAlpha, method = 'GET', body, ticket, signal } = {}) {
    return fetch(`${origin}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${serviceToken}`,
        'x-dots-principal-ticket': ticket || issuePrincipalTicket(principal, ticketSecret),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  try {
    const initial = await call('/v1/status').then(response => response.json());
    assert.deepEqual(initial.data, { state: 'not-installed' });
    const started = await call('/v1/authorization', { method: 'POST', body: {} }).then(response => response.json());
    assert.equal(started.data?.state, 'awaiting-user', `Unexpected authorization response: ${JSON.stringify(started)}`);
    assert.equal(started.data.userCode, 'E2E-DEVICE');
    assert.equal(started.data.authorizationUrl, 'https://login.dingtalk.com/oauth2/device?user_code=E2E-DEVICE');
    assert.equal(JSON.stringify(started).includes('DO-NOT-LEAK'), false, 'DWS device code must not be returned');
    const resumed = await call('/v1/status').then(response => response.json());
    assert.equal(resumed.data.id, started.data.id, 'Status must expose the current principal-owned authorization id for UI resume');
    assert.equal(resumed.data.userCode, 'E2E-DEVICE');

    const foreignPoll = await call(`/v1/authorization/${started.data.id}`, { principal: principalBeta }).then(async response => ({ status: response.status, body: await response.json() }));
    assert.equal(foreignPoll.status, 404, 'A different tenant/user cannot poll another user authorization');

    let authorization;
    const deadline = Date.now() + 8000;
    do {
      await new Promise(resolve => setTimeout(resolve, 80));
      const response = await call(`/v1/authorization/${started.data.id}`);
      authorization = await response.json();
    } while (authorization.data?.state !== 'authorized' && Date.now() < deadline);
    assert.equal(authorization.data?.state, 'authorized', JSON.stringify(authorization));
    assert.equal(authorization.data.installation.accountName, '测试用户');

    const calendar = await call('/v1/calendar/events', { method: 'POST', body: { start: '2026-10-16T00:00:00Z', end: '2026-10-17T00:00:00Z' } }).then(response => response.json());
    assert.equal(calendar.data.count, 1);
    assert.equal(calendar.data.complete, true);
    assert.equal(calendar.data.events[0].title, '排障复盘');
    assert.equal(JSON.stringify(calendar).includes('MUST-NOT-LEAK'), false, 'Calendar result must redact credential-like fields');
    const invalidCalendarRange = await call('/v1/calendar/events', { method: 'POST', body: { start: '2026-10-01T00:00:00Z', end: '2026-11-15T00:00:00Z' } }).then(async response => ({ status: response.status, body: await response.json() }));
    assert.equal(invalidCalendarRange.status, 400);
    assert.equal(invalidCalendarRange.body.error, 'DWS_CALENDAR_RANGE_INVALID');

    const search = await call('/v1/groups/search', { method: 'POST', body: { query: '告警', cursor: '0' } }).then(response => response.json());
    assert.deepEqual(search.data.groups, [{ conversationId: 'cid-alerts', name: '系统监控告警群' }], 'Adapt the official DWS result.chats contract');
    assert.equal(search.data.hasMore, true);
    assert.equal(search.data.nextCursor, 'next-page');

    const unconfirmedCreate = await call('/v1/docs/create', { method: 'POST', body: { requestId: '00000000-0000-4000-8000-000000000000', name: '未确认报告', content: '不可写入' } }).then(async response => ({ status: response.status, body: await response.json() }));
    assert.equal(unconfirmedCreate.status, 400);
    assert.equal(unconfirmedCreate.body.error, 'DWS_DOC_CONFIRMATION_REQUIRED');

    const createInput = { requestId: '11111111-1111-4111-8111-111111111111', name: 'E2E 故障报告', content: '# Trace trace-1\n原因：超时', confirmed: true };
    const created = await call('/v1/docs/create', { method: 'POST', body: createInput }).then(async response => ({ status: response.status, body: await response.json() }));
    assert.equal(created.status, 200, JSON.stringify(created));
    assert.equal(created.body.data.verified, true);
    assert.equal(created.body.data.url, 'https://alidocs.dingtalk.com/document/edit?docId=doc-1');
    const replayedCreate = await call('/v1/docs/create', { method: 'POST', body: createInput }).then(response => response.json());
    assert.equal(replayedCreate.data.nodeId, created.body.data.nodeId, 'Repeated delivery with one request ID must return the original result, not create a duplicate');
    const conflictingCreate = await call('/v1/docs/create', { method: 'POST', body: { ...createInput, content: 'different body' } }).then(async response => ({ status: response.status, body: await response.json() }));
    assert.equal(conflictingCreate.status, 409, 'A request ID cannot be reused for different document content');

    const foundDocs = await call('/v1/docs/search', { method: 'POST', body: { query: 'Trace trace-1', limit: 10 } }).then(response => response.json());
    assert.equal(foundDocs.data.count, 1);
    assert.equal(foundDocs.data.documents[0].nodeId, created.body.data.nodeId);
    const readDoc = await call('/v1/docs/fetch', { method: 'POST', body: { node: created.body.data.nodeId } }).then(response => response.json());
    assert.equal(readDoc.data.content.body, createInput.content);
    assert.equal(JSON.stringify(readDoc).includes('MUST-NOT-LEAK'), false, 'Document readback must redact credential-like fields');

    const unconfirmedUpdate = await call('/v1/docs/update', { method: 'POST', body: { requestId: '22222222-2222-4222-8222-222222222222', node: created.body.data.nodeId, command: 'append', content: '未确认追加', confirmed: false } }).then(async response => ({ status: response.status, body: await response.json() }));
    assert.equal(unconfirmedUpdate.status, 400);
    assert.equal(unconfirmedUpdate.body.error, 'DWS_DOC_CONFIRMATION_REQUIRED');
    const updated = await call('/v1/docs/update', { method: 'POST', body: { requestId: '22222222-2222-4222-8222-222222222222', node: created.body.data.nodeId, command: 'append', content: '已确认追加', confirmed: true } }).then(response => response.json());
    assert.equal(updated.data.operation, 'update');
    const readUpdated = await call('/v1/docs/fetch', { method: 'POST', body: { node: created.body.data.nodeId } }).then(response => response.json());
    assert.match(readUpdated.data.content.body, /已确认追加/);

    const unknownInput = { requestId: '33333333-3333-4333-8333-333333333333', name: 'unknown-create', content: '写入后丢失 CLI 回执', confirmed: true };
    const unknownWrite = await call('/v1/docs/create', { method: 'POST', body: unknownInput }).then(async response => ({ status: response.status, body: await response.json() }));
    assert.equal(unknownWrite.status, 409);
    assert.equal(unknownWrite.body.error, 'DWS_DOC_COMMIT_UNKNOWN');
    const unknownReplay = await call('/v1/docs/create', { method: 'POST', body: unknownInput }).then(async response => ({ status: response.status, body: await response.json() }));
    assert.equal(unknownReplay.status, 409);
    assert.equal(unknownReplay.body.error, 'DWS_DOC_COMMIT_UNKNOWN', 'A lost write acknowledgement must stay non-retryable under the same request ID');

    const otherUserRead = await call('/v1/docs/fetch', { principal: principalBeta, method: 'POST', body: { node: created.body.data.nodeId } }).then(async response => ({ status: response.status, body: await response.json() }));
    assert.notEqual(otherUserRead.status, 200, 'Another Dots tenant/user must not access this profile or document');

    const controller = new AbortController();
    const liveResponse = await call('/v1/monitors/events', { method: 'POST', body: { conversationId: 'cid-alerts' }, signal: controller.signal });
    assert.equal(liveResponse.status, 200, 'The selected-group DWS event listener should become ready before the stream opens');
    assert.match(liveResponse.headers.get('content-type') || '', /application\/x-ndjson/);
    const reader = liveResponse.body.getReader();
    const decoder = new TextDecoder();
    let streamText = '';
    const streamDeadline = Date.now() + 5_000;
    while (!streamText.includes('msg-live-1') && Date.now() < streamDeadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      streamText += decoder.decode(chunk.value, { stream: true });
    }
    assert.match(streamText, /"type":"ready"/);
    assert.match(streamText, /"messageId":"msg-live-1"/);
    assert.match(streamText, /Trace ID: trace-live-1/);
    assert.equal(streamText.includes('sender_open_dingtalk_id'), false, 'The connector must not forward raw DWS event envelopes');
    const duplicateMonitor = await call('/v1/monitors/events', { method: 'POST', body: { conversationId: 'cid-alerts' } }).then(async response => ({ status: response.status, body: await response.json() }));
    assert.equal(duplicateMonitor.status, 409, 'A second process must not subscribe to the same principal and group twice');
    controller.abort();
    await reader.cancel().catch(() => undefined);
    const beta = await call('/v1/status', { principal: principalBeta }).then(response => response.json());
    assert.deepEqual(beta.data, { state: 'not-installed' });

    const profileNames = await readdir(baseEnv.DINGTALK_CONNECTOR_STORAGE_ROOT);
    const encryptedProfiles = profileNames.filter(name => name.endsWith('.dws'));
    assert.equal(encryptedProfiles.length, 1);
    const encryptedProfile = await readFile(path.join(baseEnv.DINGTALK_CONNECTOR_STORAGE_ROOT, encryptedProfiles[0]));
    assert.equal(encryptedProfile.subarray(0, 5).toString(), 'CDWS1');
    assert.equal(encryptedProfile.includes(Buffer.from('fake-dws-token-that-must-never-be-stored-plaintext')), false);
    const operationOwners = await readdir(path.join(baseEnv.DINGTALK_CONNECTOR_STORAGE_ROOT, '.document-operations'));
    const operationFiles = await readdir(path.join(baseEnv.DINGTALK_CONNECTOR_STORAGE_ROOT, '.document-operations', operationOwners[0]));
    const operationJournal = await Promise.all(operationFiles.map(name => readFile(path.join(baseEnv.DINGTALK_CONNECTOR_STORAGE_ROOT, '.document-operations', operationOwners[0], name), 'utf8')));
    assert.equal(operationJournal.join('').includes(createInput.content), false, 'The idempotency journal must not persist DingTalk document contents');

    await gateway.close();
    gateway = createDingtalkConnectorGateway({ env: baseEnv, binary, verifyBinary: async () => {}, macTestOnly: true });
    await gateway.listen('127.0.0.1');
    const restored = await call('/v1/status').then(response => response.json());
    assert.equal(restored.data.state, 'identity-verified', 'The encrypted profile should survive a gateway process restart');
    const afterRestartCreateReplay = await call('/v1/docs/create', { method: 'POST', body: createInput }).then(response => response.json());
    assert.equal(afterRestartCreateReplay.data.nodeId, created.body.data.nodeId, 'The durable request journal must survive a connector restart');
    const afterRestartUnknownReplay = await call('/v1/docs/create', { method: 'POST', body: unknownInput }).then(async response => ({ status: response.status, body: await response.json() }));
    assert.equal(afterRestartUnknownReplay.status, 409);
    assert.equal(afterRestartUnknownReplay.body.error, 'DWS_DOC_COMMIT_UNKNOWN', 'A write with lost acknowledgement must remain blocked after a connector restart');

    const replayTicket = issuePrincipalTicket(principalAlpha, ticketSecret);
    assert.equal((await call('/v1/status', { ticket: replayTicket })).status, 200);
    assert.equal((await call('/v1/status', { ticket: replayTicket })).status, 401, 'Principal tickets must be single-use');

    const disconnected = await call('/v1/account', { method: 'DELETE' }).then(response => response.json());
    assert.deepEqual(disconnected.data, { disconnected: true, serverGrantRevoked: false });
    assert.deepEqual((await call('/v1/status').then(response => response.json())).data, { state: 'not-installed' });
  } finally {
    await gateway.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
