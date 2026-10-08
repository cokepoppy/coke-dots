import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = join(projectRoot, 'deploy/linux-desktop/agent-runtime.mjs');

async function listen(server: Server) {
  await new Promise<void>((resolvePromise, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return address.port;
}

async function freePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
  return port;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  throw new Error('Timed out waiting for the Agent runtime test condition');
}

test('cloud Agent runtime serializes desktop access, isolates runtime credentials, and pauses on takeover', { timeout: 20_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'coke-dots-agent-runtime-'));
  const workspace = join(temporary, 'workspace');
  const adapterPath = join(temporary, 'adapter.mjs');
  const markerPath = join(temporary, 'adapter-events.log');
  let owner: 'agent' | 'user' = 'agent';
  let child: ChildProcess | null = null;
  const worker = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/control') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ owner }));
      return;
    }
    res.writeHead(404); res.end();
  });
  try {
    const workerPort = await listen(worker);
    const runtimePort = await freePort();
    await writeFile(adapterPath, [
      "import { appendFile } from 'node:fs/promises';",
      "let raw = ''; for await (const chunk of process.stdin) raw += chunk;",
      'const input = JSON.parse(raw);',
      "await appendFile(process.env.DOTS_TEST_MARKER, `start ${input.taskId}\\n`);",
      "if (input.prompt === 'hold') await new Promise(resolve => setTimeout(resolve, 30000));",
      'await new Promise(resolve => setTimeout(resolve, 80));',
      "await appendFile(process.env.DOTS_TEST_MARKER, `end ${input.taskId}\\n`);",
      "process.stdout.write(JSON.stringify({ status: 'done', message: `${process.env.DOTS_AGENT_RUNTIME_TOKEN ? 'runtime token leaked' : 'runtime token isolated'}; ${process.env.LINUX_DESKTOP_WORKER_TOKEN ? 'worker token leaked' : 'worker token isolated'}` }));",
      '',
    ].join('\n'));
    child = spawn(process.execPath, [runtimePath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        DOTS_AGENT_RUNTIME_TOKEN: 'agent-test-token-never-print',
        DOTS_AGENT_RUNTIME_PORT: String(runtimePort),
        DOTS_AGENT_WORKSPACE: workspace,
        DOTS_AGENT_KERNELS_JSON: JSON.stringify({ dsh: { command: process.execPath, args: [adapterPath] } }),
        DOTS_DESKTOP_AGENT_ADAPTERS: 'dsh',
        DOTS_TEST_MARKER: markerPath,
        LINUX_DESKTOP_WORKER_PORT: String(workerPort),
        LINUX_DESKTOP_WORKER_TOKEN: 'worker-test-token',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-1000); });
    const runtimeUrl = `http://127.0.0.1:${runtimePort}`;
    await waitFor(async () => {
      try { return (await fetch(`${runtimeUrl}/healthz`)).ok; } catch { return false; }
    });

    const submit = async (taskId: string, prompt: string) => {
      const response = await fetch(`${runtimeUrl}/v1/tasks/run`, {
        method: 'POST',
        headers: { authorization: 'Bearer agent-test-token-never-print', 'content-type': 'application/json' },
        body: JSON.stringify({ engine: 'dsh', taskId, prompt, cwd: `tasks/${taskId}`, sessionId: null }),
      });
      return { status: response.status, body: await response.json() as { status?: string; message?: string; error?: string } };
    };

    const firstId = '11111111-1111-4111-8111-111111111111';
    const secondId = '22222222-2222-4222-8222-222222222222';
    const [first, second] = await Promise.all([submit(firstId, 'first'), submit(secondId, 'second')]);
    assert.deepEqual([first.status, second.status], [200, 200], JSON.stringify([first, second]));
    assert.equal(first.body.status, 'done');
    assert.equal(first.body.message, 'runtime token isolated; worker token isolated');
    assert.equal(second.body.message, 'runtime token isolated; worker token isolated');
    const events = (await readFile(markerPath, 'utf8')).trim().split('\n').map(line => line.split(' ')[0]);
    assert.deepEqual(events, ['start', 'end', 'start', 'end'], 'Only one adapter may use the tenant browser at a time');
    await stat(join(workspace, 'tasks', firstId));
    await stat(join(workspace, 'tasks', secondId));

    const heldId = '33333333-3333-4333-8333-333333333333';
    const heldPromise = submit(heldId, 'hold');
    await waitFor(async () => (await readFile(markerPath, 'utf8').catch(() => '')).includes(`start ${heldId}`));
    owner = 'user';
    const held = await heldPromise;
    assert.equal(held.status, 200);
    assert.equal(held.body.status, 'waiting');
    assert.match(held.body.message || '', /接管电脑/);
    assert.doesNotMatch(stderr, /agent-test-token-never-print/);
    owner = 'agent';

    const stoppedId = '55555555-5555-4555-8555-555555555555';
    const stoppedPromise = submit(stoppedId, 'hold');
    await waitFor(async () => (await readFile(markerPath, 'utf8').catch(() => '')).includes(`start ${stoppedId}`));
    const stopResponse = await fetch(`${runtimeUrl}/v1/tasks/stop`, {
      method: 'POST', headers: { authorization: 'Bearer agent-test-token-never-print', 'content-type': 'application/json' },
      body: JSON.stringify({ taskId: stoppedId }),
    });
    assert.equal((await stopResponse.json() as { stopped?: boolean }).stopped, true, 'The tenant task stop endpoint must interrupt the named task');
    const stopped = await stoppedPromise;
    assert.equal(stopped.status, 400);
    assert.match(stopped.body.error || '', /stopped by the user/i);
    assert.doesNotMatch(await readFile(markerPath, 'utf8'), new RegExp(`end ${stoppedId}`), 'A stopped adapter must not finish in the background');
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>(resolvePromise => child!.once('exit', () => resolvePromise()));
    }
    await new Promise<void>(resolvePromise => worker.close(() => resolvePromise()));
    await rm(temporary, { recursive: true, force: true });
  }
});

