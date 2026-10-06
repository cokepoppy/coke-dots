import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { redactSecret } from '../src/shared/redact-secret.ts';

const stdinKey = process.argv.slice(2).includes('--stdin-key');
const apiKey = (stdinKey ? await readHiddenInput() : process.env.DOTS_LIVE_MODEL_API_KEY || '').trim();
if (!apiKey) {
  console.error('Set DOTS_LIVE_MODEL_API_KEY or run interactively with --stdin-key.');
  process.exitCode = 2;
} else {
  await run(apiKey);
}

async function run(apiKey: string) {
  const baseUrl = (process.env.DOTS_LIVE_MODEL_BASE_URL || 'https://api.deepseek.com').trim().replace(/\/$/, '');
  const model = (process.env.DOTS_LIVE_MODEL || 'deepseek-flash').trim();
  let endpoint: URL;
  try { endpoint = new URL(baseUrl); }
  catch { console.error('DOTS_LIVE_MODEL_BASE_URL must be a valid HTTPS URL.'); process.exitCode = 2; return; }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || !model) {
    console.error('Live model smoke accepts an HTTPS base URL without embedded credentials and a model name.');
    process.exitCode = 2;
    return;
  }

  const environment = ['NODE_ENV', 'DOTS_E2E_AUTH', 'DOTS_MODEL_BASE_URL', 'DOTS_MODEL', 'DOTS_MODEL_API_KEY'] as const;
  const previous = Object.fromEntries(environment.map(name => [name, process.env[name]])) as Record<typeof environment[number], string | undefined>;
  const marker = `COKE_DOTS_LIVE_${randomUUID()}`;
  const startedAt = Date.now();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DOTS_E2E_AUTH: '1',
    DOTS_MODEL_BASE_URL: baseUrl,
    DOTS_MODEL: model,
    DOTS_MODEL_API_KEY: apiKey,
  });

  try {
    const { adapters } = await import('../src/server/adapters.ts');
    const result = await adapters.model.run({
      tenantId: `live-model-smoke-${randomUUID()}`,
      prompt: `Live API smoke test. Return a short Chinese confirmation in the normal task result. Include this exact marker: ${marker}.`,
      memories: [], pages: [], actionRule: null, allowDelegation: false, availableEngines: ['model'],
      delegatedResults: [], priorResult: null, sessionId: null, workspace: process.cwd(), onEvent: () => {},
    });
    const markerPresent = result.message.includes(marker);
    const ok = result.status === 'done' && markerPresent;
    console.log(JSON.stringify({ ok, baseUrl, model, status: result.status, markerPresent, elapsedMs: Date.now() - startedAt }));
    if (!ok) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown model error';
    console.error(JSON.stringify({ ok: false, baseUrl, model, elapsedMs: Date.now() - startedAt, error: redactSecret(message, apiKey) }));
    process.exitCode = 1;
  } finally {
    for (const name of environment) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function readHiddenInput() {
  if (!process.stdin.isTTY) throw new Error('--stdin-key requires an interactive terminal.');
  let terminalSettings: string;
  try {
    terminalSettings = execFileSync('stty', ['-g'], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] }).trim();
    execFileSync('stty', ['-echo'], { stdio: 'inherit' });
  } catch {
    throw new Error('Could not hide terminal input; set DOTS_LIVE_MODEL_API_KEY through a secure environment instead.');
  }
  let restored = false;
  const restoreEcho = () => {
    if (restored) return;
    restored = true;
    try { execFileSync('stty', [terminalSettings], { stdio: 'inherit' }); } catch { /* Do not replace the smoke result with a terminal cleanup error. */ }
  };
  process.once('exit', restoreEcho);
  process.stderr.write('Paste the API key and press Enter (input is hidden): ');
  try {
    return await new Promise<string>((resolve, reject) => {
      let input = '';
      const timeout = setTimeout(() => { process.stdin.off('data', onData); process.stdin.pause(); reject(new Error('Timed out waiting for hidden API key input.')); }, 30_000);
      const onData = (chunk: string) => {
        input += chunk;
        const newline = input.indexOf('\n');
        if (newline < 0) return;
        clearTimeout(timeout);
        process.stdin.off('data', onData);
        process.stdin.pause();
        resolve(input.slice(0, newline).trim());
      };
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', onData);
    });
  } finally {
    process.removeListener('exit', restoreEcho);
    restoreEcho();
    process.stderr.write('\n');
  }
}
