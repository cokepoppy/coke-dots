import { Entry as NativeEntry } from '@napi-rs/keyring';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/** Keychain access for application secrets, with a disposable test-only backend. */
export class Entry {
  private readonly native: NativeEntry | null;
  private readonly testPath: string | null;

  constructor(service: string, account: string) {
    this.testPath = testKeyPath(service, account);
    this.native = this.testPath ? null : new NativeEntry(service, account);
  }

  getPassword(): string | null {
    if (!this.testPath) return this.native!.getPassword();
    try { return readFileSync(this.testPath, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  setPassword(password: string): void {
    if (!this.testPath) return this.native!.setPassword(password);
    const directory = resolve(this.testPath, '..');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const temporaryPath = `${this.testPath}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, password, { flag: 'wx', mode: 0o600 });
    renameSync(temporaryPath, this.testPath);
    chmodSync(this.testPath, 0o600);
  }

  deletePassword(): void {
    if (!this.testPath) {
      this.native!.deletePassword();
      return;
    }
    try { unlinkSync(this.testPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function testKeyPath(service: string, account: string): string | null {
  const rootValue = process.env.DOTS_TEST_KEYRING_DIR?.trim();
  if (process.env.NODE_ENV !== 'test' || !rootValue || !/(?:^|[.-])(?:test|e2e)(?:[.-]|$)/i.test(service)) return null;

  const root = resolve(rootValue);
  const fromTemp = relative(resolve(tmpdir()), root);
  if (!fromTemp || fromTemp === '.' || fromTemp.startsWith('..') || isAbsolute(fromTemp)) {
    throw new Error('DOTS_TEST_KEYRING_DIR must be a dedicated directory inside the operating-system temp directory');
  }
  const id = createHash('sha256').update(service).update('\0').update(account).digest('hex');
  return resolve(root, `${id}.secret`);
}
