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

test('Pi cloud kernel keeps the shared key in memory and the native session inside its task workspace', async () => {
  const { root, task } = await makeWorkspace();
  let runtimeKey = '';
  const capturedOptions: { value: Record<string, any> | null } = { value: null };
  let sessionDirectory = '';
  const sdk = {
    AuthStorage: { inMemory: () => ({ setRuntimeApiKey: (_provider: string, key: string) => { runtimeKey = key; } }) },
    ModelRegistry: { inMemory: () => ({ registerProvider: (_provider: string, config: unknown) => { assert.equal((config as { baseUrl: string }).baseUrl, modelConfig.baseUrl); }, find: () => ({ id: modelConfig.model }) }) },
    SessionManager: {
      list: async (_cwd: string, directory: string) => { sessionDirectory = directory; return []; },
      create: (_cwd: string, directory: string) => ({ appendMessage: () => '', getEntries: () => [], getSessionFile: () => undefined, getSessionId: () => 'pi-cloud-session' }),
      open: () => { throw new Error('unexpected resume'); },
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
    assert(sessionDirectory.startsWith(await realpath(task)), 'The Pi session directory belongs to the task workspace');
    assert(capturedOptions.value?.agentDir.includes('/.coke-dots-agent-runtime/pi'));
    await stat(sessionDirectory);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Pi cloud browser tool uses only its scoped read-only bridge capability', async () => {
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
      assert.deepEqual(options.tools, ['read', 'grep', 'find', 'ls', 'open_public_page']);
      toolResult = await options.customTools[0].execute('call-1', { url: 'https://example.test/' });
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

test('Pi cloud computer UI tool uses a scoped bridge and permits only inspect or information-button actions', async () => {
  const { root, task } = await makeWorkspace();
  const requests: { path: string; body: unknown; token: string }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    requests.push({ path: new URL(request.url || '/', 'http://127.0.0.1').pathname, body, token: String(request.headers.authorization || '') });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ url: 'https://example.test/activity', title: 'Public activity', text: 'AI 助手上手分享\n活动详情\n免费名额：2 个' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const scopedToken = 'task-scoped-computer-ui-token';
  const toolResults: unknown[] = [];
  const sdk = {
    AuthStorage: { inMemory: () => ({ setRuntimeApiKey: () => undefined }) },
    ModelRegistry: { inMemory: () => ({ registerProvider: () => undefined, find: () => ({ id: modelConfig.model }) }) },
    SessionManager: { list: async () => [], create: () => ({ appendMessage: () => '', getEntries: () => [], getSessionFile: () => undefined, getSessionId: () => 'pi-ui-session' }), open: () => { throw new Error('unexpected'); } },
    createAgentSession: async (options: Record<string, any>) => {
      assert.deepEqual(options.tools, ['read', 'grep', 'find', 'ls', 'open_public_page', 'computer_ui']);
      const computerUi = options.customTools.find((tool: { name: string }) => tool.name === 'computer_ui');
      toolResults.push(await computerUi.execute('inspect', { action: 'inspect' }));
      toolResults.push(await computerUi.execute('click', { action: 'click_information_button', buttonName: '查看活动详情' }));
      return { session: { messages: [{ role: 'assistant', content: [{ type: 'text', text: decision }] }], prompt: async () => undefined, dispose: () => undefined } };
    },
  };
  try {
    await runCloudKernel({
      engine: 'pi', prompt: 'Open the public page, inspect it, then click 查看活动详情.', cwd: task, workspace: root,
      taskId: '11111111-1111-4111-8111-111111111111', sessionId: null, modelConfig,
      computer: {
        openPublicPageUrl: `http://127.0.0.1:${address.port}/open_public_page`, openPublicPageToken: scopedToken,
        computerUiUrl: `http://127.0.0.1:${address.port}/computer_ui`, computerUiToken: scopedToken,
      },
    }, { piSdk: sdk });
    assert.deepEqual(requests, [
      { path: '/computer_ui/inspect', body: {}, token: `Bearer ${scopedToken}` },
      { path: '/computer_ui/click', body: { name: '查看活动详情' }, token: `Bearer ${scopedToken}` },
    ]);
    assert.match(JSON.stringify(toolResults), /免费名额：2 个/);
    assert.match(JSON.stringify(toolResults), /查看活动详情/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('proactive review runs inside the Pi cloud kernel with every computer and file tool removed', async () => {
  const { root, task } = await makeWorkspace();
  const proactiveDecision = JSON.stringify({ status: 'done', message: 'The launch target conflicts with the active release task.', proactiveFinding: true });
  const capturedOptions: { value: Record<string, any> | null } = { value: null };
  const sdk = {
    AuthStorage: { inMemory: () => ({ setRuntimeApiKey: () => undefined }) },
    ModelRegistry: { inMemory: () => ({ registerProvider: () => undefined, find: () => ({ id: modelConfig.model }) }) },
    SessionManager: { list: async () => [], create: () => ({ appendMessage: () => '', getEntries: () => [], getSessionFile: () => undefined, getSessionId: () => 'pi-proactive-session' }), open: () => { throw new Error('unexpected'); } },
    createAgentSession: async (options: Record<string, any>) => {
      capturedOptions.value = options;
      return { session: { messages: [{ role: 'assistant', content: [{ type: 'text', text: proactiveDecision }] }], prompt: async () => undefined, dispose: () => undefined } };
    },
  };
  try {
    const output = await runCloudKernel({
      engine: 'pi', executionMode: 'proactive-research', prompt: 'Review only the supplied work context.', cwd: task,
      workspace: root, taskId: '11111111-1111-4111-8111-111111111111', sessionId: null, modelConfig,
      computer: { openPublicPageUrl: 'https://must-not-be-available.test/', openPublicPageToken: 'blocked-token' },
    }, { piSdk: sdk });
    assert.equal(output.proactiveFinding, true);
    assert.deepEqual(capturedOptions.value?.tools, [], 'Proactive research must not receive Pi file or browser tools');
    assert.equal(capturedOptions.value?.customTools, undefined, 'A cloud-computer browser bridge must not be registered');
  } finally { await rm(root, { recursive: true, force: true }); }
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

test('DeepSeek Harness proactive review receives no browser bridge or write-capable DSH tools', async () => {
  const { root, task } = await makeWorkspace();
  const proactiveDecision = JSON.stringify({ status: 'done', message: 'A conflict is supported by the supplied tasks.', proactiveFinding: true });
  let safetyPatch = '';
  const capturedEnvironment: { value: Record<string, string> | null } = { value: null };
  // Capture the per-run patch via the configured profile arguments.
  const WrappedHarness = class {
    private args: string[];
    constructor(options: Record<string, any>) { capturedEnvironment.value = options.launch.env; this.args = options.launch.args; }
    async run() { safetyPatch = await readFile(this.args[3], 'utf8'); return { finalResponse: proactiveDecision, sessionId: 'dsh-proactive-session' }; }
    async close() {}
  };
  try {
    const output = await runCloudKernel({
      engine: 'dsh', executionMode: 'proactive-research', prompt: 'Review only the supplied work context.', cwd: task,
      workspace: root, taskId: '11111111-1111-4111-8111-111111111111', sessionId: null, modelConfig,
      computer: { openPublicPageUrl: 'https://must-not-be-available.test/', openPublicPageToken: 'blocked-token' },
    }, { dshSdk: { DeepSeekHarness: WrappedHarness } });
    assert.equal(output.proactiveFinding, true);
    assert.equal(capturedEnvironment.value?.COKE_DOTS_PUBLIC_PAGE_BRIDGE_URL, undefined, 'The cloud DSH process must not receive a browser capability');
    assert.equal(capturedEnvironment.value?.COKE_DOTS_PUBLIC_PAGE_BRIDGE_TOKEN, undefined, 'The cloud DSH process must not receive a browser token');
    assert.doesNotMatch(safetyPatch, /coke-dots-public-page/);
    assert.match(safetyPatch, /- id: tool-web\n  disabled: true/);
    assert.match(safetyPatch, /- id: tool-bash\n  disabled: true/);
    assert.match(safetyPatch, /- id: tool-fs\n  disabled: true/);
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
