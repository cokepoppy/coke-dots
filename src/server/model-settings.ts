import { K3dModelSecretStore, type ModelSecretStatus } from './k3d-model-secret.ts';

export type ModelApiKeyStatus = 'available' | 'missing' | 'unreadable';
export interface ModelSettings {
  baseUrl: string;
  model: string;
  hasKey: boolean;
  adminTenantId: string | null;
  apiKeyStatus: ModelApiKeyStatus;
  secretStoreStatus: ModelSecretStatus;
}

const sharedSecretStore = new K3dModelSecretStore();
const testModelFixtureEnabled = () => process.env.NODE_ENV === 'test' && process.env.DOTS_E2E_AUTH === '1';
const testLegacyFixtureAllowed = (tenantId: string) => process.env.NODE_ENV === 'test' && (tenantId === 'legacy' || testModelFixtureEnabled());
let stored: ModelSettings = { baseUrl: '', model: '', hasKey: false, adminTenantId: null, apiKeyStatus: 'missing', secretStoreStatus: 'missing' };

/** Endpoint and model name are instance settings; the API credential lives in a K3D Secret. */
export function loadModelSettings(baseUrl: string | null, model: string | null, adminTenantId: string | null = null) {
  const secret = sharedSecretStore.read();
  const hasKey = Boolean(secret.value || environmentModelKey('legacy'));
  stored = { baseUrl: baseUrl || '', model: model || '', hasKey, adminTenantId, apiKeyStatus: hasKey ? 'available' : toApiStatus(secret.status), secretStoreStatus: hasKey ? 'configured' : secret.status };
}

export function saveModelKey(value: string) {
  sharedSecretStore.save(value);
  stored = { ...stored, hasKey: true, apiKeyStatus: 'available', secretStoreStatus: 'configured' };
}

export function setModelMetadata(baseUrl: string, model: string, adminTenantId: string | null = stored.adminTenantId) {
  stored = { ...stored, baseUrl, model, adminTenantId };
}

export function publicModelSettings(adminTenantId: string | null = stored.adminTenantId): ModelSettings {
  const secret = sharedSecretStore.read();
  const hasKey = Boolean(secret.value || environmentModelKey('legacy'));
  return { ...stored, hasKey, adminTenantId, apiKeyStatus: hasKey ? 'available' : toApiStatus(secret.status), secretStoreStatus: hasKey ? 'configured' : secret.status };
}

export function sharedModelApiKeyStatus(): ModelApiKeyStatus {
  if (readSharedKey() || environmentModelKey('legacy')) return 'available';
  return toApiStatus(sharedSecretStore.read().status);
}

export function effectiveModelConfig(tenantId = 'legacy') {
  const apiKey = readSharedKey() || environmentModelKey(tenantId);
  const model = stored.model || (process.env.NODE_ENV === 'test' ? process.env.DOTS_MODEL?.trim() : '') || '';
  const baseUrl = stored.baseUrl || process.env.DOTS_MODEL_BASE_URL?.trim() || 'https://api.openai.com/v1';
  return apiKey && model ? { apiKey, model, baseUrl: baseUrl.replace(/\/$/, '') } : null;
}

export function clearSharedModelSecretForTests() {
  sharedSecretStore.clearTestValue();
  stored = { baseUrl: '', model: '', hasKey: false, adminTenantId: null, apiKeyStatus: 'missing', secretStoreStatus: 'missing' };
}

function readSharedKey(): string | null {
  return sharedSecretStore.read().value;
}

function environmentModelKey(tenantId: string): string | null {
  if (!testLegacyFixtureAllowed(tenantId)) return null;
  return process.env.DOTS_MODEL_API_KEY?.trim() || null;
}

function toApiStatus(status: ModelSecretStatus): ModelApiKeyStatus {
  return status === 'unavailable' ? 'unreadable' : status === 'configured' ? 'available' : 'missing';
}
