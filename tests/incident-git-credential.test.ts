import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = join(root, 'deploy/linux-desktop/incident-git-credential-server.mjs');
const helperPath = join(root, 'deploy/linux-desktop/incident-git-credential-helper.mjs');

async function waitForSocket(socketPath: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await stat(socketPath)).isSocket()) return; } catch { /* not ready */ }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  throw new Error('Git credential broker did not create its Unix socket');
}

async function runHelper(socketPath: string, action: string, input: string) {
  const child = spawn(process.execPath, [helperPath, action], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'test', DOTS_INCIDENT_GITHUB_CREDENTIAL_SOCKET: socketPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
  child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
  const exit = new Promise<number>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', code => resolvePromise(code ?? 1));
  });
  child.stdin.end(input);
  const code = await exit;
  assert.equal(code, 0, stderr);
  assert.equal(stderr, '', 'credential helper must not log the token or request details');
  return stdout;
}

test('incident Git credential broker returns a token only for the fixed HTTPS repository', { timeout: 10_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'coke-dots-git-credential-'));
  const socketPath = join(temporary, 'credential.sock');
  const tokenPath = join(temporary, 'token');
  const token = 'github_pat_repo-scoped-test-token';
  let broker: ChildProcess | null = null;
  try {
    await writeFile(tokenPath, token, { mode: 0o600 });
    broker = spawn(process.execPath, [serverPath], {
      cwd: root,
      env: { ...process.env, DOTS_INCIDENT_GITHUB_CREDENTIAL_SOCKET: socketPath, DOTS_INCIDENT_GITHUB_TOKEN_FILE: tokenPath },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let brokerStderr = '';
    broker.stderr?.on('data', chunk => brokerStderr = (brokerStderr + chunk.toString()).slice(-1000));
    await waitForSocket(socketPath);
    assert.equal((await stat(socketPath)).mode & 0o777, 0, 'the broker socket starts inaccessible until the scoped task enables it');
    await chmod(socketPath, 0o600);

    const exact = await runHelper(socketPath, 'get', 'protocol=https\nhost=github.com\npath=cokepoppy/coke-agent-test.git\n\n');
    assert.equal(exact, `username=x-access-token\npassword=${token}\n\n`);
    const otherRepo = await runHelper(socketPath, 'get', 'protocol=https\nhost=github.com\npath=cokepoppy/another-repository.git\n\n');
    assert.equal(otherRepo, '', 'the broker must not disclose the token to another repository');
    const otherHost = await runHelper(socketPath, 'get', 'protocol=https\nhost=attacker.example\npath=cokepoppy/coke-agent-test.git\n\n');
    assert.equal(otherHost, '', 'the broker must not disclose the token to another host');
    const store = await runHelper(socketPath, 'store', `protocol=https\nhost=github.com\npath=cokepoppy/coke-agent-test.git\npassword=${token}\n\n`);
    assert.equal(store, '', 'the helper never persists supplied credentials');
    assert.doesNotMatch(brokerStderr, new RegExp(token));
  } finally {
    if (broker && broker.exitCode === null) {
      broker.kill('SIGTERM');
      await new Promise<void>(resolvePromise => broker!.once('exit', () => resolvePromise()));
    }
    await rm(temporary, { recursive: true, force: true });
  }
});
