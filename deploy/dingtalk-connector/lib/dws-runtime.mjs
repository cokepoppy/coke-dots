import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const dwsVersion = '1.0.64';
export const dwsRelease = `https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/download/v${dwsVersion}`;
export const dwsBinaryDigests = Object.freeze({
  'darwin-amd64': '0bfcedcd8fcab7a3d266708162a3bdb8fb6be4b3228d30b9ada56cac7309619c',
  'darwin-arm64': '32ad5c69302c2a586e86f988a1bb6cf1c101f8245266f9fd1b32c8893e3dc56b',
  'linux-amd64': 'd30e4778219e9cf7f1f503da7f0c77ed049b39516d4949dd5ae2c4577db12522',
  'linux-arm64': '341af37528c5f13b256006e0696dedf2629a1a01f7b081fb759ba5f59bfdf391',
});
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function platformKey(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch === 'x64' ? 'amd64' : arch}`;
  if (!Object.hasOwn(dwsBinaryDigests, key)) throw new Error('DWS_PLATFORM_UNSUPPORTED');
  return key;
}

export function principalKey(principal) {
  // Only call after the gateway has verified the enterprise identity. Not a JWT decoder.
  for (const name of ['issuer', 'subject']) {
    if (typeof principal?.[name] !== 'string' || !principal[name].trim() || principal[name].length > 2048) {
      throw new Error('CONNECTOR_IDENTITY_REQUIRED');
    }
  }
  return digest(JSON.stringify([principal.issuer, principal.subject]));
}

export function resolveDwsClientCredentials(env = process.env) {
  const clientId = typeof env.DINGTALK_CONNECTOR_DWS_CLIENT_ID === 'string'
    ? env.DINGTALK_CONNECTOR_DWS_CLIENT_ID : '';
  const clientSecret = typeof env.DINGTALK_CONNECTOR_DWS_CLIENT_SECRET === 'string'
    ? env.DINGTALK_CONNECTOR_DWS_CLIENT_SECRET : '';
  if (Boolean(clientId) !== Boolean(clientSecret)) throw new Error('DINGTALK_CONNECTOR_DWS_CREDENTIALS_INVALID');
  return { clientId: clientId || undefined, clientSecret: clientSecret || undefined };
}

async function privateDirectory(directory) {
  try { await fs.mkdir(directory, { mode: 0o700 }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid()) {
    throw new Error('CONNECTOR_STORAGE_UNSAFE');
  }
}

export async function prepareProfileRoot(storageRoot, principal) {
  const key = principalKey(principal);
  if (!path.isAbsolute(storageRoot)) throw new Error('CONNECTOR_STORAGE_ABSOLUTE_REQUIRED');
  await privateDirectory(storageRoot);
  const root = await fs.realpath(storageRoot);
  const owner = path.join(root, key);
  await privateDirectory(owner);
  for (const name of ['home', 'config', 'cache', 'data', 'temp']) await privateDirectory(path.join(owner, name));
  return owner;
}

export function isolatedEnvironment(owner, {
  proxy, macTestOnly = false, allowMacRuntime = false, clientId, clientSecret,
} = {}) {
  const env = {
    PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TERM: 'dumb', NO_COLOR: '1',
    HOME: path.join(owner, 'home'), DWS_CONFIG_DIR: path.join(owner, 'config'),
    XDG_CONFIG_HOME: path.join(owner, 'config'), XDG_CACHE_HOME: path.join(owner, 'cache'),
    XDG_DATA_HOME: path.join(owner, 'data'), TMPDIR: path.join(owner, 'temp'),
  };
  if (Boolean(clientId) !== Boolean(clientSecret)) throw new Error('DINGTALK_CONNECTOR_DWS_CREDENTIALS_INVALID');
  if (clientId && clientSecret) {
    env.DWS_CLIENT_ID = clientId;
    env.DWS_CLIENT_SECRET = clientSecret;
  }
  // This opt-in is for isolated Mac probes only, never change the host's Keychain mode.
  if (macTestOnly || allowMacRuntime) env.DWS_DISABLE_KEYCHAIN = '1';
  if (proxy) {
    const url = new URL(proxy);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('CONNECTOR_PROXY_INVALID');
    }
    env.HTTPS_PROXY = env.HTTP_PROXY = url.origin;
    env.NO_PROXY = 'localhost,127.0.0.1,::1';
  }
  return env;
}

export function hostProfileEnvironment({ proxy, clientId, clientSecret, configDir } = {}) {
  const home = homedir();
  if (configDir && !path.isAbsolute(configDir)) throw new Error('DWS_HOST_CONFIG_PATH_INVALID');
  const resolvedConfigDir = configDir ? path.resolve(configDir) : path.join(home, '.dws');
  const env = {
    PATH: path.join(home, '.local', 'bin') + ':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG || 'C.UTF-8', TERM: 'dumb', NO_COLOR: '1',
    HOME: home,
    DWS_CONFIG_DIR: resolvedConfigDir,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, 'Library', 'Caches'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    TMPDIR: tmpdir(),
  };
  if (Boolean(clientId) !== Boolean(clientSecret)) throw new Error('DINGTALK_CONNECTOR_DWS_CREDENTIALS_INVALID');
  if (clientId && clientSecret) {
    env.DWS_CLIENT_ID = clientId;
    env.DWS_CLIENT_SECRET = clientSecret;
  }
  if (proxy) {
    const url = new URL(proxy);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('CONNECTOR_PROXY_INVALID');
    }
    env.HTTPS_PROXY = env.HTTP_PROXY = url.origin;
    env.NO_PROXY = 'localhost,127.0.0.1,::1';
  }
  return env;
}

export async function withProfileLock(owner, work) {
  const lockPath = path.join(owner, '.operation.lock');
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') throw new Error('CONNECTOR_PROFILE_BUSY');
    throw error;
  }
  try { return await work(); } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}

export async function verifyDwsBinary(binary, key = platformKey()) {
  const pins = JSON.parse(await fs.readFile(new URL('./dws-binaries.json', import.meta.url), 'utf8'));
  const info = await fs.lstat(binary);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022)) throw new Error('DWS_BINARY_UNSAFE');
  if (!Object.hasOwn(dwsBinaryDigests, key) || pins.version !== dwsVersion || pins.binary?.[key] !== dwsBinaryDigests[key] || digest(await fs.readFile(binary)) !== pins.binary[key]) {
    throw new Error('DWS_BINARY_CHECKSUM_MISMATCH');
  }
}

export function runDwsProcess(binary, args, {
  env, cwd, timeoutMs = 25_000, maxBytes = 256 * 1024, parseJson = true,
  input, maxInputBytes = 512 * 1024, parseJsonOnFailure = false,
}) {
  return new Promise((resolve, reject) => {
    const inputBytes = input === undefined ? null : Buffer.from(String(input), 'utf8');
    if (inputBytes && inputBytes.length > maxInputBytes) return reject(new Error('DWS_INPUT_TOO_LARGE'));
    let output = '';
    let bytes = 0;
    let failure;
    const decoder = new StringDecoder('utf8');
    const child = spawn(binary, args, { cwd, env, shell: false, stdio: [inputBytes ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const fail = (code) => { failure ||= code; child.kill('SIGKILL'); };
    const timer = setTimeout(() => fail('DWS_PROCESS_TIMEOUT'), timeoutMs);
    if (inputBytes) {
      child.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') fail('DWS_PROCESS_INPUT_FAILED');
      });
      child.stdin.end(inputBytes);
    }
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) fail('DWS_OUTPUT_TOO_LARGE');
      else output += decoder.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) fail('DWS_OUTPUT_TOO_LARGE');
      // Provider errors can contain tokens or authorization links. Never forward them.
    });
    child.on('error', () => { failure ||= 'DWS_PROCESS_START_FAILED'; });
    child.on('close', (code) => {
      clearTimeout(timer);
      const complete = output + decoder.end();
      if (failure) return reject(new Error(failure));
      if (code !== 0 && !parseJsonOnFailure) return reject(new Error('DWS_PROCESS_FAILED'));
      if (!parseJson) return resolve(complete);
      try { resolve(JSON.parse(complete)); } catch {
        reject(new Error(code === 0 ? 'DWS_INVALID_JSON' : 'DWS_PROCESS_FAILED'));
      }
    });
  });
}

export function selectCurrentProfile(payload) {
  if (payload?.success !== true || !Array.isArray(payload.profiles)) throw new Error('DWS_INVALID_PROFILE_LIST');
  if (!payload.profiles.length) return null;
  const selected = payload.profiles.filter((p) => p.isCurrent === true && p.isOrgCurrent === true);
  if (selected.length !== 1) throw new Error('DWS_PROFILE_SELECTION_REQUIRED');
  const profile = selected[0];
  for (const name of ['corpId', 'userId']) {
    if (typeof profile[name] !== 'string' || !/^[a-zA-Z0-9._@-]{1,256}$/.test(profile[name])) {
      throw new Error('DWS_PROFILE_IDENTITY_REQUIRED');
    }
  }
  return { corpId: profile.corpId, userId: profile.userId, selector: `${profile.corpId}:${profile.userId}` };
}

export function parseAuthStatus(payload, profile, now = Date.now()) {
  if (payload?.success !== true || typeof payload.authenticated !== 'boolean') throw new Error('DWS_INVALID_AUTH_STATUS');
  // A status read checks token lifetime/refresh, not document scopes or remote revocation.
  if (payload.reason) throw new Error('DWS_AUTH_STATUS_UNAVAILABLE');
  if (!payload.authenticated) return { authenticated: false };
  if (payload.corp_id !== profile.corpId || payload.user_id !== profile.userId) throw new Error('DWS_PROFILE_MISMATCH');
  const expiry = Date.parse(payload.expires_at);
  if (payload.token_valid !== true || !Number.isFinite(expiry) || expiry <= now) return { authenticated: false };
  return {
    authenticated: true, corpId: profile.corpId, expiresAt: new Date(expiry).toISOString(),
    accountName: typeof payload.user_name === 'string' ? payload.user_name.slice(0, 200) : undefined,
    organizationName: typeof payload.corp_name === 'string' ? payload.corp_name.slice(0, 200) : undefined,
  };
}

export async function inspectDwsProfile({
  binary, storageRoot, principal, proxy, macTestOnly = false, allowMacRuntime = false,
  clientId, clientSecret, hostProfile = false, hostConfigDir, verifyBinary: verify = verifyDwsBinary,
}) {
  if (process.platform !== 'linux' && !(process.platform === 'darwin' && (macTestOnly || allowMacRuntime))) {
    throw new Error('DWS_GATEWAY_REQUIRES_LINUX');
  }
  await verify(binary);
  const owner = await prepareProfileRoot(storageRoot, principal);
  const env = hostProfile
    ? hostProfileEnvironment({ proxy, clientId, clientSecret, configDir: hostConfigDir })
    : isolatedEnvironment(owner, { proxy, macTestOnly, allowMacRuntime, clientId, clientSecret });
  return withProfileLock(owner, async () => {
    const run = (args) => runDwsProcess(binary, [...args, '--format', 'json'], { cwd: owner, env });
    const profile = selectCurrentProfile(await run(['profile', 'list']));
    if (!profile) return { state: 'not-installed' };
    const status = parseAuthStatus(await run(['auth', 'status', '--profile', profile.selector]), profile);
    // Never map mere CLI login to the UI's connected/authorized-for-docs state.
    return { state: status.authenticated ? 'identity-verified' : 'expired', ...status };
  });
}