test('cloud Agent runtime finishes disconnected work and replays the persisted result after a runtime restart', { timeout: 20_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'coke-dots-agent-recovery-'));
  const workspace = join(temporary, 'workspace');
  const adapterPath = join(temporary, 'adapter.mjs');
  const markerPath = join(temporary, 'adapter-events.log');
  let owner: 'agent' | 'user' = 'agent';
  let worker: Server | null = null;
  let workerPort = 0;
  let child: ChildProcess | null = null;
  const startRuntime = async () => {
    const port = await freePort();
    const processChild = spawn(process.execPath, [runtimePath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        DOTS_AGENT_RUNTIME_TOKEN: 'recovery-agent-token', DOTS_AGENT_RUNTIME_PORT: String(port), DOTS_AGENT_WORKSPACE: workspace,
        DOTS_AGENT_KERNELS_JSON: JSON.stringify({ dsh: { command: process.execPath, args: [adapterPath] } }),
        DOTS_DESKTOP_AGENT_ADAPTERS: 'dsh', DOTS_TEST_MARKER: markerPath,
        LINUX_DESKTOP_WORKER_PORT: String(workerPort), LINUX_DESKTOP_WORKER_TOKEN: 'worker-recovery-token',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    processChild.stderr?.on('data', chunk => { stderr += String(chunk).slice(-1200); });
    const url = `http://127.0.0.1:${port}`;
    await waitFor(async () => { try { return (await fetch(`${url}/healthz`)).ok; } catch { return false; } });
    return { process: processChild, url };
  };
  let stderr = '';
  const stopRuntime = async () => {
    if (!child || child.exitCode !== null) return;
    const current = child;
    const exited = new Promise<void>(resolvePromise => current.once('exit', () => resolvePromise()));
    current.kill('SIGTERM');
    await exited;
    child = null;
  };
  const request = async (url: string, taskId: string, prompt: string, options: { signal?: AbortSignal; executionId?: string } = {}) => {
    const response = await fetch(`${url}/v1/tasks/run`, {
      method: 'POST', headers: { authorization: 'Bearer recovery-agent-token', 'content-type': 'application/json' },
      body: JSON.stringify({ engine: 'dsh', taskId, executionId: options.executionId || `run:${taskId}`, prompt, sessionId: null, cwd: `tasks/${taskId}` }), signal: options.signal,
    });
    return { status: response.status, body: await response.json() as { status?: string; message?: string; error?: string } };
  };
  try {
    worker = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/v1/control') {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ owner })); return;
      }
      res.writeHead(404); res.end();
    });
    workerPort = await listen(worker);
    await writeFile(adapterPath, [
      "import { appendFile } from 'node:fs/promises';",
      "let raw = ''; for await (const chunk of process.stdin) raw += chunk;",
      'const input = JSON.parse(raw);',
      "await appendFile(process.env.DOTS_TEST_MARKER, `start ${input.taskId} ${input.prompt}\\n`);",
      "await new Promise(resolve => setTimeout(resolve, 250));",
      "await appendFile(process.env.DOTS_TEST_MARKER, `end ${input.taskId} ${input.prompt}\\n`);",
      "process.stdout.write(JSON.stringify({ status: 'done', message: `completed ${input.prompt}` }));",
    ].join('\n'));
    const taskId = '44444444-4444-4444-8444-444444444444';
    let runtime = await startRuntime();
    child = runtime.process;
    const disconnect = new AbortController();
    const firstRequest = request(runtime.url, taskId, 'recover after control-plane restart', { signal: disconnect.signal, executionId: 'run-one' });
    await waitFor(async () => (await readFile(markerPath, 'utf8').catch(() => '')).includes(`start ${taskId}`));
    disconnect.abort();
    await assert.rejects(firstRequest, /aborted|abort/i, 'The simulated control-plane connection should close');
    await waitFor(async () => (await readFile(markerPath, 'utf8').catch(() => '')).includes(`end ${taskId}`));

    const resultFile = join(workspace, '.coke-dots-agent-runtime-state', `${createHash('sha256').update(taskId).digest('hex')}.json`);
    await waitFor(async () => {
      try {
        const saved = JSON.parse(await readFile(resultFile, 'utf8')) as { result?: { status?: string; message?: string } };
        return saved.result?.status === 'done' && saved.result.message === 'completed recover after control-plane restart';
      } catch {
        return false;
      }
    });

    await stopRuntime();
    runtime = await startRuntime();
    child = runtime.process;
    const recovered = await request(runtime.url, taskId, 'recover after control-plane restart', { executionId: 'run-one' });
    assert.equal(recovered.status, 200);
    assert.deepEqual(recovered.body, { taskId, status: 'done', message: 'completed recover after control-plane restart', engine: 'dsh', sessionId: null });
    assert.equal((await readFile(markerPath, 'utf8')).match(new RegExp(`start ${taskId}`, 'g'))?.length, 1, 'Retry must reuse the completed result rather than run the adapter twice');

    const redirected = await request(runtime.url, taskId, 'continue with the updated goal', { executionId: 'run-two' });
    assert.equal(redirected.status, 200);
    assert.equal(redirected.body.message, 'completed continue with the updated goal', 'A redirected task must not receive a stale cached result');
    assert.equal((await readFile(markerPath, 'utf8')).match(new RegExp(`start ${taskId}`, 'g'))?.length, 2);
    const nextScheduledRun = await request(runtime.url, taskId, 'continue with the updated goal', { executionId: 'run-three' });
    assert.equal(nextScheduledRun.body.message, 'completed continue with the updated goal');
    assert.equal((await readFile(markerPath, 'utf8')).match(new RegExp(`start ${taskId}`, 'g'))?.length, 3, 'A later run with unchanged instructions must not replay an earlier recurring result');
    assert.doesNotMatch(stderr, /recovery-agent-token|worker-recovery-token/);
  } finally {
    await stopRuntime();
    await new Promise<void>(resolvePromise => worker?.close(() => resolvePromise()) || resolvePromise());
    await rm(temporary, { recursive: true, force: true });
  }
});

