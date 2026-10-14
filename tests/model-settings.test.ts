import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Entry } from '../src/server/keyring.ts';
import { Store } from '../src/server/store.ts';
import { clearSharedModelSecretForTests, configuredInstanceModelConfig, effectiveModelConfig, loadModelSettings, loadSharedModelSettings, missingModelSettings, publicModelSettings, saveSharedModelKey, setModelMetadata } from '../src/server/model-settings.ts';

process.env.DOTS_KEYCHAIN_SERVICE = `${process.env.DOTS_KEYCHAIN_SERVICE?.trim() || 'com.cokepoppy.coke-dots.test'}.model-settings-${process.pid}`;

test('model endpoint and name persist without a secret in SQLite', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-settings-'));
  try {
    let store = new Store(directory);
    store.setSetting('modelBaseUrl', 'https://example.com/v1');
    store.setSetting('modelName', 'test-model');
    store.close();
    store = new Store(directory);
    assert.equal(store.getSetting('modelBaseUrl'), 'https://example.com/v1');
    assert.equal(store.getSetting('modelName'), 'test-model');
    assert.equal(store.db.prepare("SELECT value FROM tenant_settings WHERE tenant_id='legacy' AND key='modelApiKey'").get(), undefined);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('test-only environment model credential is never returned in public settings', () => {
  const previous = { nodeEnv: process.env.NODE_ENV, apiKey: process.env.DOTS_MODEL_API_KEY, model: process.env.DOTS_MODEL };
  process.env.NODE_ENV = 'test';
  process.env.DOTS_MODEL_API_KEY = 'test-secret';
  process.env.DOTS_MODEL = 'env-model';
  try {
    clearSharedModelSecretForTests();
    loadSharedModelSettings('https://example.com/v1', '');
    assert.equal(effectiveModelConfig()?.model, 'env-model');
    assert.equal(effectiveModelConfig()?.apiKey === 'test-secret', true, 'The test fixture key should take effect without printing its value');
    assert.equal(JSON.stringify(publicModelSettings()).includes('test-secret'), false);
  } finally {
    clearSharedModelSecretForTests();
    for (const [key, value] of [['NODE_ENV', previous.nodeEnv], ['DOTS_MODEL_API_KEY', previous.apiKey], ['DOTS_MODEL', previous.model]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('the isolated E2E model fixture serves disposable tenants only when explicitly enabled', () => {
  const old = { nodeEnv: process.env.NODE_ENV, e2eAuth: process.env.DOTS_E2E_AUTH, baseUrl: process.env.DOTS_MODEL_BASE_URL, model: process.env.DOTS_MODEL, apiKey: process.env.DOTS_MODEL_API_KEY };
  const tenantId = 'disposable-e2e-model-tenant';
  process.env.NODE_ENV = 'test'; process.env.DOTS_E2E_AUTH = '1';
  process.env.DOTS_MODEL_BASE_URL = 'http://127.0.0.1:43191/v1'; process.env.DOTS_MODEL = 'fixture-model'; process.env.DOTS_MODEL_API_KEY = 'fixture-only-key';
  try {
    clearSharedModelSecretForTests();
    loadSharedModelSettings(null, null);
    loadModelSettings(null, null, tenantId);
    assert.deepEqual(effectiveModelConfig(tenantId), { apiKey: 'fixture-only-key', model: 'fixture-model', baseUrl: 'http://127.0.0.1:43191/v1' });
    assert.equal(publicModelSettings(tenantId).hasKey, true);
    process.env.DOTS_E2E_AUTH = '0';
    assert.equal(effectiveModelConfig(tenantId), null, 'The test-only model must not be available without the E2E auth fixture');
  } finally {
    clearSharedModelSecretForTests();
    for (const [key, value] of [['NODE_ENV', old.nodeEnv], ['DOTS_E2E_AUTH', old.e2eAuth], ['DOTS_MODEL_BASE_URL', old.baseUrl], ['DOTS_MODEL', old.model], ['DOTS_MODEL_API_KEY', old.apiKey]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('old workspace Keychain values do not activate a tenant model profile', () => {
  const tenantId = `missing-model-config-${randomUUID()}`;
  const service = process.env.DOTS_KEYCHAIN_SERVICE!;
  const oldTenantKey = new Entry(service, `tenant-${tenantId}-model-api-key`);
  const envKeys = ['DOTS_E2E_AUTH', 'DOTS_MODEL_BASE_URL', 'DOTS_MODEL', 'DOTS_MODEL_API_KEY'] as const;
  const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  try {
    clearSharedModelSecretForTests();
    loadSharedModelSettings(null, null);
    loadModelSettings(null, null, tenantId);
    assert.deepEqual(missingModelSettings(tenantId), ['API 密钥', '模型名称']);
    setModelMetadata('https://api.example.test/v1', 'tenant-only-model', tenantId);
    oldTenantKey.setPassword('old-tenant-keychain-test-value');
    assert.deepEqual(missingModelSettings(tenantId), ['API 密钥', '模型名称']);
    assert.equal(effectiveModelConfig(tenantId), null);
    assert.deepEqual(publicModelSettings(tenantId), { baseUrl: '', model: '', hasKey: false, secretStoreStatus: 'missing' });
  } finally {
    oldTenantKey.deletePassword();
    clearSharedModelSecretForTests();
    loadSharedModelSettings(null, null);
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('Pi and DeepSeek Harness share one K3D Secret across tenant-isolated runtimes', () => {
  const previous = { nodeEnv: process.env.NODE_ENV, e2eAuth: process.env.DOTS_E2E_AUTH, apiKey: process.env.DOTS_MODEL_API_KEY, model: process.env.DOTS_MODEL, baseUrl: process.env.DOTS_MODEL_BASE_URL };
  const alpha = `alpha-${randomUUID()}`;
  const beta = `beta-${randomUUID()}`;
  process.env.NODE_ENV = 'test'; process.env.DOTS_E2E_AUTH = '0';
  process.env.DOTS_MODEL_API_KEY = 'shared-test-fixture-key'; process.env.DOTS_MODEL = 'fixture-model'; process.env.DOTS_MODEL_BASE_URL = 'https://fixture.example.test/v1';
  try {
    clearSharedModelSecretForTests();
    loadSharedModelSettings('https://instance.example.test/v1', 'instance-model');
    loadModelSettings('https://tenant.example.test/v1', 'tenant-model', alpha);
    loadModelSettings('https://tenant.example.test/v1', 'tenant-model', beta);
    assert.equal(configuredInstanceModelConfig(alpha), null, 'Environment keys stay disabled outside the E2E auth fixture');
    saveSharedModelKey('shared-instance-key');
    assert.deepEqual(configuredInstanceModelConfig(alpha), {
      apiKey: 'shared-instance-key', model: 'instance-model', baseUrl: 'https://instance.example.test/v1',
    });
    assert.deepEqual(configuredInstanceModelConfig(beta), configuredInstanceModelConfig(alpha), 'A second tenant reuses the same instance Secret');
  } finally {
    clearSharedModelSecretForTests();
    loadSharedModelSettings(null, null);
    for (const [key, value] of [['NODE_ENV', previous.nodeEnv], ['DOTS_E2E_AUTH', previous.e2eAuth], ['DOTS_MODEL_API_KEY', previous.apiKey], ['DOTS_MODEL', previous.model], ['DOTS_MODEL_BASE_URL', previous.baseUrl]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('the instance model Secret is available to newly signed-in tenants without exposing its value', () => {
  const tenantId = `new-google-tenant-${randomUUID()}`;
  const envKeys = ['DOTS_MODEL_BASE_URL', 'DOTS_MODEL', 'DOTS_MODEL_API_KEY'] as const;
  const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  try {
    clearSharedModelSecretForTests();
    loadSharedModelSettings('https://api.shared.example.test/v1', 'shared-model');
    saveSharedModelKey('shared-secret-for-test-only');
    loadModelSettings(null, null, tenantId);
    assert.deepEqual(effectiveModelConfig(tenantId), {
      apiKey: 'shared-secret-for-test-only', model: 'shared-model', baseUrl: 'https://api.shared.example.test/v1',
    });
    assert.deepEqual(publicModelSettings(tenantId), {
      baseUrl: 'https://api.shared.example.test/v1', model: 'shared-model', hasKey: true, secretStoreStatus: 'configured',
    });
    assert.equal(JSON.stringify(publicModelSettings(tenantId)).includes('shared-secret-for-test-only'), false);
  } finally {
    clearSharedModelSecretForTests();
    loadSharedModelSettings(null, null);
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('one Google account manages the shared model profile across every tenant', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-instance-model-admin-'));
  const store = new Store(directory);
  try {
    const alpha = store.signInGoogle({ subject: 'instance-admin-alpha', email: 'alpha@example.test', name: 'Alpha' });
    const beta = store.signInGoogle({ subject: 'instance-admin-beta', email: 'beta@example.test', name: 'Beta' });
    assert.equal(store.canManageInstanceModel(alpha.user.id, alpha.tenant.id), true);
    assert.equal(store.canManageInstanceModel(beta.user.id, beta.tenant.id), true, 'Before setup, an owner can claim the instance model profile');
    assert.equal(store.claimInstanceModelManager(alpha.user.id, alpha.tenant.id), true);
    assert.equal(store.canManageInstanceModel(alpha.user.id, alpha.tenant.id), true);
    assert.equal(store.canManageInstanceModel(alpha.user.id, beta.tenant.id), true, 'Instance authority follows the Google account across tenant switches');
    assert.equal(store.canManageInstanceModel(beta.user.id, beta.tenant.id), false, 'A second personal-workspace owner cannot replace the shared model');
    assert.equal(store.claimInstanceModelManager(beta.user.id, beta.tenant.id), false);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
