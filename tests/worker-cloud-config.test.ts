import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { Worker } from '../src/server/worker.ts';
import type { ComputerRuntime } from '../src/server/computer.ts';

async function runCloudConfigPreflight(keyringMode: 'memory' | 'unavailable') {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-cloud-model-config-'));
  const envKeys = ['NODE_ENV', 'DOTS_E2E_AUTH', 'DOTS_MODEL_BASE_URL', 'DOTS_MODEL', 'DOTS_MODEL_API_KEY', 'DOTS_COMPUTER_BACKEND', 'DOTS_DESKTOP_AGENT_ADAPTERS', 'DOTS_AGENT_KERNELS_JSON', 'DOTS_KEYCHAIN_SERVICE', 'DOTS_TEST_KEYRING'] as const;
  const previous = new Map(envKeys.map(key => [key, process.env[key]]));
  for (const key of ['DOTS_MODEL_BASE_URL', 'DOTS_MODEL', 'DOTS_MODEL_API_KEY'] as const) delete process.env[key];
  process.env.NODE_ENV = 'test';
  process.env.DOTS_E2E_AUTH = '0';
  process.env.DOTS_COMPUTER_BACKEND = 'linux-desktop';
  process.env.DOTS_DESKTOP_AGENT_ADAPTERS = 'pi';
  process.env.DOTS_AGENT_KERNELS_JSON = JSON.stringify({ pi: { command: '/bin/false', args: [] } });
  process.env.DOTS_KEYCHAIN_SERVICE = `com.cokepoppy.coke-dots.test.${randomUUID()}`;
  process.env.DOTS_TEST_KEYRING = keyringMode;

  const store = new Store(directory);
  const account = store.signInGoogle({ subject: `cloud-config-${randomUUID()}`, email: 'cloud-config@example.test', name: 'Test Dot' });
  store.setSetting('sharedModelBaseUrl', 'https://api.deepseek.com', 'legacy');
  store.setSetting('sharedModelName', 'deepseek-flash', 'legacy');
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
  const result = await runCloudConfigPreflight('memory');
  assert.equal(result.task?.status, 'failed');
  assert.match(result.task?.error || '', /实例缺少API 密钥/);
  assert.equal(result.remoteDispatches, 0, 'The Agent pod must not receive a request without shared credentials');
});

test('cloud Agent tasks explain an unreadable system credential store before dispatch', async () => {
  const result = await runCloudConfigPreflight('unavailable');
  assert.equal(result.task?.status, 'failed');
  assert.match(result.task?.error || '', /系统凭据库无法读取共享 API 密钥/);
  assert.equal(result.remoteDispatches, 0, 'The Agent pod must not receive a request when Keychain access fails');
});
