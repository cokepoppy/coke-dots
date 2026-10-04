import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { effectiveModelConfig, publicModelSettings, setModelMetadata } from '../src/server/model-settings.ts';

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
    assert.equal(store.db.prepare("SELECT value FROM settings WHERE key='modelApiKey'").get(), undefined);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('environment model credential is used without appearing in public settings', () => {
  process.env.DOTS_MODEL_API_KEY = 'test-secret';
  process.env.DOTS_MODEL = 'env-model';
  try {
    setModelMetadata('https://example.com/v1', 'stored-model');
    assert.equal(effectiveModelConfig()?.model, 'env-model');
    assert.equal(effectiveModelConfig()?.apiKey, 'test-secret');
    assert.equal(JSON.stringify(publicModelSettings()).includes('test-secret'), false);
  } finally { delete process.env.DOTS_MODEL_API_KEY; delete process.env.DOTS_MODEL; }
});
