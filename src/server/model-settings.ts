import { K3dModelSecretStore, type ModelSecretStatus } from './k3d-model-secret.ts';

export interface ModelSettings {
  baseUrl: string;
  model: string;
  hasKey: boolean;
  secretStoreStatus: ModelSecretStatus;
}

const sharedSecretStore = new K3dModelSecretStore();
const stored = new Map<string, ModelSettings>();
const environmentModelAllowed = (tenantId: string) => process.env.NODE_ENV === 'test' && (tenantId === 'legacy' || process.env.DOTS_E2E_AUTH === '1');
const environmentMetadataAllowed = (tenantId: string) => process.env.NODE_ENV !== 'test' || environmentModelAllowed(tenantId);

/** Load the instance-wide model profile. The API credential lives in a K3D Secret. */
export function loadSharedModelSettings(baseUrl: string | null, model: string | null) {
  const secret = sharedSecretStore.read();
  const environmentKey = environmentModelAllowed('legacy') ? process.env.DOTS_MODEL_API_KEY?.trim() : '';
  stored.set('shared', {
    baseUrl: baseUrl || '',
    model: model || '',
    hasKey: Boolean(secret.value || environmentKey),
    secretStoreStatus: secret.value || environmentKey ? 'configured' : secret.status,
  });
}

/** Retain tenant metadata loading for database compatibility; tenant keys are no longer read. */
export function loadModelSettings(baseUrl: string | null, model: string | null, tenantId = 'legacy') {
  stored.set(tenantId, { baseUrl: baseUrl || '', model: model || '', hasKey: false, secretStoreStatus: sharedSecretStore.read().status });
}

export function saveSharedModelKey(value: string) {
  sharedSecretStore.save(value);
  const prior = stored.get('shared') || { baseUrl: '', model: '', hasKey: false, secretStoreStatus: 'missing' as const };
  stored.set('shared', { ...prior, hasKey: true, secretStoreStatus: 'configured' });
}

export function setSharedModelMetadata(baseUrl: string, model: string) {
  const prior = stored.get('shared') || { baseUrl: '', model: '', hasKey: Boolean(readSharedKey()), secretStoreStatus: sharedSecretStore.read().status };
  stored.set('shared', { ...prior, baseUrl, model });
}

export function setModelMetadata(baseUrl: string, model: string, tenantId = 'legacy') {
  const prior = stored.get(tenantId) || { baseUrl: '', model: '', hasKey: false, secretStoreStatus: sharedSecretStore.read().status };
  stored.set(tenantId, { ...prior, baseUrl, model });
}

export function publicModelSettings(tenantId = 'legacy'): ModelSettings {
  const config = effectiveModelConfig(tenantId);
  if (config) return { baseUrl: config.baseUrl, model: config.model, hasKey: true, secretStoreStatus: 'configured' };
  const shared = sharedSettings(tenantId);
  return {
    baseUrl: shared.baseUrl,
    model: shared.model,
    hasKey: false,
    secretStoreStatus: shared.secretStoreStatus,
  };
}

export function missingModelSettings(tenantId = 'legacy') {
  const shared = sharedSettings(tenantId);
  const apiKey = readSharedKey() || (environmentModelAllowed(tenantId) ? process.env.DOTS_MODEL_API_KEY?.trim() : '');
  return [
    ...(!apiKey ? [shared.secretStoreStatus === 'unavailable' ? 'K3D Secret' : 'API 密钥'] : []),
    ...(!shared.model ? ['模型名称'] : []),
  ];
}

/** Model API requests resolve the same instance-wide Secret for every tenant. */
export function effectiveModelConfig(tenantId = 'legacy') {
  const shared = sharedSettings(tenantId);
  const sharedKey = readSharedKey() || (environmentModelAllowed(tenantId) ? process.env.DOTS_MODEL_API_KEY?.trim() : '') || '';
  const model = shared.model;
  const baseUrl = shared.baseUrl || 'https://api.openai.com/v1';
  return sharedKey && model ? { apiKey: sharedKey, model, baseUrl: baseUrl.replace(/\/$/, '') } : null;
}

/** Pi and DeepSeek Harness reuse the shared instance model profile. */
export function configuredInstanceModelConfig(tenantId: string) {
  return effectiveModelConfig(tenantId);
}

export function clearSharedModelSecretForTests() {
  sharedSecretStore.clearTestValue();
  stored.delete('shared');
}

function sharedSettings(tenantId = 'legacy'): ModelSettings {
  const loaded = stored.get('shared') || { baseUrl: '', model: '', hasKey: false, secretStoreStatus: sharedSecretStore.read().status };
  const environmentAllowed = environmentModelAllowed(tenantId);
  const secret = sharedSecretStore.read();
  const environmentKey = environmentAllowed ? process.env.DOTS_MODEL_API_KEY?.trim() : '';
  return {
    baseUrl: loaded.baseUrl || (environmentMetadataAllowed(tenantId) ? process.env.DOTS_MODEL_BASE_URL?.trim() : '') || '',
    model: loaded.model || (environmentMetadataAllowed(tenantId) ? process.env.DOTS_MODEL?.trim() : '') || '',
    hasKey: Boolean(secret.value || environmentKey),
    secretStoreStatus: secret.value || environmentKey ? 'configured' : secret.status,
  };
}

function readSharedKey(): string | null {
  return sharedSecretStore.read().value;
}
