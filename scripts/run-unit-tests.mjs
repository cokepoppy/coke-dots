import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testFiles = readdirSync(join(root, 'tests'))
  .filter(file => file.endsWith('.test.ts'))
  .sort()
  .map(file => join(root, 'tests', file));
const keyringDirectory = mkdtempSync(join(tmpdir(), 'coke-dots-test-keyring-'));

try {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...testFiles], {
    cwd: root,
    env: {
      ...process.env,
      DOTS_KEYCHAIN_SERVICE: 'com.cokepoppy.coke-dots.test',
      DOTS_TEST_KEYRING_DIR: keyringDirectory,
    },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(keyringDirectory, { recursive: true, force: true });
}
