import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { K3dModelSecretStore } from '../src/server/k3d-model-secret.ts';
import { clearSharedModelSecretForTests, effectiveModelConfig, loadModelSettings, publicModelSettings, saveModelKey, setModelMetadata, sharedModelApiKeyStatus } from '../src/server/model-settings.ts';

function withIsolatedSecret(run: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-model-secret-'));
  const keys = ['NODE_ENV', 'DOTS_E2E_AUTH', 'DOTS_MODEL_API_KEY', 'DOTS_MODEL', 'DOTS_MODEL_BASE_URL', 'DOTS_TEST_MODEL_SECRET_DIR', 'DOTS_TEST_MODEL_SECRET_SCOPE', 'DOTS_TEST_MODEL_SECRET_UNAVAILABLE_FILE'] as const;
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    NODE_ENV: 'test', DOTS_E2E_AUTH: '0', DOTS_TEST_MODEL_SECRET_DIR: directory,
    DOTS_TEST_MODEL_SECRET_SCOPE: randomUUID(),
  });
  for (const key of ['DOTS_MODEL_API_KEY', 'DOTS_MODEL', 'DOTS_MODEL_BASE_URL', 'DOTS_TEST_MODEL_SECRET_UNAVAILABLE_FILE']) delete process.env[key];
  clearSharedModelSecretForTests();
  try { run(directory); }
  finally {
    clearSharedModelSecretForTests();
    rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('shared model metadata persists at instance scope without storing the API key in SQLite', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-settings-'));
  try {
    let store = new Store(directory);
    store.setAppSetting('modelBaseUrl', 'https://example.com/v1');
    store.setAppSetting('modelName', 'test-model');
    store.setAppSetting('modelSettingsAdminTenantId', 'admin-tenant');
    store.close();
    store = new Store(directory);
    assert.equal(store.getAppSetting('modelBaseUrl'), 'https://example.com/v1');
    assert.equal(store.getAppSetting('modelName'), 'test-model');
    assert.equal(store.getAppSetting('modelSettingsAdminTenantId'), 'admin-tenant');
    assert.equal(store.getSetting('modelBaseUrl', 'second-tenant'), null, 'Shared metadata must not be copied into tenant settings');
    assert.equal(store.db.prepare("SELECT value FROM app_settings WHERE key='modelApiKey'").get(), undefined, 'The API key must never be written to SQLite');
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('K3D Secret is the instance-wide API key source for all tenants and is never returned to clients', () => withIsolatedSecret(() => {
  loadModelSettings('https://api.deepseek.com/v1', 'deepseek-test-model', 'admin-tenant');
  saveModelKey('temporary-k3d-secret-test-key');
  setModelMetadata('https://api.deepseek.com/v1', 'deepseek-test-model', 'admin-tenant');

  const alpha = effectiveModelConfig('alpha-tenant');
  const beta = effectiveModelConfig('beta-tenant');
  assert.deepEqual(beta, alpha, 'Every tenant must resolve the same shared K3D credential and model profile');
  assert.equal(alpha?.apiKey, 'temporary-k3d-secret-test-key');
  assert.equal(sharedModelApiKeyStatus(), 'available');
  assert.equal(publicModelSettings('beta-tenant').hasKey, true);
  assert.equal(JSON.stringify(publicModelSettings('beta-tenant')).includes('temporary-k3d-secret-test-key'), false);
}));

test('a transient K3D read outage keeps the last in-process credential, while a confirmed missing Secret clears it', () => withIsolatedSecret(directory => {
  loadModelSettings('https://api.shared.example.test/v1', 'shared-test-model');
  saveModelKey('temporary-k3d-cache-test-key');
  const unavailableFile = join(directory, 'kubectl-unavailable');
  process.env.DOTS_TEST_MODEL_SECRET_UNAVAILABLE_FILE = unavailableFile;
  writeFileSync(unavailableFile, 'simulate temporary K3D API outage');

  assert.equal(effectiveModelConfig('second-tenant')?.apiKey, 'temporary-k3d-cache-test-key');
  assert.equal(publicModelSettings('second-tenant').hasKey, true);

  rmSync(unavailableFile, { force: true });
  clearSharedModelSecretForTests();
  assert.equal(sharedModelApiKeyStatus(), 'missing', 'A successful read after the Secret was removed must clear the cached credential');
  assert.equal(effectiveModelConfig('second-tenant'), null);
}));

test('an unreachable K3D Secret is reported separately from a missing Secret', () => withIsolatedSecret(directory => {
  const unavailableFile = join(directory, 'not-a-directory');
  writeFileSync(unavailableFile, 'force ENOTDIR');
  process.env.DOTS_TEST_MODEL_SECRET_DIR = unavailableFile;
  clearSharedModelSecretForTests();
  assert.equal(sharedModelApiKeyStatus(), 'unavailable');
  assert.equal(publicModelSettings().hasKey, false);
}));

test('K3D Secret reads and writes use kubectl stdin and never place the credential in command arguments', () => {
  const priorNodeEnv = process.env.NODE_ENV;
  const priorNamespace = process.env.DOTS_MODEL_SECRET_NAMESPACE;
  const priorName = process.env.DOTS_MODEL_SECRET_NAME;
  process.env.NODE_ENV = 'production';
  process.env.DOTS_MODEL_SECRET_NAMESPACE = 'test-system';
  process.env.DOTS_MODEL_SECRET_NAME = 'shared-model-api';
  const commandArgs: string[][] = [];
  const manifests: string[] = [];
  let readFailure: Error | null = null;
  const runner = (args: string[], input?: string) => {
    commandArgs.push(args);
    if (args.includes('get')) {
      if (readFailure) throw readFailure;
      return Buffer.from('runner-only-test-secret').toString('base64');
    }
    if (args.includes('apply') && input) manifests.push(input);
    return '';
  };

  try {
    const secret = new K3dModelSecretStore(runner);
    secret.save('runner-only-test-secret');
    assert.equal(secret.read(true).value, 'runner-only-test-secret');
    const secretManifest = JSON.parse(manifests.at(-1) || '{}') as { kind?: string; metadata?: { namespace?: string; name?: string }; data?: { apiKey?: string } };
    assert.equal(secretManifest.kind, 'Secret');
    assert.equal(secretManifest.metadata?.namespace, 'test-system');
    assert.equal(secretManifest.metadata?.name, 'shared-model-api');
    assert.equal(Buffer.from(secretManifest.data?.apiKey || '', 'base64').toString('utf8'), 'runner-only-test-secret');
    assert(commandArgs.every(args => !args.join(' ').includes('runner-only-test-secret')), 'The raw credential must never be placed in argv');
    assert.equal(manifests.some(manifest => manifest.includes('runner-only-test-secret')), false, 'The manifest contains only the base64 encoded Secret data');

    readFailure = Object.assign(new Error('kubectl unavailable'), { stderr: Buffer.from('connection refused') });
    assert.equal(secret.read(true).status, 'configured', 'A previously read credential remains usable during a transient K3D outage');
  } finally {
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorNodeEnv;
    if (priorNamespace === undefined) delete process.env.DOTS_MODEL_SECRET_NAMESPACE; else process.env.DOTS_MODEL_SECRET_NAMESPACE = priorNamespace;
    if (priorName === undefined) delete process.env.DOTS_MODEL_SECRET_NAME; else process.env.DOTS_MODEL_SECRET_NAME = priorName;
  }
});

test('production ignores DOTS_MODEL_API_KEY environment values and requires the K3D Secret', () => {
  const priorNodeEnv = process.env.NODE_ENV;
  const priorApiKey = process.env.DOTS_MODEL_API_KEY;
  const priorModel = process.env.DOTS_MODEL;
  const priorSecretDir = process.env.DOTS_TEST_MODEL_SECRET_DIR;
  process.env.NODE_ENV = 'production';
  process.env.DOTS_MODEL_API_KEY = 'environment-key-must-not-be-used';
  process.env.DOTS_MODEL = 'environment-model';
  process.env.DOTS_TEST_MODEL_SECRET_DIR = join(tmpdir(), 'not-used-outside-tests');
  try {
    const settings = new K3dModelSecretStore(() => { const error = new Error('K3D unavailable') as Error & { stderr?: Buffer }; error.stderr = Buffer.from('connection refused'); throw error; });
    assert.equal(settings.read(true).value, null);
    assert.equal(effectiveModelConfig('production-tenant', settings), null);
  } finally {
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = priorNodeEnv;
    if (priorApiKey === undefined) delete process.env.DOTS_MODEL_API_KEY; else process.env.DOTS_MODEL_API_KEY = priorApiKey;
    if (priorModel === undefined) delete process.env.DOTS_MODEL; else process.env.DOTS_MODEL = priorModel;
    if (priorSecretDir === undefined) delete process.env.DOTS_TEST_MODEL_SECRET_DIR; else process.env.DOTS_TEST_MODEL_SECRET_DIR = priorSecretDir;
  }
});
