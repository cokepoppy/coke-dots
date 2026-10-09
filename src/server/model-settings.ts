import { Entry } from '@napi-rs/keyring';

export interface ModelSettings { baseUrl: string; model: string; hasKey: boolean }
const service = process.env.DOTS_KEYCHAIN_SERVICE || 'com.cokepoppy.coke-dots';
const stored = new Map<string, ModelSettings>();
const keychainFor = (tenantId: string) => new Entry(service, `tenant-${tenantId}-model-api-key`);
const testModelFixtureEnabled = () => process.env.NODE_ENV === 'test' && process.env.DOTS_E2E_AUTH === '1';
const mayUseEnvironmentModel = (tenantId: string) => tenantId === 'legacy' || testModelFixtureEnabled();

export function loadModelSettings(baseUrl: string | null, model: string | null, tenantId = 'legacy') {
  stored.set(tenantId, { baseUrl: baseUrl || '', model: model || '', hasKey: Boolean(readTenantKey(tenantId)) });
}

export function saveModelKey(value: string, tenantId = 'legacy') {
  if (!value.trim()) throw new Error('密钥不能为空');
  keychainFor(tenantId).setPassword(value.trim());
  const prior = stored.get(tenantId) || { baseUrl: '', model: '', hasKey: false };
  stored.set(tenantId, { ...prior, hasKey: true });
}

export function setModelMetadata(baseUrl: string, model: string, tenantId = 'legacy') {
  const prior = stored.get(tenantId) || { baseUrl: '', model: '', hasKey: false };
  stored.set(tenantId, { ...prior, baseUrl, model });
}

export function publicModelSettings(tenantId = 'legacy'): ModelSettings {
  const value = stored.get(tenantId) || { baseUrl: '', model: '', hasKey: false };
  return { ...value, hasKey: Boolean(readTenantKey(tenantId) || (mayUseEnvironmentModel(tenantId) && process.env.DOTS_MODEL_API_KEY?.trim())) };
}

export function effectiveModelConfig(tenantId = 'legacy') {
  const useEnvironment = mayUseEnvironmentModel(tenantId);
  const apiKey = readTenantKey(tenantId) || (useEnvironment ? process.env.DOTS_MODEL_API_KEY?.trim() || null : null);
  const settings = stored.get(tenantId);
  const model = settings?.model || (useEnvironment ? process.env.DOTS_MODEL?.trim() : '') || '';
  const baseUrl = settings?.baseUrl || (useEnvironment ? process.env.DOTS_MODEL_BASE_URL?.trim() : '') || 'https://api.openai.com/v1';
  return apiKey && model ? { apiKey, model, baseUrl: baseUrl.replace(/\/$/, '') } : null;
}

function readTenantKey(tenantId: string): string | null {
  try {
    const scoped = keychainFor(tenantId).getPassword();
    if (scoped) return scoped;
    if (tenantId === 'legacy') {
      const prior = new Entry(service, 'local-model-api-key').getPassword();
      if (prior) { keychainFor(tenantId).setPassword(prior); return prior; }
    }
    return null;
  } catch { return null; }
}
