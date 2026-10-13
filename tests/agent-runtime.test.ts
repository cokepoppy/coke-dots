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
      "const modelKey = 'cloud-runtime-model-key-never-print';",
      "const keyInEnv = Object.values(process.env).includes(modelKey) || Boolean(process.env.DOTS_AGENT_RUNTIME_TOKEN) || Boolean(process.env.LINUX_DESKTOP_WORKER_TOKEN);",
      "const configDelivered = input.modelConfig?.apiKey === modelKey && input.modelConfig?.baseUrl === 'https://api.example.test/v1' && input.modelConfig?.model === 'runtime-test-model';",
      "await appendFile(process.env.DOTS_TEST_MARKER, `start ${input.taskId} config=${configDelivered} keyInEnv=${keyInEnv}\\n`);",
      "if (input.prompt === 'hold') await new Promise(resolve => setTimeout(resolve, 30000));",
      'await new Promise(resolve => setTimeout(resolve, 80));',
      "await appendFile(process.env.DOTS_TEST_MARKER, `end ${input.taskId}\\n`);",
      "process.stdout.write(JSON.stringify({ status: 'done', message: configDelivered && !keyInEnv && !process.env.DOTS_AGENT_RUNTIME_TOKEN ? 'shared model config delivered via stdin; runtime token isolated' : 'shared model config missing', diagnostic: input.modelConfig?.apiKey }));",
      '',
    ].join('\n'));
    child = spawn(process.execPath, [runtimePath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        DOTS_AGENT_RUNTIME_TOKEN: 'agent-test-token-never-print',
        DOTS_MODEL_API_KEY: 'cloud-runtime-model-key-never-print',
        DOTS_AGENT_RUNTIME_PORT: String(runtimePort),
        DOTS_AGENT_WORKSPACE: workspace,
        DOTS_AGENT_KERNELS_JSON: JSON.stringify({ dsh: { command: process.execPath, args: [adapterPath] }, claude: { command: '/bin/false', args: [] } }),
        DOTS_DESKTOP_AGENT_ADAPTERS: 'dsh,claude',
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
    const health = await fetch(`${runtimeUrl}/healthz`).then(response => response.json()) as { adapters?: string[] };
    assert.deepEqual(health.adapters, ['dsh'], 'Legacy Claude configuration must not be advertised as an installed kernel');
    const disabled = await fetch(`${runtimeUrl}/v1/tasks/run`, {
      method: 'POST',
      headers: { authorization: 'Bearer agent-test-token-never-print', 'content-type': 'application/json' },
      body: JSON.stringify({ engine: 'claude', taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', prompt: 'legacy attempt', cwd: 'tasks/legacy', sessionId: null }),
    });
    assert.equal(disabled.status, 400, 'The cloud runtime must reject Claude Code even if an old environment still lists it');
    assert.match((await disabled.json() as { error?: string }).error || '', /not enabled for this workspace/);
    const modelConfig = { apiKey: 'cloud-runtime-model-key-never-print', baseUrl: 'https://api.example.test/v1', model: 'runtime-test-model' };
    const submit = async (taskId: string, prompt: string, config: typeof modelConfig | null = modelConfig) => {
      const response = await fetch(`${runtimeUrl}/v1/tasks/run`, {
        method: 'POST',
        headers: { authorization: 'Bearer agent-test-token-never-print', 'content-type': 'application/json' },
        body: JSON.stringify({ engine: 'dsh', taskId, prompt, cwd: `tasks/${taskId}`, sessionId: null, ...(config ? { modelConfig: config } : {}) }),
      });
      return { status: response.status, body: await response.json() as { status?: string; message?: string; error?: string } };
    };

    const missingConfig = await submit('44444444-4444-4444-8444-444444444444', 'missing config', null);
    assert.equal(missingConfig.status, 400);
    assert.match(missingConfig.body.error || '', /Shared Model API configuration is required/);
    assert.doesNotMatch(await readFile(markerPath, 'utf8').catch(() => ''), /44444444-4444-4444-8444-444444444444/, 'Missing model config must be rejected before starting the adapter');

    const firstId = '11111111-1111-4111-8111-111111111111';
    const secondId = '22222222-2222-4222-8222-222222222222';
    const [first, second] = await Promise.all([submit(firstId, 'first'), submit(secondId, 'second')]);
    assert.deepEqual([first.status, second.status], [200, 200]);
    assert.equal(first.body.status, 'done');
    assert.equal(first.body.message, 'shared model config delivered via stdin; runtime token isolated');
    assert.equal(second.body.message, 'shared model config delivered via stdin; runtime token isolated');
    assert.doesNotMatch(JSON.stringify([first.body, second.body]), /cloud-runtime-model-key-never-print/, 'Agent output must not persist or return the shared API credential');
    const markers = (await readFile(markerPath, 'utf8')).trim().split('\n');
    assert(markers.filter(line => line.startsWith('start ')).every(line => line.includes('config=true keyInEnv=false')), 'The adapter must receive model config over stdin, never via environment');
    const events = markers.map(line => line.split(' ')[0]);
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
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>(resolvePromise => child!.once('exit', () => resolvePromise()));
    }
    await new Promise<void>(resolvePromise => worker.close(() => resolvePromise()));
    await rm(temporary, { recursive: true, force: true });
  }
});
