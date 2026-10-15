import { randomUUID, createHash, createHmac, timingSafeEqual, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import {
  inspectDwsProfile, isolatedEnvironment, parseAuthStatus, prepareProfileRoot, principalKey,
  runDwsProcess, selectCurrentProfile, verifyDwsBinary,
} from './lib/dws-runtime.mjs';
import { createDwsAuthorizationManager } from './lib/dws-authorization-manager.mjs';
import { createDwsDocumentOperations } from './lib/dws-documents.mjs';
import { createDwsCalendarOperations } from './lib/dws-calendar.mjs';

const encryptedMagic = Buffer.from('CDWS1');
const maxArchiveBytes = 32 * 1024 * 1024;
const maxRequestBytes = 32 * 1024;
const maxDocumentRequestBytes = 600 * 1024;
const maxTicketLifetimeSeconds = 120;
const allowedErrors = new Set([
  'DWS_PLATFORM_UNSUPPORTED', 'DWS_BINARY_UNSAFE', 'DWS_BINARY_CHECKSUM_MISMATCH',
  'DWS_PROFILE_SELECTION_REQUIRED', 'DWS_PROFILE_MISMATCH', 'DWS_AUTH_STATUS_UNAVAILABLE', 'DWS_PROFILE_ALREADY_CONNECTED', 'DWS_GROUP_LIST_LIMIT_INVALID',
  'DWS_PROFILE_NOT_INSTALLED', 'DWS_PROFILE_NOT_AUTHENTICATED', 'DWS_GROUP_QUERY_INVALID',
  'DWS_GROUP_SEARCH_INVALID_RESULT', 'DWS_LOGOUT_READBACK_FAILED',
  'DWS_PROCESS_TIMEOUT', 'DWS_PROCESS_START_FAILED', 'DWS_PROCESS_FAILED', 'DWS_INVALID_JSON',
  'DWS_OUTPUT_TOO_LARGE', 'DWS_AUTHORIZATION_START_TIMEOUT', 'DWS_AUTHORIZATION_FAILED',
  'DWS_AUTHORIZATION_INVALID_RESULT', 'DWS_AUTHORIZATION_EXPIRED', 'DWS_PROFILE_BUSY',
  'DWS_EVENT_LISTENER_FAILED', 'DWS_MONITOR_ALREADY_ACTIVE',
  'DWS_DOC_AUTHORIZATION_REQUIRED', 'DWS_DOC_NAME_INVALID', 'DWS_DOC_CONTENT_INVALID',
  'DWS_DOC_CONTENT_TOO_LARGE', 'DWS_DOC_NODE_INVALID', 'DWS_DOC_LOCATION_INVALID',
  'DWS_DOC_QUERY_INVALID', 'DWS_DOC_LIMIT_INVALID', 'DWS_DOC_SEARCH_FAILED',
  'DWS_DOC_READBACK_FAILED', 'DWS_DOC_READBACK_MISMATCH', 'DWS_DOC_OPERATION_UNVERIFIED',
  'DWS_DOC_OPERATION_FAILED', 'DWS_DOC_OPERATION_MISMATCH', 'DWS_DOC_PARTIAL_SUCCESS',
  'DWS_DOC_COMMIT_UNKNOWN', 'DWS_DOC_RETRYABLE_FAILURE', 'DWS_DOC_CONFIRMATION_REQUIRED',
  'DWS_DOC_UPDATE_COMMAND_INVALID', 'DWS_DOC_REQUEST_ID_INVALID', 'DWS_DOC_REQUEST_CONFLICT',
  'DWS_DOC_OPERATION_STORAGE_FAILED', 'DINGTALK_REQUEST_TOO_LARGE',
  'DWS_CALENDAR_RANGE_INVALID', 'DWS_CALENDAR_CURSOR_INVALID', 'DWS_CALENDAR_LIST_FAILED',
  'CONNECTOR_AUTHORIZATION_NOT_FOUND', 'CONNECTOR_IDENTITY_READBACK_FAILED',
]);

export function parseEncryptionKey(value) {
  const encoded = String(value || '').trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw new Error('DINGTALK_ENCRYPTION_KEY_INVALID');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error('DINGTALK_ENCRYPTION_KEY_INVALID');
  return key;
}

export function issuePrincipalTicket(principal, secret, now = Date.now()) {
  const payload = {
    tenantId: principal?.tenantId,
    userId: principal?.userId,
    expiresAt: Math.floor(now / 1000) + 60,
    nonce: randomUUID(),
  };
  validatePrincipal(payload);
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyPrincipalTicket(ticket, secret, now = Date.now()) {
  if (typeof ticket !== 'string' || ticket.length > 4096) throw new Error('PRINCIPAL_TICKET_INVALID');
  const [encoded, signature, extra] = ticket.split('.');
  if (!encoded || !signature || extra) throw new Error('PRINCIPAL_TICKET_INVALID');
  const expected = createHmac('sha256', secret).update(encoded).digest();
  let actual;
  try { actual = Buffer.from(signature, 'base64url'); } catch { throw new Error('PRINCIPAL_TICKET_INVALID'); }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('PRINCIPAL_TICKET_INVALID');
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { throw new Error('PRINCIPAL_TICKET_INVALID'); }
  validatePrincipal(payload);
  const secondsLeft = Number(payload.expiresAt) - Math.floor(now / 1000);
  if (!Number.isInteger(payload.expiresAt) || secondsLeft < 0 || secondsLeft > maxTicketLifetimeSeconds) throw new Error('PRINCIPAL_TICKET_EXPIRED');
  if (typeof payload.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(payload.nonce)) throw new Error('PRINCIPAL_TICKET_INVALID');
  return { tenantId: payload.tenantId, userId: payload.userId, nonce: payload.nonce, expiresAt: payload.expiresAt };
}

function validatePrincipal(principal) {
  if (typeof principal?.tenantId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(principal.tenantId) ||
      typeof principal?.userId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(principal.userId)) {
    throw new Error('PRINCIPAL_TICKET_INVALID');
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function profileEncryptionKey(masterKey, ownerKey) {
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.from(ownerKey), Buffer.from('coke-dots-dws-profile-v1'), 32));
}

export function sealProfileBytes(plaintext, ownerKey, masterKey, nonce = randomUUID().replaceAll('-', '').slice(0, 24)) {
  const iv = Buffer.from(nonce, 'hex');
  if (iv.length !== 12) throw new Error('DINGTALK_ENCRYPTION_FAILED');
  const cipher = createCipheriv('aes-256-gcm', profileEncryptionKey(masterKey, ownerKey), iv);
  cipher.setAAD(Buffer.from(ownerKey));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([encryptedMagic, iv, cipher.getAuthTag(), encrypted]);
}

export function openProfileBytes(ciphertext, ownerKey, masterKey) {
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length < encryptedMagic.length + 12 + 16 || !ciphertext.subarray(0, encryptedMagic.length).equals(encryptedMagic)) {
    throw new Error('DINGTALK_PROFILE_CIPHERTEXT_INVALID');
  }
  const iv = ciphertext.subarray(encryptedMagic.length, encryptedMagic.length + 12);
  const tag = ciphertext.subarray(encryptedMagic.length + 12, encryptedMagic.length + 28);
  const decipher = createDecipheriv('aes-256-gcm', profileEncryptionKey(masterKey, ownerKey), iv);
  decipher.setAAD(Buffer.from(ownerKey));
  decipher.setAuthTag(tag);
  try { return Buffer.concat([decipher.update(ciphertext.subarray(encryptedMagic.length + 28)), decipher.final()]); }
  catch { throw new Error('DINGTALK_PROFILE_DECRYPT_FAILED'); }
}

async function runTar(args, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { shell: false, stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', () => { clearTimeout(timer); reject(new Error('DINGTALK_PROFILE_ARCHIVE_FAILED')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(new Error('DINGTALK_PROFILE_ARCHIVE_FAILED'));
    });
  });
}

