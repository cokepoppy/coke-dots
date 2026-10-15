import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
const baseEnvironment = {
  ...process.env,
  NODE_ENV: 'test',
  DOTS_E2E_AUTH: '1',
};

function createIsolatedEnvironment() {
  const testKeyringDirectory = mkdtempSync(join(tmpdir(), 'coke-dots-test-keyring-'));
  const testModelSecretDirectory = mkdtempSync(join(tmpdir(), 'coke-dots-test-model-secret-'));
  return {
    testKeyringDirectory,
    testModelSecretDirectory,
    environment: {
      ...baseEnvironment,
      DOTS_KEYCHAIN_SERVICE: `com.cokepoppy.coke-dots.test-${randomBytes(8).toString('hex')}`,
      DOTS_TEST_KEYRING_DIR: testKeyringDirectory,
      DOTS_TEST_MODEL_SECRET_DIR: testModelSecretDirectory,
      DOTS_TEST_MODEL_SECRET_SCOPE: randomBytes(8).toString('hex'),
    },
  };
}

const testFiles = readdirSync(join(projectRoot, 'tests'))
  .filter(file => file.endsWith('.test.ts') || file.endsWith('.test.mjs'))
  .sort()
  .map(file => join('tests', file));

let commands;
if (mode === 'unit') {
  commands = [[process.execPath, ['--import', 'tsx', '--import', './tests/test-keyring-scope.ts', '--test', ...testFiles]]];
} else if (mode === 'e2e') {
  commands = [
    [process.execPath, ['--import', 'tsx', 'tests/e2e/ui.e2e.ts']],
    [process.execPath, ['--import', 'tsx', 'tests/e2e/cloud-computer.e2e.ts']],
  ];
} else if (mode === 'cloud-computer') {
  commands = [[process.execPath, ['--import', 'tsx', 'tests/e2e/cloud-computer.e2e.ts']]];
} else if (mode === 'demo-path') {
  commands = [[process.execPath, ['--import', 'tsx', 'tests/e2e/base-path-auth.e2e.ts']]];
} else {
  console.error('Usage: node scripts/run-isolated-tests.mjs <unit|e2e|cloud-computer|demo-path>');
  process.exitCode = 2;
  commands = [];
}

for (const [command, args] of commands) {
  const isolated = createIsolatedEnvironment();
  try {
    const result = spawnSync(command, args, { cwd: projectRoot, env: isolated.environment, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  } finally {
    rmSync(isolated.testKeyringDirectory, { recursive: true, force: true });
    rmSync(isolated.testModelSecretDirectory, { recursive: true, force: true });
  }
}
