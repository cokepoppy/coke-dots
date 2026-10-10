import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { configuredDesktopAgentEngines, configuredDesktopImage, desktopResourceIdentity, desktopResources, isPinnedDesktopImageReference, KubectlDesktopConnector, LinuxDesktopComputer, type DesktopConnector } from '../src/server/linux-desktop-computer.ts';

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
  const deployment = list.items.find(item => item.kind === 'Deployment') as { spec: { template: { spec: { automountServiceAccountToken: boolean; shareProcessNamespace?: boolean; containers: { name: string; env: { name: string; value?: string; valueFrom?: unknown }[]; startupProbe?: { timeoutSeconds?: number }; readinessProbe?: { timeoutSeconds?: number; failureThreshold?: number }; livenessProbe?: { timeoutSeconds?: number; failureThreshold?: number }; securityContext: { runAsNonRoot: boolean; runAsUser: number; allowPrivilegeEscalation: boolean; readOnlyRootFilesystem: boolean } }[] } } } };
  assert.equal(deployment.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(deployment.spec.template.spec.shareProcessNamespace, undefined, 'Desktop and Agent must not share a process namespace');
  const [desktop, runtime] = deployment.spec.template.spec.containers;
  assert.equal(desktop.name, 'desktop');
  assert.equal(runtime.name, 'agent-runtime');
  assert.equal(desktop.securityContext.runAsNonRoot, true);
  assert.equal(desktop.securityContext.runAsUser, 1000);
  assert.equal(desktop.securityContext.allowPrivilegeEscalation, false);
  assert.equal(desktop.startupProbe?.timeoutSeconds, 5, 'Chromium startup receives a bounded probe window');
  assert.equal(desktop.readinessProbe?.timeoutSeconds, 5, 'readiness can exercise a bounded page-runtime probe');
  assert.equal(desktop.readinessProbe?.failureThreshold, 2, 'a blocked renderer is removed from Service endpoints promptly');
  assert.equal(desktop.livenessProbe?.timeoutSeconds, 5);
  assert.equal(desktop.livenessProbe?.failureThreshold, 3, 'liveness restarts only when the desktop worker process itself stops responding');
  assert.equal(runtime.securityContext.runAsNonRoot, true);
  assert.equal(runtime.securityContext.runAsUser, 1001);
  assert.equal(runtime.securityContext.allowPrivilegeEscalation, false);
  assert.equal(runtime.securityContext.readOnlyRootFilesystem, true);
  assert.equal(runtime.readinessProbe?.timeoutSeconds, 5, 'agent readiness tolerates transient node and API latency');
  assert.equal(runtime.livenessProbe?.timeoutSeconds, 5, 'agent liveness avoids restarting a responsive but briefly delayed runtime');
  assert.equal(runtime.livenessProbe?.failureThreshold, 3);
  const desktopEnv = desktop.env.map(item => item.name);
  const runtimeEnv = runtime.env.map(item => item.name);
  assert.equal(desktopEnv.includes('DOTS_AGENT_RUNTIME_TOKEN'), false);
  assert.equal(desktopEnv.includes('DOTS_AGENT_KERNELS_JSON'), false);
  assert.equal(runtimeEnv.includes('DOTS_AGENT_RUNTIME_TOKEN'), true);
  assert.equal(runtimeEnv.includes('LINUX_DESKTOP_WORKER_TOKEN'), true);
});

test('production cloud computers require a pinned worker image and record its desired release', () => {
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
      spec: { template: { metadata: { annotations: Record<string, string> }; spec: { containers: { name: string; image: string; imagePullPolicy: string }[] } } };
    };
    assert.equal(deployment.metadata.annotations['coke-dots.io/desktop-image'], commitImage);
    assert.equal(deployment.spec.template.metadata.annotations['coke-dots.io/desktop-image'], commitImage);
    assert.deepEqual(deployment.spec.template.spec.containers.map(container => container.image), [commitImage, commitImage]);
    assert.deepEqual(deployment.spec.template.spec.containers.map(container => container.imagePullPolicy), ['IfNotPresent', 'IfNotPresent']);
  } finally {
    if (originalEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalEnvironment;
    if (originalImage === undefined) delete process.env.DOTS_LINUX_DESKTOP_IMAGE; else process.env.DOTS_LINUX_DESKTOP_IMAGE = originalImage;
  }
});

