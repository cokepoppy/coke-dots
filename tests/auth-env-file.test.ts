import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('OAuth cookie path uses the base path loaded from DOTS_ENV_FILE after module imports', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'coke-dots-auth-env-e2e-'));
  let app: ChildProcess | null = null;
  let logOutput = '';
  try {
    const port = await freePort();
    const basePath = '/oauth-prefix';
    const envFile = join(tempRoot, 'demo.env');
    await writeFile(envFile, [
      `DOTS_PORT=${port}`,
      `DOTS_BASE_PATH=${basePath}`,
      `DOTS_DATA_DIR=${join(tempRoot, 'data')}`,
      'DOTS_PUBLIC_ORIGIN=https://dots.example.test',
      'DOTS_APP_URL=https://dots.example.test/oauth-prefix',
      'GOOGLE_CLIENT_ID=oauth-env-test.apps.googleusercontent.com',
      'GOOGLE_CLIENT_SECRET=oauth-env-test-secret',
      `GOOGLE_REDIRECT_URI=https://dots.example.test${basePath}/auth/google/callback`,
      '',
    ].join('\n'));

    const env: NodeJS.ProcessEnv = { ...process.env, DOTS_ENV_FILE: envFile, NODE_ENV: 'production' };
    for (const key of ['DOTS_PORT', 'DOTS_BASE_PATH', 'DOTS_DATA_DIR', 'DOTS_PUBLIC_ORIGIN', 'DOTS_APP_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']) delete env[key];
    app = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    app.stdout?.on('data', data => { logOutput = `${logOutput}${data}`.slice(-2000); });
    app.stderr?.on('data', data => { logOutput = `${logOutput}${data}`.slice(-2000); });

    const healthUrl = `http://127.0.0.1:${port}${basePath}/api/health`;
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      if (app.exitCode !== null) throw new Error(`The env-file test service exited early: ${logOutput}`);
      try { ready = (await fetch(healthUrl, { signal: AbortSignal.timeout(250) })).status === 200; }
      catch { await new Promise(resolvePromise => setTimeout(resolvePromise, 50)); }
    }
    assert(ready, `The env-file test service did not start: ${logOutput}`);

    const start = await fetch(`http://127.0.0.1:${port}${basePath}/api/auth/google/start`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const authorization = new URL(start.headers.get('location') || '');
    assert.equal(authorization.searchParams.get('redirect_uri'), `https://dots.example.test${basePath}/auth/google/callback`);

    const stateCookie = start.headers.getSetCookie().find(cookie => cookie.startsWith('coke_dots_oauth_state='));
    assert(stateCookie, 'The OAuth start response must set its state cookie');
    assert.equal(/;\s*Path=([^;]+)/i.exec(stateCookie)?.[1], `${basePath}/auth/google/callback`);
    assert.match(stateCookie, /;\s*HttpOnly\b/i);
    assert.match(stateCookie, /;\s*Secure\b/i);
    assert.match(stateCookie, /;\s*SameSite=Lax\b/i);
  } finally {
    if (app && app.exitCode === null) {
      const exited = new Promise<void>(resolvePromise => app!.once('exit', () => resolvePromise()));
      app.kill('SIGTERM');
      await Promise.race([exited, new Promise(resolvePromise => setTimeout(resolvePromise, 3_000))]);
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

async function freePort() {
  const probe: Server = createServer();
  await new Promise<void>((resolvePromise, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolvePromise));
  const address = probe.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolvePromise, reject) => probe.close(error => error ? reject(error) : resolvePromise()));
  return address.port;
}