async function writeEncryptedProfile({ storageRoot, ownerKey, masterKey, sourceRoot, tempRoot }) {
  const archivePath = path.join(tempRoot, `save-${randomUUID()}.tar.gz`);
  const encryptedPath = path.join(storageRoot, `${ownerKey}.dws`);
  const pendingPath = `${encryptedPath}.${randomUUID()}.tmp`;
  try {
    await runTar(['-czf', archivePath, '-C', sourceRoot, '.']);
    const archiveInfo = await stat(archivePath);
    if (archiveInfo.size > maxArchiveBytes) throw new Error('DINGTALK_PROFILE_TOO_LARGE');
    const archive = await readFile(archivePath);
    await writeFile(pendingPath, sealProfileBytes(archive, ownerKey, masterKey), { mode: 0o600, flag: 'wx' });
    await rename(pendingPath, encryptedPath);
    await chmodPrivate(encryptedPath, 0o600);
  } finally {
    await rm(archivePath, { force: true });
    await rm(pendingPath, { force: true });
  }
}

async function restoreEncryptedProfile({ storageRoot, ownerKey, masterKey, destinationRoot, tempRoot }) {
  const encryptedPath = path.join(storageRoot, `${ownerKey}.dws`);
  let ciphertext;
  try { ciphertext = await readFile(encryptedPath); } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw new Error('DINGTALK_PROFILE_READ_FAILED');
  }
  if (ciphertext.length > maxArchiveBytes + 64) throw new Error('DINGTALK_PROFILE_TOO_LARGE');
  const archivePath = path.join(tempRoot, `restore-${randomUUID()}.tar.gz`);
  try {
    const plaintext = openProfileBytes(ciphertext, ownerKey, masterKey);
    if (plaintext.length > maxArchiveBytes) throw new Error('DINGTALK_PROFILE_TOO_LARGE');
    await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
    await writeFile(archivePath, plaintext, { mode: 0o600, flag: 'wx' });
    await runTar(['-xzf', archivePath, '-C', destinationRoot, '--no-same-owner', '--no-same-permissions']);
    await chmodPrivate(destinationRoot, 0o700);
    return true;
  } finally { await rm(archivePath, { force: true }); }
}

async function chmodPrivate(target, mode) {
  await chmod(target, mode);
}

async function ensurePrivateStorageRoot(storageRoot) {
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  const info = await lstat(storageRoot);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error('DINGTALK_STORAGE_UNSAFE');
  await chmod(storageRoot, 0o700);
}

function safeVerificationUrl(raw) {
  try {
    const source = new URL(raw);
    const code = source.searchParams.get('user_code') || source.searchParams.get('userCode');
    if (source.protocol !== 'https:' || source.hostname !== 'login.dingtalk.com' || source.port || source.username || source.password || !code || code.length > 80) return null;
    const url = new URL(`${source.origin}${source.pathname}`);
    url.searchParams.set('user_code', code);
    return { authorizationUrl: url.toString(), userCode: code };
  } catch { return null; }
}

function sanitizeGroups(payload) {
  const raw = extractGroupRows(payload);
  if (payload?.success !== true || !raw) throw new Error('DWS_GROUP_SEARCH_INVALID_RESULT');
  const groups = sanitizeGroupRows(raw);
  const page = payload.result && !Array.isArray(payload.result) ? payload.result : payload;
  return {
    groups,
    hasMore: page.hasMore === true,
    ...(typeof page.nextCursor === 'string' || typeof page.nextCursor === 'number' ? { nextCursor: String(page.nextCursor).slice(0, 200) } : {}),
  };
}

function sanitizeGroupRows(raw) {
  if (!Array.isArray(raw)) throw new Error('DWS_GROUP_SEARCH_INVALID_RESULT');
  const groups = [];
  for (const group of raw) {
    const conversationId = groupConversationId(group);
    const name = groupName(group);
    if (!conversationId || !name) continue;
    groups.push({ conversationId: conversationId.slice(0, 512), name: name.slice(0, 200) });
  }
  if (groups.length !== raw.length) throw new Error('DWS_GROUP_SEARCH_INVALID_RESULT');
  return groups;
}

