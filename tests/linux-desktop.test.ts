import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { configuredDesktopImage, desktopResourceIdentity, desktopResources, isPinnedDesktopImageReference, KubectlDesktopConnector, LinuxDesktopComputer, type DesktopConnector } from '../src/server/linux-desktop-computer.ts';

test('Linux desktop resources isolate tenant namespaces and never publish CDP', () => {
  const alpha = desktopResourceIdentity('alpha-workspace');
  const beta = desktopResourceIdentity('beta-workspace');
  assert.notEqual(alpha.namespace, beta.namespace);
  assert.equal(desktopResourceIdentity('alpha-workspace').namespace, alpha.namespace);
  assert(alpha.tenantHash.length <= 63, 'Kubernetes label values cannot exceed 63 characters');
  assert.match(desktopResourceIdentity('legacy').namespace, /^dots-coke-dots-legacy-/);

  const documents = desktopResources('alpha-workspace', 'worker-secret', 'agent-secret');
  assert.equal(documents[0].kind, 'Namespace');
  const list = documents[1] as { items: Record<string, unknown>[] };
  const service = list.items.find(item => item.kind === 'Service') as { spec: { ports: { port: number }[] } };
  assert.deepEqual(service.spec.ports.map(port => port.port), [6080, 8082, 8083]);
  assert.equal(service.spec.ports.some(port => port.port === 9222), false, 'Raw Chromium CDP must stay inside the Pod');
  const secret = list.items.find(item => item.kind === 'Secret') as { stringData: Record<string, string> };
  assert.deepEqual(secret.stringData, { LINUX_DESKTOP_WORKER_TOKEN: 'worker-secret', DOTS_AGENT_RUNTIME_TOKEN: 'agent-secret' });
  const deployment = list.items.find(item => item.kind === 'Deployment') as { spec: { template: { spec: { automountServiceAccountToken: boolean; containers: { securityContext: { runAsNonRoot: boolean; allowPrivilegeEscalation: boolean } }[] } } } };
  assert.equal(deployment.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(deployment.spec.template.spec.containers[0].securityContext.runAsNonRoot, true);
  assert.equal(deployment.spec.template.spec.containers[0].securityContext.allowPrivilegeEscalation, false);
});

test('production cloud computers reject mutable worker tags and expose the selected release image', () => {
  const commit = '0123456789abcdef0123456789abcdef01234567';
  const commitImage = `coke-dots-linux-desktop:sha-${commit}`;
  const digestImage = `registry.example.test/coke-dots-linux-desktop@sha256:${'a'.repeat(64)}`;
  assert.equal(isPinnedDesktopImageReference(commitImage), true);
  assert.equal(isPinnedDesktopImageReference(digestImage), true);
  assert.equal(isPinnedDesktopImageReference('coke-dots-linux-desktop:dev'), false);
  assert.equal(isPinnedDesktopImageReference('coke-dots-linux-desktop:test'), false);
  assert.equal(isPinnedDesktopImageReference(`@sha256:${'a'.repeat(64)}`), false);
  assert.equal(configuredDesktopImage('production', commitImage), commitImage);
  assert.equal(configuredDesktopImage('production', digestImage), digestImage);
  assert.throws(() => configuredDesktopImage('production', 'coke-dots-linux-desktop:dev'), /固定镜像摘要/);
  assert.throws(() => configuredDesktopImage('production', undefined), /固定镜像摘要/);

  const originalEnvironment = process.env.NODE_ENV;
  const originalImage = process.env.DOTS_LINUX_DESKTOP_IMAGE;
  process.env.NODE_ENV = 'production';
  process.env.DOTS_LINUX_DESKTOP_IMAGE = commitImage;
  try {
    const resources = desktopResources('tenant-release', 'worker-secret', 'agent-secret')[1] as { items: Record<string, any>[] };
    const deployment = resources.items.find(item => item.kind === 'Deployment') as {
      metadata: { annotations: Record<string, string> };
      spec: { template: { metadata: { annotations: Record<string, string> }; spec: { containers: { image: string; imagePullPolicy: string }[] } } };
    };
    assert.equal(deployment.metadata.annotations['coke-dots.io/desktop-image'], commitImage);
    assert.equal(deployment.spec.template.metadata.annotations['coke-dots.io/desktop-image'], commitImage);
    assert.deepEqual(deployment.spec.template.spec.containers.map(container => container.image), [commitImage]);
    assert.deepEqual(deployment.spec.template.spec.containers.map(container => container.imagePullPolicy), ['IfNotPresent']);
  } finally {
    if (originalEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalEnvironment;
    if (originalImage === undefined) delete process.env.DOTS_LINUX_DESKTOP_IMAGE; else process.env.DOTS_LINUX_DESKTOP_IMAGE = originalImage;
  }
});

test('Kubernetes reconciliation reconnects only when the Deployment generation changes', async () => {
  const envKeys = ['KUBERNETES_SERVICE_HOST', 'DOTS_LINUX_DESKTOP_FORCE_PORT_FORWARD', 'DOTS_LINUX_DESKTOP_TOKEN_SECRET'] as const;
  const previousEnvironment = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.KUBERNETES_SERVICE_HOST = 'kubernetes.default.svc';
  delete process.env.DOTS_LINUX_DESKTOP_FORCE_PORT_FORWARD;
  process.env.DOTS_LINUX_DESKTOP_TOKEN_SECRET = 'test-only-token-signing-key-that-is-long-enough';
  let generation = 7;
  let changeGenerationOnApply = false;
  const calls: string[][] = [];
  const connector = new KubectlDesktopConnector(async args => {
    calls.push(args);
    if (args.includes('get') && args.includes('deployment')) return String(generation);
    if (args[0] === 'apply') {
      if (changeGenerationOnApply) { generation += 1; changeGenerationOnApply = false; }
      return 'deployment.apps/desktop configured';
    }
    return 'deployment/desktop successfully rolled out';
  });

  try {
    await connector.connect('tenant-generation-test');
    assert.equal(await connector.reconcile('tenant-generation-test'), false, 'Metadata-only apply output must not invalidate the worker connection');
    changeGenerationOnApply = true;
    assert.equal(await connector.reconcile('tenant-generation-test'), true, 'A changed Deployment generation must invalidate the cached connection');
    assert.equal(calls.filter(args => args[0] === 'apply').length, 6);
  } finally {
    await connector.close();
    for (const key of envKeys) {
      const value = previousEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('cached tenant desktop reconciles once and reconnects after a real generation change', async () => {
  let generationChanged = false;
  let connects = 0;
  let reconciles = 0;
  let closes = 0;
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ready: true, owner: 'agent', url: 'about:blank', title: `Generation ${connects}` }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const connector: DesktopConnector = {
    async connect() {
      connects += 1;
      const url = new URL(`http://127.0.0.1:${address.port}/`);
      return { workerUrl: url, novncUrl: url, agentUrl: url, workerToken: 'worker', agentToken: 'agent' };
    },
    async reconcile() { reconciles += 1; return generationChanged; },
    async close() { closes += 1; },
  };
  const computer = new LinuxDesktopComputer('tenant-generation-cache', connector, 0);
  try {
    assert.equal((await computer.state()).title, 'Generation 1');
    assert.equal((await computer.state()).title, 'Generation 1');
    assert.equal(connects, 1, 'No Pod template change should keep the current worker connection');
    assert.equal(reconciles, 1, 'Concurrent request paths should not reconcile twice for the same interval');

    generationChanged = true;
    assert.equal((await computer.state()).title, 'Generation 2');
    assert.equal(connects, 2, 'A changed Pod template should close the stale connection and wait for rollout');
    assert.equal(closes, 1);
  } finally {
    await computer.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('Linux desktop never replays a command after a port-forward transport failure', async () => {
  let commandCount = 0;
  const failedWorker = createServer((req, res) => {
    if (req.url === '/v1/commands' && req.method === 'POST') {
      commandCount += 1;
      res.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ready: true, owner: 'agent', url: 'about:blank', title: 'Recovered desktop' }));
  });
  await new Promise<void>(resolve => failedWorker.listen(0, '127.0.0.1', resolve));
  const firstAddress = failedWorker.address();
  assert(firstAddress && typeof firstAddress !== 'string');

  async function startRecoveredWorker() {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ready: true, owner: 'agent', url: 'about:blank', title: 'Recovered desktop' }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    return { server, port: address.port };
  }

  let workerPort = firstAddress.port;
  let connectionCount = 0;
  const connector: DesktopConnector = {
    async connect() {
      connectionCount += 1;
      const workerUrl = new URL(`http://127.0.0.1:${workerPort}/`);
      return { workerUrl, novncUrl: workerUrl, agentUrl: workerUrl, workerToken: 'worker', agentToken: 'agent' };
    },
    async close() {},
  };
  const computer = new LinuxDesktopComputer('tenant-no-replay', connector);
  let recovered: Awaited<ReturnType<typeof startRecoveredWorker>> | null = null;
  try {
    await assert.rejects(computer.open('Dot'), /fetch failed/);
    assert.equal(commandCount, 1, 'An open command with an unknown delivery result must never be replayed');
    assert.equal(connectionCount, 1, 'Unsafe writes must not trigger an automatic retry');

    await new Promise<void>((resolve, reject) => failedWorker.close(error => error ? reject(error) : resolve()));
    recovered = await startRecoveredWorker();
    workerPort = recovered.port;
    assert.equal((await computer.state()).title, 'Recovered desktop');
    assert.equal(connectionCount, 2, 'The next safe read can establish a new connection');
  } finally {
    await computer.close();
    if (failedWorker.listening) await new Promise<void>(resolve => failedWorker.close(() => resolve()));
    if (recovered?.server.listening) await new Promise<void>(resolve => recovered!.server.close(() => resolve()));
  }
});

test('Linux desktop runtime scopes browser control and task dispatch to its connection', async () => {
  let owner: 'agent' | 'user' = 'agent';
  const commands: Record<string, unknown>[] = [];
  let connectionCount = 0;
  const png = Buffer.from('mock-desktop-frame');
  const agentInput: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const value = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    if (req.url === '/v1/control' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ owner })); return;
    }
    if (req.url === '/v1/control' && req.method === 'POST') {
      owner = value.owner; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ owner })); return;
    }
    if (req.url === '/v1/commands' && req.method === 'POST') {
      commands.push(value); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ready: true })); return;
    }
    if (req.url === '/v1/state') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ready: true, owner, url: 'https://example.test/', title: 'Example' })); return;
    }
    if (req.url === '/v1/screenshot') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); return; }
    res.writeHead(404); res.end();
  });
  const agentServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    agentInput.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'done', message: 'remote task finished', sessionId: 'remote-session' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => agentServer.listen(0, '127.0.0.1', resolve));
  const workerAddress = server.address();
  const agentAddress = agentServer.address();
  assert(workerAddress && typeof workerAddress !== 'string');
  assert(agentAddress && typeof agentAddress !== 'string');
  const connector: DesktopConnector = {
    async connect() { connectionCount += 1; return { workerUrl: new URL(`http://127.0.0.1:${workerAddress.port}/`), novncUrl: new URL(`http://127.0.0.1:${workerAddress.port}/`), agentUrl: new URL(`http://127.0.0.1:${agentAddress.port}/`), workerToken: 'scoped-worker-token', agentToken: 'scoped-agent-token' }; },
  };
  try {
    const computer = new LinuxDesktopComputer('tenant-alpha', connector);
    const [firstState, concurrentState] = await Promise.all([computer.state(), computer.state()]);
    assert.deepEqual(firstState, { ready: true, owner: 'agent', url: 'https://example.test/', title: 'Example', backend: 'linux-desktop', width: 1440, height: 900 });
    assert.deepEqual(concurrentState, firstState);
    assert.equal(connectionCount, 1, 'Concurrent status requests must share one tenant desktop provisioning operation');
    const opened = await computer.open('Dot');
    assert.equal(opened.backend, 'linux-desktop');
    assert.equal(opened.ready, true);
    await assert.rejects(computer.click(10, 10), /先选择“接管”/);
    await computer.takeOver();
    await computer.click(250, 400);
    await computer.type('human input');
    await computer.navigate('https://example.test/path');
    assert.equal(owner, 'user');
    assert.deepEqual(commands.map(command => command.action), ['open', 'click', 'type', 'navigate']);
    assert.equal((await computer.screenshot()).toString(), png.toString());
    await assert.rejects(computer.runAgentTask({ engine: 'dsh', taskId: 'task-1', prompt: 'continue', sessionId: null }), /用户正在接管/);
    await computer.returnControl();
    const result = await computer.runAgentTask({ engine: 'dsh', taskId: 'task-1', prompt: 'continue', sessionId: null });
    assert.equal(result.message, 'remote task finished');
    assert.equal(result.sessionId, 'remote-session');
    assert.equal(agentInput[0].cwd, 'tasks/task-1');
    assert.equal('signal' in agentInput[0], false, 'AbortSignal must control the HTTP request, not leak into the runtime payload');
    assert.equal((agentInput[0].computer as { workerToken: string }).workerToken, 'scoped-worker-token');
    await computer.close();
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => agentServer.close(() => resolve()));
  }
});
