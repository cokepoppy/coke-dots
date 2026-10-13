import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCloudKernel } from '../deploy/linux-desktop/cloud-kernel-adapter.mjs';
import { parseAgentDecisionJson } from '../src/shared/agent-decision-json.mjs';

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
    assert.equal(capturedOptions.value?.tools.includes('create_task_file'), false, 'File creation is not available unless the control plane explicitly authorizes a standard Pi task');
    assert(sessionDirectory.startsWith(await realpath(task)), 'The Pi session directory belongs to the task workspace');
    assert(capturedOptions.value?.agentDir.includes('/.coke-dots-agent-runtime/pi'));
    await stat(sessionDirectory);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Pi file output is create-only, bounded, and confined to its authorized task directory', async () => {
  const { root, task } = await makeWorkspace();
  const captured: { tool: any } = { tool: null };
  const sdk = {
    AuthStorage: { inMemory: () => ({ setRuntimeApiKey: () => undefined }) },
    ModelRegistry: { inMemory: () => ({ registerProvider: () => undefined, find: () => ({ id: modelConfig.model }) }) },
    SessionManager: { list: async () => [], create: () => ({ appendMessage: () => '', getEntries: () => [], getSessionFile: () => undefined, getSessionId: () => 'pi-file-session' }), open: () => { throw new Error('unexpected'); } },
    createAgentSession: async (options: Record<string, any>) => {
      assert(options.tools.includes('create_task_file'));
      captured.tool = options.customTools.find((tool: { name: string }) => tool.name === 'create_task_file');
      return { session: { messages: [{ role: 'assistant', content: [{ type: 'text', text: decision }] }], prompt: async () => undefined, dispose: () => undefined } };
    },
  };
  try {
    await runCloudKernel({ engine: 'pi', prompt: 'Create a local HTML file.', cwd: task, workspace: root, taskId: '11111111-1111-4111-8111-111111111111', sessionId: null, modelConfig, allowWorkspaceFileWrites: true }, { piSdk: sdk });
    const content = '<!doctype html><title>云电脑文件</title>';
    const result = await captured.tool.execute('write-1', { path: 'games/tetris.html', content });
    assert.equal(result.details.path, 'games/tetris.html');
    assert.equal(await readFile(join(task, 'games/tetris.html'), 'utf8'), content);
    assert.equal((await captured.tool.execute('write-same', { path: 'games/tetris.html', content })).details.alreadyExisted, true);
    await assert.rejects(captured.tool.execute('write-2', { path: 'games/tetris.html', content: '<h1>replacement</h1>' }), /拒绝覆盖/);
    await assert.rejects(captured.tool.execute('write-3', { path: '../outside.txt', content }), /安全相对路径/);
    await assert.rejects(captured.tool.execute('write-4', { path: join(root, 'outside.txt'), content }), /安全相对路径/);
    await assert.rejects(captured.tool.execute('write-5', { path: '.coke-dots-agent-runtime/secret.txt', content }), /安全相对路径/);
    await symlink(root, join(task, 'linked-out'));
    await assert.rejects(captured.tool.execute('write-6', { path: 'linked-out/escape.txt', content }), /符号链接/);
    await assert.rejects(captured.tool.execute('write-7', { path: 'too-large.txt', content: 'x'.repeat(512 * 1024 + 1) }), /512 KiB/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Pi decision JSON accepts multiline messages and output longer than the previous 4202-character failure', () => {
  const message = `第一行\n第二行\t列\r结束 ${'完成'.repeat(2200)}`;
  const raw = `Result:\n\`\`\`json\n{"status":"done","message":"${message}"}\n\`\`\``;
  const parsed = parseAgentDecisionJson(raw) as { status: string; message: string };
  assert.equal(parsed.status, 'done');
  assert.equal(parsed.message, message);
  assert(raw.length > 4202);
  assert.throws(() => parseAgentDecisionJson('{"status":"done","message":"truncated'), /不完整/);
});

test('Pi output-limit recovery disables tools and asks for a concise evidence-based status', async () => {
  const { root, task } = await makeWorkspace();
  const makeSdk = (writeFileFirst: boolean, repairText: string, repairStopReason = 'stop') => ({
    AuthStorage: { inMemory: () => ({ setRuntimeApiKey: () => undefined }) },
    ModelRegistry: { inMemory: () => ({ registerProvider: () => undefined, find: () => ({ id: modelConfig.model }) }) },
    SessionManager: { list: async () => [], create: () => ({ appendMessage: () => '', getEntries: () => [], getSessionFile: () => undefined, getSessionId: () => 'pi-limited-session' }), open: () => { throw new Error('unexpected'); } },
    createAgentSession: async (options: Record<string, any>) => {
      let activeTools = [...options.tools];
      let prompts = 0;
      const messages: any[] = [];
      return { session: {
        messages,
        prompt: async () => {
          prompts += 1;
          if (prompts === 1) {
            if (writeFileFirst) await options.customTools.find((tool: { name: string }) => tool.name === 'create_task_file').execute('write-1', { path: 'tetris.html', content: '<h1>blocks</h1>' });
            messages.push({ role: 'assistant', stopReason: 'length', content: [{ type: 'text', text: `{"status":"done","message":"${'x'.repeat(4180)}` }] });
            return;
          }
          assert.deepEqual(activeTools, [], 'The status recovery must not be able to repeat file or browser actions');
          messages.push({ role: 'assistant', stopReason: repairStopReason, content: [{ type: 'text', text: repairText }] });
        },
        setActiveToolsByName: (names: string[]) => { activeTools = names; },
        dispose: () => undefined,
      } };
    },
  });
  try {
    const waiting = await runCloudKernel({ engine: 'pi', prompt: 'Analyze only.', cwd: task, workspace: root, taskId: '11111111-1111-4111-8111-111111111111', sessionId: null, modelConfig }, { piSdk: makeSdk(false, JSON.stringify({ status: 'waiting', message: '回复被截断，现有证据不足以确认任务完成。' })) });
    assert.equal(waiting.status, 'waiting', 'An incomplete answer without file evidence must not be reported as completed');

    const output = await runCloudKernel({ engine: 'pi', prompt: 'Create a local HTML file.', cwd: task, workspace: root, taskId: '11111111-1111-4111-8111-111111111111', sessionId: null, modelConfig, allowWorkspaceFileWrites: true }, { piSdk: makeSdk(true, JSON.stringify({ status: 'done', message: '已创建 tetris.html。' })) });
    assert.equal(output.status, 'done');
    assert.equal(output.message, '已创建 tetris.html。');
    assert.equal(await readFile(join(task, 'tetris.html'), 'utf8'), '<h1>blocks</h1>');

    await assert.rejects(
      runCloudKernel({ engine: 'pi', prompt: 'Analyze only.', cwd: task, workspace: root, taskId: '11111111-1111-4111-8111-111111111111', sessionId: null, modelConfig }, { piSdk: makeSdk(false, '{"status":"done","message":"still truncated', 'length') }),
      /简短状态恢复仍达到模型输出上限/,
    );
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
