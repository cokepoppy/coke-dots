import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { Worker } from '../src/server/worker.ts';
import type { ComputerRuntime } from '../src/server/computer.ts';
import { ComputerControlOwnedByUserError } from '../src/server/computer-errors.ts';

async function runCloudConfigPreflight(keyringMode: 'missing' | 'unreadable') {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-cloud-model-config-'));
  const lockFile = join(directory, 'login-keychain-locked');
  const envKeys = ['NODE_ENV', 'DOTS_E2E_AUTH', 'DOTS_MODEL_BASE_URL', 'DOTS_MODEL', 'DOTS_MODEL_API_KEY', 'DOTS_COMPUTER_BACKEND', 'DOTS_AGENT_KERNELS_JSON', 'DOTS_KEYCHAIN_SERVICE', 'DOTS_TEST_SHARED_MODEL_KEYCHAIN_LOCK_FILE'] as const;
  const previous = new Map(envKeys.map(key => [key, process.env[key]]));
  for (const key of ['DOTS_MODEL_BASE_URL', 'DOTS_MODEL', 'DOTS_MODEL_API_KEY'] as const) delete process.env[key];
  process.env.NODE_ENV = 'test';
  process.env.DOTS_E2E_AUTH = '0';
  process.env.DOTS_COMPUTER_BACKEND = 'linux-desktop';
  process.env.DOTS_AGENT_KERNELS_JSON = JSON.stringify({ pi: { command: '/bin/false', args: [] } });
  process.env.DOTS_KEYCHAIN_SERVICE = `com.cokepoppy.coke-dots.test.${randomUUID()}`;
  if (keyringMode === 'unreadable') {
    writeFileSync(lockFile, 'simulated unavailable keychain');
    process.env.DOTS_TEST_SHARED_MODEL_KEYCHAIN_LOCK_FILE = lockFile;
  } else {
    delete process.env.DOTS_TEST_SHARED_MODEL_KEYCHAIN_LOCK_FILE;
  }

  const store = new Store(directory);
  const account = store.signInGoogle({ subject: `cloud-config-${randomUUID()}`, email: 'cloud-config@example.test', name: 'Test Dot' });
  store.setAppSetting('modelBaseUrl', 'https://api.deepseek.com/v1');
  store.setAppSetting('modelName', 'deepseek-test-model');
  const task = store.createTask('Cloud Pi config preflight', null, 'pi', account.tenant.id);
  let remoteDispatches = 0;
  const computer = {
    async runAgentTask() {
      remoteDispatches += 1;
      throw new Error('The cloud Agent runtime must not be contacted without modelConfig');
    },
  } as unknown as ComputerRuntime;
  const worker = new Worker(store, () => {}, join(directory, 'workspaces'), async () => {}, () => computer);

  try {
    await worker.tick();
    return { task: store.getTask(task.id, account.tenant.id), remoteDispatches };
  } finally {
    worker.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('cloud Agent tasks fail before dispatch when the shared Model API key is missing', async () => {
  const result = await runCloudConfigPreflight('missing');
  assert.equal(result.task?.status, 'failed');
  assert.match(result.task?.error || '', /实例尚未配置共享模型 API/);
  assert.equal(result.remoteDispatches, 0, 'The Agent pod must not receive a request without shared credentials');
});

test('cloud Agent tasks explain an unreadable system credential store before dispatch', async () => {
  const result = await runCloudConfigPreflight('unreadable');
  assert.equal(result.task?.status, 'failed');
  assert.match(result.task?.error || '', /无法读取 Coke Dots 实例共享 API 密钥/);
  assert.equal(result.remoteDispatches, 0, 'The Agent pod must not receive a request when Keychain access fails');
});

test('a cloud Agent task interrupted by computer takeover is persisted as paused and can be resumed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-computer-takeover-pause-'));
  const envKeys = ['NODE_ENV', 'DOTS_E2E_AUTH', 'DOTS_MODEL_BASE_URL', 'DOTS_MODEL', 'DOTS_MODEL_API_KEY', 'DOTS_COMPUTER_BACKEND', 'DOTS_AGENT_KERNELS_JSON', 'DOTS_KEYCHAIN_SERVICE', 'DOTS_TEST_SHARED_MODEL_KEYCHAIN_LOCK_FILE'] as const;
  const previous = new Map(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    NODE_ENV: 'test', DOTS_E2E_AUTH: '1', DOTS_MODEL_BASE_URL: 'https://api.example.test/v1', DOTS_MODEL: 'cloud-pause-test-model',
    DOTS_MODEL_API_KEY: 'cloud-pause-fixture-key', DOTS_COMPUTER_BACKEND: 'linux-desktop',
    DOTS_AGENT_KERNELS_JSON: JSON.stringify({ pi: { command: '/bin/false', args: [] } }), DOTS_KEYCHAIN_SERVICE: `com.cokepoppy.coke-dots.pause.${randomUUID()}`,
  });
  delete process.env.DOTS_TEST_SHARED_MODEL_KEYCHAIN_LOCK_FILE;
  const store = new Store(directory);
  const account = store.signInGoogle({ subject: `computer-pause-${randomUUID()}`, email: 'computer-pause@example.test', name: 'Test Dot' });
  store.setAppSetting('modelBaseUrl', 'https://api.example.test/v1');
  store.setAppSetting('modelName', 'cloud-pause-test-model');
  const task = store.createTask('Pause when computer is taken over', null, 'pi', account.tenant.id);
  let dispatches = 0;
  const computer = {
    async runAgentTask() {
      dispatches += 1;
      if (dispatches === 1) throw new ComputerControlOwnedByUserError();
      return { status: 'done', message: 'Task resumed after computer control returned.' };
    },
  } as unknown as ComputerRuntime;
  const worker = new Worker(store, () => {}, join(directory, 'workspaces'), async () => {}, () => computer);

  try {
    await worker.tick();
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && store.getTask(task.id, account.tenant.id)?.status === 'working') {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const paused = store.getTask(task.id, account.tenant.id);
    assert.equal(dispatches, 1);
    assert.equal(paused?.status, 'paused');
    assert.equal(paused?.nextRunAt, null);
    assert.equal(paused?.result, null);
    assert.match(paused?.error || '', /用户正在接管云电脑.*点击“继续”/);
    assert.equal(store.activityPage(account.tenant.id).entries.some(entry => entry.taskId === task.id && entry.body === paused?.error), true);

    store.updateTask(task.id, { status: 'queued', nextRunAt: new Date().toISOString(), error: null }, account.tenant.id);
    await worker.tick();
    const resumeDeadline = Date.now() + 2_000;
    while (Date.now() < resumeDeadline && store.getTask(task.id, account.tenant.id)?.status === 'working') {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(dispatches, 2, 'Resuming after the user returns control should dispatch the task again');
    assert.equal(store.getTask(task.id, account.tenant.id)?.status, 'done');
    assert.equal(store.getTask(task.id, account.tenant.id)?.result, 'Task resumed after computer control returned.');
  } finally {
    worker.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
