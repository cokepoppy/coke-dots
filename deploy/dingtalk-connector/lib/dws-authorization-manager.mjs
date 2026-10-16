import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  inspectDwsProfile, isolatedEnvironment, prepareProfileRoot, principalKey,
  runDwsProcess, selectCurrentProfile, verifyDwsBinary, withProfileLock,
} from './dws-runtime.mjs';

const ansiPattern = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const urlPattern = /https:\/\/[^\s│┤]+/g;
const terminalStates = new Set(['authorized', 'failed', 'cancelled', 'expired']);

function clearExpiryTimer(job) {
  if (!job.expiryTimer) return;
  clearTimeout(job.expiryTimer);
  job.expiryTimer = null;
}

export function parseDwsVerificationUrl(value) {
  const urls = String(value || '').replace(ansiPattern, '').match(urlPattern) || [];
  const parsed = urls.flatMap((candidate) => {
    try { return [new URL(candidate)]; } catch { return []; }
  }).filter((url) => url.protocol === 'https:' && url.hostname === 'login.dingtalk.com' &&
    !url.username && !url.password && (url.port === '' || url.port === '443'));
  const complete = parsed.find((url) => url.searchParams.has('user_code') || url.searchParams.has('userCode'));
  if (!complete) return null;
  complete.hash = '';
  return complete.toString();
}

function publicJob(job) {
  const result = { id: job.id, state: job.state, createdAt: job.createdAt, expiresAt: job.expiresAt };
  if (job.state === 'awaiting-user') result.authorizationUrl = job.authorizationUrl;
  if (job.state === 'authorized') result.installation = job.installation;
  if (['failed', 'expired'].includes(job.state)) result.reason = job.reason;
  return result;
}

function startAuthorizationProcess(binary, owner, env, {
  onVerificationUrl, onComplete, onFailure, maxBytes = 256 * 1024,
} = {}) {
  let bytes = 0;
  let stdout = '';
  let stderr = '';
  let failure;
  const outDecoder = new StringDecoder('utf8');
  const errDecoder = new StringDecoder('utf8');
  const child = spawn(binary, ['auth', 'login', '--device', '--no-browser', '--format', 'json'], {
    cwd: owner, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = (reason) => {
    failure ||= reason;
    child.kill('SIGKILL');
  };
  child.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes) return stop('DWS_OUTPUT_TOO_LARGE');
    stdout += outDecoder.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes) return stop('DWS_OUTPUT_TOO_LARGE');
    stderr += errDecoder.write(chunk);
    const authorizationUrl = parseDwsVerificationUrl(stderr);
    if (authorizationUrl) onVerificationUrl?.(authorizationUrl);
  });
  child.on('error', () => { failure ||= 'DWS_PROCESS_START_FAILED'; });
  child.on('close', (code) => {
    stdout += outDecoder.end();
    stderr += errDecoder.end();
    if (failure || code !== 0) return onFailure?.(failure || 'DWS_AUTHORIZATION_FAILED');
    try {
      const payload = JSON.parse(stdout);
      if (payload?.success !== true || payload?.token_valid !== true || typeof payload?.corp_id !== 'string' ||
          !payload.corp_id || typeof payload?.user_id !== 'string' || !payload.user_id) {
        throw new Error('invalid');
      }
      onComplete?.();
    } catch {
      onFailure?.('DWS_AUTHORIZATION_INVALID_RESULT');
    }
  });
  return { kill: () => stop('CONNECTOR_AUTHORIZATION_CANCELLED') };
}