test('a fresh Linux desktop ships the Pi and DeepSeek Harness cloud kernel adapters without copying the shared API key into Kubernetes', () => {
  const previousBackend = process.env.DOTS_COMPUTER_BACKEND;
  const previousEngines = process.env.DOTS_DESKTOP_AGENT_ADAPTERS;
  const previousKernels = process.env.DOTS_AGENT_KERNELS_JSON;
  process.env.DOTS_COMPUTER_BACKEND = 'linux-desktop';
  delete process.env.DOTS_DESKTOP_AGENT_ADAPTERS;
  delete process.env.DOTS_AGENT_KERNELS_JSON;
  try {
    assert.deepEqual(configuredDesktopAgentEngines(), ['pi', 'dsh']);
    const list = desktopResources('cloud-agent-tenant', 'worker-secret', 'agent-secret')[1] as { items: Record<string, any>[] };
    const deployment = list.items.find(item => item.kind === 'Deployment') as { spec: { template: { spec: { containers: { name: string; env: { name: string; value?: string }[] }[] } } } };
    const runtime = deployment.spec.template.spec.containers.find(container => container.name === 'agent-runtime');
    assert(runtime, 'A fresh Debian Pod must place its Agent kernel in the isolated cloud runtime container');
    const env = Object.fromEntries(runtime.env.filter(item => item.value !== undefined).map(item => [item.name, item.value]));
    const kernels = JSON.parse(env.DOTS_AGENT_KERNELS_JSON || '{}') as Record<string, { command: string; args: string[] }>;
    assert.deepEqual(Object.keys(kernels), ['pi', 'dsh']);
    assert.deepEqual(kernels.pi, { command: 'node', args: ['/opt/coke-dots/cloud-kernel-adapter.mjs'] });
    assert.deepEqual(kernels.dsh, kernels.pi);
    assert.equal(env.DOTS_DSH_BIN, '/usr/local/bin/dsh');
    const secret = list.items.find(item => item.kind === 'Secret') as { stringData: Record<string, string> };
    assert.deepEqual(Object.keys(secret.stringData).sort(), ['DOTS_AGENT_RUNTIME_TOKEN', 'LINUX_DESKTOP_WORKER_TOKEN']);
  } finally {
    if (previousBackend === undefined) delete process.env.DOTS_COMPUTER_BACKEND; else process.env.DOTS_COMPUTER_BACKEND = previousBackend;
    if (previousEngines === undefined) delete process.env.DOTS_DESKTOP_AGENT_ADAPTERS; else process.env.DOTS_DESKTOP_AGENT_ADAPTERS = previousEngines;
    if (previousKernels === undefined) delete process.env.DOTS_AGENT_KERNELS_JSON; else process.env.DOTS_AGENT_KERNELS_JSON = previousKernels;
  }
});

