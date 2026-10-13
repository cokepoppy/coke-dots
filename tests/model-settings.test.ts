import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Entry } from '../src/server/keyring.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { effectiveModelConfig, loadModelSettings, migrateTenantModelKey, publicModelSettings, setModelMetadata } from '../src/server/model-settings.ts';

const keychainService = () => process.env.DOTS_KEYCHAIN_SERVICE || 'com.cokepoppy.coke-dots.test';
const sharedEntry = () => new Entry(keychainService(), 'shared-model-api-key');
const tenantEntry = (tenantId: string) => new Entry(keychainService(), `tenant-${tenantId}-model-api-key`);
const localEntry = () => new Entry(keychainService(), 'local-model-api-key');
function deletePassword(entry: Entry) { try { entry.deletePassword(); } catch { /* Isolated test service may not contain this item. */ } }

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

test('environment model configuration is shared across tenants and secrets stay private', () => {
  const old = { nodeEnv: process.env.NODE_ENV, e2e: process.env.DOTS_E2E_AUTH, key: process.env.DOTS_MODEL_API_KEY, model: process.env.DOTS_MODEL, baseUrl: process.env.DOTS_MODEL_BASE_URL };
  process.env.NODE_ENV = 'test'; process.env.DOTS_E2E_AUTH = '1';
  process.env.DOTS_MODEL_API_KEY = 'test-secret'; process.env.DOTS_MODEL = 'env-model'; process.env.DOTS_MODEL_BASE_URL = 'https://example.com/v1';
  try {
    setModelMetadata('', '');
    assert.deepEqual(effectiveModelConfig('alpha-workspace'), effectiveModelConfig('beta-workspace'));
    assert.equal(effectiveModelConfig('beta-workspace')?.apiKey, 'test-secret');
    assert.equal(effectiveModelConfig('beta-workspace')?.model, 'env-model');
    assert.equal(JSON.stringify(publicModelSettings()).includes('test-secret'), false);
    process.env.DOTS_E2E_AUTH = '0';
    assert.equal(effectiveModelConfig('alpha-workspace'), null, 'Test fixture credentials require the E2E gate for every tenant');
  } finally {
    for (const [key, value] of [['NODE_ENV', old.nodeEnv], ['DOTS_E2E_AUTH', old.e2e], ['DOTS_MODEL_API_KEY', old.key], ['DOTS_MODEL', old.model], ['DOTS_MODEL_BASE_URL', old.baseUrl]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('tenant-scoped key migrates once to a shared Keychain entry and serves other tenants', () => {
  const sourceTenant = `migration-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sourceEntry = tenantEntry(sourceTenant);
  const missingTenant = `migration-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const globalEntry = sharedEntry();
  const old = { nodeEnv: process.env.NODE_ENV, e2e: process.env.DOTS_E2E_AUTH, key: process.env.DOTS_MODEL_API_KEY, model: process.env.DOTS_MODEL, baseUrl: process.env.DOTS_MODEL_BASE_URL };
  deletePassword(globalEntry);
  deletePassword(sourceEntry);
  process.env.NODE_ENV = 'test'; process.env.DOTS_E2E_AUTH = '0';
  delete process.env.DOTS_MODEL_API_KEY; delete process.env.DOTS_MODEL; delete process.env.DOTS_MODEL_BASE_URL;
  try {
    sourceEntry.setPassword('temporary-migration-test-key');
    assert.equal(effectiveModelConfig(sourceTenant), null, 'Legacy tenant keys are not silently consulted as fallbacks');
    assert.equal(migrateTenantModelKey([missingTenant, sourceTenant]), sourceTenant, 'The migration skips workspaces without a Keychain entry and records the workspace that held the shared key');
    loadModelSettings('https://example.com/v1', 'migration-model', sourceTenant);
    const alphaConfig = effectiveModelConfig('alpha-tenant');
    const betaConfig = effectiveModelConfig('beta-tenant');
    assert(alphaConfig && betaConfig);
    assert.deepEqual(betaConfig, alphaConfig, 'A second tenant must receive the same endpoint, model, and credential');
    assert.equal(alphaConfig.apiKey, 'temporary-migration-test-key');
    assert.equal(publicModelSettings().adminTenantId, sourceTenant);
    assert.equal(JSON.stringify(publicModelSettings()).includes('temporary-migration-test-key'), false);
    assert.equal(migrateTenantModelKey([sourceTenant]), null, 'The migration is idempotent once a shared key exists');
  } finally {
    deletePassword(sourceEntry); deletePassword(globalEntry);
    for (const [key, value] of [['NODE_ENV', old.nodeEnv], ['DOTS_E2E_AUTH', old.e2e], ['DOTS_MODEL_API_KEY', old.key], ['DOTS_MODEL', old.model], ['DOTS_MODEL_BASE_URL', old.baseUrl]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('the pre-tenant local Keychain entry migrates to the shared entry', () => {
  const globalEntry = sharedEntry();
  const oldEntry = localEntry();
  const old = { nodeEnv: process.env.NODE_ENV, key: process.env.DOTS_MODEL_API_KEY, model: process.env.DOTS_MODEL, baseUrl: process.env.DOTS_MODEL_BASE_URL };
  deletePassword(globalEntry); deletePassword(oldEntry);
  process.env.NODE_ENV = 'test';
  delete process.env.DOTS_MODEL_API_KEY; delete process.env.DOTS_MODEL; delete process.env.DOTS_MODEL_BASE_URL;
  try {
    oldEntry.setPassword('legacy-local-key');
    assert.equal(migrateTenantModelKey(['legacy']), null, 'Legacy single-user keys have no tenant administrator owner');
    loadModelSettings('https://example.com/v1', 'legacy-model');
    assert.equal(effectiveModelConfig('any-tenant')?.apiKey, 'legacy-local-key');
  } finally {
    deletePassword(globalEntry); deletePassword(oldEntry);
    for (const [key, value] of [['NODE_ENV', old.nodeEnv], ['DOTS_MODEL_API_KEY', old.key], ['DOTS_MODEL', old.model], ['DOTS_MODEL_BASE_URL', old.baseUrl]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
