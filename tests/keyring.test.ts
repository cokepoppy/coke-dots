import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Entry } from '../src/server/keyring.ts';

test('test Keychain entries use a private temporary store and never touch the system Keychain', () => {
  const previous = { nodeEnv: process.env.NODE_ENV, keyringDirectory: process.env.DOTS_TEST_KEYRING_DIR };
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-keyring-test-'));
  process.env.NODE_ENV = 'test';
  process.env.DOTS_TEST_KEYRING_DIR = directory;
  try {
    const entry = new Entry('com.cokepoppy.coke-dots.test-keyring-unit', 'shared-model-api-key');
    assert.equal(entry.getPassword(), null);
    entry.setPassword('test-only-secret');
    assert.equal(entry.getPassword(), 'test-only-secret');
    const file = requireSingleFile(directory);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    entry.deletePassword();
    assert.equal(entry.getPassword(), null);
  } finally {
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.keyringDirectory === undefined) delete process.env.DOTS_TEST_KEYRING_DIR; else process.env.DOTS_TEST_KEYRING_DIR = previous.keyringDirectory;
    rmSync(directory, { recursive: true, force: true });
  }
});

function requireSingleFile(directory: string) {
  const files = readdirSync(directory);
  assert.equal(files.length, 1);
  return join(directory, files[0]);
}
