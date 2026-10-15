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

  async function call(route, { principal = principalAlpha, method = 'GET', body, ticket } = {}) {
    return fetch(`${origin}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${serviceToken}`,
        'x-dots-principal-ticket': ticket || issuePrincipalTicket(principal, ticketSecret),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  try {
    const initial = await call('/v1/status').then(response => response.json());
    assert.deepEqual(initial.data, { state: 'not-installed' });
    const started = await call('/v1/authorization', { method: 'POST', body: {} }).then(response => response.json());
    assert.equal(started.data.state, 'awaiting-user');
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

    const search = await call('/v1/groups/search', { method: 'POST', body: { query: '告警', cursor: '0' } }).then(response => response.json());
    assert.deepEqual(search.data.groups, [{ conversationId: 'cid-alerts', name: '系统监控告警群' }], 'Adapt the official DWS result.chats contract');
    assert.equal(search.data.hasMore, true);
    assert.equal(search.data.nextCursor, 'next-page');
    const beta = await call('/v1/status', { principal: principalBeta }).then(response => response.json());
    assert.deepEqual(beta.data, { state: 'not-installed' });

    const profileNames = await readdir(baseEnv.DINGTALK_CONNECTOR_STORAGE_ROOT);
    assert.equal(profileNames.length, 1);
    const encryptedProfile = await readFile(path.join(baseEnv.DINGTALK_CONNECTOR_STORAGE_ROOT, profileNames[0]));
    assert.equal(encryptedProfile.subarray(0, 5).toString(), 'CDWS1');
    assert.equal(encryptedProfile.includes(Buffer.from('fake-dws-token-that-must-never-be-stored-plaintext')), false);

    await gateway.close();
    gateway = createDingtalkConnectorGateway({ env: baseEnv, binary, verifyBinary: async () => {}, macTestOnly: true });
    await gateway.listen('127.0.0.1');
    const restored = await call('/v1/status').then(response => response.json());
    assert.equal(restored.data.state, 'identity-verified', 'The encrypted profile should survive a gateway process restart');

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
