import { existsSync } from 'node:fs';
import { Entry } from './keyring.ts';

export type ModelApiKeyStatus = 'available' | 'missing' | 'unreadable';
export interface ModelSettings { baseUrl: string; model: string; hasKey: boolean; adminTenantId: string | null; apiKeyStatus: ModelApiKeyStatus }

const keychainService = () => process.env.DOTS_KEYCHAIN_SERVICE?.trim()
  || (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT !== undefined || process.argv.includes('--test') ? 'com.cokepoppy.coke-dots.test' : 'com.cokepoppy.coke-dots');
const sharedKeychainEntry = () => new Entry(keychainService(), 'shared-model-api-key');
const tenantKeychainEntry = (tenantId: string) => new Entry(keychainService(), `tenant-${tenantId}-model-api-key`);
const legacyKeychainEntry = () => new Entry(keychainService(), 'local-model-api-key');
const testModelFixtureEnabled = () => process.env.NODE_ENV === 'test' && process.env.DOTS_E2E_AUTH === '1';

let stored: ModelSettings = { baseUrl: '', model: '', hasKey: false, adminTenantId: null, apiKeyStatus: 'missing' };
const lastReadableSharedKeys = new Map<string, string>();
const unreadableSharedKeychains = new Set<string>();

/** Endpoint, model name, and API credential are shared by all Coke Dots tenants. */
export function loadModelSettings(baseUrl: string | null, model: string | null, adminTenantId: string | null = null) {
  const apiKeyStatus = sharedModelApiKeyStatus();
  stored = { baseUrl: baseUrl || '', model: model || '', hasKey: apiKeyStatus === 'available', adminTenantId, apiKeyStatus };
}

/** Migrate one existing tenant-scoped credential to the instance Keychain entry. */
export function migrateTenantModelKey(tenantIds: readonly string[]): string | null {
  if (readSharedKey()) return null;
  for (const tenantId of [...new Set(tenantIds)]) {
    if (!tenantId) continue;
    let key: string | null = null;
    try { key = tenantKeychainEntry(tenantId).getPassword() || null; }
    catch { continue; }
    if (!key) continue;
    try {
      sharedKeychainEntry().setPassword(key);
      lastReadableSharedKeys.set(keychainService(), key);
      return tenantId === 'legacy' ? null : tenantId;
    } catch {
      // A locked or unavailable Keychain leaves the shared model unavailable until it is configured.
      return null;
    }
  }
  try {
    const legacyKey = legacyKeychainEntry().getPassword();
    if (legacyKey) {
      sharedKeychainEntry().setPassword(legacyKey);
      lastReadableSharedKeys.set(keychainService(), legacyKey);
    }
  } catch { /* A missing legacy entry is expected on new installations. */ }
  return null;
}

export function saveModelKey(value: string) {
  if (!value.trim()) throw new Error('密钥不能为空');
  const key = value.trim();
  sharedKeychainEntry().setPassword(key);
  lastReadableSharedKeys.set(keychainService(), key);
  unreadableSharedKeychains.delete(keychainService());
  stored = { ...stored, hasKey: true, apiKeyStatus: 'available' };
}

export function setModelMetadata(baseUrl: string, model: string, adminTenantId: string | null = stored.adminTenantId) {
  stored = { ...stored, baseUrl, model, adminTenantId };
}

export function publicModelSettings(adminTenantId: string | null = stored.adminTenantId): ModelSettings {
  const apiKeyStatus = sharedModelApiKeyStatus();
  return { ...stored, hasKey: apiKeyStatus === 'available', apiKeyStatus, adminTenantId };
}

export function sharedModelApiKeyStatus(): ModelApiKeyStatus {
  if (readSharedKey() || environmentModelKey()) return 'available';
  return unreadableSharedKeychains.has(keychainService()) ? 'unreadable' : 'missing';
}

export function effectiveModelConfig(_tenantId = 'legacy') {
  const apiKey = readSharedKey() || environmentModelKey();
  const model = stored.model || process.env.DOTS_MODEL?.trim() || '';
  const baseUrl = stored.baseUrl || process.env.DOTS_MODEL_BASE_URL?.trim() || 'https://api.openai.com/v1';
  return apiKey && model ? { apiKey, model, baseUrl: baseUrl.replace(/\/$/, '') } : null;
}

function environmentModelKey(): string | null {
  const value = process.env.DOTS_MODEL_API_KEY?.trim();
  return value && (process.env.NODE_ENV !== 'test' || testModelFixtureEnabled()) ? value : null;
}

function readSharedKey(): string | null {
  const service = keychainService();
  try {
    // Browser E2E can simulate a locked Keychain without changing the host login Keychain.
    const simulatedLockFile = process.env.DOTS_TEST_SHARED_MODEL_KEYCHAIN_LOCK_FILE?.trim();
    if (process.env.NODE_ENV === 'test' && simulatedLockFile && existsSync(simulatedLockFile)) {
      throw new Error('Simulated unavailable shared Model API Keychain');
    }
    const value = new Entry(service, 'shared-model-api-key').getPassword() || null;
    unreadableSharedKeychains.delete(service);
    if (value) lastReadableSharedKeys.set(service, value);
    else lastReadableSharedKeys.delete(service);
    return value;
  } catch {
    unreadableSharedKeychains.add(service);
    // macOS can temporarily make the login Keychain unreadable while it is locked.
    // Retain only the last value read or saved successfully in this service process.
    return lastReadableSharedKeys.get(service) || null;
  }
}
