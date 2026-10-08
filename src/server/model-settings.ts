import { Entry } from '@napi-rs/keyring';

export interface ModelSettings { baseUrl: string; model: string; hasKey: boolean }
const keychainService = () => process.env.DOTS_KEYCHAIN_SERVICE?.trim() || 'com.cokepoppy.coke-dots';
const stored = new Map<string, ModelSettings>();
const keychainFor = (tenantId: string) => new Entry(keychainService(), `tenant-${tenantId}-model-api-key`);
const sharedKeychainFor = () => new Entry(keychainService(), 'shared-model-api-key');
const environmentModelAllowed = (tenantId: string) => process.env.NODE_ENV !== 'test' || tenantId === 'legacy' || (process.env.DOTS_E2E_AUTH === '1');

/** Load the Coke Dots instance-wide Model API profile. Its secret stays in Keychain. */
export function loadSharedModelSettings(baseUrl: string | null, model: string | null) {
  stored.set('shared', {
    baseUrl: baseUrl || '',
    model: model || '',
    hasKey: Boolean(readSharedKey()),
  });
}

/** Read old workspace profiles for one-time promotion into the instance profile. */
export function loadModelSettings(baseUrl: string | null, model: string | null, tenantId = 'legacy') {
  stored.set(tenantId, { baseUrl: baseUrl || '', model: model || '', hasKey: false });
}

export function saveSharedModelKey(value: string) {
  if (!value.trim()) throw new Error('密钥不能为空');
  sharedKeychainFor().setPassword(value.trim());
  const prior = stored.get('shared') || { baseUrl: '', model: '', hasKey: false };
  stored.set('shared', { ...prior, hasKey: true });
}

export function setSharedModelMetadata(baseUrl: string, model: string) {
  const prior = stored.get('shared') || { baseUrl: '', model: '', hasKey: Boolean(readSharedKey()) };
  stored.set('shared', { ...prior, baseUrl, model });
}

/** Promote an existing workspace Keychain profile when no instance default exists yet. */
export function migrateWorkspaceModelToShared(tenantId: string, baseUrl: string, model: string) {
  if (hasSharedModelKey()) return false;
  const apiKey = readTenantKey(tenantId);
  if (!apiKey || !model.trim()) return false;
  sharedKeychainFor().setPassword(apiKey);
  stored.set('shared', { baseUrl, model, hasKey: true });
  return true;
}

export function hasSharedModelKey() {
  try { return Boolean(sharedKeychainFor().getPassword() || (environmentModelAllowed('legacy') && process.env.DOTS_MODEL_API_KEY?.trim())); }
  catch { return Boolean(environmentModelAllowed('legacy') && process.env.DOTS_MODEL_API_KEY?.trim()); }
}

/** Legacy writer retained for migration coverage; runtime adapters never resolve this credential. */
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
  const config = effectiveModelConfig(tenantId);
  if (config) return { baseUrl: config.baseUrl, model: config.model, hasKey: true };
  const shared = sharedSettings(tenantId);
  return {
    baseUrl: shared.baseUrl,
    model: shared.model,
    hasKey: false,
  };
}

export function missingModelSettings(tenantId = 'legacy') {
  const envAllowed = environmentModelAllowed(tenantId);
  const apiKey = readSharedKey() || (envAllowed ? process.env.DOTS_MODEL_API_KEY?.trim() : '');
  const model = sharedSettings(tenantId).model;
  return [
    ...(!apiKey ? ['API 密钥'] : []),
    ...(!model ? ['模型名称'] : []),
  ];
}

/** Model API requests use only the shared instance profile for every tenant. */
export function effectiveModelConfig(tenantId = 'legacy') {
  const envAllowed = environmentModelAllowed(tenantId);
  const shared = sharedSettings(tenantId);
  const sharedKey = readSharedKey() || (envAllowed ? process.env.DOTS_MODEL_API_KEY?.trim() : '') || '';
  const model = shared.model;
  const baseUrl = shared.baseUrl || 'https://api.openai.com/v1';
  return sharedKey && model ? { apiKey: sharedKey, model, baseUrl: baseUrl.replace(/\/$/, '') } : null;
}

/** Pi and DeepSeek Harness reuse the shared instance model profile. */
export function configuredInstanceModelConfig(tenantId: string) {
  return effectiveModelConfig(tenantId);
}

function sharedSettings(tenantId = 'legacy'): ModelSettings {
  const loaded = stored.get('shared') || { baseUrl: '', model: '', hasKey: false };
  const envAllowed = environmentModelAllowed(tenantId);
  return {
    baseUrl: loaded.baseUrl || (envAllowed ? process.env.DOTS_MODEL_BASE_URL?.trim() : '') || '',
    model: loaded.model || (envAllowed ? process.env.DOTS_MODEL?.trim() : '') || '',
    hasKey: Boolean(readSharedKey() || (envAllowed && process.env.DOTS_MODEL_API_KEY?.trim())),
  };
}

function readSharedKey(): string | null {
  try { return sharedKeychainFor().getPassword(); }
  catch { return null; }
}

function readTenantKey(tenantId: string): string | null {
  try {
    const scoped = keychainFor(tenantId).getPassword();
    if (scoped) return scoped;
    if (tenantId === 'legacy') {
      const prior = new Entry(keychainService(), 'local-model-api-key').getPassword();
      if (prior) { keychainFor(tenantId).setPassword(prior); return prior; }
    }
    return null;
  } catch { return null; }
}
