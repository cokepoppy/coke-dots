import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { Entry } from '@napi-rs/keyring';
import { adapters, resolvePiSessionManager, resolveTenantAgentDirectory } from '../src/server/adapters.ts';
import { loadModelSettings, loadSharedModelSettings, saveModelKey, saveSharedModelKey } from '../src/server/model-settings.ts';

process.env.DOTS_KEYCHAIN_SERVICE = `${process.env.DOTS_KEYCHAIN_SERVICE?.trim() || 'com.cokepoppy.coke-dots.test'}.pi-session-${process.pid}`;
const sharedKeychainEntry = () => new Entry(process.env.DOTS_KEYCHAIN_SERVICE!, 'shared-model-api-key');

let piSdk: Parameters<typeof resolvePiSessionManager>[0] | null = null;
try {
  piSdk = await import('@mariozechner/pi-coding-agent') as unknown as Parameters<typeof resolvePiSessionManager>[0];
} catch {
  // Pi is optional; run these persistence checks whenever its adapter package is installed.
}

async function listen(server: Server) {
  await new Promise<void>((resolvePromise, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  assert(address && typeof address !== 'string');
  return address.port;
}

test('Pi session history survives reopening inside one task workspace and does not cross tenants', { skip: !piSdk }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-pi-session-'));
  const taskWorkspace = join(directory, 'tenant-a', 'task-1');
  const otherTenantWorkspace = join(directory, 'tenant-b', 'task-1');
  mkdirSync(taskWorkspace, { recursive: true });
  mkdirSync(otherTenantWorkspace, { recursive: true });
  try {
    const first = await resolvePiSessionManager(piSdk!, taskWorkspace, null);
    const sessionId = first.getSessionId();
    const sessionFile = first.getSessionFile();
    assert.ok(sessionFile);
    assert.equal(relative(realpathSync(taskWorkspace), sessionFile).startsWith('..'), false);
    assert.equal(statSync(join(taskWorkspace, '.coke-dots')).mode & 0o777, 0o700);
    assert.equal(statSync(join(taskWorkspace, '.coke-dots', 'pi-sessions')).mode & 0o777, 0o700);

    first.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Remember this task-specific detail.' }], timestamp: Date.now() });
    first.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'I will remember that detail for this task.' }], timestamp: Date.now() });

    const resumed = await resolvePiSessionManager(piSdk!, taskWorkspace, sessionId);
    assert.equal(resumed.getSessionId(), sessionId);
    const entries = resumed.getEntries() as { type?: string; message?: { content?: { text?: string }[] } }[];
    assert.ok(entries.some(entry => entry.type === 'message' && entry.message?.content?.some(content => content.text === 'Remember this task-specific detail.')));

    const recoveredWithoutDatabaseId = await resolvePiSessionManager(piSdk!, taskWorkspace, null);
    assert.equal(recoveredWithoutDatabaseId.getSessionId(), sessionId);
    await assert.rejects(resolvePiSessionManager(piSdk!, otherTenantWorkspace, sessionId), /不存在或不唯一/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Pi reuses the shared instance credential while keeping each tenant runtime isolated', { skip: !piSdk, timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'coke-dots-pi-tenant-runtime-'));
  const dataDirectory = join(root, 'data');
  const tenants = [
    { id: 'pi-tenant-alpha', key: 'pi-alpha-only-test-key' },
    { id: 'pi-tenant-beta', key: 'pi-beta-only-test-key' },
  ];
  const authHeaders: string[] = [];
  const modelServer = createServer((request, response) => {
    authHeaders.push(String(request.headers.authorization || ''));
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.match(body, /tenant runtime smoke task/);
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.end([
        `data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'tenant-model', choices: [{ index: 0, delta: { role: 'assistant', content: '{"status":"done","message":"Pi tenant runtime completed."}' }, finish_reason: null }] })}`,
        '',
        `data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'tenant-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
        '',
        'data: [DONE]',
        '',
        '',
      ].join('\n'));
    });
  });
  const previous = { enabled: process.env.DOTS_PI_ENABLED, dataDirectory: process.env.DOTS_DATA_DIR };
  const sharedEntry = sharedKeychainEntry();
  sharedEntry.deletePassword();
  try {
    const port = await listen(modelServer);
    process.env.DOTS_PI_ENABLED = '1';
    process.env.DOTS_DATA_DIR = dataDirectory;
    loadSharedModelSettings(`http://127.0.0.1:${port}/v1`, 'tenant-model');
    saveSharedModelKey('pi-shared-instance-test-key');
    for (const tenant of tenants) {
      loadModelSettings('https://tenant-override.invalid/v1', 'tenant-override-model', tenant.id);
      saveModelKey(tenant.key, tenant.id);
      const workspace = join(root, 'workspaces', tenant.id, 'task-1');
      mkdirSync(workspace, { recursive: true });
      const result = await adapters.pi.run({
        tenantId: tenant.id,
        prompt: 'tenant runtime smoke task',
        priorResult: null,
        sessionId: null,
        workspace,
        onEvent: () => {},
      });
      assert.equal(result.status, 'done');
      assert.equal(result.message, 'Pi tenant runtime completed.');
      assert.ok(result.sessionId);
      assert.equal(statSync(resolveTenantAgentDirectory(tenant.id, 'pi', dataDirectory)).mode & 0o777, 0o700);
    }
    assert.deepEqual(authHeaders, tenants.map(() => 'Bearer pi-shared-instance-test-key'), 'Every tenant uses the single instance API credential');
  } finally {
    sharedEntry.deletePassword();
    loadSharedModelSettings(null, null);
    if (previous.enabled === undefined) delete process.env.DOTS_PI_ENABLED; else process.env.DOTS_PI_ENABLED = previous.enabled;
    if (previous.dataDirectory === undefined) delete process.env.DOTS_DATA_DIR; else process.env.DOTS_DATA_DIR = previous.dataDirectory;
    for (const tenant of tenants) new Entry(process.env.DOTS_KEYCHAIN_SERVICE?.trim() || 'com.cokepoppy.coke-dots', `tenant-${tenant.id}-model-api-key`).deletePassword();
    await new Promise<void>(resolvePromise => modelServer.close(() => resolvePromise()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('Pi exposes the tenant computer public-page reader while using the shared model profile', { skip: !piSdk, timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'coke-dots-pi-browser-tool-'));
  const tenantId = 'pi-browser-tool-tenant';
  const dataDirectory = join(root, 'data');
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const authHeaders: string[] = [];
  const requests: Record<string, unknown>[] = [];
  const modelServer = createServer((request, response) => {
    authHeaders.push(String(request.headers.authorization || ''));
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body) as Record<string, unknown>;
      requests.push(payload);
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(payload.stream, true);
      if (requests.length === 1) {
        assert.match(body, /open_public_page/, 'Pi did not receive the custom browser tool definition');
        assert.match(body, /Research this public launch page/);
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        response.end([
          `data: ${JSON.stringify({ id: 'pi-browser-tool', object: 'chat.completion.chunk', created: 1, model: 'tenant-model', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-public-page', type: 'function', function: { name: 'open_public_page', arguments: JSON.stringify({ url: 'https://research-fixture.dots.test/launch' }) } }] }, finish_reason: null }] })}`,
          '',
          `data: ${JSON.stringify({ id: 'pi-browser-tool', object: 'chat.completion.chunk', created: 1, model: 'tenant-model', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}`,
          '',
          'data: [DONE]',
          '',
          '',
        ].join('\n'));
        return;
      }

      assert.equal(requests.length, 2, 'Pi should make one browser call then finish');
      assert.match(body, /Release criteria: harden session recovery\./, 'The browser result did not return to Pi');
      assert.match(body, /untrusted webpage content/);
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.end([
        `data: ${JSON.stringify({ id: 'pi-browser-tool-result', object: 'chat.completion.chunk', created: 1, model: 'tenant-model', choices: [{ index: 0, delta: { role: 'assistant', content: '{"status":"done","message":"The launch page requires hardened session recovery. Source: https://research-fixture.dots.test/launch"}' }, finish_reason: null }] })}`,
        '',
        `data: ${JSON.stringify({ id: 'pi-browser-tool-result', object: 'chat.completion.chunk', created: 1, model: 'tenant-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
        '',
        'data: [DONE]',
        '',
        '',
      ].join('\n'));
    });
  });
  const previous = { enabled: process.env.DOTS_PI_ENABLED, dataDirectory: process.env.DOTS_DATA_DIR };
  const sharedEntry = sharedKeychainEntry();
  sharedEntry.deletePassword();
  const eventMessages: string[] = [];
  let pageReads = 0;
  try {
    const port = await listen(modelServer);
    process.env.DOTS_PI_ENABLED = '1';
    process.env.DOTS_DATA_DIR = dataDirectory;
    loadSharedModelSettings(`http://127.0.0.1:${port}/v1`, 'tenant-model');
    saveSharedModelKey('pi-browser-shared-instance-test-key');
    loadModelSettings('https://tenant-override.invalid/v1', 'tenant-override-model', tenantId);
    saveModelKey('pi-browser-tool-tenant-only-key', tenantId);
    const result = await adapters.pi.run({
      tenantId,
      prompt: 'Research this public launch page',
      priorResult: null,
      sessionId: null,
      workspace,
      onEvent: message => eventMessages.push(message),
      openPublicPage: async (url, signal) => {
        pageReads += 1;
        assert.equal(url, 'https://research-fixture.dots.test/launch');
        assert.equal(signal?.aborted, false);
        return { url, title: 'Launch notes', text: 'Release criteria: harden session recovery.' };
      },
    });
    assert.equal(result.status, 'done');
    assert.match(result.message, /hardened session recovery/);
    assert.equal(pageReads, 1, 'Pi should execute one read-only public page lookup');
    assert.equal(requests.length, 2, 'Pi should send the page evidence in its follow-up model turn');
    assert.deepEqual(authHeaders, ['Bearer pi-browser-shared-instance-test-key', 'Bearer pi-browser-shared-instance-test-key']);
    assert.ok(eventMessages.includes('Dot 正在自己的电脑浏览器中读取公开网页。'));
  } finally {
    sharedEntry.deletePassword();
    loadSharedModelSettings(null, null);
    if (previous.enabled === undefined) delete process.env.DOTS_PI_ENABLED; else process.env.DOTS_PI_ENABLED = previous.enabled;
    if (previous.dataDirectory === undefined) delete process.env.DOTS_DATA_DIR; else process.env.DOTS_DATA_DIR = previous.dataDirectory;
    new Entry(process.env.DOTS_KEYCHAIN_SERVICE?.trim() || 'com.cokepoppy.coke-dots', `tenant-${tenantId}-model-api-key`).deletePassword();
    await new Promise<void>(resolvePromise => modelServer.close(() => resolvePromise()));
    rmSync(root, { recursive: true, force: true });
  }
});

test('Pi refuses to guess when a task workspace contains multiple sessions but has no stored ID', { skip: !piSdk }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'coke-dots-pi-ambiguous-'));
  try {
    const first = await resolvePiSessionManager(piSdk!, workspace, null);
    const sessionDir = join(workspace, '.coke-dots', 'pi-sessions');
    first.appendMessage({ role: 'user', content: [{ type: 'text', text: 'First task turn.' }], timestamp: Date.now() });
    first.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'First task response.' }], timestamp: Date.now() });
    const second = piSdk!.SessionManager.create(workspace, sessionDir);
    second.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Second task turn.' }], timestamp: Date.now() });
    second.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Second task response.' }], timestamp: Date.now() });
    await assert.rejects(resolvePiSessionManager(piSdk!, workspace, null), /多个会话/);
    assert.ok(first.getSessionFile());
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Pi rejects a state-directory symlink escaping the task workspace before changing its target', { skip: !piSdk }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-pi-symlink-'));
  const workspace = join(directory, 'tenant-a', 'task-1');
  const otherTenantState = join(directory, 'tenant-b', 'state');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(otherTenantState, { recursive: true });
  const modeBefore = statSync(otherTenantState).mode & 0o777;
  symlinkSync(otherTenantState, join(workspace, '.coke-dots'), 'dir');
  try {
    await assert.rejects(resolvePiSessionManager(piSdk!, workspace, null), /状态目录超出当前任务工作区/);
    assert.equal(statSync(otherTenantState).mode & 0o777, modeBefore);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Pi rejects a session-directory symlink escaping the task state root before changing its target', { skip: !piSdk }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-pi-session-symlink-'));
  const workspace = join(directory, 'tenant-a', 'task-1');
  const otherTenantSessions = join(directory, 'tenant-b', 'sessions');
  mkdirSync(join(workspace, '.coke-dots'), { recursive: true });
  mkdirSync(otherTenantSessions, { recursive: true });
  const modeBefore = statSync(otherTenantSessions).mode & 0o777;
  symlinkSync(otherTenantSessions, join(workspace, '.coke-dots', 'pi-sessions'), 'dir');
  try {
    await assert.rejects(resolvePiSessionManager(piSdk!, workspace, null), /会话目录超出当前任务状态目录/);
    assert.equal(statSync(otherTenantSessions).mode & 0o777, modeBefore);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
