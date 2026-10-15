import assert from 'node:assert/strict';
import { test } from 'node:test';
import { engineAvailabilityHint } from '../src/shared/engine-availability.ts';

const configuredModel = { apiKeyStatus: 'available' as const, hasKey: true, baseUrl: 'https://api.example.test', model: 'test-model', adminTenantId: null };

test('Pi status explains a missing cloud adapter separately from a missing model credential', () => {
  assert.match(engineAvailabilityHint({ modelSettings: configuredModel, availableEngines: [], remoteEngines: [] }, 'pi'), /尚未注册 Pi Agent 适配器/);
  assert.match(engineAvailabilityHint({ modelSettings: { ...configuredModel, apiKeyStatus: 'missing', hasKey: false }, availableEngines: [], remoteEngines: [] }, 'pi'), /模型 API 尚未完整配置/);
});

test('engine status reports available local and remote execution paths', () => {
  assert.equal(engineAvailabilityHint({ modelSettings: configuredModel, availableEngines: ['pi'], remoteEngines: ['pi'] }, 'pi'), '任务由 Dot 的云电脑运行。');
  assert.equal(engineAvailabilityHint({ modelSettings: configuredModel, availableEngines: ['pi'], remoteEngines: [] }, 'pi'), '任务由本机后台处理。');
});
