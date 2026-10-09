import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { effectiveModelConfig, loadModelSettings, publicModelSettings, setModelMetadata } from '../src/server/model-settings.ts';

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

test('environment model credential is used without appearing in public settings', () => {
  const original = {
    nodeEnv: process.env.NODE_ENV,
    e2eAuth: process.env.DOTS_E2E_AUTH,
    apiKey: process.env.DOTS_MODEL_API_KEY,
    model: process.env.DOTS_MODEL,
  };
  const tenantId = `isolated-env-model-test-${process.pid}`;
  process.env.NODE_ENV = 'test';
  process.env.DOTS_E2E_AUTH = '1';
  process.env.DOTS_MODEL_API_KEY = 'test-secret';
  process.env.DOTS_MODEL = 'env-model';
  try {
    setModelMetadata('https://example.com/v1', '', tenantId);
    assert.equal(effectiveModelConfig(tenantId)?.model, 'env-model');
    assert.equal(effectiveModelConfig(tenantId)?.apiKey, 'test-secret');
    assert.equal(JSON.stringify(publicModelSettings(tenantId)).includes('test-secret'), false);
  } finally {
    for (const [key, value] of [['NODE_ENV', original.nodeEnv], ['DOTS_E2E_AUTH', original.e2eAuth], ['DOTS_MODEL_API_KEY', original.apiKey], ['DOTS_MODEL', original.model]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('the shared E2E model fixture can serve disposable test tenants without writing a key to Keychain', () => {
  const old = { nodeEnv: process.env.NODE_ENV, e2eAuth: process.env.DOTS_E2E_AUTH, baseUrl: process.env.DOTS_MODEL_BASE_URL, model: process.env.DOTS_MODEL, apiKey: process.env.DOTS_MODEL_API_KEY };
  const tenantId = 'disposable-e2e-model-tenant';
  process.env.NODE_ENV = 'test'; process.env.DOTS_E2E_AUTH = '1';
  process.env.DOTS_MODEL_BASE_URL = 'http://127.0.0.1:43191/v1'; process.env.DOTS_MODEL = 'fixture-model'; process.env.DOTS_MODEL_API_KEY = 'fixture-only-key';
  try {
    loadModelSettings(null, null, tenantId);
    assert.deepEqual(effectiveModelConfig(tenantId), { apiKey: 'fixture-only-key', model: 'fixture-model', baseUrl: 'http://127.0.0.1:43191/v1' });
    assert.equal(publicModelSettings(tenantId).hasKey, true);
    process.env.DOTS_E2E_AUTH = '0';
    assert.equal(effectiveModelConfig(tenantId), null, 'The test-only model must not be available without the E2E auth fixture');
  } finally {
    for (const [key, value] of [['NODE_ENV', old.nodeEnv], ['DOTS_E2E_AUTH', old.e2eAuth], ['DOTS_MODEL_BASE_URL', old.baseUrl], ['DOTS_MODEL', old.model], ['DOTS_MODEL_API_KEY', old.apiKey]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
