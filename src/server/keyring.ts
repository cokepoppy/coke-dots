import { Entry as NativeEntry } from '@napi-rs/keyring';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const memoryEntries = new Map<string, string>();

function memoryKey(service: string, username: string) {
  return JSON.stringify([service, username]);
}

function isTestProcess() {
  return process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT !== undefined || process.argv.includes('--test');
}

function useMemoryKeyring() {
  return isTestProcess() && process.env.DOTS_TEST_KEYRING === 'memory';
}

function useUnavailableTestKeyring() {
  return isTestProcess() && process.env.DOTS_TEST_KEYRING === 'unavailable';
}

function unavailableTestKeyringError() {
  return Object.assign(new Error('Test credential store is unavailable'), { code: 'GenericFailure' });
}

function testKeyringFile() {
  const configured = process.env.DOTS_TEST_KEYRING_PATH?.trim();
  return configured ? configured : null;
}

function readTestEntries(file: string | null) {
  if (!file || !existsSync(file)) return new Map(memoryEntries);
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  return new Map(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function writeTestEntries(file: string | null, entries: Map<string, string>) {
  memoryEntries.clear();
  for (const [key, value] of entries) memoryEntries.set(key, value);
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(Object.fromEntries(entries)), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

/**
 * Use the OS credential store in production. Tests may opt into an isolated,
 * process-local backend so they never read or mutate a developer's Keychain.
 */
export class Entry {
  private readonly native?: NativeEntry;
  private readonly memory?: string;
  private readonly memoryFile: string | null;
  private readonly unavailableForTest: boolean;

  constructor(service: string, username: string) {
    if (useUnavailableTestKeyring()) {
      this.unavailableForTest = true;
      this.memoryFile = null;
      return;
    }
    this.unavailableForTest = false;
    if (useMemoryKeyring()) {
      this.memory = memoryKey(service, username);
      this.memoryFile = testKeyringFile();
    } else {
      this.memoryFile = null;
      this.native = new NativeEntry(service, username);
    }
  }

  setPassword(password: string) {
    if (this.unavailableForTest) throw unavailableTestKeyringError();
    if (this.memory !== undefined) {
      const entries = readTestEntries(this.memoryFile);
      entries.set(this.memory, password);
      writeTestEntries(this.memoryFile, entries);
      return;
    }
    this.native!.setPassword(password);
  }

  getPassword() {
    if (this.unavailableForTest) throw unavailableTestKeyringError();
    if (this.memory !== undefined) return readTestEntries(this.memoryFile).get(this.memory) ?? null;
    return this.native!.getPassword();
  }

  deletePassword() {
    if (this.unavailableForTest) throw unavailableTestKeyringError();
    if (this.memory !== undefined) {
      const entries = readTestEntries(this.memoryFile);
      const deleted = entries.delete(this.memory);
      if (deleted) writeTestEntries(this.memoryFile, entries);
      return deleted;
    }
    return this.native!.deletePassword();
  }
}