export function createDwsAuthorizationManager({
  binary, storageRoot, proxy, macTestOnly = false, allowMacRuntime = false, now = () => Date.now(), uuid = randomUUID,
  verifyBinary = verifyDwsBinary, launch = startAuthorizationProcess,
  inspect = inspectDwsProfile, run = runDwsProcess,
  startTimeoutMs = 20_000, authorizationTtlMs = 10 * 60_000,
} = {}) {
  const jobs = new Map();
  const activeByOwner = new Map();
  let binaryVerified;
  const verify = () => binaryVerified ||= verifyBinary(binary);
  const ownerFor = async (principal) => {
    await verify();
    return prepareProfileRoot(storageRoot, principal);
  };

  async function status(principal) {
    const ownerKey = principalKey(principal);
    const active = activeByOwner.get(ownerKey);
    if (active && !terminalStates.has(active.state)) return { state: 'pending', authorization: publicJob(active) };
    return inspect({ binary, storageRoot, principal, proxy, macTestOnly, allowMacRuntime, verifyBinary });
  }

  async function start(principal) {
    const ownerKey = principalKey(principal);
    const active = activeByOwner.get(ownerKey);
    if (active && !terminalStates.has(active.state)) return publicJob(active);
    const owner = await ownerFor(principal);
    const created = now();
    const job = {
      id: uuid(), ownerKey, state: 'starting', createdAt: new Date(created).toISOString(),
      expiresAt: new Date(created + authorizationTtlMs).toISOString(), process: null, expiryTimer: null,
    };
    jobs.set(job.id, job);
    activeByOwner.set(ownerKey, job);

    let settleReady;
    const ready = new Promise((resolve, reject) => { settleReady = { resolve, reject }; });
    let processResult;
    const complete = withProfileLock(owner, () => new Promise((resolve) => {
      const env = isolatedEnvironment(owner, { proxy, macTestOnly, allowMacRuntime });
      job.process = launch(binary, owner, env, {
        onVerificationUrl: (authorizationUrl) => {
          if (terminalStates.has(job.state) || job.authorizationUrl) return;
          job.authorizationUrl = authorizationUrl;
          job.state = 'awaiting-user';
          settleReady.resolve();
        },
        onComplete: () => {
          if (terminalStates.has(job.state)) return resolve();
          clearExpiryTimer(job);
          processResult = 'complete';
          job.state = 'verifying';
          resolve();
        },
        onFailure: (reason) => {
          if (terminalStates.has(job.state)) return resolve();
          clearExpiryTimer(job);
          processResult = reason;
          job.state = reason === 'CONNECTOR_AUTHORIZATION_CANCELLED' ? 'cancelled' : 'failed';
          job.reason = job.state === 'failed' ? reason : undefined;
          settleReady.reject(new Error(reason));
          resolve();
        },
      });
    }));
    job.completion = complete.then(async () => {
      if (processResult !== 'complete') return;
      try {
        const result = await inspect({ binary, storageRoot, principal, proxy, macTestOnly, allowMacRuntime, verifyBinary });
        if (result.state !== 'identity-verified') throw new Error('not verified');
        job.installation = result;
        job.state = 'authorized';
      } catch {
        job.state = 'failed';
        job.reason = 'CONNECTOR_IDENTITY_READBACK_FAILED';
      }
      settleReady.resolve();
    }).catch((error) => {
      job.state = 'failed';
      job.reason = error.message === 'CONNECTOR_PROFILE_BUSY' ? error.message : 'CONNECTOR_AUTHORIZATION_FAILED';
      settleReady.reject(new Error(job.reason));
    });

    const timer = setTimeout(() => {
      if (job.state === 'starting') {
      processResult = 'CONNECTOR_AUTHORIZATION_START_TIMEOUT';
      job.state = 'failed';
      job.reason = 'CONNECTOR_AUTHORIZATION_START_TIMEOUT';
      clearExpiryTimer(job);
      settleReady.reject(new Error(job.reason));
        job.process?.kill();
      }
    }, startTimeoutMs);
    job.expiryTimer = setTimeout(() => {
      if (terminalStates.has(job.state)) return;
      processResult = 'CONNECTOR_AUTHORIZATION_EXPIRED';
      job.state = 'expired';
      job.reason = 'CONNECTOR_AUTHORIZATION_EXPIRED';
      clearExpiryTimer(job);
      settleReady.reject(new Error(job.reason));
      job.process?.kill();
    }, authorizationTtlMs);
    try { await ready; } finally { clearTimeout(timer); }
    return publicJob(job);
  }

  function ownedJob(principal, id) {
    const job = jobs.get(id);
    if (!job || job.ownerKey !== principalKey(principal)) throw new Error('CONNECTOR_AUTHORIZATION_NOT_FOUND');
    if (!terminalStates.has(job.state) && Date.parse(job.expiresAt) <= now()) {
      job.state = 'expired';
      job.reason = 'CONNECTOR_AUTHORIZATION_EXPIRED';
      clearExpiryTimer(job);
      job.process?.kill();
    }
    return job;
  }

  async function poll(principal, id) {
    const job = ownedJob(principal, id);
    if (job.state === 'verifying') await job.completion;
    return publicJob(job);
  }

  async function cancel(principal, id) {
    const job = ownedJob(principal, id);
    if (!terminalStates.has(job.state)) {
      job.state = 'cancelled';
      clearExpiryTimer(job);
      job.process?.kill();
      await job.completion;
    }
    return publicJob(job);
  }

  async function disconnect(principal) {
    const ownerKey = principalKey(principal);
    const active = activeByOwner.get(ownerKey);
    if (active && !terminalStates.has(active.state)) await cancel(principal, active.id);
    const owner = await ownerFor(principal);
    return withProfileLock(owner, async () => {
      const env = isolatedEnvironment(owner, { proxy, macTestOnly, allowMacRuntime });
      const profile = selectCurrentProfile(await run(binary, ['profile', 'list', '--format', 'json'], { cwd: owner, env }));
      if (!profile) return { disconnected: true };
      await run(binary, ['auth', 'logout', '--profile', profile.selector, '--format', 'json'], { cwd: owner, env, parseJson: false });
      const readback = await run(binary, ['profile', 'list', '--format', 'json'], { cwd: owner, env });
      if (readback?.success !== true || !Array.isArray(readback.profiles)) throw new Error('DWS_LOGOUT_READBACK_FAILED');
      if (readback.profiles.some((item) => `${item.corpId}:${item.userId}` === profile.selector)) {
        throw new Error('DWS_LOGOUT_READBACK_FAILED');
      }
      return { disconnected: true };
    });
  }

  return { status, start, poll, cancel, disconnect };
}