test('Linux desktop provisioning rejects Claude Code kernel configuration', () => {
  const previousAdapters = process.env.DOTS_DESKTOP_AGENT_ADAPTERS;
  const previousKernels = process.env.DOTS_AGENT_KERNELS_JSON;
  process.env.DOTS_DESKTOP_AGENT_ADAPTERS = 'claude';
  process.env.DOTS_AGENT_KERNELS_JSON = '{}';
  try {
    assert.throws(() => desktopResources('tenant-alpha', 'worker-secret', 'agent-secret'), /暂只支持 Pi 和 DeepSeek Harness/);
    process.env.DOTS_DESKTOP_AGENT_ADAPTERS = 'dsh';
    process.env.DOTS_AGENT_KERNELS_JSON = JSON.stringify({ claude: { command: 'claude', args: [] } });
    assert.throws(() => desktopResources('tenant-alpha', 'worker-secret', 'agent-secret'), /不支持内核：claude/);
  } finally {
    if (previousAdapters === undefined) delete process.env.DOTS_DESKTOP_AGENT_ADAPTERS; else process.env.DOTS_DESKTOP_AGENT_ADAPTERS = previousAdapters;
    if (previousKernels === undefined) delete process.env.DOTS_AGENT_KERNELS_JSON; else process.env.DOTS_AGENT_KERNELS_JSON = previousKernels;
  }
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
      spec: { template: { metadata: { annotations: Record<string, string> }; spec: { containers: { name: string; image: string; imagePullPolicy: string }[] } } };
    };
    assert.equal(deployment.metadata.annotations['coke-dots.io/desktop-image'], commitImage);
    assert.equal(deployment.spec.template.metadata.annotations['coke-dots.io/desktop-image'], commitImage);
    assert.deepEqual(deployment.spec.template.spec.containers.map(({ name, image }) => ({ name, image })), [
      { name: 'desktop', image: commitImage },
      { name: 'agent-runtime', image: commitImage },
    ]);
    assert.deepEqual(deployment.spec.template.spec.containers.map(container => container.imagePullPolicy), ['IfNotPresent', 'IfNotPresent']);
  } finally {
    if (originalEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalEnvironment;
    if (originalImage === undefined) delete process.env.DOTS_LINUX_DESKTOP_IMAGE; else process.env.DOTS_LINUX_DESKTOP_IMAGE = originalImage;
  }
});