test('cloud Agent runtime refuses Claude Code even when an operator configures it', { timeout: 10_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'coke-dots-agent-runtime-kernel-boundary-'));
  const runtimePort = await freePort();
  const child = spawn(process.execPath, [runtimePath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DOTS_AGENT_RUNTIME_TOKEN: 'kernel-boundary-test-token',
      DOTS_AGENT_RUNTIME_PORT: String(runtimePort),
      DOTS_AGENT_WORKSPACE: join(temporary, 'workspace'),
      DOTS_AGENT_KERNELS_JSON: JSON.stringify({ claude: { command: process.execPath, args: ['-e', 'process.exit(0)'] } }),
      DOTS_DESKTOP_AGENT_ADAPTERS: 'claude',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
  try {
    const exitCode = await new Promise<number | null>(resolvePromise => {
      const timer = setTimeout(() => resolvePromise(null), 2500);
      timer.unref();
      child.once('exit', code => { clearTimeout(timer); resolvePromise(code); });
    });
    assert.notEqual(exitCode, null, 'Runtime must reject unsupported configuration instead of serving Claude Code');
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /Unsupported cloud Agent kernel 'claude'/);
    assert.doesNotMatch(stderr, /kernel-boundary-test-token/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolvePromise => child.once('exit', () => resolvePromise()));
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise(resolvePromise => setTimeout(resolvePromise, 1000))]);
    }
    await rm(temporary, { recursive: true, force: true });
  }
});
