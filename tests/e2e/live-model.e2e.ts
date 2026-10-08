import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Entry } from '@napi-rs/keyring';
import { chromium, type Browser } from 'playwright-core';
import { Store } from '../../src/server/store.ts';
import { redactSecret } from '../../src/shared/redact-secret.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tempRoot = await mkdtemp(join(tmpdir(), 'coke-dots-live-model-e2e-'));
const dataDirectory = join(tempRoot, 'data');
const envFile = join(tempRoot, 'empty.env');
const liveEngine = process.env.DOTS_LIVE_MODEL_ENGINE?.trim() || (process.argv.includes('--dsh') ? 'dsh' : 'model');
const liveDshDelegation = process.env.DOTS_LIVE_DSH_DELEGATION === '1';
const artifactDirectory = resolve(projectRoot, 'artifacts', 'e2e', `live-${liveEngine}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const chromePath = [process.env.DOTS_CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'].find(path => path && existsSync(path));
const keychainService = process.env.DOTS_LIVE_KEYCHAIN_SERVICE?.trim() || process.env.DOTS_KEYCHAIN_SERVICE?.trim() || 'com.cokepoppy.coke-dots';
const dshBin = findDshPath();
let server: ChildProcess | null = null;
let browser: Browser | null = null;
let stage = 'preflight';
let taskStatus: string | null = null;
let apiKeyForRedaction = '';
let serverDiagnostics = '';
let taskDiagnostic: { id: string; status: string; error: string | null; agentSessionId: string | null } | null = null;
let taskEntries: string[] = [];
let childTaskDiagnostics: { id: string; engine: string; status: string }[] = [];

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

function findDshPath() {
  const explicit = process.env.DOTS_LIVE_DSH_BIN || process.env.DOTS_DSH_BIN;
  if (explicit) {
    try { accessSync(explicit, constants.X_OK); return explicit; } catch { /* Check PATH below. */ }
  }
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    const candidate = join(directory, 'dsh');
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* Continue searching PATH. */ }
  }
  return null;
}

function dshProfile() {
  return process.env.DOTS_LIVE_DSH_PROFILE?.trim() || process.env.DOTS_DSH_PROFILE?.trim() || 'sdk';
}

try {
  assert(['model', 'pi', 'dsh'].includes(liveEngine), 'DOTS_LIVE_MODEL_ENGINE must be model, pi, or dsh.');
  assert(!liveDshDelegation || liveEngine === 'dsh', 'DOTS_LIVE_DSH_DELEGATION requires DOTS_LIVE_MODEL_ENGINE=dsh.');
  assert(chromePath, 'Chrome was not found; set DOTS_CHROME_BIN.');
  if (liveEngine === 'dsh') assert(dshBin, 'DeepSeek Harness CLI was not found; set DOTS_LIVE_DSH_BIN.');
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(envFile, '');

  const sourceStore = new Store(resolve(process.env.DOTS_DATA_DIR || './data'));
  let baseUrl = '';
  let model = '';
  try {
    baseUrl = sourceStore.getSetting('modelBaseUrl', 'legacy') || '';
    model = sourceStore.getSetting('modelName', 'legacy') || '';
  } finally { sourceStore.close(); }
  apiKeyForRedaction = new Entry(keychainService, 'tenant-legacy-model-api-key').getPassword() || '';
  const hasKeychainKey = Boolean(apiKeyForRedaction);
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
      DOTS_PI_ENABLED: liveEngine === 'pi' ? '1' : '0',
      DOTS_DSH_BIN: liveEngine === 'dsh' ? dshBin! : '',
      DOTS_DSH_PROFILE: liveEngine === 'dsh' ? dshProfile() : '',
      DOTS_DSH_READ_ONLY_CONFIG: '',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr?.on('data', chunk => {
    serverDiagnostics = `${serverDiagnostics}${String(chunk)}`.slice(-32_000);
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

  stage = `${liveEngine}-preflight`;
  const workspace = await page.evaluate(async () => await (await fetch('/api/state')).json()) as { availableEngines: string[]; modelSettings: { baseUrl: string; model: string; hasKey: boolean } };
  assert.equal(workspace.availableEngines.includes(liveEngine), true, `The UI did not load the configured ${liveEngine} kernel.`);
  assert.deepEqual(workspace.modelSettings, { baseUrl, model, hasKey: true });

  stage = 'browser-task-submit';
  await page.getByRole('button', { name: '你的 dot', exact: true }).click();
  await page.getByTestId('computer-choice').getByRole('button', { name: 'Continue' }).click();
  await page.getByTestId('dot-onboarding').waitFor({ state: 'visible' });
  const waitForTask = async (instruction: string) => {
    const deadline = Date.now() + 120_000;
    let task: { id: string; status: string; result: string | null; error: string | null; agentSessionId: string | null } | undefined;
    while (Date.now() < deadline) {
      const state = await page.evaluate(async () => await (await fetch('/api/state')).json()) as {
        tasks: { id: string; instruction: string; status: string; result: string | null; error: string | null; agentSessionId: string | null; engine: string; parentTaskId: string | null }[];
        entries: { taskId: string | null; body: string }[];
      };
      task = state.tasks.find(item => item.instruction === instruction);
      if (task) {
        taskDiagnostic = { id: task.id, status: task.status, error: task.error, agentSessionId: task.agentSessionId };
        taskEntries = state.entries.filter(entry => entry.taskId === task!.id).map(entry => entry.body);
        childTaskDiagnostics = state.tasks.filter(item => item.parentTaskId === task!.id).map(item => ({ id: item.id, engine: item.engine, status: item.status }));
      }
      if (task && ['done', 'failed', 'waiting', 'stopped'].includes(task.status)) break;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
    }
    return task;
  };

  if (liveEngine !== 'model') {
    stage = 'bootstrap-conversation';
    const bootstrapMarker = `COKE_DOTS_BOOTSTRAP_${randomUUID().replaceAll('-', '').toUpperCase()}`;
    const bootstrapPrompt = `请只回复这个随机标记，作为开启对话的最小连通性检查：${bootstrapMarker}`;
    await page.getByTestId('task-composer').fill(bootstrapPrompt);
    await page.locator('button.send').click();
    await page.locator('.timeline .message.user p').filter({ hasText: bootstrapMarker }).waitFor({ state: 'visible', timeout: 10_000 });
    const bootstrapTask = await waitForTask(bootstrapPrompt);
    assert(bootstrapTask, 'The conversation bootstrap task did not appear.');
    assert.equal(bootstrapTask.status, 'done', bootstrapTask.error || 'The Model API could not open the first conversation needed to reveal the kernel picker.');
    assert(bootstrapTask.result?.includes(bootstrapMarker), 'The bootstrap response did not contain its unique marker.');
    await page.locator('.composer-bottom select').waitFor({ state: 'visible' });
    await page.locator('.composer-bottom select').selectOption(liveEngine);
  }

  const marker = `COKE_DOTS_LIVE_E2E_${randomUUID().replaceAll('-', '').toUpperCase()}`;
  const prompt = liveDshDelegation
    ? `请创建一个使用 dsh 内核的子任务，让它原样返回这个随机标记：${marker}。等待子任务结束，然后在本任务中总结并逐字包含同一个标记。不要访问网页、调用其他工具或创建文件。`
    : `请在当前任务中直接完成一次最小化的真实 ${liveEngine} 内核连通性检查；不要委派子任务，不调用工具，不访问网页，也不要创建文件。请在最终结果中逐字包含这个随机标记：${marker}。`;
  await page.getByTestId('task-composer').fill(prompt);
  await page.locator('button.send').click();
  await page.locator('.timeline .message.user p').filter({ hasText: marker }).waitFor({ state: 'visible', timeout: 10_000 });

  stage = 'worker-result';
  const workerStartedAt = Date.now();
  const task = await waitForTask(prompt);
  taskStatus = task?.status || null;
  assert(task, 'The submitted task did not appear in the authenticated workspace.');
  assert.equal(task.status, 'done', task.error || 'The real background task did not complete successfully.');
  assert(task.result?.includes(marker), 'The real model result did not contain its unique marker.');
  if (liveDshDelegation) {
    assert(taskEntries.some(entry => entry.includes('已拆分为 1 项并行子任务')), 'The real DSH run did not create the requested child task.');
    assert(taskEntries.some(entry => entry.includes('保存的会话') && entry.includes('任务进度恢复')), 'The parent must recover from the stored SDK session collision after the child completes.');
    assert.equal(taskEntries.filter(entry => entry.includes('使用 dsh 开始处理')).length, 2, 'The parent must use DSH for both its initial run and recovered continuation.');
    assert(childTaskDiagnostics.some(child => child.engine === 'dsh' && child.status === 'done'), 'The delegated child must complete using the requested DSH kernel.');
  }

  stage = 'activity-render';
  await page.getByRole('button', { name: 'Activity', exact: true }).first().click();
  const resultCard = page.getByTestId(`task-card-${taskDiagnostic!.id}`);
  await resultCard.waitFor({ state: 'visible', timeout: 10_000 });
  assert((await resultCard.textContent())?.includes(marker), 'The parent Activity card must show its completed DSH result.');
  const screenshot = `live-${liveEngine}-task-completed.png`;
  await page.screenshot({ path: join(artifactDirectory, screenshot), fullPage: false, animations: 'disabled' });
  const report = { ok: true, engine: liveEngine, baseUrl, model, status: task.status, markerPresent: true, dshDelegationRecoveryVerified: liveDshDelegation, elapsedMs: Date.now() - workerStartedAt, screenshot };
  await writeFile(join(artifactDirectory, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, screenshot: join(artifactDirectory, report.screenshot) }));
} catch (error) {
  const message = redactSecret(error instanceof Error ? error.message : 'Unknown live E2E error', apiKeyForRedaction);
  const diagnostics = redactSecret(serverDiagnostics, apiKeyForRedaction)
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED_API_KEY]')
    .slice(-12_000);
  console.error(JSON.stringify({ ok: false, stage, taskStatus, error: message, task: taskDiagnostic, childTasks: childTaskDiagnostics, taskEntries, ...(diagnostics ? { diagnostics } : {}) }));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stopServer();
  await rm(tempRoot, { recursive: true, force: true });
}
