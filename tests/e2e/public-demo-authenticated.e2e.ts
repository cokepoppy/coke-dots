import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifactRoot = resolve(process.env.DOTS_E2E_ARTIFACTS || join(projectRoot, 'artifacts', 'e2e', `public-demo-authenticated-${runStamp}`));
const baseUrl = new URL(process.env.DOTS_PUBLIC_DEMO_URL || 'https://codex.cokeagent.com/dots-demo/');
const basePath = baseUrl.pathname.endsWith('/') ? baseUrl.pathname : `${baseUrl.pathname}/`;
const storageState = process.env.DOTS_PUBLIC_DEMO_STORAGE_STATE;
const screenshotPath = join(artifactRoot, 'linux-cloud-computer.png');
const videoDirectory = join(artifactRoot, 'video');
const browserCandidates = [process.env.DOTS_CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
const browserPath = browserCandidates.find(candidate => candidate && existsSync(candidate));
const runModelTask = process.env.DOTS_E2E_PUBLIC_MODEL_TASK === '1';
const result: { checks: string[]; failures: string[]; statuses: Record<string, number>; tenantHash: string | null; computer: Record<string, unknown> | null; modelTask: Record<string, unknown> | null } = {
  checks: [], failures: [], statuses: {}, tenantHash: null, computer: null, modelTask: null,
};
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

if (baseUrl.protocol !== 'https:') throw new Error('The authenticated public Dots E2E requires HTTPS.');
if (basePath !== baseUrl.pathname) throw new Error('DOTS_PUBLIC_DEMO_URL must end with a slash.');
if (!storageState || !existsSync(storageState)) {
  throw new Error('Set DOTS_PUBLIC_DEMO_STORAGE_STATE to a local Playwright storage-state JSON for a dedicated Dots test account. Keep that file out of Git and do not share it; it contains a login session.');
}
if (process.platform !== 'win32' && ((await stat(storageState)).mode & 0o077) !== 0) {
  throw new Error('The Playwright storage-state file is readable by group or other users. Restrict it with chmod 600 before testing.');
}
if (!browserPath) throw new Error('Chrome was not found. Set DOTS_CHROME_BIN to a local Chrome executable.');

await mkdir(videoDirectory, { recursive: true });

async function check(name: string, run: () => Promise<void>) {
  await run();
  result.checks.push(name);
  console.log(`PASS ${name}`);
}

try {
  browser = await chromium.launch({ executablePath: browserPath, headless: process.env.DOTS_E2E_HEADFUL !== '1' });
  context = await browser.newContext({
    storageState,
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    ...(process.env.DOTS_E2E_RECORD_VIDEO === '1' ? { recordVideo: { dir: videoDirectory, size: { width: 1440, height: 1000 } } } : {}),
  });
  page = await context.newPage();
  page.on('pageerror', error => result.failures.push(`pageerror:${error.name}`));
  page.on('console', message => {
    if (message.type() === 'error') result.failures.push(`console-error:${message.text().slice(0, 240)}`);
  });
  page.on('requestfailed', request => {
    const url = new URL(request.url());
    const failure = request.failure()?.errorText || '';
    if (url.origin === baseUrl.origin && url.pathname.startsWith(basePath) && !failure.includes('ERR_ABORTED')) {
      result.failures.push(`request-failed:${request.method()} ${url.pathname}`);
    }
  });
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin !== baseUrl.origin || !url.pathname.startsWith(basePath)) return;
    const methodPath = `${response.request().method()} ${url.pathname}`;
    result.statuses[methodPath] = response.status();
    if (response.status() >= 400) result.failures.push(`${response.status()} ${methodPath}`);
  });

  await check('the saved browser session authenticates to the deployed Dots tenant', async () => {
    const response = await page!.goto(baseUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    assert.equal(response?.status(), 200);
    await page!.getByTestId('app-shell').waitFor({ state: 'visible', timeout: 20_000 });
    await page!.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true', null, { timeout: 30_000 });
    const auth = await page!.evaluate(async () => {
      const response = await fetch('api/auth/me', { cache: 'no-store' });
      return { status: response.status, body: response.ok ? await response.json() as { tenant?: { id?: string } } : null };
    });
    assert.equal(auth.status, 200, 'The saved session must be authenticated on the public site');
    assert(auth.body?.tenant?.id, 'The authenticated response must identify the active tenant');
    result.tenantHash = createHash('sha256').update(auth.body.tenant.id).digest('hex').slice(0, 12);
    const state = await page!.evaluate(async () => {
      const response = await fetch('api/state', { cache: 'no-store' });
      return { status: response.status, body: response.ok ? await response.json() as { availableEngines?: string[]; configured?: boolean; modelSettings?: { hasKey?: boolean; model?: string } } : null };
    });
    assert.equal(state.status, 200, 'The signed-in application state must load from the deployed service');
    assert(state.body?.availableEngines, 'The signed-in state must report available Agent kernels');
    if (runModelTask) {
      assert(state.body.availableEngines.includes('model'), 'The test account must see the shared Model API kernel as configured');
      assert.equal(state.body.configured, true, 'The test account must receive the shared Model API configuration');
      assert.equal(state.body.modelSettings?.hasKey, true, 'The deployed instance must report an available shared Model API key');
      assert(state.body.modelSettings?.model, 'The deployed instance must report a model name');
    }
    result.modelTask = { enabled: runModelTask, available: state.body.availableEngines.includes('model'), configured: state.body.configured === true, hasKey: state.body.modelSettings?.hasKey === true, modelNamePresent: Boolean(state.body.modelSettings?.model) };
  });

  await check('Chrome opens the signed-in cloud-computer view and the UI reaches ready state', async () => {
    const computerFetch = page!.waitForResponse(response => {
      const url = new URL(response.url());
      return response.request().method() === 'GET' && url.origin === baseUrl.origin && url.pathname === `${basePath}api/computer`;
    }, { timeout: 20_000 });
    await page!.getByRole('button', { name: '电脑', exact: true }).click();
    await page!.locator('.computer-view').waitFor({ state: 'visible', timeout: 20_000 });
    const initialComputerResponse = await computerFetch;
    assert.equal(initialComputerResponse.status(), 200, 'The first authenticated computer state probe must succeed');
    const initialComputer = await initialComputerResponse.json() as { ready?: boolean; backend?: string };
    assert.equal(initialComputer.backend, 'linux-desktop', 'The deployed tenant must use the Linux cloud desktop');

    const workspace = page!.getByTestId('computer-workspace');
    let shouldOpen = !initialComputer.ready;
    if (shouldOpen) {
      // The component polls every two seconds. Recheck immediately before acting
      // so a slow initial render cannot make the test open an already-ready Pod.
      const current = await page!.evaluate(async () => {
        const response = await fetch('api/computer', { cache: 'no-store' });
        return { status: response.status, body: response.ok ? await response.json() as { ready?: boolean } : null };
      });
      assert.equal(current.status, 200, 'The computer state must remain readable before provisioning');
      shouldOpen = !current.body?.ready;
    }
    if (shouldOpen) {
      const openButton = page!.getByRole('button', { name: '打开电脑', exact: true });
      await openButton.waitFor({ state: 'visible', timeout: 20_000 });
      // This is the one intentional provisioning action in this test. Never retry
      // it automatically: inspect the persisted tenant state after a failure.
      await openButton.click();
    }

    await workspace.waitFor({ state: 'visible', timeout: 240_000 });
    const computerImage = page!.locator('img[alt="Linux 云桌面画面"]');
    await computerImage.waitFor({ state: 'visible', timeout: 20_000 });
    const dimensions = await computerImage.evaluate(async image => {
      await (image as HTMLImageElement).decode();
      return { width: (image as HTMLImageElement).naturalWidth, height: (image as HTMLImageElement).naturalHeight };
    });
    assert.deepEqual(dimensions, { width: 1440, height: 1080 }, 'The public desktop image must be fully decoded at the expected size');

    const computer = await page!.evaluate(async () => {
      const response = await fetch('api/computer', { cache: 'no-store' });
      return { status: response.status, body: response.ok ? await response.json() as { ready?: boolean; owner?: string; backend?: string; title?: string } : null };
    });
    assert.equal(computer.status, 200, 'Authenticated computer state must return HTTP 200');
    assert.equal(computer.body?.ready, true);
    assert.equal(computer.body?.backend, 'linux-desktop');
    assert.equal(computer.body?.owner, 'agent', 'The test must leave the desktop under Agent control');
    assert(computer.body?.title, 'The cloud browser must report a page title');
    result.computer = { ready: computer.body.ready, owner: computer.body.owner, backend: computer.body.backend, hasPageTitle: Boolean(computer.body.title), screenshot: dimensions };

    const screenshot = await page!.request.get(new URL(`${basePath}api/computer/screenshot`, baseUrl).toString(), { timeout: 30_000 });
    assert.equal(screenshot.status(), 200, 'The authenticated screenshot endpoint must return HTTP 200');
    assert.match(screenshot.headers()['content-type'] || '', /^image\/png/i);
    const bytes = await screenshot.body();
    assert(bytes.length > 8_000, 'The cloud-computer screenshot must contain a complete desktop frame');
    await page!.locator('[data-testid="computer-workspace"]').screenshot({ path: screenshotPath, animations: 'disabled' });
  });

  if (runModelTask) {
    await check('Chrome submits one Chinese task to the deployed shared Model API and verifies its result after reload', async () => {
      const acceptanceId = randomUUID();
      const instruction = `公网自动验收 ${acceptanceId}：请只用中文回复“公网真实模型链路测试成功”，不要调用工具或访问外网。`;
      await page!.getByRole('button', { name: '你的 dot', exact: true }).click();
      const enginePicker = page!.locator('.composer-bottom select').first();
      await enginePicker.selectOption('model');
      await page!.getByTestId('task-composer').fill(instruction);
      await page!.locator('.composer button.send').click();

      const deadline = Date.now() + 180_000;
      let completed: { id: string; status: string; result: string | null; error: string | null; entries: { kind: string; body: string }[] } | null = null;
      while (Date.now() < deadline) {
        completed = await page!.evaluate(async instructionText => {
          const response = await fetch('api/state', { cache: 'no-store' });
          if (!response.ok) throw new Error(`State refresh failed with HTTP ${response.status}`);
        const state = await response.json() as { tasks: { id: string; instruction: string; status: string; result: string | null; error: string | null }[]; entries: { taskId: string | null; kind: string; body: string }[] };
          const task = state.tasks.find(item => item.instruction === instructionText);
          if (!task) return null;
          return { id: task.id, status: task.status, result: task.result, error: task.error, entries: state.entries.filter(entry => entry.taskId === task.id).map(({ kind, body }) => ({ kind, body })) };
        }, instruction);
        if (completed?.status === 'done' || completed?.status === 'failed') break;
        await page!.waitForTimeout(2_000);
      }
      assert(completed, 'The public UI did not persist the task after the single submit click');
      assert.equal(completed.status, 'done', `The public model task ended as ${completed.status}: ${(completed.error || '').slice(0, 300)}`);
      assert.match(completed.result || '', /公网真实模型链路测试成功/, 'The deployed model result did not contain the expected Chinese response');
      assert(completed.entries.some(entry => entry.kind === 'dot' && entry.body.includes('公网真实模型链路测试成功')), 'The model response was not persisted to the task conversation');

      result.modelTask = { ...(result.modelTask || {}), enabled: true, status: completed.status, responseConfirmed: true };
      const taskId = completed.id;
      await page!.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page!.getByTestId('app-shell').waitFor({ state: 'visible', timeout: 20_000 });
      await page!.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true', null, { timeout: 30_000 });
      const persisted = await page!.evaluate(async id => {
        const response = await fetch('api/state', { cache: 'no-store' });
        if (!response.ok) throw new Error(`State refresh after reload failed with HTTP ${response.status}`);
        const state = await response.json() as { tasks: { id: string; title: string; status: string; result: string | null }[]; entries: { taskId: string | null; kind: string; body: string }[] };
        const task = state.tasks.find(item => item.id === id);
        return { task: task ? { title: task.title, status: task.status, result: task.result } : null, dotReply: state.entries.find(entry => entry.taskId === id && entry.kind === 'dot')?.body || null };
      }, taskId);
      assert.equal(persisted.task?.status, 'done', 'The completed public task did not persist after a full page reload');
      assert.match(persisted.task?.result || '', /公网真实模型链路测试成功/);
      assert.match(persisted.dotReply || '', /公网真实模型链路测试成功/);
      assert(persisted.task?.title, 'The completed task title was not persisted after reload');
      const recentTask = page!.locator('.task-links button').filter({ hasText: persisted.task.title });
      await recentTask.waitFor({ state: 'visible', timeout: 20_000 });
      await recentTask.click();
      const visibleConversation = page!.getByTestId('chat-timeline-item');
      await visibleConversation.filter({ hasText: acceptanceId }).waitFor({ state: 'visible', timeout: 20_000 });
      await visibleConversation.filter({ hasText: '公网真实模型链路测试成功' }).waitFor({ state: 'visible', timeout: 20_000 });
    });
  }

  await check('the cloud-computer flow has no application or browser errors', async () => {
    assert.deepEqual(result.failures, [], `Deployed errors: ${result.failures.join('; ')}`);
    assert.equal(await page!.locator('.error-banner').count(), 0, 'The page must not retain a cloud-computer error banner');
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  result.failures.push(message.slice(0, 500));
  if (page) {
    const workspace = page.locator('[data-testid="computer-workspace"]');
    if (await workspace.isVisible().catch(() => false)) await workspace.screenshot({ path: screenshotPath, animations: 'disabled' }).catch(() => undefined);
  }
  throw error;
} finally {
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  const videos = await readdir(videoDirectory).then(names => names.filter(name => name.endsWith('.webm'))).catch(() => [] as string[]);
  for (const name of videos) await chmod(join(videoDirectory, name), 0o600).catch(() => undefined);
  if (existsSync(screenshotPath)) await chmod(screenshotPath, 0o600).catch(() => undefined);
  const manifest = {
    testKind: 'authenticated-public-cloud-computer-e2e',
    runAt: new Date().toISOString(),
    origin: baseUrl.origin,
    basePath,
    viewport: { width: 1440, height: 1000 },
    browser: browserPath,
    tenantHash: result.tenantHash,
    computer: result.computer,
    modelTask: result.modelTask,
    statuses: result.statuses,
    checks: result.checks,
    failures: result.failures,
    screenshots: existsSync(screenshotPath) ? ['linux-cloud-computer.png'] : [],
    videos: videos.map(name => `video/${name}`),
  };
  const manifestPath = join(artifactRoot, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  await chmod(manifestPath, 0o600).catch(() => undefined);
  console.log(`Authenticated public E2E evidence: ${artifactRoot}`);
}

if (result.failures.length) throw new Error(result.failures.join('\n'));
console.log(`PASS ${result.checks.length} authenticated public cloud-computer E2E checks`);
