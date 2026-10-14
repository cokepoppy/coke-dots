import { spawnSync } from 'node:child_process';

/** Read the real instance Secret for an explicitly requested live E2E, without logging its value. */
export function readLiveSharedModelApiKey(): string | null {
  const namespace = process.env.DOTS_MODEL_SECRET_NAMESPACE?.trim() || 'coke-dots-system';
  const name = process.env.DOTS_MODEL_SECRET_NAME?.trim() || 'shared-model-api';
  const result = spawnSync(process.env.DOTS_KUBECTL?.trim() || 'kubectl', [
    '-n', namespace, 'get', 'secret', name, '-o=jsonpath={.data.apiKey}',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, maxBuffer: 32 * 1024 });
  if (result.error || result.status !== 0) return null;
  const encoded = result.stdout.trim();
  if (!encoded) return null;
  const key = Buffer.from(encoded, 'base64').toString('utf8');
  return key || null;
}
