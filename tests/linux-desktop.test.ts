import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { configuredDesktopAgentEngines, desktopResourceIdentity, desktopResources, LinuxDesktopComputer, type DesktopConnector } from '../src/server/linux-desktop-computer.ts';

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
  const deployment = list.items.find(item => item.kind === 'Deployment') as { spec: { template: { spec: { automountServiceAccountToken: boolean; shareProcessNamespace?: boolean; containers: { name: string; env: { name: string; value?: string; valueFrom?: unknown }[]; securityContext: { runAsNonRoot: boolean; runAsUser: number; allowPrivilegeEscalation: boolean; readOnlyRootFilesystem: boolean } }[] } } } };
  assert.equal(deployment.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(deployment.spec.template.spec.shareProcessNamespace, undefined, 'Desktop and Agent must not share a process namespace');
  const [desktop, runtime] = deployment.spec.template.spec.containers;
  assert.equal(desktop.name, 'desktop');
  assert.equal(runtime.name, 'agent-runtime');
  assert.equal(desktop.securityContext.runAsNonRoot, true);
  assert.equal(desktop.securityContext.runAsUser, 1000);
  assert.equal(desktop.securityContext.allowPrivilegeEscalation, false);
  assert.equal(runtime.securityContext.runAsNonRoot, true);
  assert.equal(runtime.securityContext.runAsUser, 1001);
  assert.equal(runtime.securityContext.allowPrivilegeEscalation, false);
  assert.equal(runtime.securityContext.readOnlyRootFilesystem, true);
  const desktopEnv = desktop.env.map(item => item.name);
  const runtimeEnv = runtime.env.map(item => item.name);
  assert.equal(desktopEnv.includes('DOTS_AGENT_RUNTIME_TOKEN'), false);
  assert.equal(desktopEnv.includes('DOTS_AGENT_KERNELS_JSON'), false);
  assert.equal(runtimeEnv.includes('DOTS_AGENT_RUNTIME_TOKEN'), true);
  assert.equal(runtimeEnv.includes('LINUX_DESKTOP_WORKER_TOKEN'), true);
});

test('compact Linux desktop memory requests are limited to the authenticated E2E profile', () => {
  const envNames = ['NODE_ENV', 'DOTS_E2E_AUTH', 'DOTS_LINUX_DESKTOP_TEST_RESOURCE_PROFILE'] as const;
  const previous = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  const readResources = () => {
    const list = desktopResources('resource-profile-test', 'worker-secret', 'agent-secret')[1] as { items: Record<string, any>[] };
    const deployment = list.items.find(item => item.kind === 'Deployment') as { spec: { template: { spec: { containers: { name: string; resources: { requests: Record<string, string>; limits: Record<string, string> } }[] } } } };
    return Object.fromEntries(deployment.spec.template.spec.containers.map(container => [container.name, container.resources]));
  };
  try {
    delete process.env.NODE_ENV;
    delete process.env.DOTS_E2E_AUTH;
    delete process.env.DOTS_LINUX_DESKTOP_TEST_RESOURCE_PROFILE;
    const defaults = readResources();
    assert.equal(defaults.desktop.requests.memory, '1Gi');
    assert.equal(defaults['agent-runtime'].requests.memory, '384Mi');

    process.env.NODE_ENV = 'test';
    process.env.DOTS_E2E_AUTH = '1';
    process.env.DOTS_LINUX_DESKTOP_TEST_RESOURCE_PROFILE = 'compact';
    const compact = readResources();
    assert.equal(compact.desktop.requests.memory, '768Mi');
    assert.equal(compact['agent-runtime'].requests.memory, '256Mi');
    assert.equal(compact.desktop.limits.memory, defaults.desktop.limits.memory, 'The test profile must keep the production desktop memory limit');
    assert.equal(compact['agent-runtime'].limits.memory, defaults['agent-runtime'].limits.memory, 'The test profile must keep the production Agent memory limit');

    process.env.DOTS_E2E_AUTH = '0';
    assert.equal(readResources().desktop.requests.memory, '1Gi', 'The compact requests must be unavailable outside E2E authentication');
  } finally {
    for (const name of envNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
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
