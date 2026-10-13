import { Entry as NativeEntry } from '@napi-rs/keyring';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

let processKeychainPath: string | null = null;

function testKeychainFile(): string | null {
  if (process.env.NODE_ENV !== 'test' || process.env.DOTS_TEST_KEYCHAIN !== '1') return null;
  const configuredPath = process.env.DOTS_TEST_KEYCHAIN_FILE?.trim();
  if (configuredPath) return configuredPath;
  if (!processKeychainPath) {
    processKeychainPath = join(tmpdir(), `coke-dots-test-keychain-${process.pid}.json`);
    process.once('exit', () => { try { rmSync(processKeychainPath!, { force: true }); } catch { /* Test-only temporary data is best-effort cleanup. */ } });
  }
  return processKeychainPath;
}

function readTestEntries(path: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, string> : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export class Entry {
  constructor(private readonly service: string, private readonly account: string) {}

  private nativeEntry() { return new NativeEntry(this.service, this.account); }

  getPassword(): string | null {
    const path = testKeychainFile();
    if (!path) return this.nativeEntry().getPassword();
    return readTestEntries(path)[`${this.service}\0${this.account}`] || null;
  }

  setPassword(password: string): void {
    const path = testKeychainFile();
    if (!path) { this.nativeEntry().setPassword(password); return; }
    const entries = readTestEntries(path);
    entries[`${this.service}\0${this.account}`] = password;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(entries), { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
  }

  deletePassword(): void {
    const path = testKeychainFile();
    if (!path) { this.nativeEntry().deletePassword(); return; }
    const entries = readTestEntries(path);
    delete entries[`${this.service}\0${this.account}`];
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(entries), { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
  }
}