test('Linux desktop runtime scopes browser control and task dispatch to its connection', async () => {
  let owner: 'agent' | 'user' = 'agent';
  const commands: Record<string, unknown>[] = [];
  let connectionCount = 0;
  let researchRequests = 0;
  const privateSignInRequests: Record<string, unknown>[] = [];
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
    if (req.url === '/v1/commands/private-sign-in' && req.method === 'POST') {
      privateSignInRequests.push(value); owner = 'user';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ready: true, owner, url: value.url, title: 'Demo service sign in' })); return;
    }
    if (req.url === '/v1/state') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ready: true, owner, url: 'https://example.test/', title: 'Example' })); return;
    }
    if (req.url === '/v1/screenshot') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); return; }
    if (req.url === '/v1/research/open-public-page' && req.method === 'POST') {
      researchRequests += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: value.url, title: 'Public launch notes', text: 'Release criteria: harden session recovery.' }));
      return;
    }
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
  const priorEnvironment = { nodeEnv: process.env.NODE_ENV, auth: process.env.DOTS_E2E_AUTH, fixture: process.env.DOTS_E2E_COMPUTER_RESEARCH_FIXTURE_URL, signInFixture: process.env.DOTS_E2E_COMPUTER_SIGNIN_FIXTURE_URL };
  process.env.NODE_ENV = 'test';
  process.env.DOTS_E2E_AUTH = '1';
  process.env.DOTS_E2E_COMPUTER_RESEARCH_FIXTURE_URL = 'https://research-fixture.dots.test/launch';
  process.env.DOTS_E2E_COMPUTER_SIGNIN_FIXTURE_URL = 'https://login-fixture.dots.test/sign-in';
  try {
    const computer = new LinuxDesktopComputer('tenant-alpha', connector);
    const [firstState, concurrentState] = await Promise.all([computer.state(), computer.state()]);
    assert.deepEqual(firstState, { ready: true, owner: 'agent', url: 'https://example.test/', title: 'Example', backend: 'linux-desktop', width: 1440, height: 1080 });
    assert.deepEqual(concurrentState, firstState);
    assert.equal(connectionCount, 1, 'Concurrent status requests must share one tenant desktop provisioning operation');
    const opened = await computer.open('Dot');
    assert.equal(opened.backend, 'linux-desktop');
    assert.equal(opened.ready, true);
    await assert.rejects(computer.click(10, 10), /先选择“接管”/);
    await assert.rejects(computer.fillWebsiteSignIn('http://login-fixture.dots.test/sign-in', 'alpha', 'not-sent'), /标准 HTTPS 网址/);
    const signedInState = await computer.fillWebsiteSignIn('https://login-fixture.dots.test/sign-in', 'alpha@example.test', 'private-sign-in-test-secret');
    assert.equal(signedInState.owner, 'user');
    assert.deepEqual(privateSignInRequests, [{ url: 'https://login-fixture.dots.test/sign-in', identifier: 'alpha@example.test', password: 'private-sign-in-test-secret' }]);
    await computer.returnControl();
    await computer.takeOver();
    await computer.click(250, 400);
    await computer.type('human input');
    await computer.navigate('https://example.test/path');
    assert.equal(owner, 'user');
    assert.deepEqual(commands.map(command => command.action), ['open', 'click', 'type', 'navigate']);
    assert.equal((await computer.screenshot()).toString(), png.toString());
    await assert.rejects(computer.runAgentTask({ engine: 'dsh', taskId: 'task-1', prompt: 'continue', sessionId: null }), /用户正在接管/);
    await computer.returnControl();
    const page = await computer.openPublicPageForAgent('https://research-fixture.dots.test/launch');
    assert.deepEqual(page, { url: 'https://research-fixture.dots.test/launch', title: 'Public launch notes', text: 'Release criteria: harden session recovery.' });
    assert.equal(researchRequests, 1);
    await computer.takeOver();
    await assert.rejects(computer.openPublicPageForAgent('https://research-fixture.dots.test/launch'), /你控制/);
    assert.equal(researchRequests, 1, 'The browser research endpoint must not run during user takeover');
    await computer.returnControl();
    const result = await computer.runAgentTask({ engine: 'dsh', taskId: 'task-1', prompt: 'continue', sessionId: null });
    assert.equal(result.message, 'remote task finished');
    assert.equal(result.sessionId, 'remote-session');
    assert.equal(agentInput[0].cwd, 'tasks/task-1');
    assert.equal(agentInput[0].executionId, 'task-1', 'Remote tasks need a stable execution identity for safe replay');
    assert.equal('signal' in agentInput[0], false, 'AbortSignal must control the HTTP request, not leak into the runtime payload');
    assert.equal('computer' in agentInput[0], false, 'The control plane must not forward the raw desktop worker token to the Agent runtime');
    assert.equal('workerToken' in agentInput[0], false, 'The Agent runtime must mint its own read-only browser capability');
    await computer.close();
  } finally {
    if (priorEnvironment.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorEnvironment.nodeEnv;
    if (priorEnvironment.auth === undefined) delete process.env.DOTS_E2E_AUTH; else process.env.DOTS_E2E_AUTH = priorEnvironment.auth;
    if (priorEnvironment.fixture === undefined) delete process.env.DOTS_E2E_COMPUTER_RESEARCH_FIXTURE_URL; else process.env.DOTS_E2E_COMPUTER_RESEARCH_FIXTURE_URL = priorEnvironment.fixture;
    if (priorEnvironment.signInFixture === undefined) delete process.env.DOTS_E2E_COMPUTER_SIGNIN_FIXTURE_URL; else process.env.DOTS_E2E_COMPUTER_SIGNIN_FIXTURE_URL = priorEnvironment.signInFixture;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => agentServer.close(() => resolve()));
  }
});

