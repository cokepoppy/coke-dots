import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Entry } from '@napi-rs/keyring';
import { chromium, type Browser } from 'playwright-core';
import { Store } from '../../src/server/store.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tempRoot = await mkdtemp(join(tmpdir(), 'coke-dots-live-model-e2e-'));
const dataDirectory = join(tempRoot, 'data');
const envFile = join(tempRoot, 'empty.env');
const artifactDirectory = resolve(projectRoot, 'artifacts', 'e2e', `live-model-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const chromePath = [process.env.DOTS_CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find(path => path && existsSync(path));
const keychainService = process.env.DOTS_LIVE_KEYCHAIN_SERVICE?.trim() || process.env.DOTS_KEYCHAIN_SERVICE?.trim() || 'com.cokepoppy.coke-dots';
let server: ChildProcess | null = null;
let browser: Browser | null = null;
let stage = 'preflight';
let taskStatus: string | null = null;

async function freePort() {
  const listener = createServer();
  await new Promise<void>((resolvePromise, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolvePromise));
  const address = listener.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolvePromise, reject) => listener.close(error => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise<void>(resolvePromise => server!.once('exit', () => resolvePromise()));
  server.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolvePromise => setTimeout(resolvePromise, 3000))]);
  if (server.exitCode === null) server.kill('SIGKILL');
}

try {
  assert(chromePath, 'Chrome was not found; set DOTS_CHROME_BIN.');
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(envFile, '');

  const sourceStore = new Store(resolve(process.env.DOTS_DATA_DIR || './data'));
  let baseUrl = '';
  let model = '';
  try {
    baseUrl = sourceStore.getSetting('modelBaseUrl', 'legacy') || '';
    model = sourceStore.getSetting('modelName', 'legacy') || '';
  } finally { sourceStore.close(); }
  const hasKeychainKey = Boolean(new Entry(keychainService, 'tenant-legacy-model-api-key').getPassword());
  assert(baseUrl && model && hasKeychainKey, 'The local legacy workspace must have a model endpoint, model name, and Keychain key.');
  assert.equal(new URL(baseUrl).protocol, 'https:', 'The live model test requires HTTPS.');

  const setupStore = new Store(dataDirectory);
  setupStore.setSetting('modelBaseUrl', baseUrl, 'legacy');
  setupStore.setSetting('modelName', model, 'legacy');
  setupStore.close();

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test', DOTS_E2E_AUTH: '1', DOTS_ENV_FILE: envFile,
      DOTS_DATA_DIR: dataDirectory, DOTS_PORT: String(port), DOTS_KEYCHAIN_SERVICE: keychainService,
      GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', DOTS_MODEL_BASE_URL: '', DOTS_MODEL: '', DOTS_MODEL_API_KEY: '',
      DOTS_PI_ENABLED: '0', DOTS_DSH_BIN: '', DOTS_DSH_READ_ONLY_CONFIG: '',
    },
    stdio: 'ignore',
  });
  const healthUrl = `${base}/api/health`;
  const startDeadline = Date.now() + 20_000;
  while (Date.now() < startDeadline) {
    if (server.exitCode !== null) throw new Error(`Live E2E service exited before health check (${server.exitCode}).`);
    try { if ((await fetch(healthUrl)).ok) break; } catch { /* Wait for the loopback listener. */ }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  assert.equal((await fetch(healthUrl)).ok, true, 'Live E2E service did not become healthy.');

  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, deviceScaleFactor: 1 });
  stage = 'browser-login';
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('#e2e-email').fill(`live-model-${randomUUID().slice(0, 8)}@example.test`);
  const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 });
  await page.getByTestId('e2e-sign-in').click();
  await navigation;
  await page.getByTestId('app-shell').waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true', null, { timeout: 10_000 });

  stage = 'model-preflight';
  const workspace = await page.evaluate(async () => await (await fetch('/api/state')).json()) as { availableEngines: string[]; modelSettings: { baseUrl: string; model: string; hasKey: boolean } };
  assert.equal(workspace.availableEngines.includes('model'), true, 'The UI did not load the configured Model API kernel.');
  assert.deepEqual(workspace.modelSettings, { baseUrl, model, hasKey: true });

  stage = 'browser-task-submit';
  await page.getByRole('button', { name: '你的 dot', exact: true }).click();
  await page.getByTestId('computer-choice').getByRole('button', { name: 'Continue' }).click();
  await page.getByTestId('dot-onboarding').waitFor({ state: 'visible' });
  const marker = `COKE_DOTS_LIVE_E2E_${randomUUID().replaceAll('-', '').toUpperCase()}`;
  const prompt = `请进行一次最小化的真实模型连通性检查，不要访问网页或创建文件。请在最终结果中逐字包含这个随机标记：${marker}。`;
  await page.getByTestId('task-composer').fill(prompt);
  await page.locator('button.send').click();
  await page.locator('.timeline .message.user p').filter({ hasText: marker }).waitFor({ state: 'visible', timeout: 10_000 });

  stage = 'worker-result';
  const deadline = Date.now() + 120_000;
  let task: { status: string; result: string | null; error: string | null } | undefined;
  while (Date.now() < deadline) {
    const state = await page.evaluate(async () => await (await fetch('/api/state')).json()) as { tasks: { instruction: string; status: string; result: string | null; error: string | null }[] };
    task = state.tasks.find(item => item.instruction === prompt);
    if (task && ['done', 'failed', 'waiting', 'stopped'].includes(task.status)) break;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
  }
  taskStatus = task?.status || null;
  assert(task, 'The submitted task did not appear in the authenticated workspace.');
  assert.equal(task.status, 'done', 'The real background task did not complete successfully.');
  assert(task.result?.includes(marker), 'The real model result did not contain its unique marker.');

  stage = 'activity-render';
  await page.getByRole('button', { name: 'Activity', exact: true }).first().click();
  const resultCard = page.locator('.task-card').filter({ hasText: marker });
  await resultCard.waitFor({ state: 'visible', timeout: 10_000 });
  await page.screenshot({ path: join(artifactDirectory, 'live-model-task-completed.png'), fullPage: false, animations: 'disabled' });
  const report = { ok: true, baseUrl, model, status: task.status, markerPresent: true, elapsedMs: Math.round(Date.now() - (deadline - 120_000)), screenshot: 'live-model-task-completed.png' };
  await writeFile(join(artifactDirectory, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, screenshot: join(artifactDirectory, report.screenshot) }));
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown live E2E error';
  console.error(JSON.stringify({ ok: false, stage, taskStatus, error: message }));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stopServer();
  await rm(tempRoot, { recursive: true, force: true });
}
