import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { desktopResourceIdentity, desktopResources, LinuxDesktopComputer, type DesktopConnector } from '../src/server/linux-desktop-computer.ts';

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
