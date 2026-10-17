import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import test from 'node:test';
import {
  appendBoundedStartupStderr,
  createDingtalkConnectorGateway,
  eventStartupDiagnostic,
  hostProfileUserHash,
  issuePrincipalTicket,
  openProfileBytes,
  parseEncryptionKey,
  sealProfileBytes,
} from '../deploy/dingtalk-connector/gateway.mjs';
import { dwsBinaryDigests, hostProfileEnvironment, isolatedEnvironment, parseAuthStatus, platformKey, resolveDwsClientCredentials, verifyDwsBinary } from '../deploy/dingtalk-connector/lib/dws-runtime.mjs';

test('DWS 1.0.64 pins include the official macOS binaries and remain platform explicit', () => {
  assert.equal(platformKey('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(platformKey('darwin', 'x64'), 'darwin-amd64');
  assert.equal(platformKey('linux', 'arm64'), 'linux-arm64');
  assert.equal(dwsBinaryDigests['darwin-arm64'], '32ad5c69302c2a586e86f988a1bb6cf1c101f8245266f9fd1b32c8893e3dc56b');
  assert.throws(() => platformKey('win32', 'x64'), /DWS_PLATFORM_UNSUPPORTED/);
});

test('opted-in macOS profiles disable shared Keychain state', () => {
  const env = isolatedEnvironment('/tmp/dws-owner-fixture', { allowMacRuntime: true });
  assert.equal(env.DWS_DISABLE_KEYCHAIN, '1');
  assert.equal(env.HOME, '/tmp/dws-owner-fixture/home');
  assert.equal(env.DWS_CONFIG_DIR, '/tmp/dws-owner-fixture/config');
});

test('host-profile DWS environment reuses the existing private CLI config without disabling Keychain', () => {
  const env = hostProfileEnvironment({ configDir: path.join(homedir(), '.dws') });
  assert.equal(env.HOME, homedir());
  assert.equal(env.DWS_CONFIG_DIR, path.join(homedir(), '.dws'));
  assert.equal(env.DWS_DISABLE_KEYCHAIN, undefined);
  assert.equal(env.PATH.startsWith(path.join(homedir(), '.local', 'bin')), true);
  assert.equal(Object.hasOwn(env, 'DINGTALK_CONNECTOR_SERVICE_TOKEN'), false);
});

test('DWS AppKey credentials are forwarded only as a complete explicit pair', () => {
  assert.deepEqual(resolveDwsClientCredentials({ DINGTALK_CONNECTOR_DWS_CLIENT_ID: 'app-id', DINGTALK_CONNECTOR_DWS_CLIENT_SECRET: 'app-secret' }), {
    clientId: 'app-id', clientSecret: 'app-secret',
  });
  assert.deepEqual(resolveDwsClientCredentials({}), { clientId: undefined, clientSecret: undefined });
  assert.throws(() => resolveDwsClientCredentials({ DINGTALK_CONNECTOR_DWS_CLIENT_ID: 'app-id' }), /DINGTALK_CONNECTOR_DWS_CREDENTIALS_INVALID/);
});

test('local host-profile gateway binds the existing DWS identity to one Dots user and never archives it', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Requires the explicit macOS host-profile runtime');
  const root = await mkdtemp(path.join(tmpdir(), 'dws-host-profile-test-'));
  const hostConfigDir = path.join(root, 'host-profile');
  await mkdir(hostConfigDir, { mode: 0o700 });
  await chmod(hostConfigDir, 0o700);
  const port = await reservePort();
  const serviceToken = randomBytes(32).toString('base64url');
  const ticketSecret = randomBytes(32).toString('base64url');
  const calls = [];
  const inspectCalls = [];
  const env = {
    DINGTALK_CONNECTOR_PORT: String(port),
    DINGTALK_CONNECTOR_SERVICE_TOKEN: serviceToken,
    DINGTALK_CONNECTOR_TICKET_SECRET: ticketSecret,
    DINGTALK_CONNECTOR_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    DINGTALK_CONNECTOR_STORAGE_ROOT: path.join(root, 'profiles'),
    DINGTALK_CONNECTOR_TMP_ROOT: path.join(root, 'run'),
    DINGTALK_CONNECTOR_ALLOW_MACOS_RUNTIME: '1',
    DINGTALK_CONNECTOR_USE_HOST_PROFILE: '1',
    DINGTALK_CONNECTOR_DWS_HOST_CONFIG_DIR: hostConfigDir,
    DINGTALK_CONNECTOR_ALLOWED_USER_HASH: hostProfileUserHash('user-alpha'),
  };
  const gateway = createDingtalkConnectorGateway({
    env,
    binary: '/private/test/dws',
    verifyBinary: async () => {},
    inspectProfile: async options => {
      inspectCalls.push(options);
      return { state: 'identity-verified', authenticated: true, corpId: 'corp-test', expiresAt: '2030-01-01T00:00:00.000Z' };
    },
    runDws: async (_binary, args, options) => {
      calls.push({ args, env: options.env });
      if (args[0] === 'profile' && args[1] === 'list') return {
        success: true,
        profiles: [{ corpId: 'corp-test', userId: 'dws-user', isCurrent: true, isOrgCurrent: true }],
      };
      if (args[0] === 'auth' && args[1] === 'status') return {
        success: true, authenticated: true, corp_id: 'corp-test', user_id: 'dws-user', token_valid: true,
        expires_at: '2030-01-01T00:00:00.000Z',
      };
      if (args[0] === 'chat' && args[1] === '+my-groups') return {
        groups: [{ conversationId: 'cid-test', name: 'Test group' }], count: 1, pagesFetched: 1,
        paginationKnown: true, complete: true, hasMore: false, failures: [], failedCount: 0,
      };
      if (args[0] === 'todo' && args[1] === '+due-today') return {
        ok: true, outcome: 'success', data: {
          count: 1, hasMore: false, complete: true,
          tasks: [{ taskId: 'todo-test', title: '核对实施安排', accessToken: 'must-not-leak' }],
        },
      };
      throw new Error('unexpected fake DWS command');
    },
  });
  try {
    await gateway.listen('127.0.0.1');
    const origin = `http://127.0.0.1:${port}`;
    const call = async (route, { userId = 'user-alpha', method = 'GET', body } = {}) => fetch(`${origin}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${serviceToken}`,
        'x-dots-principal-ticket': issuePrincipalTicket({ tenantId: 'tenant-alpha', userId }, ticketSecret),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const status = await call('/v1/status').then(response => response.json());
    assert.equal(status.data.state, 'identity-verified');
    assert.equal(inspectCalls[0].hostProfile, true);
    assert.equal(inspectCalls[0].hostConfigDir, hostConfigDir);
    assert.equal(inspectCalls.length, 1);

    const groups = await call('/v1/groups/list', { method: 'POST', body: { cursor: '0', pageLimit: 50 } });
    assert.equal(groups.status, 200);
    assert.deepEqual((await groups.json()).data.groups, [{ conversationId: 'cid-test', name: 'Test group' }]);
    assert.equal(calls.length, 2);
    assert.equal(calls.every(item => item.env.HOME === homedir()), true);
    assert.equal(calls.every(item => item.env.DWS_CONFIG_DIR === hostConfigDir), true);
    assert.equal(calls.every(item => item.env.DWS_DISABLE_KEYCHAIN === undefined), true);
    assert.equal(inspectCalls.length, 2);

    const todos = await call('/v1/secretary/todo-list', { method: 'POST', body: { scope: 'due-today' } });
    assert.equal(todos.status, 200);
    const todoResult = (await todos.json()).data;
    assert.deepEqual(todoResult, {
      scope: 'due-today', count: 1, tasks: [{ taskId: 'todo-test', title: '核对实施安排' }], complete: true, hasMore: false,
    });
    const todoCommand = calls.find(item => item.args[0] === 'todo' && item.args[1] === '+due-today');
    assert(todoCommand, 'The authenticated Dots principal must reach the bounded DWS due-today command');
    assert(todoCommand.args.includes('--profile') && todoCommand.args.includes('corp-test:dws-user'));
    assert.equal(inspectCalls.length, 2, 'Read-only secretary operations do not re-inspect or mutate profile identity');
    assert.equal(JSON.stringify(todoResult).includes('must-not-leak'), false);

    const invalidTodoScope = await call('/v1/secretary/todo-list', { method: 'POST', body: { scope: 'all-organization-tasks' } });
    assert.equal(invalidTodoScope.status, 400);
    assert.equal((await invalidTodoScope.json()).error, 'DWS_TODO_LIST_FAILED');
    assert.equal(calls.some(item => item.args[0] === 'todo' && item.args[1] === '+get-all-tasks'), false);

    const denied = await call('/v1/status', { userId: 'user-beta' });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error, 'DWS_HOST_PROFILE_USER_NOT_ALLOWED');
    assert.equal(inspectCalls.length, 2, 'A different Dots user must be rejected before calling DWS');
    assert.equal(calls.filter(item => item.args[0] === 'chat' && item.args[1] === '+my-groups').length, 1);
    const files = await readdir(env.DINGTALK_CONNECTOR_STORAGE_ROOT);
    assert.equal(files.some(file => file.endsWith('.dws')), false, 'The Keychain-backed host profile must not be exported or archived');
  } finally {
    await gateway.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('official app-scoped DWS binary matches the pinned release digest on macOS', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Requires macOS local runtime');
  const binary = path.join(homedir(), 'Library', 'Application Support', 'Coke Dots Demo', 'tools', 'dws', 'bin', 'dws');
  try { await verifyDwsBinary(binary); } catch (error) {
    if (error.code === 'ENOENT') return t.skip('Official local DWS binary is not installed');
    throw error;
  }
});

test('user-installed DWS CLI path is the pinned v1.0.64 binary on macOS', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Requires macOS local DWS CLI');
  const binary = path.join(homedir(), '.local', 'bin', 'dws');
  try { await verifyDwsBinary(binary); } catch (error) {
    if (error.code === 'ENOENT') return t.skip('User-installed DWS CLI is not installed');
    throw error;
  }
});

test('opted-in macOS gateway listens only on loopback by default', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Requires macOS local runtime');
  const root = await mkdtemp(path.join(tmpdir(), 'dws-local-listener-test-'));
  const env = {
    DINGTALK_CONNECTOR_PORT: String(await reservePort()),
    DINGTALK_CONNECTOR_SERVICE_TOKEN: randomBytes(32).toString('base64url'),
    DINGTALK_CONNECTOR_TICKET_SECRET: randomBytes(32).toString('base64url'),
    DINGTALK_CONNECTOR_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    DINGTALK_CONNECTOR_STORAGE_ROOT: path.join(root, 'profiles'),
    DINGTALK_CONNECTOR_TMP_ROOT: path.join(root, 'run'),
    DINGTALK_CONNECTOR_ALLOW_MACOS_RUNTIME: '1',
  };
  const gateway = createDingtalkConnectorGateway({ env, verifyBinary: async () => {} });
  try {
    await assert.rejects(gateway.listen('0.0.0.0'), /DWS_LOCAL_RUNTIME_LOOPBACK_ONLY/);
    const address = await gateway.listen();
    assert.equal(address.address, '127.0.0.1');
  } finally {
    await gateway.close();
    await rm(root, { recursive: true, force: true });
  }
});

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

test('DWS monitor startup diagnostics expose only bounded categories and process metadata', () => {
  const raw = 'registerToEventCenter failed: group subscription denied; token=DO-NOT-LEAK https://example.invalid/callback?code=SECRET';
  const diagnostic = eventStartupDiagnostic({
    stage: 'child-exit', code: 'DWS_EVENT_SUBSCRIPTION_REJECTED', exitCode: 2,
    stderr: raw, stderrBytes: Buffer.byteLength(raw), elapsedMs: 41,
  });
  assert.deepEqual(diagnostic, {
    component: 'dws-im-monitor', stage: 'child-exit', code: 'DWS_EVENT_SUBSCRIPTION_REJECTED',
    cause: 'subscription-rejected', stderrBytes: Buffer.byteLength(raw), diagnosticChannels: ['stderr'], exitCode: 2, elapsedMs: 41,
  });
  const serialized = JSON.stringify(diagnostic);
  for (const secret of ['DO-NOT-LEAK', 'SECRET', 'example.invalid', 'group subscription denied']) {
    assert.equal(serialized.includes(secret), false, `diagnostics must not expose ${secret}`);
  }
});

test('DWS monitor diagnostics classify structured internal errors without exposing their messages', () => {
  const raw = `{
  "error": {
    "category": "internal",
    "code": 5,
    "message": "consume: discover bus: busctl: start https://private.example/path?token=NEVER-LOG token=NEVER-LOG"
  }
}`;
  const diagnostic = eventStartupDiagnostic({ stage: 'child-exit', stderr: raw, exitCode: 5, elapsedMs: 6100 });
  assert.deepEqual(diagnostic, {
    component: 'dws-im-monitor', stage: 'child-exit', code: 'DWS_EVENT_LISTENER_FAILED',
    cause: 'event-bus-startup', dwsErrorCategory: 'internal', dwsErrorCode: 5,
    dwsMessageClass: 'bus-discovery', dwsErrorFields: ['category', 'code', 'message'],
    stderrBytes: Buffer.byteLength(raw), diagnosticChannels: ['stderr'], exitCode: 5, elapsedMs: 6100,
  });
  const serialized = JSON.stringify(diagnostic);
  for (const secret of ['private.example', 'NEVER-LOG', 'token=', 'discover bus']) {
    assert.equal(serialized.includes(secret), false, `diagnostics must not expose ${secret}`);
  }
});

test('DWS monitor diagnostics classify provider errorCode/errorMsg envelopes and expose only safe field names', () => {
  const raw = `provider output before JSON\n{"success":false,"errorCode":"SYSTEM_ERROR","errorMsg":"subscribeUser failed: registerToEventCenter failed; token=DO-NOT-LEAK; trace_id=PRIVATE"}\ntrailing provider text`;
  const diagnostic = eventStartupDiagnostic({ stage: 'child-exit', stderr: raw, exitCode: 5, elapsedMs: 6200 });
  assert.deepEqual(diagnostic, {
    component: 'dws-im-monitor', stage: 'child-exit', code: 'DWS_EVENT_SUBSCRIPTION_REJECTED',
    cause: 'subscription-rejected', dwsErrorCode: 'SYSTEM_ERROR', dwsMessageClass: 'subscription',
    dwsErrorFields: ['errorcode', 'errormsg', 'success'],
    stderrBytes: Buffer.byteLength(raw), diagnosticChannels: ['stderr'], exitCode: 5, elapsedMs: 6200,
  });
  const serialized = JSON.stringify(diagnostic);
  for (const secret of ['DO-NOT-LEAK', 'PRIVATE', 'registerToEventCenter', 'provider output', 'trailing provider']) {
    assert.equal(serialized.includes(secret), false, `diagnostics must not expose ${secret}`);
  }
});

test('DWS monitor diagnostics omit unknown provider codes rather than logging arbitrary values', () => {
  const raw = '{"errorCode":"PRIVATE-CREDENTIAL","errorMsg":"unknown provider failure token=DO-NOT-LEAK"}';
  const diagnostic = eventStartupDiagnostic({ stage: 'child-exit', stderr: raw, exitCode: 5 });
  assert.equal(diagnostic.dwsErrorCode, undefined);
  assert.deepEqual(diagnostic.dwsErrorFields, ['errorcode', 'errormsg']);
  assert.equal(JSON.stringify(diagnostic).includes('PRIVATE-CREDENTIAL'), false);
  assert.equal(JSON.stringify(diagnostic).includes('DO-NOT-LEAK'), false);
});

test('DWS monitor does not infer AppKey misconfiguration from a bare clientId mention', () => {
  const diagnostic = eventStartupDiagnostic({ stage: 'child-exit', stderr: 'failed to fetch clientId metadata', exitCode: 5 });
  assert.equal(diagnostic.cause, 'unclassified');
  assert.equal(diagnostic.code, 'DWS_EVENT_LISTENER_FAILED');
});

test('DWS monitor classifies clientId transport timeouts as network failures', () => {
  const raw = '{"errorCode":"SYSTEM_ERROR","errorMsg":"fetch clientId metadata: dial tcp i/o timeout"}';
  const diagnostic = eventStartupDiagnostic({ stage: 'child-exit', stderr: raw, exitCode: 5 });
  assert.equal(diagnostic.cause, 'network');
  assert.equal(diagnostic.code, 'DWS_EVENT_NETWORK_UNAVAILABLE');
  assert.equal(JSON.stringify(diagnostic).includes('dial tcp'), false);
});

test('DWS monitor reserves AppKey configuration for explicit missing-key errors', () => {
  const missingKey = eventStartupDiagnostic({ stage: 'child-exit', stderr: 'missing clientId configuration', exitCode: 5 });
  assert.equal(missingKey.cause, 'app-key-configuration');

  const providerCode = eventStartupDiagnostic({
    stage: 'child-exit', stderr: '{"errorCode":"UNIFIED_APP_ID_NOT_FOUND","errorMsg":"application mapping missing"}', exitCode: 5,
  });
  assert.equal(providerCode.cause, 'app-key-configuration');
  assert.equal(providerCode.dwsErrorCode, 'UNIFIED_APP_ID_NOT_FOUND');
});

test('DWS monitor startup failures classify structured stdout errors without exposing event content', () => {
  const providerError = `\u001b[31m{"success":false,"errorCode":"SYSTEM_ERROR","errorMsg":"subscribeUser failed: registerToEventCenter failed; token=DO-NOT-LEAK"}\u001b[0m`;
  const diagnostic = eventStartupDiagnostic({
    stage: 'child-exit', code: 'DWS_EVENT_LISTENER_FAILED', cause: 'unclassified',
    stderr: 'command terminated', stderrBytes: Buffer.byteLength('command terminated'),
    stdout: providerError, stdoutBytes: Buffer.byteLength(providerError), exitCode: 5,
  });
  assert.deepEqual(diagnostic, {
    component: 'dws-im-monitor', stage: 'child-exit', code: 'DWS_EVENT_SUBSCRIPTION_REJECTED',
    cause: 'subscription-rejected', dwsErrorCode: 'SYSTEM_ERROR', dwsMessageClass: 'subscription',
    dwsErrorFields: ['errorcode', 'errormsg', 'success'],
    stderrBytes: Buffer.byteLength('command terminated'), stdoutBytes: Buffer.byteLength(providerError), diagnosticChannels: ['stderr', 'stdout'], exitCode: 5,
  });
  for (const secret of ['DO-NOT-LEAK', 'registerToEventCenter', 'command terminated']) {
    assert.equal(JSON.stringify(diagnostic).includes(secret), false);
  }

  const eventContent = '{"type":"message","message":{"text":"SYSTEM_ERROR subscribeUser failed token=PRIVATE"}}';
  const ignored = eventStartupDiagnostic({
    stage: 'child-exit', code: 'DWS_EVENT_LISTENER_FAILED', cause: 'unclassified', stdout: eventContent,
  });
  assert.equal(ignored.dwsErrorCode, undefined);
  assert.equal(ignored.code, 'DWS_EVENT_LISTENER_FAILED');
  assert.equal(ignored.cause, 'no-stderr');
  assert.equal(JSON.stringify(ignored).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(ignored).includes('SYSTEM_ERROR'), false);
});

test('bounded startup stderr retains multiline structured errors across process chunks', () => {
  const raw = `{
  "error": {
    "category": "internal",
    "code": 5,
    "message": "consume: discover bus: busctl: start token=NEVER-LOG"
  }
}`;
  const captured = [raw.slice(0, 17), raw.slice(17, 68), raw.slice(68)].reduce(
    (current, chunk) => appendBoundedStartupStderr(current, chunk),
  );
  assert.equal(captured, raw);
  const diagnostic = eventStartupDiagnostic({ stage: 'child-exit', stderr: captured, exitCode: 5 });
  assert.equal(diagnostic.cause, 'event-bus-startup');
  assert.equal(diagnostic.dwsErrorCategory, 'internal');
  assert.equal(diagnostic.dwsErrorCode, 5);
  assert.equal(JSON.stringify(diagnostic).includes('NEVER-LOG'), false);

  const bounded = appendBoundedStartupStderr('123456', '7890', 8);
  assert.equal(bounded, '34567890');
  assert.equal(Buffer.byteLength(bounded), 8);
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
} else if (group === 'chat' && command === '+my-groups') {
  const pageLimit = args[args.indexOf('--page-limit') + 1];
  const cursorIndex = args.indexOf('--cursor');
  if (!args.includes('--page-all') || !args.includes('--profile') || pageLimit === undefined || (cursorIndex >= 0 && args[cursorIndex + 1] !== 'next-page')) process.exit(2);
  console.log(JSON.stringify({
    count: 1,
    groups: [{ conversationId: cursorIndex >= 0 ? 'cid-alerts-2' : 'cid-alerts', name: cursorIndex >= 0 ? '发布告警群' : '系统监控告警群' }],
    pagesFetched: 1,
    paginationKnown: true,
    complete: pageLimit !== '1',
    hasMore: pageLimit === '1',
    stopReason: pageLimit === '1' ? 'page_limit' : 'source_complete',
    truncatedByPageLimit: pageLimit === '1',
    truncatedByResultLimit: false,
    failedCount: 0,
    failures: [],
    ...(pageLimit === '1' ? { nextCursor: 'next-page' } : {}),
  }));
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
  const conversationId = args[args.indexOf('--chat-id') + 1];
  if (!args.includes('--debug')) {
    process.stderr.write('monitor listener must enable private startup diagnostics\\n');
    process.exitCode = 2;
    process.exit();
  }
  if (conversationId === 'cid-rejected') {
    process.stderr.write('registerToEventCenter failed: group subscription denied; token=DO-NOT-LEAK\\n');
    process.exitCode = 2;
    process.exit();
  }
  if (conversationId === 'cid-cli-usage') {
    process.stderr.write('Usage: dws event +listen-im --kind group --chat-id <id>\\ninvalid chat selector\\n');
    process.exitCode = 2;
    process.exit();
  }
  if (conversationId === 'cid-unsupported-flag') {
    process.stderr.write('unknown flag: --flatten\\n');
    process.exitCode = 2;
    process.exit();
  }
  if (args.includes('--flatten')) {
    process.stderr.write('unknown flag: --flatten\\n');
    process.exitCode = 2;
    process.exit();
  }
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

    const groups = await call('/v1/groups/list', { method: 'POST', body: { cursor: '0', pageLimit: 50 } }).then(response => response.json());
    assert.deepEqual(groups.data.groups, [{ conversationId: 'cid-alerts', name: '系统监控告警群' }], 'Load current user groups through the DWS group-list shortcut');
    assert.equal(groups.data.complete, true);
    assert.equal(groups.data.hasMore, false);
    assert.equal(groups.data.failureCount, 0);

    const otherUserGroupList = await call('/v1/groups/list', { principal: principalBeta, method: 'POST', body: { cursor: '0', pageLimit: 50 } }).then(async response => ({ status: response.status, body: await response.json() }));
    assert.equal(otherUserGroupList.status, 400, 'Another Dots tenant/user must not enumerate this identity’s joined groups');
    assert.equal(otherUserGroupList.body.error, 'DWS_PROFILE_NOT_INSTALLED');
    assert.equal(JSON.stringify(otherUserGroupList).includes('系统监控告警群'), false);

    const partialGroups = await call('/v1/groups/list', { method: 'POST', body: { cursor: '0', pageLimit: 1 } }).then(response => response.json());
    assert.equal(partialGroups.data.complete, false, 'Do not call a capped group list complete');
    assert.equal(partialGroups.data.hasMore, true);
    assert.equal(partialGroups.data.nextCursor, 'next-page');
    assert.equal(partialGroups.data.failureCount, 0);

    const nextGroupPage = await call('/v1/groups/list', { method: 'POST', body: { cursor: partialGroups.data.nextCursor, pageLimit: 50 } }).then(response => response.json());
    assert.deepEqual(nextGroupPage.data.groups, [{ conversationId: 'cid-alerts-2', name: '发布告警群' }]);
    assert.equal(nextGroupPage.data.complete, true);

    const invalidGroupPage = await call('/v1/groups/list', { method: 'POST', body: { cursor: '0', pageLimit: 51 } }).then(async response => ({ status: response.status, body: await response.json() }));
    assert.equal(invalidGroupPage.status, 400);
    assert.equal(invalidGroupPage.body.error, 'DWS_GROUP_LIST_LIMIT_INVALID');

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

    const rejectedSubscription = await call('/v1/monitors/events', { method: 'POST', body: { conversationId: 'cid-rejected' } }).then(async response => ({ status: response.status, body: await response.json() }));
    assert.equal(rejectedSubscription.status, 502);
    assert.equal(rejectedSubscription.body.error, 'DWS_EVENT_SUBSCRIPTION_REJECTED', 'A DingTalk event-center rejection should be classified without returning provider stderr');
    assert.equal(JSON.stringify(rejectedSubscription).includes('DO-NOT-LEAK'), false, 'Raw DWS stderr must never cross the connector API');

    const usageFailure = await call('/v1/monitors/events', { method: 'POST', body: { conversationId: 'cid-cli-usage' } }).then(async response => ({ status: response.status, body: await response.json() }));
    assert.equal(usageFailure.body.error, 'DWS_EVENT_LISTENER_FAILED', 'Generic Usage output must not be misclassified as an unsupported DWS command');

    const unsupportedFlag = await call('/v1/monitors/events', { method: 'POST', body: { conversationId: 'cid-unsupported-flag' } }).then(async response => ({ status: response.status, body: await response.json() }));
    assert.equal(unsupportedFlag.body.error, 'DWS_EVENT_COMMAND_UNSUPPORTED', 'An explicit unknown flag must be surfaced as a CLI contract mismatch');

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
