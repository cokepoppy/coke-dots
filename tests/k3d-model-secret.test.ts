import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { K3dModelSecretStore } from '../src/server/k3d-model-secret.ts';

test('K3D model Secret applies through stdin without putting the key in kubectl arguments or annotations', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
  let savedKey = '';
  const calls: { args: string[]; input?: string }[] = [];
  const store = new K3dModelSecretStore((args, input) => {
    calls.push({ args, input });
    if (args[0] === 'create') return 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: coke-dots-system\n';
    if (args.includes('get')) return Buffer.from(savedKey, 'utf8').toString('base64');
    if (input?.includes('"kind":"Secret"')) {
      const manifest = JSON.parse(input) as { kind?: string; data?: { apiKey?: string }; metadata?: { annotations?: Record<string, string> } };
      if (manifest.kind === 'Secret') {
        savedKey = Buffer.from(manifest.data?.apiKey || '', 'base64').toString('utf8');
        assert.equal(manifest.metadata?.annotations, undefined, 'kubectl apply must not create a last-applied annotation containing the secret');
      }
    }
    return '';
  });

  store.save('model-secret-test-only');
  assert.equal(store.read(true).value, 'model-secret-test-only');
  assert.equal(store.read(true).status, 'configured');
  const secretWrite = calls.find(call => call.args.includes('apply') && call.input?.includes('"kind":"Secret"'))!;
  assert.equal(secretWrite.args.includes('model-secret-test-only'), false);
  assert.equal(secretWrite.input?.includes('model-secret-test-only'), false, 'Secret manifest stores only base64 data');
  assert.equal(secretWrite.args.includes('--server-side'), true);
  assert.equal(secretWrite.args.includes('--field-manager=coke-dots-model-settings'), true);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('K3D model Secret store distinguishes an absent Secret from an unavailable cluster', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
  const absent = new K3dModelSecretStore(() => { throw Object.assign(new Error('kubectl failed'), { stderr: Buffer.from('Error from server (NotFound): secrets not found') }); });
  assert.deepEqual(absent.read(true), { value: null, status: 'missing' });
  const unavailable = new K3dModelSecretStore(() => { throw Object.assign(new Error('kubectl failed'), { stderr: Buffer.from('The connection to the server was refused') }); });
  assert.deepEqual(unavailable.read(true), { value: null, status: 'unavailable' });
  assert.throws(() => unavailable.save('sensitive-test-value'), error => {
    assert.equal((error as Error).message.includes('sensitive-test-value'), false);
    return true;
  });
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
  }
});

test('test Secret backend is private, temporary, and isolated from real K3D', () => {
  const previous = { nodeEnv: process.env.NODE_ENV, directory: process.env.DOTS_TEST_MODEL_SECRET_DIR };
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-model-secret-'));
  process.env.NODE_ENV = 'test';
  process.env.DOTS_TEST_MODEL_SECRET_DIR = directory;
  try {
    const store = new K3dModelSecretStore(() => { throw new Error('tests must never call real kubectl'); });
    store.save('isolated-test-value');
    assert.equal(store.read().value, 'isolated-test-value');
    const secretFile = join(directory, readdirSync(directory)[0]);
    const files = readFileSync(secretFile, 'utf8');
    assert.equal(files, 'isolated-test-value');
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(secretFile).mode & 0o777, 0o600);
    store.clearTestValue();
    assert.equal(store.read().status, 'missing');
  } finally {
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.directory === undefined) delete process.env.DOTS_TEST_MODEL_SECRET_DIR; else process.env.DOTS_TEST_MODEL_SECRET_DIR = previous.directory;
    rmSync(directory, { recursive: true, force: true });
  }
});
