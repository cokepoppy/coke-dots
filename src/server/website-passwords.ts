import { randomUUID } from 'node:crypto';
import { Entry } from '@napi-rs/keyring';
import type { SavedWebsiteLogin } from '../shared/types.ts';
import { Store } from './store.ts';

interface SecretEntry {
  getPassword(): string | null;
  setPassword(value: string): void;
  deletePassword(): boolean;
}

function normalizeHost(value: string) {
  const hostname = value.trim().toLowerCase();
  if (!hostname || hostname.length > 253 || /[\s/@?#]/.test(hostname)) throw new Error('网站地址无效');
  const parsed = new URL(`https://${hostname}`);
  if (parsed.hostname !== hostname || parsed.port || parsed.pathname !== '/') throw new Error('网站地址无效');
  return hostname;
}

function keychainService() {
  return process.env.DOTS_KEYCHAIN_SERVICE?.trim() || 'com.cokepoppy.coke-dots';
}

export class WebsitePasswordVault {
  constructor(
    private readonly store: Store,
    private readonly entryFor: (account: string) => SecretEntry = account => new Entry(keychainService(), account),
  ) {}

  list(userId: string, hostname: string): SavedWebsiteLogin[] {
    return this.store.savedWebsiteLogins(userId, normalizeHost(hostname));
  }

  async save(userId: string, hostnameValue: string, usernameValue: string, password: string) {
    const hostname = normalizeHost(hostnameValue);
    const username = usernameValue.trim();
    if (!username || username.length > 320 || /[\x00-\x1f\x7f]/.test(username)) throw new Error('登录账号格式无效');
    if (!password || password.length > 4096 || password.includes('\0')) throw new Error('密码格式无效');

    const prior = this.store.savedWebsiteLogins(userId, hostname).find(item => item.username === username);
    const priorRecord = prior ? this.store.savedWebsiteLogin(userId, prior.id) : null;
    const keychainAccount = priorRecord?.keychainAccount || `website-login-${userId}-${randomUUID()}`;
    const entry = this.entryFor(keychainAccount);
    entry.setPassword(password);
    try {
      const saved = this.store.saveWebsiteLoginMetadata(userId, hostname, username, keychainAccount, prior?.id);
      return publicMetadata(saved);
    } catch (error) {
      if (!priorRecord) {
        try { entry.deletePassword(); } catch { /* Retain no metadata; an unreferenced OS keychain item cannot be addressed by the app. */ }
      }
      throw error;
    }
  }

  loadForUse(userId: string, id: string, requestedHostname: string): { username: string; password: string } | null {
    const saved = this.store.savedWebsiteLogin(userId, id);
    if (!saved || saved.hostname !== normalizeHost(requestedHostname)) return null;
    const password = this.entryFor(saved.keychainAccount).getPassword();
    return password ? { username: saved.username, password } : null;
  }

  async forget(userId: string, id: string) {
    const saved = this.store.savedWebsiteLogin(userId, id);
    if (!saved) return false;
    this.entryFor(saved.keychainAccount).deletePassword();
    this.store.deleteWebsiteLoginMetadata(userId, id);
    return true;
  }
}

function publicMetadata(saved: SavedWebsiteLogin): SavedWebsiteLogin {
  return { id: saved.id, hostname: saved.hostname, username: saved.username, createdAt: saved.createdAt, updatedAt: saved.updatedAt };
}
