import { Entry } from '@napi-rs/keyring';

export interface ModelSettings { baseUrl: string; model: string; hasKey: boolean }
const keychain = new Entry('com.cokepoppy.coke-dots', 'local-model-api-key');
let stored: ModelSettings = { baseUrl: '', model: '', hasKey: false };
let cachedKey: string | null = null;

export function loadModelSettings(baseUrl: string | null, model: string | null) {
  stored = { baseUrl: baseUrl || '', model: model || '', hasKey: false };
  try { cachedKey = keychain.getPassword(); } catch { cachedKey = null; }
  stored.hasKey = Boolean(cachedKey);
}

export function saveModelKey(value: string) {
  if (!value.trim()) throw new Error('密钥不能为空');
  keychain.setPassword(value.trim());
  cachedKey = value.trim();
  stored.hasKey = true;
}

export function setModelMetadata(baseUrl: string, model: string) {
  stored = { ...stored, baseUrl, model };
}

export function publicModelSettings(): ModelSettings {
  return { ...stored, hasKey: Boolean(process.env.DOTS_MODEL_API_KEY || cachedKey) };
}

export function effectiveModelConfig() {
  const apiKey = process.env.DOTS_MODEL_API_KEY?.trim() || cachedKey;
  const model = process.env.DOTS_MODEL?.trim() || stored.model;
  const baseUrl = process.env.DOTS_MODEL_BASE_URL?.trim() || stored.baseUrl || 'https://api.openai.com/v1';
  return apiKey && model ? { apiKey, model, baseUrl: baseUrl.replace(/\/$/, '') } : null;
}
