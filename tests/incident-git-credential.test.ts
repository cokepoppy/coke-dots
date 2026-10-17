import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type Server } from 'node:http';
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

async function listen(server: Server) {
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/`;
}

async function postBroker(socketPath: string, pathname: string, payload: unknown) {
  const body = JSON.stringify(payload);
  return await new Promise<{ status: number; value: any }>((resolvePromise, reject) => {
    const request = httpRequest({ socketPath, path: pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        try { resolvePromise({ status: response.statusCode || 0, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch (error) { reject(error); }
      });
    });
    request.once('error', reject);
    request.end(body);
  });
}

test('incident Git credential broker returns a token only for the fixed HTTPS repository', { timeout: 10_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'coke-dots-git-credential-'));
  const socketPath = join(temporary, 'credential.sock');
  const tokenPath = join(temporary, 'token');
  const token = 'github_pat_repo-scoped-test-token';
  let broker: ChildProcess | null = null;
  const pullRequests: any[] = [];
  const githubRequests: Array<{ method: string; authorization: string | undefined; url: string }> = [];
  const github = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    githubRequests.push({ method: request.method || '', authorization: request.headers.authorization, url: request.url || '' });
    response.setHeader('content-type', 'application/json');
    if (request.url?.startsWith('/repos/cokepoppy/coke-agent-test/pulls?')) {
      response.end(JSON.stringify(pullRequests.filter(value => value.state === 'open')));
      return;
    }
    if (request.url === '/repos/cokepoppy/coke-agent-test/branches/fix%2Fcoke-agent-empty-conversation-c7e2a195') {
      response.end(JSON.stringify({ name: 'fix/coke-agent-empty-conversation-c7e2a195', commit: { sha: 'c'.repeat(40) } }));
      return;
    }
    if (request.url === '/repos/cokepoppy/coke-agent-test/pulls' && request.method === 'POST') {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(payload.title, 'Handle missing conversation state in Coke Agent');
      assert.equal(payload.head, 'fix/coke-agent-empty-conversation-c7e2a195');
      assert.equal(payload.base, 'main');
      assert.match(payload.body, /c7e2a195-4f93-4c60-8a27-b1d6e0f5a94c/);
      const created = {
        number: 7,
        html_url: 'https://github.com/cokepoppy/coke-agent-test/pull/7',
        state: 'open',
        merged: false,
        head: { ref: payload.head, repo: { full_name: 'cokepoppy/coke-agent-test' } },
        base: { ref: payload.base, repo: { full_name: 'cokepoppy/coke-agent-test' } },
      };
      pullRequests.push(created);
      response.statusCode = 201;
      response.end(JSON.stringify(created));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'unexpected route' }));
  });
  try {
    const apiUrl = await listen(github);
    await writeFile(tokenPath, token, { mode: 0o600 });
    broker = spawn(process.execPath, [serverPath], {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'test', DOTS_INCIDENT_GITHUB_API_URL: apiUrl, DOTS_INCIDENT_GITHUB_CREDENTIAL_SOCKET: socketPath, DOTS_INCIDENT_GITHUB_TOKEN_FILE: tokenPath },
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

    const created = await postBroker(socketPath, '/pull-request', {});
    assert.equal(created.status, 201);
    assert.deepEqual(created.value, {
      number: 7,
      url: 'https://github.com/cokepoppy/coke-agent-test/pull/7',
      state: 'open',
      head: 'fix/coke-agent-empty-conversation-c7e2a195',
      base: 'main',
      merged: false,
    });
    const reused = await postBroker(socketPath, '/pull-request', {});
    assert.equal(reused.status, 200, 'retries reuse the existing open PR instead of creating a duplicate');
    assert.equal(reused.value.number, 7);
    assert.equal(pullRequests.length, 1);
    const callerSuppliedText = await postBroker(socketPath, '/pull-request', { title: 'Caller supplied text', body: '' });
    assert.equal(callerSuppliedText.status, 400, 'the caller cannot choose PR text, repository, head, or base');
    assert.equal(githubRequests.filter(value => value.method === 'POST').length, 1);
    assert.ok(githubRequests.every(value => value.authorization === `Bearer ${token}`));
    assert.ok(githubRequests.every(value => ['/repos/cokepoppy/coke-agent-test/pulls', '/repos/cokepoppy/coke-agent-test/branches/fix%2Fcoke-agent-empty-conversation-c7e2a195'].some(route => value.url.startsWith(route))));
    assert.doesNotMatch(brokerStderr, new RegExp(token));
  } finally {
    if (broker && broker.exitCode === null) {
      broker.kill('SIGTERM');
      await new Promise<void>(resolvePromise => broker!.once('exit', () => resolvePromise()));
    }
    await new Promise<void>(resolvePromise => github.close(() => resolvePromise()));
    await rm(temporary, { recursive: true, force: true });
  }
});
