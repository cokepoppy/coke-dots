import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/server/store.ts';
import { clearSharedModelSecretForTests, effectiveModelConfig, loadModelSettings, publicModelSettings, saveModelKey, setModelMetadata, sharedModelApiKeyStatus } from '../src/server/model-settings.ts';

function withSecretTest<T>(run: (directory: string) => T): T {
  const prior = Object.fromEntries(['NODE_ENV', 'DOTS_E2E_AUTH', 'DOTS_TEST_MODEL_SECRET_DIR', 'DOTS_TEST_MODEL_SECRET_SCOPE', 'DOTS_MODEL_API_KEY', 'DOTS_MODEL', 'DOTS_MODEL_BASE_URL'].map(key => [key, process.env[key]]));
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-model-settings-'));
  process.env.NODE_ENV = 'test';
  process.env.DOTS_TEST_MODEL_SECRET_DIR = directory;
  process.env.DOTS_TEST_MODEL_SECRET_SCOPE = randomUUID();
  process.env.DOTS_E2E_AUTH = '0';
  delete process.env.DOTS_MODEL_API_KEY; delete process.env.DOTS_MODEL; delete process.env.DOTS_MODEL_BASE_URL;
  clearSharedModelSecretForTests();
  try { return run(directory); }
  finally {
    clearSharedModelSecretForTests();
    rmSync(directory, { recursive: true, force: true });
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
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
    assert.equal(store.getSetting('modelBaseUrl', 'second-tenant'), null);
    assert.equal(store.db.prepare("SELECT value FROM app_settings WHERE key='modelApiKey'").get(), undefined, 'The API key must never be written to SQLite');
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the K3D Secret is shared across tenant model runtimes and never returned in public settings', () => withSecretTest(() => {
  setModelMetadata('https://api.deepseek.com/v1', 'deepseek-flash', 'admin-tenant');
  saveModelKey('shared-test-secret');
  const alpha = effectiveModelConfig('alpha-workspace');
  const beta = effectiveModelConfig('beta-workspace');
  assert.deepEqual(beta, alpha);
  assert.equal(alpha?.apiKey, 'shared-test-secret');
  assert.equal(publicModelSettings('beta-workspace').hasKey, true);
  assert.equal(publicModelSettings().adminTenantId, 'admin-tenant');
  assert.equal(publicModelSettings('beta-workspace').secretStoreStatus, 'configured');
  assert.equal(JSON.stringify(publicModelSettings()).includes('shared-test-secret'), false);
}));
test('test-only environment keys require the explicit E2E gate and stay private', () => withSecretTest(() => {
  process.env.DOTS_E2E_AUTH = '1';
  process.env.DOTS_MODEL_API_KEY = 'test-only-secret';
  process.env.DOTS_MODEL = 'env-model';
  process.env.DOTS_MODEL_BASE_URL = 'https://example.com/v1';
  loadModelSettings('', '', 'admin-tenant');
  assert.equal(effectiveModelConfig('alpha-workspace')?.apiKey, 'test-only-secret');
  assert.equal(effectiveModelConfig('beta-workspace')?.model, 'env-model');
  assert.equal(JSON.stringify(publicModelSettings()).includes('test-only-secret'), false);
  process.env.DOTS_E2E_AUTH = '0';
  assert.equal(effectiveModelConfig('alpha-workspace'), null);
}));

test('K3D Secret status distinguishes a missing Secret from an unavailable K3D store', () => withSecretTest(directory => {
  loadModelSettings('https://api.example.test/v1', 'test-model');
  assert.equal(sharedModelApiKeyStatus(), 'missing');
  assert.equal(publicModelSettings().secretStoreStatus, 'missing');
  const invalidRoot = join(directory, 'not-a-directory');
  writeFileSync(invalidRoot, 'test');
  process.env.DOTS_TEST_MODEL_SECRET_DIR = invalidRoot;
  clearSharedModelSecretForTests();
  loadModelSettings('https://api.example.test/v1', 'test-model');
  assert.equal(sharedModelApiKeyStatus(), 'unreadable');
  assert.equal(publicModelSettings().secretStoreStatus, 'unavailable');
}));
