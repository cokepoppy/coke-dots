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
      "const bridgeToken = input.dingtalkDocumentsBridge?.token || '';",
      "const bridgeTokenInEnv = Boolean(bridgeToken && Object.values(process.env).includes(bridgeToken));",
      "const configDelivered = input.modelConfig?.apiKey === modelKey && input.modelConfig?.baseUrl === 'https://api.example.test/v1' && input.modelConfig?.model === 'runtime-test-model';",
      "await appendFile(process.env.DOTS_TEST_MARKER, `start ${input.taskId} config=${configDelivered} keyInEnv=${keyInEnv} fileWrites=${input.allowWorkspaceFileWrites === true} dingtalkBridge=${Boolean(bridgeToken)} bridgeTokenInEnv=${bridgeTokenInEnv}\\n`);",
      "await (await import('node:fs/promises')).writeFile('minesweeper.html', '<!doctype html><title>Minesweeper</title>');",
      "if (input.prompt === 'hold') await new Promise(resolve => setTimeout(resolve, 30000));",
      'await new Promise(resolve => setTimeout(resolve, 80));',
      "await appendFile(process.env.DOTS_TEST_MARKER, `end ${input.taskId}\\n`);",
      "process.stdout.write(JSON.stringify({ status: 'done', message: configDelivered && !keyInEnv && !process.env.DOTS_AGENT_RUNTIME_TOKEN ? 'shared model config delivered via stdin; runtime token isolated' : 'shared model config missing', diagnostic: input.modelConfig?.apiKey, diagnosticGrant: bridgeToken }));",
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
        DOTS_AGENT_KERNELS_JSON: JSON.stringify({ pi: { command: process.execPath, args: [adapterPath] }, dsh: { command: process.execPath, args: [adapterPath] }, claude: { command: '/bin/false', args: [] } }),
        DOTS_DESKTOP_AGENT_ADAPTERS: 'dsh,pi,claude',
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
    assert.deepEqual(health.adapters, ['dsh', 'pi'], 'Legacy Claude configuration must not be advertised as an installed kernel');
    const disabled = await fetch(`${runtimeUrl}/v1/tasks/run`, {
      method: 'POST',
      headers: { authorization: 'Bearer agent-test-token-never-print', 'content-type': 'application/json' },
      body: JSON.stringify({ engine: 'claude', taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', prompt: 'legacy attempt', cwd: 'tasks/legacy', sessionId: null }),
    });
    assert.equal(disabled.status, 400, 'The cloud runtime must reject Claude Code even if an old environment still lists it');
    assert.match((await disabled.json() as { error?: string }).error || '', /not enabled for this workspace/);
    const modelConfig = { apiKey: 'cloud-runtime-model-key-never-print', baseUrl: 'https://api.example.test/v1', model: 'runtime-test-model' };
    const submit = async (taskId: string, prompt: string, config: typeof modelConfig | null = modelConfig, cwd = `tasks/${taskId}`, engine: 'pi' | 'dsh' = 'dsh', allowWorkspaceFileWrites = false, dingtalkDocumentsBridge?: { url: string; token: string; actions: string[] }) => {
      const response = await fetch(`${runtimeUrl}/v1/tasks/run`, {
        method: 'POST',
        headers: { authorization: 'Bearer agent-test-token-never-print', 'content-type': 'application/json' },
        body: JSON.stringify({ engine, taskId, prompt, cwd, sessionId: null, ...(config ? { modelConfig: config } : {}), ...(allowWorkspaceFileWrites ? { allowWorkspaceFileWrites: true } : {}), ...(dingtalkDocumentsBridge ? { dingtalkDocumentsBridge } : {}) }),
      });
      return { status: response.status, body: await response.json() as { status?: string; message?: string; error?: string } };
    };

    const missingConfig = await submit('44444444-4444-4444-8444-444444444444', 'missing config', null);
    assert.equal(missingConfig.status, 400);
    assert.match(missingConfig.body.error || '', /Shared Model API configuration is required/);
    assert.doesNotMatch(await readFile(markerPath, 'utf8').catch(() => ''), /44444444-4444-4444-8444-444444444444/, 'Missing model config must be rejected before starting the adapter');

    const wrongTaskDirectory = await submit('66666666-6666-4666-8666-666666666666', 'reject another task directory', modelConfig, 'tasks/11111111-1111-4111-8111-111111111111');
    assert.equal(wrongTaskDirectory.status, 400, 'A cloud Agent must not be started in a different task directory');
    assert.match(wrongTaskDirectory.body.error || '', /must match its task id/);
    assert.doesNotMatch(await readFile(markerPath, 'utf8').catch(() => ''), /66666666-6666-4666-8666-666666666666/, 'A mismatched task directory must be rejected before starting the adapter');

    const firstId = '11111111-1111-4111-8111-111111111111';
    const secondId = '22222222-2222-4222-8222-222222222222';
    const [first, second] = await Promise.all([submit(firstId, 'first'), submit(secondId, 'second')]);
    assert.deepEqual([first.status, second.status], [200, 200]);
    assert.equal(first.body.status, 'done');
    assert.equal(first.body.message, 'shared model config delivered via stdin; runtime token isolated');
    assert.equal(second.body.message, 'shared model config delivered via stdin; runtime token isolated');
    assert.doesNotMatch(JSON.stringify([first.body, second.body]), /cloud-runtime-model-key-never-print/, 'Agent output must not persist or return the shared API credential');
    assert.equal(await readFile(join(workspace, 'tasks', firstId, 'minesweeper.html'), 'utf8'), '<!doctype html><title>Minesweeper</title>',
      'The cloud Agent working directory must allow the requested file deliverable to be written');
    const markers = (await readFile(markerPath, 'utf8')).trim().split('\n');
    assert(markers.filter(line => line.startsWith('start ')).every(line => line.includes('config=true keyInEnv=false fileWrites=false dingtalkBridge=false bridgeTokenInEnv=false')), 'Non-Pi adapters must not receive the Pi file-write capability or a DingTalk grant unless one was authorized');

    const piFileTaskId = '77777777-7777-4777-8777-777777777777';
    const piFileTask = await submit(piFileTaskId, 'create a task artifact', modelConfig, `tasks/${piFileTaskId}`, 'pi', true);
    assert.equal(piFileTask.status, 200);
    const allMarkers = (await readFile(markerPath, 'utf8')).trim().split('\n');
    assert(allMarkers.some(line => line.startsWith(`start ${piFileTaskId} config=true keyInEnv=false fileWrites=true dingtalkBridge=false bridgeTokenInEnv=false`)), 'An explicitly enabled Pi task must receive the file-write capability over stdin');
    assert.doesNotMatch(JSON.stringify(piFileTask.body), /cloud-runtime-model-key-never-print/);
    const events = markers.map(line => line.split(' ')[0]);
    assert.deepEqual(events, ['start', 'end', 'start', 'end'], 'Only one adapter may use the tenant browser at a time');
    await stat(join(workspace, 'tasks', firstId));
    await stat(join(workspace, 'tasks', secondId));

    const dingtalkTaskId = '88888888-8888-4888-8888-888888888888';
    const dingtalkGrant = 'task-scoped-dingtalk-runtime-grant-never-return';
    const dingtalkTask = await submit(dingtalkTaskId, 'Search the DingTalk document', modelConfig, `tasks/${dingtalkTaskId}`, 'pi', false, { url: 'https://dots.example.test/dots-demo/api/agent/dingtalk/documents', token: dingtalkGrant, actions: ['search'] });
    assert.equal(dingtalkTask.status, 200);
    assert.equal(dingtalkTask.body.message, 'shared model config delivered via stdin; runtime token isolated');
    assert.equal((dingtalkTask.body as any).diagnosticGrant, '[redacted]', 'An accidentally echoed task grant is redacted from persisted task output');
    assert.doesNotMatch(JSON.stringify(dingtalkTask.body), new RegExp(dingtalkGrant));
    assert((await readFile(markerPath, 'utf8')).includes(`start ${dingtalkTaskId} config=true keyInEnv=false fileWrites=false dingtalkBridge=true bridgeTokenInEnv=false`), 'The scoped bridge is passed to the adapter in private stdin, not its environment');

    const heldId = '33333333-3333-4333-8333-333333333333';
    const heldPromise = submit(heldId, 'hold');
    await waitFor(async () => (await readFile(markerPath, 'utf8').catch(() => '')).includes(`start ${heldId}`));
    owner = 'user';
    const held = await heldPromise;
    assert.equal(held.status, 200);
    assert.equal(held.body.status, 'waiting');
    assert.equal((held.body as { pausedForControl?: boolean }).pausedForControl, true, 'A user takeover must be identified separately from a normal clarification');
    assert.match(held.body.message || '', /接管电脑/);
    assert.doesNotMatch(stderr, /agent-test-token-never-print/);
    owner = 'user';
    const queuedWhileUserControls = await submit('55555555-5555-4555-8555-555555555555', 'queued during takeover');
    assert.equal(queuedWhileUserControls.status, 200);
    assert.equal((queuedWhileUserControls.body as { pausedForControl?: boolean }).pausedForControl, true, 'A queued remote task must also become a resumable pause while the user owns the computer');
    assert.doesNotMatch(await readFile(markerPath, 'utf8'), /55555555-5555-4555-8555-555555555555/, 'A queued task must not spawn a kernel while the user controls the desktop');
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