function extractGroupRows(payload) {
  return Array.isArray(payload?.result) ? payload.result :
    Array.isArray(payload?.result?.groups) ? payload.result.groups :
      Array.isArray(payload?.result?.chats) ? payload.result.chats :
        Array.isArray(payload?.result?.items) ? payload.result.items :
          Array.isArray(payload?.groups) ? payload.groups : null;
}

function groupConversationId(group) {
  return String(group?.openConversationId || group?.open_conversation_id || group?.conversationId || '').trim();
}

function groupName(group) {
  return String(group?.title || group?.name || group?.groupName || group?.conversationName || group?.chatName || '').trim();
}

function sanitizeGroupList(payload) {
  // DWS v1.0.64's `chat +my-groups --page-all --format json` shortcut
  // writes a direct projection (`groups`, `complete`, `hasMore`,
  // `paginationKnown`, `failures`), without the `success/result` envelope
  // used by the lower-level `chat search` command.
  const shortcutPage = payload && typeof payload === 'object' &&
    Array.isArray(payload.groups) && Number.isSafeInteger(payload.count) && payload.count === payload.groups.length &&
    Number.isSafeInteger(payload.pagesFetched) && payload.pagesFetched >= 1 && payload.paginationKnown === true &&
    typeof payload.complete === 'boolean' && typeof payload.hasMore === 'boolean' &&
    Array.isArray(payload.failures) && Number.isSafeInteger(payload.failedCount) &&
    payload.failedCount >= 0 && payload.failedCount === payload.failures.length;
  let groups;
  let page;
  if (shortcutPage) {
    groups = sanitizeGroupRows(payload.groups);
    page = payload;
  } else {
    groups = sanitizeGroups(payload).groups;
    page = payload.result && !Array.isArray(payload.result) ? payload.result : payload;
    if (typeof page.complete !== 'boolean' || typeof page.hasMore !== 'boolean') throw new Error('DWS_GROUP_SEARCH_INVALID_RESULT');
  }
  const failures = Math.max(Array.isArray(page.failures) ? page.failures.length : 0,
    Number.isSafeInteger(page.failedCount) && page.failedCount >= 0 ? page.failedCount : 0);
  const hasMore = page.hasMore;
  return {
    groups,
    hasMore,
    ...(typeof page.nextCursor === 'string' || typeof page.nextCursor === 'number' ? { nextCursor: String(page.nextCursor).slice(0, 200) } : {}),
    complete: page.complete === true && !hasMore && failures === 0,
    failureCount: failures,
  };
}

function publicError(error) {
  const code = typeof error?.message === 'string' && allowedErrors.has(error.message) ? error.message : 'DINGTALK_CONNECTOR_REQUEST_FAILED';
  const status = code === 'CONNECTOR_AUTHORIZATION_NOT_FOUND' ? 404 :
    code === 'DWS_DOC_AUTHORIZATION_REQUIRED' ? 403 :
      ['DWS_DOC_CONTENT_TOO_LARGE', 'DINGTALK_REQUEST_TOO_LARGE'].includes(code) ? 413 :
        ['DWS_PROFILE_BUSY', 'DWS_MONITOR_ALREADY_ACTIVE', 'DWS_DOC_PARTIAL_SUCCESS', 'DWS_DOC_COMMIT_UNKNOWN', 'DWS_DOC_REQUEST_CONFLICT'].includes(code) ? 409 :
          ['DWS_PROCESS_TIMEOUT', 'DWS_PROCESS_FAILED', 'DWS_EVENT_LISTENER_FAILED'].includes(code) ? 502 : 400;
  return { status, body: { ok: false, error: code } };
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw new Error('DWS_DOC_OPERATION_STORAGE_FAILED');
  await chmodPrivate(directory, 0o700);
}

async function writeDocumentOperationRecord(file, value) {
  const pending = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(pending, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(pending, file);
    await chmodPrivate(file, 0o600);
    await syncDirectory(path.dirname(file));
  } finally { await handle?.close().catch(() => undefined); await rm(pending, { force: true }); }
}

async function syncDirectory(directory) {
  let handle;
  try { handle = await open(directory, 'r'); await handle.sync(); }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EBADF'].includes(error?.code)) throw error; }
  finally { await handle?.close().catch(() => undefined); }
}

function createDocumentWriteOnce(storageRoot) {
  return async ({ ownerKey, requestId, operation, input, work }) => {
    const ownerDirectory = path.join(storageRoot, '.document-operations', ownerKey);
    await ensurePrivateDirectory(path.dirname(ownerDirectory));
    await ensurePrivateDirectory(ownerDirectory);
    const requestHash = createHash('sha256').update(requestId).digest('hex');
    const recordPath = path.join(ownerDirectory, `${requestHash}.json`);
    const fingerprint = createHash('sha256').update(JSON.stringify({ operation, input })).digest('hex');
    let existing;
    try { existing = JSON.parse(await readFile(recordPath, 'utf8')); }
    catch (error) { if (error?.code !== 'ENOENT') throw new Error('DWS_DOC_OPERATION_STORAGE_FAILED'); }
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('DWS_DOC_REQUEST_CONFLICT');
      if (existing.state === 'complete' && existing.result && typeof existing.result === 'object') return existing.result;
      throw new Error(existing.error || 'DWS_DOC_COMMIT_UNKNOWN');
    }

    const started = { state: 'running', fingerprint, createdAt: new Date().toISOString() };
    try {
      const handle = await open(recordPath, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(started)); await handle.sync(); }
      finally { await handle.close(); }
      await syncDirectory(ownerDirectory);
    }
    catch (error) {
      if (error?.code === 'EEXIST') {
        let raced;
        try { raced = JSON.parse(await readFile(recordPath, 'utf8')); } catch { throw new Error('DWS_DOC_COMMIT_UNKNOWN'); }
        if (raced.fingerprint !== fingerprint) throw new Error('DWS_DOC_REQUEST_CONFLICT');
        if (raced.state === 'complete' && raced.result && typeof raced.result === 'object') return raced.result;
        throw new Error(raced.error || 'DWS_DOC_COMMIT_UNKNOWN');
      }
      throw new Error('DWS_DOC_OPERATION_STORAGE_FAILED');
    }

    try {
      const result = await work();
      await writeDocumentOperationRecord(recordPath, { ...started, state: 'complete', result });
      return result;
    } catch (error) {
      const rawCode = typeof error?.message === 'string' && allowedErrors.has(error.message) ? error.message : 'DWS_DOC_COMMIT_UNKNOWN';
      const uncertain = ['DWS_DOC_COMMIT_UNKNOWN', 'DWS_DOC_PARTIAL_SUCCESS'].includes(rawCode);
      await writeDocumentOperationRecord(recordPath, { ...started, state: uncertain ? 'unknown' : 'failed', error: rawCode }).catch(() => undefined);
      throw error;
    }
  };
}