test('Linux desktop reconnects after a stale worker port-forward fails', async () => {
  async function startWorker(title: string) {
    const server = createServer((req, res) => {
      if (req.url === '/v1/state') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ready: true, owner: 'agent', url: 'about:blank', title }));
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    return { server, port: address.port };
  }

  const first = await startWorker('First desktop');
  let workerPort = first.port;
  let connectionCount = 0;
  let closeCount = 0;
  const connector: DesktopConnector = {
    async connect() {
      connectionCount += 1;
      const workerUrl = new URL(`http://127.0.0.1:${workerPort}/`);
      return { workerUrl, novncUrl: workerUrl, agentUrl: workerUrl, workerToken: 'worker', agentToken: 'agent' };
    },
    async close() { closeCount += 1; },
  };
  const computer = new LinuxDesktopComputer('tenant-reconnect', connector);

  try {
    assert.equal((await computer.state()).title, 'First desktop');
    await new Promise<void>((resolve, reject) => first.server.close(error => error ? reject(error) : resolve()));
    const second = await startWorker('Recovered desktop');
    workerPort = second.port;

    const recovered = await computer.state();
    assert.equal(recovered.title, 'Recovered desktop');
    assert.equal(connectionCount, 2, 'A safe status read should reconnect once and retry');
    assert.equal(closeCount, 1, 'The failed port-forward should be closed before reconnecting');

    await computer.close();
    await new Promise<void>(resolve => second.server.close(() => resolve()));
  } finally {
    await computer.close();
    if (first.server.listening) await new Promise<void>(resolve => first.server.close(() => resolve()));
  }
});

test('Linux desktop reconciles tenant resources while its cached worker connection still responds', async () => {
  let title = 'Existing desktop';
  let needsReconcile = true;
  let connectionCount = 0;
  let reconcileCount = 0;
  let closeCount = 0;
  const server = createServer((req, res) => {
    if (req.url === '/v1/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ready: true, owner: 'agent', url: 'https://example.test/', title }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');

  const connector: DesktopConnector = {
    async connect() {
      connectionCount += 1;
      const workerUrl = new URL(`http://127.0.0.1:${address.port}/`);
      return { workerUrl, novncUrl: workerUrl, agentUrl: workerUrl, workerToken: 'worker', agentToken: 'agent' };
    },
    async reconcile() {
      reconcileCount += 1;
      if (!needsReconcile) return false;
      needsReconcile = false;
      title = 'Recovered from resource drift';
      return true;
    },
    async close() { closeCount += 1; },
  };
  const computer = new LinuxDesktopComputer('tenant-resource-drift', connector, 50);

  try {
    assert.equal((await computer.state()).title, 'Existing desktop');
    assert.equal((await computer.state()).title, 'Existing desktop');
    assert.equal(reconcileCount, 0, 'Repeated status reads inside the reconciliation interval must not re-apply manifests');
    await new Promise(resolve => setTimeout(resolve, 60));
    const [first, concurrent] = await Promise.all([computer.state(), computer.state()]);
    assert.equal(first.title, 'Recovered from resource drift');
    assert.equal(concurrent.title, 'Recovered from resource drift');
    assert.equal(reconcileCount, 1, 'Concurrent reads must share one tenant reconciliation');
    assert.equal(connectionCount, 2, 'A changed Deployment must discard the cached worker tunnel and reconnect');
    assert.equal(closeCount, 1, 'The cached tunnel must close once after resource changes');
  } finally {
    await computer.close();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('Kubernetes desktop reconciliation only reconnects when the Deployment generation changes', async () => {
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
    assert.equal(await connector.reconcile('tenant-generation-test'), false, 'Apply output such as "configured" must not trigger a reconnect when the Pod template generation is unchanged');
    changeGenerationOnApply = true;
    assert.equal(await connector.reconcile('tenant-generation-test'), true, 'A changed Deployment generation must invalidate the cached worker connection');
    assert.equal(calls.filter(args => args[0] === 'apply').length, 6, 'Both authoritative resource documents should be applied on connect and each reconcile');
  } finally {
    await connector.close();
    for (const key of envKeys) {
      const value = previousEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
