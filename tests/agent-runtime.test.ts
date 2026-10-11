import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
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
      "if (input.executionMode === 'proactive-research') await appendFile(process.env.DOTS_TEST_MARKER, `review ${JSON.stringify({ cwd: input.cwd, workspace: input.workspace, computer: input.computer, workerToken: Boolean(process.env.LINUX_DESKTOP_WORKER_TOKEN) })}\\n`);",
      "if (input.engine === 'pi') await appendFile(process.env.DOTS_TEST_MARKER, `pi-config ${JSON.stringify({ present: Boolean(input.modelConfig?.apiKey), model: input.modelConfig?.model, keyCopiedToEnv: process.env.DOTS_MODEL_API_KEY === input.modelConfig?.apiKey })}\\n`);",
      "process.stdout.write(JSON.stringify(input.executionMode === 'proactive-research' ? { status: 'done', message: 'A bounded finding.', proactiveFinding: true } : { status: 'done', message: `runtime ${process.env.DOTS_AGENT_RUNTIME_TOKEN ? 'token leaked' : 'token isolated'}; computer ${process.env.LINUX_DESKTOP_WORKER_TOKEN ? 'token leaked' : 'token isolated'}` }));",
      '',
    ].join('\n'));
    child = spawn(process.execPath, [runtimePath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        DOTS_AGENT_RUNTIME_TOKEN: 'agent-test-token-never-print',
        DOTS_AGENT_RUNTIME_PORT: String(runtimePort),
        DOTS_AGENT_WORKSPACE: workspace,
        DOTS_AGENT_KERNELS_JSON: JSON.stringify({ dsh: { command: process.execPath, args: [adapterPath] }, pi: { command: process.execPath, args: [adapterPath] }, claude: { command: '/bin/false', args: [] } }),
        DOTS_DESKTOP_AGENT_ADAPTERS: 'dsh,pi,claude',
        DOTS_TEST_MARKER: markerPath,
        DOTS_MODEL_API_KEY: '',
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
    const health = await fetch(`${runtimeUrl}/healthz`).then(response => response.json()) as { adapters?: string[] };
    assert.deepEqual(health.adapters, ['dsh', 'pi'], 'A kernel is advertised only when it is enabled as well as configured');
    const disabled = await fetch(`${runtimeUrl}/v1/tasks/run`, {
      method: 'POST',
      headers: { authorization: 'Bearer agent-test-token-never-print', 'content-type': 'application/json' },
      body: JSON.stringify({ engine: 'claude', taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', prompt: 'legacy attempt', cwd: 'tasks/legacy', sessionId: null }),
    });
    assert.equal(disabled.status, 400, 'The cloud runtime must reject Claude Code even if an old environment still lists it');
    assert.match((await disabled.json() as { error?: string }).error || '', /not enabled for this workspace/);
    const submit = async (taskId: string, prompt: string, executionMode = 'standard', engine = 'dsh', modelConfig?: { apiKey: string; model: string; baseUrl: string }) => {
      const response = await fetch(`${runtimeUrl}/v1/tasks/run`, {
        method: 'POST',
        headers: { authorization: 'Bearer agent-test-token-never-print', 'content-type': 'application/json' },
        body: JSON.stringify({ engine, taskId, prompt, executionMode, cwd: `tasks/${taskId}`, sessionId: null, ...(modelConfig ? { modelConfig } : {}) }),
      });
      return { status: response.status, body: await response.json() as { status?: string; message?: string; error?: string; proactiveFinding?: boolean } };
    };

    const firstId = '11111111-1111-4111-8111-111111111111';
    const secondId = '22222222-2222-4222-8222-222222222222';
    const [first, second] = await Promise.all([submit(firstId, 'first'), submit(secondId, 'second')]);
    assert.deepEqual([first.status, second.status], [200, 200]);
    assert.equal(first.body.status, 'done');
    assert.equal(first.body.message, 'runtime token isolated; computer token isolated');
    assert.equal(second.body.message, 'runtime token isolated; computer token isolated');
    const events = (await readFile(markerPath, 'utf8')).trim().split('\n').map(line => line.split(' ')[0]);
    assert.deepEqual(events, ['start', 'end', 'start', 'end'], 'Only one adapter may use the tenant browser at a time');
    await stat(join(workspace, 'tasks', firstId));
    await stat(join(workspace, 'tasks', secondId));

    const reviewId = '44444444-4444-4444-8444-444444444444';
    const testModelKey = 'test-pi-shared-key-never-print';
    const review = await submit(reviewId, 'Review only the supplied task snapshot.', 'proactive-research', 'pi', { apiKey: testModelKey, model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' });
    assert.equal(review.status, 200);
    assert.equal(review.body.proactiveFinding, true);
    await stat(join(workspace, 'reviews', reviewId));
    const reviewPayload = (await readFile(markerPath, 'utf8')).split('\n').find(line => line.startsWith('review '));
    assert(reviewPayload);
    assert.deepEqual(JSON.parse(reviewPayload.slice('review '.length)), { cwd: join(workspace, 'reviews', reviewId), workerToken: false });
    const markers = await readFile(markerPath, 'utf8');
    assert.match(markers, /pi-config \{"present":true,"model":"deepseek-chat","keyCopiedToEnv":false\}/);
    assert.doesNotMatch(markers, new RegExp(testModelKey));
    const rejectedPi = await submit('55555555-5555-4555-8555-555555555555', 'bad config', 'proactive-research', 'pi', { apiKey: testModelKey, model: 'deepseek-chat', baseUrl: 'file:///etc/passwd' });
    assert.equal(rejectedPi.status, 400);
    assert.match(rejectedPi.body.error || '', /configuration is invalid/);
    assert.doesNotMatch(rejectedPi.body.error || '', new RegExp(testModelKey));

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
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>(resolvePromise => child!.once('exit', () => resolvePromise()));
    }
    await new Promise<void>(resolvePromise => worker.close(() => resolvePromise()));
    await rm(temporary, { recursive: true, force: true });
  }
});