export function createDingtalkConnectorGateway({
  env = process.env,
  binary = env.DINGTALK_CONNECTOR_DWS_BINARY || '/usr/local/bin/dws',
  verifyBinary = verifyDwsBinary,
  runDws = runDwsProcess,
  spawnProcess = spawn,
  inspectProfile = inspectDwsProfile,
  macTestOnly = false,
} = {}) {
  const port = Number(env.DINGTALK_CONNECTOR_PORT || 8789);
  const storageRoot = path.resolve(env.DINGTALK_CONNECTOR_STORAGE_ROOT || '/var/lib/dws/profiles');
  const tmpRoot = path.resolve(env.DINGTALK_CONNECTOR_TMP_ROOT || '/run/dws');
  const managedTmpRoot = path.join(tmpRoot, 'coke-dots-dingtalk-connector');
  const serviceToken = String(env.DINGTALK_CONNECTOR_SERVICE_TOKEN || '');
  const ticketSecret = String(env.DINGTALK_CONNECTOR_TICKET_SECRET || '');
  const proxy = env.DINGTALK_CONNECTOR_HTTPS_PROXY || undefined;
  const masterKey = parseEncryptionKey(env.DINGTALK_CONNECTOR_ENCRYPTION_KEY || '');
  if (!Number.isInteger(port) || port < 1 || port > 65535 || serviceToken.length < 32 || ticketSecret.length < 32) throw new Error('DINGTALK_CONNECTOR_CONFIGURATION_INVALID');
  const usedTicketNonces = new Map();
  const flows = new Map();
  const locks = new Map();
  const activeMonitors = new Map();
  const documents = createDwsDocumentOperations({
    withAuthenticatedProfile: async (principal, work) => {
      if (process.platform !== 'linux' && !(process.platform === 'darwin' && macTestOnly)) throw new Error('DWS_GATEWAY_REQUIRES_LINUX');
      const ownerKey = principalKey(principal);
      return withOwnerLock(ownerKey, async () => {
        const workspace = await createPrincipalProfileWorkspace(principal, 'documents');
        let restored = false;
        try {
          restored = await restoreEncryptedProfile({ storageRoot, ownerKey, masterKey, destinationRoot: workspace.root, tempRoot: managedTmpRoot });
          if (!restored) throw new Error('DWS_PROFILE_NOT_INSTALLED');
          await verifyBinary(binary);
          const owner = await prepareProfileRoot(workspace.root, principal);
          const env = isolatedEnvironment(owner, { proxy, macTestOnly });
          const call = (args, options = {}) => runDws(binary, [...args, '--format', 'json'], {
            cwd: owner, env, timeoutMs: 60_000, maxBytes: 1024 * 1024, parseJsonOnFailure: true, ...options,
          });
          const profile = selectCurrentProfile(await call(['profile', 'list']));
          if (!profile) throw new Error('DWS_PROFILE_SELECTION_REQUIRED');
          const authStatus = parseAuthStatus(await call(['auth', 'status', '--profile', profile.selector]), profile);
          if (!authStatus.authenticated) throw new Error('DWS_DOC_AUTHORIZATION_REQUIRED');
          return await work({ call, profile, ownerKey });
        } finally {
          if (restored) await writeEncryptedProfile({ storageRoot, ownerKey, masterKey, sourceRoot: workspace.root, tempRoot: managedTmpRoot }).catch(() => undefined);
          await rm(workspace.root, { recursive: true, force: true });
        }
      });
    },
    writeOnce: createDocumentWriteOnce(storageRoot),
  });
  const calendar = createDwsCalendarOperations({
    withAuthenticatedProfile: async (principal, work) => {
      if (process.platform !== 'linux' && !(process.platform === 'darwin' && macTestOnly)) throw new Error('DWS_GATEWAY_REQUIRES_LINUX');
      const ownerKey = principalKey(principal);
      return withOwnerLock(ownerKey, async () => {
        const workspace = await createPrincipalProfileWorkspace(principal, 'calendar');
        let restored = false;
        try {
          restored = await restoreEncryptedProfile({ storageRoot, ownerKey, masterKey, destinationRoot: workspace.root, tempRoot: managedTmpRoot });
          if (!restored) throw new Error('DWS_PROFILE_NOT_INSTALLED');
          await verifyBinary(binary);
          const owner = await prepareProfileRoot(workspace.root, principal);
          const env = isolatedEnvironment(owner, { proxy, macTestOnly });
          const call = (args, options = {}) => runDws(binary, [...args, '--format', 'json'], {
            cwd: owner, env, timeoutMs: 60_000, maxBytes: 1024 * 1024, parseJsonOnFailure: true, ...options,
          });
          const profile = selectCurrentProfile(await call(['profile', 'list']));
          if (!profile) throw new Error('DWS_PROFILE_SELECTION_REQUIRED');
          const authStatus = parseAuthStatus(await call(['auth', 'status', '--profile', profile.selector]), profile);
          if (!authStatus.authenticated) throw new Error('DWS_DOC_AUTHORIZATION_REQUIRED');
          return await work({ call, profile, ownerKey });
        } finally {
          if (restored) await writeEncryptedProfile({ storageRoot, ownerKey, masterKey, sourceRoot: workspace.root, tempRoot: managedTmpRoot }).catch(() => undefined);
          await rm(workspace.root, { recursive: true, force: true });
        }
      });
    },
  });

  async function initialize() {
    await ensurePrivateStorageRoot(storageRoot);
    await rm(managedTmpRoot, { recursive: true, force: true });
    await mkdir(managedTmpRoot, { recursive: true, mode: 0o700 });
  }

  function ownerPrincipal(ticket) { return { issuer: 'coke-dots', subject: `${ticket.tenantId}:${ticket.userId}` }; }

  async function createProfileWorkspace(ticket, suffix) {
    return createPrincipalProfileWorkspace(ownerPrincipal(ticket), suffix);
  }

  async function createPrincipalProfileWorkspace(principal, suffix) {
    const ownerKey = principalKey(principal);
    const root = await mkdtemp(path.join(managedTmpRoot, `${ownerKey}-${suffix}-`));
    await chmodPrivate(root, 0o700);
    return { ownerKey, root, principal };
  }

  async function withOwnerLock(ownerKey, work) {
    const previous = locks.get(ownerKey) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    locks.set(ownerKey, current);
    await previous;
    try { return await work(); }
    finally { release(); if (locks.get(ownerKey) === current) locks.delete(ownerKey); }
  }

  async function status(ticket) {
    const ownerKey = principalKey(ownerPrincipal(ticket));
    const flow = [...flows.values()].find(item => item.ownerKey === ownerKey);
    if (flow) {
      const value = await flow.manager.poll(flow.principal, flow.id);
      if (value.state === 'authorized') await persistFlow(flow);
      else if (['failed', 'cancelled', 'expired'].includes(value.state)) await removeFlow(flow);
      return { id: flow.id, state: value.state, ...(value.authorizationUrl ? safeVerificationUrl(value.authorizationUrl) : {}), ...(value.installation ? { installation: value.installation } : {}), ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}), ...(value.reason ? { reason: value.reason } : {}) };
    }
    return withOwnerLock(ownerKey, async () => {
      const workspace = await createProfileWorkspace(ticket, 'status');
      try {
        const restored = await restoreEncryptedProfile({ storageRoot, ownerKey, masterKey, destinationRoot: workspace.root, tempRoot: managedTmpRoot });
        if (!restored) return { state: 'not-installed' };
        const result = await inspectProfile({ binary, storageRoot: workspace.root, principal: workspace.principal, proxy, macTestOnly, verifyBinary });
        if (result.state === 'identity-verified') await writeEncryptedProfile({ storageRoot, ownerKey, masterKey, sourceRoot: workspace.root, tempRoot: managedTmpRoot });
        return result;
      } finally { await rm(workspace.root, { recursive: true, force: true }); }
    });
  }

  async function startAuthorization(ticket) {
    const ownerKey = principalKey(ownerPrincipal(ticket));
    const pending = [...flows.values()].find(item => item.ownerKey === ownerKey);
    if (pending) return publicAuthorization(await pending.manager.poll(pending.principal, pending.id));
    const existing = await status(ticket);
    if (existing.state === 'identity-verified') return { state: 'failed', reason: 'DWS_PROFILE_ALREADY_CONNECTED' };
    const workspace = await createProfileWorkspace(ticket, 'auth');
    try {
      const restored = await restoreEncryptedProfile({ storageRoot, ownerKey, masterKey, destinationRoot: workspace.root, tempRoot: managedTmpRoot });
      if (restored) {
        if (existing.state !== 'expired') throw new Error('DWS_PROFILE_ALREADY_CONNECTED');
        const oldManager = createDwsAuthorizationManager({ binary, storageRoot: workspace.root, proxy, macTestOnly, verifyBinary });
        await oldManager.disconnect(workspace.principal);
      }
      const manager = createDwsAuthorizationManager({ binary, storageRoot: workspace.root, proxy, macTestOnly, verifyBinary, inspect: inspectProfile });
      const authorization = await manager.start(workspace.principal);
      if (authorization.state !== 'awaiting-user' || !safeVerificationUrl(authorization.authorizationUrl)) {
        await rm(workspace.root, { recursive: true, force: true });
        throw new Error('DWS_AUTHORIZATION_INVALID_RESULT');
      }
      const flow = { ...workspace, manager, id: authorization.id };
      flows.set(authorization.id, flow);
      return publicAuthorization(authorization);
    } catch (error) {
      await rm(workspace.root, { recursive: true, force: true });
      throw error;
    }
  }

  function publicAuthorization(value) {
    const verification = value.authorizationUrl ? safeVerificationUrl(value.authorizationUrl) : null;
    return {
      id: value.id,
      state: value.state,
      ...(verification || {}),
      ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}),
      ...(value.installation ? { installation: value.installation } : {}),
      ...(value.reason ? { reason: value.reason } : {}),
    };
  }

  async function persistFlow(flow) {
    await writeEncryptedProfile({ storageRoot, ownerKey: flow.ownerKey, masterKey, sourceRoot: flow.root, tempRoot: managedTmpRoot });
    await removeFlow(flow);
  }

  async function removeFlow(flow) {
    flows.delete(flow.id);
    await rm(flow.root, { recursive: true, force: true });
  }

  async function pollAuthorization(ticket, id) {
    const flow = flows.get(id);
    if (!flow || flow.ownerKey !== principalKey(ownerPrincipal(ticket))) throw new Error('CONNECTOR_AUTHORIZATION_NOT_FOUND');
    const authorization = await flow.manager.poll(flow.principal, id);
    if (authorization.state === 'authorized') await persistFlow(flow);
    else if (['failed', 'cancelled', 'expired'].includes(authorization.state)) await removeFlow(flow);
    return {
      id: authorization.id,
      state: authorization.state,
      ...(authorization.authorizationUrl ? safeVerificationUrl(authorization.authorizationUrl) : {}),
      ...(authorization.installation ? { installation: authorization.installation } : {}),
      ...(authorization.expiresAt ? { expiresAt: authorization.expiresAt } : {}),
      ...(authorization.reason ? { reason: authorization.reason } : {}),
    };
  }

  async function cancelAuthorization(ticket, id) {
    const flow = flows.get(id);
    if (!flow || flow.ownerKey !== principalKey(ownerPrincipal(ticket))) throw new Error('CONNECTOR_AUTHORIZATION_NOT_FOUND');
    const result = await flow.manager.cancel(flow.principal, id);
    await removeFlow(flow);
    return { id, state: result.state };
  }

  async function searchGroups(ticket, body) {
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    const cursor = typeof body.cursor === 'string' && body.cursor.length <= 200 ? body.cursor : '0';
    if (!query || query.length > 100) throw new Error('DWS_GROUP_QUERY_INVALID');
    const ownerKey = principalKey(ownerPrincipal(ticket));
    return withOwnerLock(ownerKey, async () => {
      const workspace = await createProfileWorkspace(ticket, 'search');
      let restored = false;
      try {
        restored = await restoreEncryptedProfile({ storageRoot, ownerKey, masterKey, destinationRoot: workspace.root, tempRoot: managedTmpRoot });
        if (!restored) throw new Error('DWS_PROFILE_NOT_INSTALLED');
        const statusValue = await inspectProfile({ binary, storageRoot: workspace.root, principal: workspace.principal, proxy, macTestOnly, verifyBinary });
        if (statusValue.state !== 'identity-verified') throw new Error('DWS_PROFILE_NOT_AUTHENTICATED');
        const owner = await prepareProfileRoot(workspace.root, workspace.principal);
        const profilePayload = await runDws(binary, ['profile', 'list', '--format', 'json'], { cwd: owner, env: isolatedEnvironment(owner, { proxy, macTestOnly }) });
        const profile = selectCurrentProfile(profilePayload);
        if (!profile) throw new Error('DWS_PROFILE_SELECTION_REQUIRED');
        const result = await runDws(binary, ['chat', 'search', '--query', query, '--limit', '20', '--cursor', cursor, '--format', 'json', '--profile', profile.selector], {
          cwd: owner, env: isolatedEnvironment(owner, { proxy, macTestOnly }), timeoutMs: 30_000,
        });
        return sanitizeGroups(result);
      } finally {
        if (restored) await writeEncryptedProfile({ storageRoot, ownerKey, masterKey, sourceRoot: workspace.root, tempRoot: managedTmpRoot }).catch(() => undefined);
        await rm(workspace.root, { recursive: true, force: true });
      }
    });
  }

  async function listGroups(ticket, body) {
    const cursor = typeof body.cursor === 'string' && body.cursor.length <= 200 ? body.cursor : '0';
    const pageLimit = Number(body.pageLimit ?? 50);
    if (!cursor || !Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 50) throw new Error('DWS_GROUP_LIST_LIMIT_INVALID');
    const ownerKey = principalKey(ownerPrincipal(ticket));
    return withOwnerLock(ownerKey, async () => {
      const workspace = await createProfileWorkspace(ticket, 'list-groups');
      let restored = false;
      try {
        restored = await restoreEncryptedProfile({ storageRoot, ownerKey, masterKey, destinationRoot: workspace.root, tempRoot: managedTmpRoot });
        if (!restored) throw new Error('DWS_PROFILE_NOT_INSTALLED');
        const statusValue = await inspectProfile({ binary, storageRoot: workspace.root, principal: workspace.principal, proxy, macTestOnly, verifyBinary });
        if (statusValue.state !== 'identity-verified') throw new Error('DWS_PROFILE_NOT_AUTHENTICATED');
        const owner = await prepareProfileRoot(workspace.root, workspace.principal);
        const profilePayload = await runDws(binary, ['profile', 'list', '--format', 'json'], { cwd: owner, env: isolatedEnvironment(owner, { proxy, macTestOnly }) });
        const profile = selectCurrentProfile(profilePayload);
        if (!profile) throw new Error('DWS_PROFILE_SELECTION_REQUIRED');
        const args = ['chat', '+my-groups', '--page-all', '--page-limit', String(pageLimit), '--format', 'json', '--profile', profile.selector];
        if (cursor !== '0') args.splice(5, 0, '--cursor', cursor);
        const result = await runDws(binary, args, {
          cwd: owner, env: isolatedEnvironment(owner, { proxy, macTestOnly }), timeoutMs: 60_000, maxBytes: 2 * 1024 * 1024,
        });
        return sanitizeGroupList(result);
      } finally {
        if (restored) await writeEncryptedProfile({ storageRoot, ownerKey, masterKey, sourceRoot: workspace.root, tempRoot: managedTmpRoot }).catch(() => undefined);
        await rm(workspace.root, { recursive: true, force: true });
      }
    });
  }

  async function disconnect(ticket) {
    const ownerKey = principalKey(ownerPrincipal(ticket));
    const flow = [...flows.values()].find(item => item.ownerKey === ownerKey);
    if (flow) { await flow.manager.cancel(flow.principal, flow.id).catch(() => undefined); await removeFlow(flow); }
    for (const [key, listener] of activeMonitors) {
      if (listener.ownerKey === ownerKey) listener.stop();
    }
    await rm(path.join(storageRoot, `${ownerKey}.dws`), { force: true });
    return { disconnected: true, serverGrantRevoked: false };
  }

  async function streamGroupMessages(ticket, body, req, res) {
    const conversationId = typeof body?.conversationId === 'string' ? body.conversationId.trim() : '';
    if (!conversationId || conversationId.length > 512) throw new Error('DWS_GROUP_QUERY_INVALID');
    const ownerKey = principalKey(ownerPrincipal(ticket));
    const monitorKey = `${ownerKey}:${conversationId}`;
    if (activeMonitors.has(monitorKey)) throw new Error('DWS_MONITOR_ALREADY_ACTIVE');

    let workspace;
    let child;
    let ready = false;
    let streamOpen = false;
    let cancelled = false;
    let closed = false;
    let output = '';
    let errors = '';
    let outputBytes = 0;
    let readyTimer;
    let heartbeat;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const pendingEvents = [];
    let resolveClosed;
    const closedPromise = new Promise(resolve => { resolveClosed = resolve; });
    let resolveReady;
    let rejectReady;
    const readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const listener = {
      ownerKey,
      stop() {
        cancelled = true;
        if (closed) return;
        child?.kill('SIGTERM');
        if (!res.destroyed && res.headersSent) res.end();
      },
    };

    const sendFrame = value => {
      if (!res.destroyed && res.headersSent) res.write(`${JSON.stringify(value)}\n`);
    };
    const processOutputLine = line => {
      if (!line.trim()) return;
      let value;
      try { value = JSON.parse(line); } catch { return; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const eventConversationId = String(value.conversation_id || value.conversationId || conversationId).trim();
      const messageId = String(value.message_id || value.messageId || '').trim();
      const text = typeof value.content === 'string' ? value.content : '';
      if (eventConversationId !== conversationId || !messageId || !text.trim()) return;
      const event = {
        type: 'message',
        message: {
          conversationId,
          messageId: messageId.slice(0, 256),
          senderId: String(value.sender_open_dingtalk_id || '').slice(0, 256),
          senderName: String(value.sender || '').slice(0, 200),
          text: text.slice(0, 6000),
        },
      };
      if (streamOpen) sendFrame(event);
      else if (pendingEvents.length < 100) pendingEvents.push(event);
    };

    const start = async () => withOwnerLock(ownerKey, async () => {
      if (activeMonitors.has(monitorKey)) throw new Error('DWS_MONITOR_ALREADY_ACTIVE');
      workspace = await createProfileWorkspace(ticket, 'monitor');
      const restored = await restoreEncryptedProfile({ storageRoot, ownerKey, masterKey, destinationRoot: workspace.root, tempRoot: managedTmpRoot });
      if (!restored) throw new Error('DWS_PROFILE_NOT_INSTALLED');
      const profileState = await inspectProfile({ binary, storageRoot: workspace.root, principal: workspace.principal, proxy, macTestOnly, verifyBinary });
      if (profileState.state !== 'identity-verified') throw new Error('DWS_PROFILE_NOT_AUTHENTICATED');
      const owner = await prepareProfileRoot(workspace.root, workspace.principal);
      const profilePayload = await runDws(binary, ['profile', 'list', '--format', 'json'], { cwd: owner, env: isolatedEnvironment(owner, { proxy, macTestOnly }) });
      const profile = selectCurrentProfile(profilePayload);
      if (!profile) throw new Error('DWS_PROFILE_SELECTION_REQUIRED');
      child = spawnProcess(binary, [
        'event', '+listen-im', '--kind', 'group', '--chat-id', conversationId,
        '--events', 'message', '--flatten', '-f', 'ndjson', '--profile', profile.selector,
      ], { cwd: owner, env: isolatedEnvironment(owner, { proxy, macTestOnly }), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      if (cancelled) child.kill('SIGTERM');
      const versionInfo = await stat(path.join(storageRoot, `${ownerKey}.dws`));
      listener.child = child;
      listener.workspace = workspace;
      listener.profileVersion = `${versionInfo.size}:${versionInfo.mtimeMs}`;
      child.stdout.on('data', chunk => {
        outputBytes += chunk.length;
        if (outputBytes > 8 * 1024 * 1024) { child.kill('SIGTERM'); return; }
        output += stdoutDecoder.write(chunk);
        let boundary;
        while ((boundary = output.indexOf('\n')) >= 0) {
          const line = output.slice(0, boundary);
          output = output.slice(boundary + 1);
          processOutputLine(line);
        }
        if (output.length > 256 * 1024) { output = ''; child.kill('SIGTERM'); }
      });
      child.stderr.on('data', chunk => {
        errors += stderrDecoder.write(chunk);
        let boundary;
        while ((boundary = errors.indexOf('\n')) >= 0) {
          const line = errors.slice(0, boundary);
          errors = errors.slice(boundary + 1);
          if (!ready && line.includes('[event] ready')) resolveReady();
        }
        if (errors.length > 64 * 1024) errors = errors.slice(-1024);
      });
      child.once('error', () => rejectReady(new Error('DWS_EVENT_LISTENER_FAILED')));
      child.once('close', () => {
        if (!ready) rejectReady(new Error('DWS_EVENT_LISTENER_FAILED'));
        closed = true;
        resolveClosed();
      });
      activeMonitors.set(monitorKey, listener);
      readyTimer = setTimeout(() => rejectReady(new Error('DWS_EVENT_LISTENER_FAILED')), 30_000);
      await readyPromise;
      ready = true;
    });

    const stop = () => listener.stop();
    req.once('aborted', stop);
    res.once('close', stop);
    try {
      await start();
      clearTimeout(readyTimer);
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no',
      });
      sendFrame({ type: 'ready' });
      streamOpen = true;
      for (const event of pendingEvents.splice(0)) sendFrame(event);
      heartbeat = setInterval(() => sendFrame({ type: 'ping' }), 20_000);
      await closedPromise;
      if (!res.destroyed) res.end();
    } catch (error) {
      clearTimeout(readyTimer);
      const failure = publicError(error);
      if (!res.headersSent) {
        const payload = Buffer.from(JSON.stringify({ ok: false, error: failure.body.error }));
        res.writeHead(failure.status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length, 'cache-control': 'no-store' });
        res.end(payload);
      } else if (!res.destroyed) {
        sendFrame({ type: 'error', error: failure.body.error });
        res.end();
      }
    } finally {
      clearTimeout(readyTimer);
      clearInterval(heartbeat);
      req.off('aborted', stop);
      res.off('close', stop);
      if (child && !closed) {
        child?.kill('SIGTERM');
        await Promise.race([closedPromise, new Promise(resolve => setTimeout(resolve, 5_000))]);
        if (!closed) child?.kill('SIGKILL');
      }
      if (activeMonitors.get(monitorKey) === listener) activeMonitors.delete(monitorKey);
      if (workspace) {
        try {
          const encryptedPath = path.join(storageRoot, `${ownerKey}.dws`);
          const current = await stat(encryptedPath);
          const currentVersion = `${current.size}:${current.mtimeMs}`;
          if (listener.profileVersion && currentVersion === listener.profileVersion) {
            await withOwnerLock(ownerKey, () => writeEncryptedProfile({ storageRoot, ownerKey, masterKey, sourceRoot: workspace.root, tempRoot: managedTmpRoot }));
          }
        } catch { /* Keep the existing encrypted profile if it changed or cannot be refreshed. */ }
        await rm(workspace.root, { recursive: true, force: true });
      }
    }
  }

  async function readBody(req, maximumBytes = maxRequestBytes) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maximumBytes) throw new Error('DINGTALK_REQUEST_TOO_LARGE');
      chunks.push(chunk);
    }
    try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; }
    catch { throw new Error('DINGTALK_REQUEST_INVALID'); }
  }

  async function handle(req, res) {
    const send = (statusCode, body) => {
      const data = Buffer.from(JSON.stringify(body));
      res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length, 'cache-control': 'no-store' });
      res.end(data);
    };
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/healthz') return send(200, { ok: true, service: 'dingtalk-connector-gateway', dwsVersion: '1.0.64' });
    if (req.headers.authorization !== `Bearer ${serviceToken}`) return send(401, { ok: false, error: 'SERVICE_AUTH_REQUIRED' });
    let ticket;
    try {
      ticket = verifyPrincipalTicket(req.headers['x-dots-principal-ticket'], ticketSecret);
      const previousExpiry = usedTicketNonces.get(ticket.nonce);
      if (previousExpiry && previousExpiry >= Math.floor(Date.now() / 1000)) return send(401, { ok: false, error: 'PRINCIPAL_TICKET_REPLAYED' });
      usedTicketNonces.set(ticket.nonce, ticket.expiresAt);
      for (const [nonce, expiresAt] of usedTicketNonces) if (expiresAt < Math.floor(Date.now() / 1000)) usedTicketNonces.delete(nonce);
    } catch { return send(401, { ok: false, error: 'PRINCIPAL_TICKET_INVALID' }); }

    try {
      if (req.method === 'GET' && url.pathname === '/v1/status') return send(200, { ok: true, data: await status(ticket) });
      if (req.method === 'POST' && url.pathname === '/v1/authorization') return send(201, { ok: true, data: await startAuthorization(ticket) });
      const authorizationMatch = url.pathname.match(/^\/v1\/authorization\/([a-f0-9-]{36})$/i);
      if (authorizationMatch && req.method === 'GET') return send(200, { ok: true, data: await pollAuthorization(ticket, authorizationMatch[1]) });
      if (authorizationMatch && req.method === 'DELETE') return send(200, { ok: true, data: await cancelAuthorization(ticket, authorizationMatch[1]) });
      if (req.method === 'POST' && url.pathname === '/v1/groups/search') return send(200, { ok: true, data: await searchGroups(ticket, await readBody(req)) });
      if (req.method === 'POST' && url.pathname === '/v1/groups/list') return send(200, { ok: true, data: await listGroups(ticket, await readBody(req)) });
      const documentRoute = url.pathname.match(/^\/v1\/docs\/(create|fetch|search|update)$/);
      if (req.method === 'POST' && documentRoute) {
        const body = await readBody(req, maxDocumentRequestBytes);
        const operation = { create: 'createDocument', fetch: 'fetchDocument', search: 'searchDocuments', update: 'updateDocument' }[documentRoute[1]];
        return send(200, { ok: true, data: await documents[operation](ownerPrincipal(ticket), body) });
      }
      if (req.method === 'POST' && url.pathname === '/v1/calendar/events') {
        const body = await readBody(req, 16 * 1024);
        return send(200, { ok: true, data: await calendar.listEvents(ownerPrincipal(ticket), body) });
      }
      if (req.method === 'POST' && url.pathname === '/v1/monitors/events') return await streamGroupMessages(ticket, await readBody(req), req, res);
      if (req.method === 'DELETE' && url.pathname === '/v1/account') return send(200, { ok: true, data: await disconnect(ticket) });
      return send(404, { ok: false, error: 'NOT_FOUND' });
    } catch (error) {
      const failure = publicError(error);
      return send(failure.status, { ...failure.body, ok: false });
    }
  }

  const server = createServer((req, res) => { void handle(req, res); });
  return {
    server,
    async listen(host = '0.0.0.0') {
      await initialize();
      await verifyBinary(binary);
      await new Promise((resolve, reject) => server.once('error', reject).listen(port, host, resolve));
      return server.address();
    },
    async close() {
      for (const flow of flows.values()) await flow.manager.cancel(flow.principal, flow.id).catch(() => undefined);
      flows.clear();
      for (const listener of activeMonitors.values()) listener.stop();
      await Promise.all([...activeMonitors.values()].map(listener => listener.child ? new Promise(resolve => listener.child.once('close', resolve)) : Promise.resolve()));
      activeMonitors.clear();
      if (server.listening) await new Promise(resolve => server.close(() => resolve()));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const gateway = createDingtalkConnectorGateway();
    await gateway.listen();
    process.stdout.write(`DingTalk connector gateway listening on ${process.env.DINGTALK_CONNECTOR_PORT || 8789}\n`);
    const shutdown = () => { void gateway.close().finally(() => process.exit(0)); };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  } catch {
    process.stderr.write('DingTalk connector gateway startup failed\n');
    process.exitCode = 1;
  }
}
