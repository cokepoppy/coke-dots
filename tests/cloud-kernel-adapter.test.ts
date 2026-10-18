import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCloudKernel } from '../deploy/linux-desktop/cloud-kernel-adapter.mjs';

const modelConfig = { apiKey: 'shared-cloud-test-key', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' };
const decision = JSON.stringify({ status: 'done', message: 'cloud kernel completed' });

async function makeWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'coke-dots-cloud-kernel-'));
  const task = join(root, 'tasks', '11111111-1111-4111-8111-111111111111');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(task, { recursive: true });
  return { root, task };
}

test('Pi cloud kernel enables the full coding toolset and keeps runtime secrets out of Bash children', async () => {
  const { root, task } = await makeWorkspace();
  let runtimeKey = '';
  const capturedOptions: { value: Record<string, any> | null } = { value: null };
  let sessionDirectory = '';
  let bashSpawnHook: ((context: Record<string, any>) => Record<string, any>) | undefined;
  const expectedCwd = await realpath(task);
  const sdk = {
    AuthStorage: { inMemory: () => ({ setRuntimeApiKey: (_provider: string, key: string) => { runtimeKey = key; } }) },
    ModelRegistry: { inMemory: () => ({ registerProvider: (_provider: string, config: unknown) => { assert.equal((config as { baseUrl: string }).baseUrl, modelConfig.baseUrl); }, find: () => ({ id: modelConfig.model }) }) },
    SessionManager: {
      list: async (_cwd: string, directory: string) => { sessionDirectory = directory; return []; },
      create: (_cwd: string, directory: string) => ({ appendMessage: () => '', getEntries: () => [], getSessionFile: () => undefined, getSessionId: () => 'pi-cloud-session' }),
      open: () => { throw new Error('unexpected resume'); },
    },
    createBashTool: (cwd: string, options: Record<string, any>) => {
      assert.equal(cwd, expectedCwd);
      bashSpawnHook = options.spawnHook;
      return { name: 'bash', label: 'Run command', description: 'Run a command', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) };
    },
    createAgentSession: async (options: Record<string, any>) => {
      capturedOptions.value = options;
      return { session: { messages: [{ role: 'assistant', content: [{ type: 'text', text: decision }] }], prompt: async () => undefined, dispose: () => undefined } };
    },
  };
  try {
    const output = await runCloudKernel({ engine: 'pi', prompt: 'complete the cloud task', cwd: task, workspace: root, taskId: '11111111-1111-4111-8111-111111111111', sessionId: null, modelConfig }, { piSdk: sdk });
    assert.equal(output.message, 'cloud kernel completed');
    assert.equal(output.sessionId, 'pi-cloud-session');
    assert.equal(runtimeKey, modelConfig.apiKey, 'Pi receives the shared credential through in-memory AuthStorage');
    assert.equal(Boolean(process.env.DEEPSEEK_API_KEY?.includes(modelConfig.apiKey)), false, 'The API key is not added to the cloud adapter process environment');
    assert.deepEqual(capturedOptions.value?.tools, ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
    assert.equal(capturedOptions.value?.customTools.some((tool: { name: string }) => tool.name === 'bash'), true, 'Pi Bash is enabled in the cloud computer');
    assert(bashSpawnHook);
    const childEnvironment = bashSpawnHook({ command: '/bin/true', args: [], cwd: task, env: {
      PATH: '/usr/bin:/bin', SAFE_TEST_VALUE: 'preserved', DEEPSEEK_API_KEY: 'model-secret',
      LINUX_DESKTOP_WORKER_TOKEN: 'worker-secret', DOTS_AGENT_RUNTIME_TOKEN: 'runtime-secret',
      DOTS_INCIDENT_GITHUB_CREDENTIAL_SOCKET: '/run/incident-git-agent/credential.sock',
    } }).env;
    assert.deepEqual(childEnvironment, { PATH: '/usr/bin:/bin', SAFE_TEST_VALUE: 'preserved' }, 'Bash can run commands without inheriting model or service credentials');
    assert(sessionDirectory.startsWith(await realpath(task)), 'The Pi session directory belongs to the task workspace');
    assert(capturedOptions.value?.agentDir.includes('/.coke-dots-agent-runtime/pi'));
    await stat(sessionDirectory);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Pi exposes the PR broker only to the incident task and its Bash child', async () => {
  const { root, task } = await makeWorkspace();
  const socketPath = `/tmp/coke-dots-pr-${process.pid}.sock`;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSocket = process.env.DOTS_INCIDENT_GITHUB_CREDENTIAL_SOCKET;
  process.env.NODE_ENV = 'test';
  process.env.DOTS_INCIDENT_GITHUB_CREDENTIAL_SOCKET = socketPath;
  let bashSpawnHook: ((context: Record<string, any>) => Record<string, any>) | undefined;
  let toolOutput: any;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    assert.equal(request.url, '/pull-request');
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), {});
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ number: 7, url: 'https://github.com/cokepoppy/coke-agent-test/pull/7', state: 'open', head: 'fix/coke-agent-empty-conversation-c7e2a195', base: 'main', merged: false }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    const sdk = {
      AuthStorage: { inMemory: () => ({ setRuntimeApiKey: () => undefined }) },
      ModelRegistry: { inMemory: () => ({ registerProvider: () => undefined, find: () => ({ id: modelConfig.model }) }) },
      SessionManager: { list: async () => [], create: () => ({ appendMessage: () => '', getEntries: () => [], getSessionFile: () => undefined, getSessionId: () => 'pi-incident-session' }), open: () => { throw new Error('unexpected'); } },
      createBashTool: (_cwd: string, options: Record<string, any>) => {
        bashSpawnHook = options.spawnHook;
        return { name: 'bash', label: 'Run command', description: 'Run a command', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) };
      },
      createAgentSession: async (options: Record<string, any>) => {
        assert(options.tools.includes('create_incident_pull_request'));
        const tool = options.customTools.find((item: { name: string }) => item.name === 'create_incident_pull_request');
        assert(tool);
        toolOutput = await tool.execute('pr-1', {});
        return { session: { messages: [{ role: 'assistant', content: [{ type: 'text', text: decision }] }], prompt: async () => undefined, dispose: () => undefined } };
      },
    };
    await runCloudKernel({ engine: 'pi', prompt: 'Finish the incident fix.', cwd: task, workspace: root, taskId: '11111111-1111-4111-8111-111111111111', sessionId: null, modelConfig }, { piSdk: sdk });
    assert.deepEqual(toolOutput.details, { number: 7, url: 'https://github.com/cokepoppy/coke-agent-test/pull/7', state: 'open' });
    assert(bashSpawnHook);
    const withSocket = bashSpawnHook({ command: '/bin/true', args: [], cwd: task, env: { PATH: '/usr/bin:/bin', DOTS_INCIDENT_GITHUB_CREDENTIAL_SOCKET: socketPath, DOTS_AGENT_RUNTIME_TOKEN: 'secret' } }).env;
    assert.deepEqual(withSocket, { PATH: '/usr/bin:/bin', DOTS_INCIDENT_GITHUB_CREDENTIAL_SOCKET: socketPath });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalNodeEnv;
    if (originalSocket === undefined) delete process.env.DOTS_INCIDENT_GITHUB_CREDENTIAL_SOCKET; else process.env.DOTS_INCIDENT_GITHUB_CREDENTIAL_SOCKET = originalSocket;
    await rm(socketPath, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('Pi exposes one task-scoped read-only DingTalk calendar tool and sends only the bounded list request', async () => {
  const { root, task } = await makeWorkspace();
  const captured: { payload: Record<string, unknown> | null } = { payload: null };
  let calendarTool: any;
  let receivedPrompt = '';
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    captured.payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, data: { events: [], count: 0, complete: true } }));
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const token = 'calendar-agent-token-not-in-environment';
  const sdk = {
    AuthStorage: { inMemory: () => ({ setRuntimeApiKey: () => undefined }) },
    ModelRegistry: { inMemory: () => ({ registerProvider: () => undefined, find: () => ({ id: modelConfig.model }) }) },
    SessionManager: { list: async () => [], create: () => ({ appendMessage: () => '', getEntries: () => [], getSessionFile: () => undefined, getSessionId: () => 'pi-calendar-session' }), open: () => { throw new Error('unexpected'); } },
    createAgentSession: async (options: Record<string, any>) => {
      assert(options.tools.includes('list_dingtalk_calendar_events'));
      assert.equal(options.tools.some((name: string) => /create|update|cancel.*calendar/i.test(name)), false);
      calendarTool = options.customTools.find((tool: { name: string }) => tool.name === 'list_dingtalk_calendar_events');
      return { session: { messages: [{ role: 'assistant', content: [{ type: 'text', text: decision }] }], prompt: async (prompt: string) => { receivedPrompt = prompt; }, dispose: () => undefined } };
    },
  };
  try {
    await runCloudKernel({
      engine: 'pi', prompt: '读取本周钉钉日程', cwd: task, workspace: root,
      taskId: '11111111-1111-4111-8111-111111111111', sessionId: null, modelConfig,
      dingtalkCalendarBridge: { url: `http://127.0.0.1:${address.port}/api/agent/dingtalk/calendar`, token, actions: ['list'] },
    }, { piSdk: sdk });
    assert.match(receivedPrompt, /Task-scoped DingTalk access policy/);
    assert.match(receivedPrompt, /list_dingtalk_calendar_events/);
    assert.match(receivedPrompt, /Do not use Bash, curl, wget/);
    assert.doesNotMatch(receivedPrompt, /create_dingtalk_calendar_event/);
    const result = await calendarTool.execute('calendar-1', {});
    assert.match(result.content[0].text, /"events":\[\]/);
    assert.equal(captured.payload?.action, 'list');
    assert.equal('start' in (captured.payload || {}), false, 'The gateway supplies a verified seven-day default range');
    assert.equal(JSON.stringify(captured.payload).includes(token), false);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('Pi exposes only the task-granted DingTalk calendar, todo, and fixed cokeclaw report tools', async () => {
  const { root, task } = await makeWorkspace();
  const requests: Array<Record<string, unknown>> = [];
  const captured: { names: string[]; calendarCreate: any; todoList: any; todo: any; report: any } = { names: [], calendarCreate: null, todoList: null, todo: null, report: null };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, data: { verified: true } }));
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const sdk = {
    AuthStorage: { inMemory: () => ({ setRuntimeApiKey: () => undefined }) },
    ModelRegistry: { inMemory: () => ({ registerProvider: () => undefined, find: () => ({ id: modelConfig.model }) }) },
    SessionManager: { list: async () => [], create: () => ({ appendMessage: () => '', getEntries: () => [], getSessionFile: () => undefined, getSessionId: () => 'pi-secretary-session' }), open: () => { throw new Error('unexpected'); } },
    createAgentSession: async (options: Record<string, any>) => {
      captured.names = options.tools;
      captured.calendarCreate = options.customTools.find((tool: { name: string }) => tool.name === 'create_dingtalk_calendar_event');
      captured.todoList = options.customTools.find((tool: { name: string }) => tool.name === 'list_dingtalk_personal_todos');
      captured.todo = options.customTools.find((tool: { name: string }) => tool.name === 'create_dingtalk_personal_todo');
      captured.report = options.customTools.find((tool: { name: string }) => tool.name === 'send_cokeclaw_group_report');
      return { session: { messages: [{ role: 'assistant', content: [{ type: 'text', text: decision }] }], prompt: async () => undefined, dispose: () => undefined } };
    },
  };
  const bridgeUrl = `http://127.0.0.1:${address.port}/api/agent/dingtalk/secretary`;
  const token = 'task-scoped-secretary-token-never-in-environment';
  try {
    await runCloudKernel({
      engine: 'pi', prompt: '创建会议和个人待办，把最终报告发到 cokeclaw', cwd: task, workspace: root,
      taskId: '11111111-1111-4111-8111-111111111111', sessionId: null, modelConfig,
      dingtalkCalendarBridge: { url: `http://127.0.0.1:${address.port}/api/agent/dingtalk/calendar`, token, actions: ['create'] },
      dingtalkSecretaryBridge: { url: bridgeUrl, token, actions: ['todo-list', 'todo-create', 'cokeclaw-send'] },
    }, { piSdk: sdk });
    assert.equal(captured.names.includes('create_dingtalk_calendar_event'), true);
    assert.equal(captured.names.includes('list_dingtalk_calendar_events'), false, 'A create-only grant must not expose calendar reads');
    assert.equal(captured.names.includes('create_dingtalk_personal_todo'), true);
    assert.equal(captured.names.includes('list_dingtalk_personal_todos'), true);
    assert.equal(captured.names.includes('send_cokeclaw_group_report'), true);
    assert.equal(captured.report.parameters.properties.group, undefined, 'The Agent cannot choose a group');
    const meeting = await captured.calendarCreate.execute('meeting-1', { title: '北交所准备会', start: '2026-10-19T10:00:00+08:00', end: '2026-10-19T10:45:00+08:00' });
    const todos = await captured.todoList.execute('todo-list-1', { scope: 'due-today' });
    const todo = await captured.todo.execute('todo-1', { title: '核验规则', due: '2026-10-20T17:00:00+08:00', priority: 30 });
    const report = await captured.report.execute('report-1', { content: '报告已完成' });
    assert.match(meeting.content[0].text, /verified/);
    assert.match(todos.content[0].text, /verified/);
    assert.match(todo.content[0].text, /verified/);
    assert.match(report.content[0].text, /verified/);
    assert.deepEqual(requests.map(item => item.action), ['create', 'todo-list', 'todo-create', 'cokeclaw-send']);
    assert.equal(requests[2].group, undefined, 'Group routing remains fixed in the server');
    assert(requests.every(item => !JSON.stringify(item).includes(token)));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('Pi cloud tasks expose standard read, write, edit, and Bash tools without a legacy approval flag', async () => {
  const { root, task } = await makeWorkspace();
  const captured: { tools: string[]; customTools: Array<{ name: string }> } = { tools: [], customTools: [] };
  const sdk = {
    AuthStorage: { inMemory: () => ({ setRuntimeApiKey: () => undefined }) },
    ModelRegistry: { inMemory: () => ({ registerProvider: () => undefined, find: () => ({ id: modelConfig.model }) }) },
    SessionManager: { list: async () => [], create: () => ({ appendMessage: () => '', getEntries: () => [], getSessionFile: () => undefined, getSessionId: () => 'pi-file-session' }), open: () => { throw new Error('unexpected'); } },
    createBashTool: () => ({ name: 'bash', label: 'Run command', description: 'Run a command', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }),
    createAgentSession: async (options: Record<string, any>) => {
      captured.tools = options.tools;
      captured.customTools = options.customTools;
      return { session: { messages: [{ role: 'assistant', content: [{ type: 'text', text: decision }] }], prompt: async () => undefined, dispose: () => undefined } };
    },
  };
  try {
    await runCloudKernel({ engine: 'pi', prompt: 'Create and update a local HTML file.', cwd: task, workspace: root, taskId: '11111111-1111-4111-8111-111111111111', sessionId: null, modelConfig }, { piSdk: sdk });
    for (const name of ['read', 'write', 'edit', 'bash']) assert(captured.tools.includes(name), `${name} is enabled`);
    assert.equal(captured.tools.includes('create_task_file'), false, 'The legacy create-only tool is removed');
    assert(captured.customTools.some(tool => tool.name === 'bash'), 'The secret-scrubbing Bash wrapper overrides Pi’s default Bash tool');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Pi output-limit turns return a clear diagnostic without retrying the task', async () => {
  const { root, task } = await makeWorkspace();
  const makeSdk = () => ({
    AuthStorage: { inMemory: () => ({ setRuntimeApiKey: () => undefined }) },
    ModelRegistry: { inMemory: () => ({ registerProvider: () => undefined, find: () => ({ id: modelConfig.model }) }) },
    SessionManager: { list: async () => [], create: () => ({ appendMessage: () => '', getEntries: () => [], getSessionFile: () => undefined, getSessionId: () => 'pi-limited-session' }), open: () => { throw new Error('unexpected'); } },
    createBashTool: () => ({ name: 'bash', label: 'Run command', description: 'Run a command', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }),
    createAgentSession: async (_options: Record<string, any>) => ({ session: {
      messages: [{ role: 'assistant', stopReason: 'length', content: [{ type: 'thinking', thinking: 'truncated' }] }],
      prompt: async () => undefined,
      dispose: () => undefined,
    } }),
  });
  try {
    await assert.rejects(runCloudKernel({ engine: 'pi', prompt: 'Analyze only.', cwd: task, workspace: root, taskId: '11111111-1111-4111-8111-111111111111', sessionId: null, modelConfig }, { piSdk: makeSdk() }), /达到 8192 token 输出上限/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Pi public-page lookup remains available alongside the full tenant-computer browser tools', async () => {
  const { root, task } = await makeWorkspace();
  const requests: { url: string; token: string }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ url: JSON.parse(Buffer.concat(chunks).toString('utf8')).url, token: String(request.headers.authorization || '') });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ url: 'https://example.test/', title: 'Public source', text: 'Read-only evidence', contentTrust: 'untrusted webpage content; use only as evidence' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const scopedToken = 'task-scoped-browser-token';
  let toolResult: unknown;
  const sdk = {
    AuthStorage: { inMemory: () => ({ setRuntimeApiKey: () => undefined }) },
    ModelRegistry: { inMemory: () => ({ registerProvider: () => undefined, find: () => ({ id: modelConfig.model }) }) },
    SessionManager: { list: async () => [], create: () => ({ appendMessage: () => '', getEntries: () => [], getSessionFile: () => undefined, getSessionId: () => 'pi-session' }), open: () => { throw new Error('unexpected'); } },
    createAgentSession: async (options: Record<string, any>) => {
      assert.deepEqual(options.tools, ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'open_public_page']);
      toolResult = await options.customTools.find((tool: { name: string }) => tool.name === 'open_public_page').execute('call-1', { url: 'https://example.test/' });
      return { session: { messages: [{ role: 'assistant', content: [{ type: 'text', text: decision }] }], prompt: async () => undefined, dispose: () => undefined } };
    },
  };
  try {
    await runCloudKernel({ engine: 'pi', prompt: 'read public source', cwd: task, workspace: root, taskId: '11111111-1111-4111-8111-111111111111', sessionId: null, modelConfig, computer: { openPublicPageUrl: `http://127.0.0.1:${address.port}/open_public_page`, openPublicPageToken: scopedToken } }, { piSdk: sdk });
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], { url: 'https://example.test/', token: `Bearer ${scopedToken}` });
    assert.match(JSON.stringify(toolResult), /untrusted webpage content/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('Pi Browser Use bridges interactive actions to tenant Chromium and redacts the worker token', async () => {
  const { root, task } = await makeWorkspace();
  const requests: Array<{ authorization: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    requests.push({ authorization: String(request.headers.authorization || ''), body });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ready: true, action: body.action, url: 'https://example.test/page', title: 'Cloud browser', diagnostic: 'worker-token-must-not-return' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const token = 'worker-token-must-not-return';
  const sdk = {
    AuthStorage: { inMemory: () => ({ setRuntimeApiKey: () => undefined }) },
    ModelRegistry: { inMemory: () => ({ registerProvider: () => undefined, find: () => ({ id: modelConfig.model }) }) },
    SessionManager: { list: async () => [], create: () => ({ appendMessage: () => '', getEntries: () => [], getSessionFile: () => undefined, getSessionId: () => 'pi-browser-session' }), open: () => { throw new Error('unexpected'); } },
    createBashTool: () => ({ name: 'bash', label: 'Run command', description: 'Run a command', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }),
    createAgentSession: async (options: Record<string, any>) => {
      assert(options.tools.includes('computer_browser'));
      const tool = options.customTools.find((item: { name: string }) => item.name === 'computer_browser');
      const inspect = await tool.execute('inspect-1', { action: 'inspect' });
      const click = await tool.execute('click-1', { action: 'click', by: 'role', role: 'button', target: 'Search' });
      assert.doesNotMatch(JSON.stringify([inspect, click]), new RegExp(token));
      return { session: { messages: [{ role: 'assistant', content: [{ type: 'text', text: decision }] }], prompt: async () => undefined, dispose: () => undefined } };
    },
  };
  try {
    await runCloudKernel({ engine: 'pi', prompt: 'Search with the cloud browser', cwd: task, workspace: root, taskId: '11111111-1111-4111-8111-111111111111', sessionId: null, modelConfig, computer: { baseUrl: `http://127.0.0.1:${address.port}/`, workerToken: token } }, { piSdk: sdk });
    assert.deepEqual(requests.map(request => request.authorization), [`Bearer ${token}`, `Bearer ${token}`]);
    assert.deepEqual(requests.map(request => request.body), [
      { action: 'inspect', taskId: '11111111-1111-4111-8111-111111111111' },
      { action: 'click', by: 'role', role: 'button', target: 'Search', taskId: '11111111-1111-4111-8111-111111111111' },
    ]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('Pi exposes only the task-scoped DingTalk document tools and keeps their grant out of prompts and environment', async () => {
  const { root, task } = await makeWorkspace();
  const requests: Array<{ authorization: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    requests.push({ authorization: String(request.headers.authorization || ''), body });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, data: body.action === 'create' ? { nodeId: 'created-doc-1', verified: true, url: 'https://alidocs.dingtalk.com/document/edit?docId=created-doc-1' } : { documents: [{ nodeId: 'doc-1', name: '值班手册' }], count: 1 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const token = 'task-scoped-dingtalk-document-token';
  let toolOutputs: unknown[] = [];
  const sdk = {
    AuthStorage: { inMemory: () => ({ setRuntimeApiKey: () => undefined }) },
    ModelRegistry: { inMemory: () => ({ registerProvider: () => undefined, find: () => ({ id: modelConfig.model }) }) },
    SessionManager: { list: async () => [], create: () => ({ appendMessage: () => '', getEntries: () => [], getSessionFile: () => undefined, getSessionId: () => 'pi-dingtalk-session' }), open: () => { throw new Error('unexpected'); } },
    createAgentSession: async (options: Record<string, any>) => {
      assert.deepEqual(options.tools, ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'search_dingtalk_documents', 'fetch_dingtalk_document', 'create_dingtalk_document']);
      const byName = new Map(options.customTools.map((tool: { name: string }) => [tool.name, tool]));
      toolOutputs = [
        await (byName.get('search_dingtalk_documents') as any).execute('search-1', { query: '值班手册' }),
        await (byName.get('create_dingtalk_document') as any).execute('create-1', { name: '排障报告', content: 'Trace ID: trace-1' }),
      ];
      return { session: { messages: [{ role: 'assistant', content: [{ type: 'text', text: decision }] }], prompt: async () => undefined, dispose: () => undefined } };
    },
  };
  try {
    const prompt = '请搜索钉钉值班手册并把排障报告创建为钉钉文档。';
    await runCloudKernel({ engine: 'pi', prompt, cwd: task, workspace: root, taskId: '11111111-1111-4111-8111-111111111111', sessionId: null, modelConfig, dingtalkDocumentsBridge: { url: `http://127.0.0.1:${address.port}/api/agent/dingtalk/documents`, token, actions: ['search', 'fetch', 'create'] } }, { piSdk: sdk });
    assert.equal(requests.length, 2);
    assert(requests.every(request => request.authorization === `Bearer ${token}`));
    assert.deepEqual(requests.map(request => request.body.action), ['search', 'create']);
    assert.equal(requests[1]?.body.name, '排障报告');
    assert.doesNotMatch(prompt, new RegExp(token));
    assert.equal(Object.values(process.env).includes(token), false, 'The task-scoped grant is not exported through the adapter environment');
    assert.doesNotMatch(JSON.stringify(toolOutputs), new RegExp(token), 'Tool responses never return the grant');
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('DeepSeek Harness routes the shared OpenAI-compatible profile through its pi-ai adapter and a task-local runtime home', async () => {
  const { root, task } = await makeWorkspace();
  const captured: { launch: Record<string, any> | null; provider: string | null } = { launch: null, provider: null };
  let safetyPatch = '';
  const sdk = {
    DeepSeekHarness: class {
      constructor(options: Record<string, any>) { captured.launch = options.launch; captured.provider = options.provider; }
      async run() {
        safetyPatch = await readFile(captured.launch!.args[3], 'utf8');
        return { finalResponse: decision, sessionId: 'dsh-cloud-session' };
      }
      async close() {}
    },
  };
  try {
    const output = await runCloudKernel({ engine: 'dsh', prompt: 'complete the cloud task', cwd: task, workspace: root, taskId: '11111111-1111-4111-8111-111111111111', sessionId: null, modelConfig }, { dshSdk: sdk });
    assert.equal(output.message, 'cloud kernel completed');
    assert.equal(output.sessionId, 'dsh-cloud-session');
    assert(captured.launch);
    assert.equal(captured.provider, 'coke-dots-shared');
    const launch = captured.launch!;
    assert.equal(launch.env.DEEPSEEK_API_KEY, modelConfig.apiKey);
    assert.equal(launch.env.DEEPSEEK_BASE_URL, modelConfig.baseUrl);
    assert.equal(launch.env.DSH_MODEL, modelConfig.model);
    assert.equal(launch.env.DOTS_AGENT_RUNTIME_TOKEN, undefined);
    assert.equal(launch.env.LINUX_DESKTOP_WORKER_TOKEN, undefined);
    assert.equal(launch.env.DSH_HOME, join(await realpath(task), '.coke-dots-agent-runtime', 'dsh-home'));
    assert.match(launch.args.join(' '), /--profile sdk --patch/);
    assert.match(safetyPatch, /id: llm-pi-ai/);
    assert.match(safetyPatch, /api: openai-completions/);
    assert.match(safetyPatch, /baseURL: "https:\/\/api\.deepseek\.com"/);
    assert.match(safetyPatch, /id: "deepseek-flash"/);
    assert.doesNotMatch(safetyPatch, new RegExp(modelConfig.apiKey));
    const written = await readdir(launch.env.DSH_HOME);
    assert.equal(written.some(name => name.endsWith('.cordis.yml')), false, 'Per-run safety patches are removed after completion');
    assert.equal(written.some(name => name.endsWith('.mjs')), false, 'Per-run browser plugins are removed after completion');
    assert.match(safetyPatch, /- id: tool-bash\n  disabled: true/);
    assert.match(safetyPatch, /- id: tool-fs-search\n  disabled: true/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('DeepSeek Harness registers a temporary scoped DingTalk plugin without putting its grant in process environment', async () => {
  const { root, task } = await makeWorkspace();
  const token = 'task-scoped-dingtalk-grant-test-value';
  const captured: { launch: Record<string, any> | null; patch: string; plugin: string; envHasToken: boolean } = { launch: null, patch: '', plugin: '', envHasToken: false };
  const sdk = {
    DeepSeekHarness: class {
      constructor(options: Record<string, any>) { captured.launch = options.launch; }
      async run() {
        const launch = captured.launch!;
        captured.patch = await readFile(launch.args[3], 'utf8');
        const pluginName = (await readdir(launch.env.DSH_HOME)).find(name => name.endsWith('-dingtalk-documents.mjs'));
        assert(pluginName);
        captured.plugin = await readFile(join(launch.env.DSH_HOME, pluginName), 'utf8');
        captured.envHasToken = Object.values(launch.env).includes(token);
        return { finalResponse: decision, sessionId: 'dsh-dingtalk-session' };
      }
      async close() {}
    },
  };
  try {
    const output = await runCloudKernel({
      engine: 'dsh', prompt: '请创建钉钉排障报告', cwd: task, workspace: root,
      taskId: '11111111-1111-4111-8111-111111111111', sessionId: null, modelConfig,
      dingtalkDocumentsBridge: { url: 'https://dots.example.test/dots-demo/api/agent/dingtalk/documents', token, actions: ['search', 'fetch', 'create'] },
    }, { dshSdk: sdk });
    assert.equal(output.message, 'cloud kernel completed');
    assert.equal(captured.envHasToken, false);
    assert.match(captured.patch, /coke-dots-dingtalk-documents-/);
    assert.doesNotMatch(captured.patch, new RegExp(token));
    assert.match(captured.plugin, /search_dingtalk_documents/);
    assert.match(captured.plugin, /fetch_dingtalk_document/);
    assert.match(captured.plugin, /create_dingtalk_document/);
    assert.match(captured.plugin, new RegExp(token), 'The delegated token stays in the temporary restricted plugin that the DSH tools cannot read');
    assert.doesNotMatch(captured.plugin, new RegExp(modelConfig.apiKey));
    assert.equal((await readdir(join(await realpath(task), '.coke-dots-agent-runtime', 'dsh-home'))).some(name => name.includes('dingtalk-documents')), false, 'The capability-bearing plugin is removed after the task returns');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('DeepSeek Harness exposes a temporary read-only DingTalk calendar tool for the authorized task', async () => {
  const { root, task } = await makeWorkspace();
  const token = 'task-scoped-calendar-grant-never-in-env';
  const captured: { launch: Record<string, any> | null; plugin: string; envHasToken: boolean } = { launch: null, plugin: '', envHasToken: false };
  const sdk = {
    DeepSeekHarness: class {
      constructor(options: Record<string, any>) { captured.launch = options.launch; }
      async run() {
        const launch = captured.launch!;
        const pluginName = (await readdir(launch.env.DSH_HOME)).find(name => name.endsWith('-dingtalk-calendar.mjs'));
        assert(pluginName);
        captured.plugin = await readFile(join(launch.env.DSH_HOME, pluginName), 'utf8');
        captured.envHasToken = Object.values(launch.env).includes(token);
        return { finalResponse: decision, sessionId: 'dsh-calendar-session' };
      }
      async close() {}
    },
  };
  try {
    await runCloudKernel({
      engine: 'dsh', prompt: '读取本周钉钉日程', cwd: task, workspace: root,
      taskId: '11111111-1111-4111-8111-111111111111', sessionId: null, modelConfig,
      dingtalkCalendarBridge: { url: 'https://dots.example.test/dots-demo/api/agent/dingtalk/calendar', token, actions: ['list'] },
    }, { dshSdk: sdk });
    assert.equal(captured.envHasToken, false);
    assert.match(captured.plugin, /list_dingtalk_calendar_events/);
    assert.match(captured.plugin, /Read-only/);
    assert.match(captured.plugin, /if \(bridge\.actions\.includes\('create'\)\)/, 'The create tool is runtime-gated by the task grant and is not available to a list-only capability');
    assert.match(captured.plugin, new RegExp(token));
    assert.equal((await readdir(join(await realpath(task), '.coke-dots-agent-runtime', 'dsh-home'))).some(name => name.endsWith('-dingtalk-calendar.mjs')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('DeepSeek Harness surfaces a bounded turn-end failure when the runtime returns no assistant text', async () => {
  const { root, task } = await makeWorkspace();
  const sdk = {
    DeepSeekHarness: class {
      constructor(_options: Record<string, unknown>) {}
      async run() {
        return { finalResponse: '', events: [{ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'AUTH', message: 'Model authorization failed' } } } }] };
      }
      async close() {}
    },
  };
  try {
    await assert.rejects(
      runCloudKernel({ engine: 'dsh', prompt: 'complete the cloud task', cwd: task, workspace: root, taskId: '11111111-1111-4111-8111-111111111111', modelConfig }, { dshSdk: sdk }),
      /DeepSeek Harness returned no assistant text \(error AUTH: Model authorization failed\)/,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cloud Agent kernels reject unsafe model endpoints and task paths outside their tenant workspace', async () => {
  const { root, task } = await makeWorkspace();
  try {
    await assert.rejects(runCloudKernel({ engine: 'pi', prompt: 'x', cwd: task, workspace: root, modelConfig: { ...modelConfig, baseUrl: 'http://api.deepseek.com' } }, { piSdk: {} }), /HTTPS/);
    await assert.rejects(runCloudKernel({ engine: 'pi', prompt: 'x', cwd: '/tmp', workspace: root, modelConfig }, { piSdk: {} }), /outside the tenant workspace/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
