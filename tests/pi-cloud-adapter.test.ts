import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const projectRoot = resolve(import.meta.dirname, '..');

test('Pi cloud adapter uses the in-memory shared model profile and saves a task-local proactive session', { timeout: 30_000 }, async context => {
  try { await import('@mariozechner/pi-coding-agent'); }
  catch { context.skip('The optional Pi SDK is not installed in this environment.'); return; }

  const requests: { authorization: string | undefined; model: string; prompt: string; stream: boolean; tools: unknown[] }[] = [];
  const modelServer: Server = createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(raw) as { model?: string; stream?: boolean; messages?: { role: string; content?: unknown }[]; tools?: unknown[] };
      const userContent = payload.messages?.filter(message => message.role === 'user').map(message => {
        if (typeof message.content === 'string') return message.content;
        if (Array.isArray(message.content)) return message.content.map(item => typeof item === 'object' && item && 'text' in item ? String((item as { text: unknown }).text) : '').join('\n');
        return '';
      }).join('\n') || '';
      requests.push({
        authorization: request.headers.authorization,
        model: String(payload.model || ''),
        prompt: userContent,
        stream: payload.stream === true,
        tools: payload.tools || [],
      });
      const content = JSON.stringify({ status: 'done', message: '发现一处待确认的日期冲突。', proactiveFinding: true, notifyUser: false });
      if (payload.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        response.write(`data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        response.end('data: [DONE]\n\n');
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) => modelServer.once('error', reject).listen(0, '127.0.0.1', resolvePromise));
  const address = modelServer.address();
  assert(address && typeof address !== 'string');
  const workspace = await mkdtemp(join(tmpdir(), 'coke-dots-pi-cloud-adapter-'));
  const testKey = 'pi-fixture-key-never-print';
  const child = spawn(process.execPath, [join(projectRoot, 'deploy/linux-desktop/pi-adapter.mjs')], {
    cwd: projectRoot,
    env: { ...process.env, DOTS_MODEL_API_KEY: '', DOTS_PI_ADAPTER_TEST_DIAGNOSTICS: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-20_000); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2_000); });
  try {
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolvePromise => child.once('close', (code, signal) => resolvePromise({ code, signal })));
    child.stdin.end(JSON.stringify({
      engine: 'pi',
      taskId: '77777777-7777-4777-8777-777777777777',
      cwd: workspace,
      executionMode: 'proactive-research',
      prompt: '只比较已提供的两个日期，使用中文返回 JSON。',
      sessionId: null,
      modelConfig: { apiKey: testKey, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'pi-fixture-model' },
    }));
    const result = await exit;
    assert.equal(result.code, 0, `Pi adapter exited unexpectedly (${result.signal || 'no signal'}; model requests=${requests.length}): ${stderr}`);
    const decision = JSON.parse(stdout) as { status: string; message: string; proactiveFinding: boolean; sessionId: string };
    assert.equal(decision.status, 'done');
    assert.match(decision.message, /日期冲突/);
    assert.equal(decision.proactiveFinding, true);
    assert(decision.sessionId);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].authorization, `Bearer ${testKey}`);
    assert.equal(requests[0].model, 'pi-fixture-model');
    assert.equal(requests[0].stream, true, 'Pi uses streaming Chat Completions in the cloud runtime.');
    assert.match(requests[0].prompt, /只比较已提供的两个日期/);
    assert.deepEqual(requests[0].tools, [], 'Pi proactive review must expose no tools to the model.');
    assert.doesNotMatch(`${stdout}\n${stderr}`, new RegExp(testKey));
    const sessions = await readdir(join(workspace, '.coke-dots', 'pi-sessions'));
    assert(sessions.some(file => file.endsWith('.jsonl')), 'Pi session must be persisted inside this task workspace.');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(workspace, { recursive: true, force: true });
    await new Promise<void>(resolvePromise => modelServer.close(() => resolvePromise()));
  }
});
