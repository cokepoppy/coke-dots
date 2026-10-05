import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const artifactStamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifactRoot = resolve(process.env.DOTS_E2E_ARTIFACTS || join(projectRoot, 'artifacts', 'e2e', artifactStamp));
const screenshotsDir = join(artifactRoot, 'screenshots');
const videoDir = join(artifactRoot, 'video');
const tempRoot = await mkdtemp(join(tmpdir(), 'coke-dots-e2e-'));
const emptyEnvFile = join(tempRoot, 'empty.env');
const testDataDir = join(tempRoot, 'data');
const fixtureSource = join(projectRoot, 'tests', 'e2e', 'fixtures', 'computer.html');
const fixtureDestination = join(projectRoot, 'dist', 'e2e-computer-fixture.html');
const chromePath = findChromePath();
const steps: { name: string; result: 'passed' }[] = [];
const screenshotNames: string[] = [];
const serverLogs: string[] = [];
const pageErrors: string[] = [];
let server: ChildProcess | null = null;
let mockModelServer: Server | null = null;
let mockModelPrompts: string[] = [];
let testModelBaseUrl = '';
let testModelApiKey = '';
let testModelName = '';
let browser: Browser | null = null;
let alphaContext: BrowserContext | null = null;
let betaContext: BrowserContext | null = null;
let alphaPage: Page | null = null;
let betaPage: Page | null = null;
let baseUrl = '';
let failure = '';
let e2ePort = 0;

await mkdir(screenshotsDir, { recursive: true });
await mkdir(videoDir, { recursive: true });
await writeFile(emptyEnvFile, '');
await copyFile(fixtureSource, fixtureDestination);

function findChromePath() {
  const candidates = [process.env.DOTS_CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  const result = candidates.find(candidate => candidate && existsSync(candidate));
  if (!result) throw new Error('Chrome was not found. Set DOTS_CHROME_BIN to a local Chrome executable.');
  return result;
}

async function reservePort() {
  const listener = createServer();
  await new Promise<void>((resolvePromise, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolvePromise));
  const address = listener.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolvePromise, reject) => listener.close(error => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function startMockModel() {
  mockModelPrompts = [];
  mockModelServer = createHttpServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      try {
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/v1/chat/completions');
        const payload = JSON.parse(raw) as { messages?: { role: string; content: string }[] };
        const prompt = payload.messages?.find(message => message.role === 'user')?.content || '';
        mockModelPrompts.push(prompt);
        const hasReply = prompt.includes('User reply: Use Friday.');
        const isRecurringCheck = prompt.includes('E2E recurring run — verify due work reruns automatically');
        const isComplete = hasReply || isRecurringCheck;
        const content = JSON.stringify({ status: isComplete ? 'done' : 'waiting', message: hasReply ? 'The launch plan now uses Friday.' : isRecurringCheck ? 'The recurring check completed.' : 'What launch date should I use?' });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content } }] }));
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Invalid test model request' }));
      }
    });
  });
  await new Promise<void>((resolvePromise, reject) => mockModelServer!.once('error', reject).listen(0, '127.0.0.1', resolvePromise));
  const address = mockModelServer.address();
  assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/v1`;
}

function captureServerOutput(child: ChildProcess) {
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => {
    const line = String(chunk);
    serverLogs.push(line);
    if (serverLogs.length > 500) serverLogs.splice(0, serverLogs.length - 500);
  });
}

async function startServer(port: number) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DOTS_E2E_AUTH: '1',
      DOTS_ENV_FILE: emptyEnvFile,
      DOTS_DATA_DIR: testDataDir,
      DOTS_PORT: String(port),
      DOTS_CHROME_BIN: chromePath,
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      DOTS_MODEL_BASE_URL: testModelBaseUrl,
      DOTS_MODEL_API_KEY: testModelApiKey,
      DOTS_MODEL: testModelName,
      DOTS_CLAUDE_BIN: '',
      DOTS_PI_ENABLED: '0',
      DOTS_DSH_BIN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  captureServerOutput(child);
  const healthUrl = `http://127.0.0.1:${port}/api/health`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Coke Dots test service exited early (${child.exitCode}).\n${serverLogs.join('')}`);
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return child;
    } catch { /* Wait for the loopback listener. */ }
    await delay(150);
  }
  child.kill('SIGTERM');
  throw new Error(`Coke Dots test service did not become healthy.\n${serverLogs.join('')}`);
}

async function stopServer(child: ChildProcess | null) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>(resolvePromise => child.once('exit', () => resolvePromise()));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function delay(milliseconds: number) {
  await new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
}

async function waitFor(predicate: () => boolean, timeout = 3_000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for browser task state');
    await delay(20);
  }
}

async function recordStep(name: string, action: () => Promise<void>) {
  await action();
  steps.push({ name, result: 'passed' });
  console.log(`PASS ${name}`);
}

async function screenshot(page: Page, name: string) {
  await page.evaluate(async () => { await document.fonts.ready; });
  const path = join(screenshotsDir, `${name}.png`);
  await page.screenshot({ path, fullPage: false, animations: 'disabled' });
  screenshotNames.push(`screenshots/${name}.png`);
}

async function clickNav(page: Page, label: string) {
  await page.locator('.sidebar .nav').filter({ hasText: label }).click();
}

async function signIn(page: Page, email: string) {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#e2e-email').fill(email);
  const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 });
  await page.getByTestId('e2e-sign-in').click();
  await navigation;
  await page.getByTestId('app-shell').waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true', null, { timeout: 10_000 });
  await page.locator('.profile-link small').filter({ hasText: email }).waitFor({ state: 'visible' });
}

async function createTask(page: Page, instruction: string, scheduled = false) {
  if (scheduled) {
    await page.getByLabel('定期检查').check();
    await page.getByLabel('重复频率').selectOption('interval');
    await page.locator('input.minutes').fill('60');
  }
  await page.getByPlaceholder('告诉 dot 接下来要负责什么…').fill(instruction);
  await page.locator('button.send').click();
  await page.locator('.timeline .message.user p').filter({ hasText: instruction }).waitFor({ state: 'visible', timeout: 10_000 });
  if (scheduled) await page.waitForFunction(() => document.querySelector<HTMLInputElement>('.schedule-toggle input[type="checkbox"]')?.checked === false);
}

async function selectTenant(page: Page, text: string) {
  const option = page.locator('.workspace-switcher option').filter({ hasText: text }).first();
  await option.waitFor({ state: 'attached', timeout: 10_000 });
  const value = await option.getAttribute('value');
  assert(value, `Workspace option containing "${text}" has no value`);
  const activeTenantId = await page.getByTestId('app-shell').getAttribute('data-tenant-id');
  if (activeTenantId === value) {
    await page.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true', null, { timeout: 10_000 });
    return;
  }
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/auth/tenant') && response.request().method() === 'POST');
  await page.locator('.workspace-switcher select').selectOption(value);
  const response = await responsePromise;
  assert(response.ok(), `Workspace switch returned HTTP ${response.status()}`);
  const data = await response.json() as { tenant: { id: string } };
  await page.waitForFunction(tenantId => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-tenant-id') === tenantId, data.tenant.id);
  await page.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true', null, { timeout: 10_000 });
}

async function assertNoVisibleText(page: Page, text: string) {
  assert.equal(await page.getByText(text, { exact: true }).count(), 0, `Unexpected tenant data visible: ${text}`);
}

async function restartService() {
  await stopServer(server);
  server = await startServer(e2ePort);
}

try {
  e2ePort = await reservePort();
  baseUrl = `http://127.0.0.1:${e2ePort}`;
  server = await startServer(e2ePort);
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  alphaContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, recordVideo: { dir: videoDir, size: { width: 1440, height: 1000 } } });
  betaContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, recordVideo: { dir: videoDir, size: { width: 1440, height: 1000 } } });
  await alphaContext.tracing.start({ screenshots: true, snapshots: true, sources: true });
  await betaContext.tracing.start({ screenshots: true, snapshots: true, sources: true });
  alphaPage = await alphaContext.newPage();
  betaPage = await betaContext.newPage();
  alphaPage.on('pageerror', error => pageErrors.push(`alpha: ${error.message}`));
  betaPage.on('pageerror', error => pageErrors.push(`beta: ${error.message}`));

  await recordStep('Unauthenticated page and E2E-only sign-in control render', async () => {
    await alphaPage!.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await alphaPage!.getByTestId('e2e-sign-in').waitFor({ state: 'visible' });
    await screenshot(alphaPage!, '01-login');
  });

  await recordStep('Google-style tenant Alpha signs in through the rendered page', async () => {
    await signIn(alphaPage!, 'alpha@example.test');
    await alphaPage!.getByTestId('app-shell').waitFor();
    assert.equal(await alphaPage!.locator('.profile-link small').innerText(), 'alpha@example.test');
    assert.equal(await alphaPage!.getByTestId('app-shell').getAttribute('data-theme'), 'dark');
    assert.equal(await alphaPage!.locator('.sidebar').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(17, 17, 19)');
    assert.equal(await alphaPage!.locator('.main').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(13, 13, 15)');
    assert.equal(await alphaPage!.getByTestId('dot-context-panel').count(), 0, 'A new-dot welcome state should not show the post-setup details panel');
    await screenshot(alphaPage!, '02-alpha-home');
  });

  await recordStep('First-run greeting opens Dot customization and focuses the task composer', async () => {
    const onboarding = alphaPage!.getByTestId('dot-onboarding');
    await onboarding.getByRole('heading', { name: 'Hey! I’m your dot' }).waitFor({ state: 'visible' });
    await onboarding.getByText('Message or call me anytime. I’ll keep things moving, even when we’re not talking, and check in with updates or questions.').waitFor({ state: 'visible' });
    await screenshot(alphaPage!, 'onboarding-first-run');
    await alphaPage!.getByTestId('onboarding-customize').click();
    await alphaPage!.getByRole('heading', { name: '你的 dot' }).waitFor({ state: 'visible' });
    assert.equal(await alphaPage!.getByLabel('名字').inputValue(), 'Dot');
    await clickNav(alphaPage!, '你的 dot');
    await onboarding.waitFor({ state: 'visible' });
    await alphaPage!.getByTestId('onboarding-start').click();
    assert.equal(await alphaPage!.getByPlaceholder('告诉 dot 接下来要负责什么…').evaluate(element => document.activeElement === element), true, 'The start action should put the task composer in focus');
  });

  const alphaPrivateTask = 'E2E alpha private goal — inventory the project risks';
  await recordStep('Create a persistent task and inspect its visible execution state', async () => {
    await createTask(alphaPage!, alphaPrivateTask);
    await alphaPage!.locator('.timeline .pill').waitFor({ state: 'visible', timeout: 10_000 });
    await alphaPage!.waitForFunction(() => ['失败', '已完成'].includes(document.querySelector('.timeline .pill')?.textContent?.trim() || ''), null, { timeout: 15_000 });
    const status = await alphaPage!.locator('.timeline .pill').innerText();
    assert.equal(status, '失败', 'With model credentials disabled, the task must fail visibly instead of claiming completion');
    const contextPanel = alphaPage!.getByTestId('dot-context-panel');
    await contextPanel.waitFor({ state: 'visible' });
    await contextPanel.getByRole('region', { name: 'Computers' }).waitFor({ state: 'visible' });
    await contextPanel.getByRole('region', { name: 'Recent activity' }).getByText(alphaPrivateTask).waitFor({ state: 'visible' });
    assert.equal(await alphaPage!.locator('.timeline .message.user').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(93, 73, 191)');
    assert.equal(await contextPanel.getByRole('button', { name: 'Call, not connected' }).isDisabled(), true);
    assert.equal(await contextPanel.getByRole('button', { name: 'Slack, not connected' }).isDisabled(), true);
    await contextPanel.getByText('No skills yet', { exact: true }).waitFor({ state: 'visible' });
    await screenshot(alphaPage!, '03-task-progress-and-context');
  });

  await recordStep('Dot computer shortcut opens the tenant-isolated browser workspace', async () => {
    await alphaPage!.getByTestId('dot-computer-row').click();
    await alphaPage!.getByRole('heading', { name: '打开独立浏览器' }).waitFor({ state: 'visible' });
    await screenshot(alphaPage!, 'context-computer-shortcut');
    await clickNav(alphaPage!, '你的 dot');
    await alphaPage!.getByTestId('dot-context-panel').waitFor({ state: 'visible' });
  });

  await recordStep('A second Google-style account is isolated before workspace invitation', async () => {
    await signIn(betaPage!, 'beta@example.test');
    assert.equal(await betaPage!.locator('.task-links button').count(), 0, 'Beta inherited Alpha task links');
    assert.equal(await betaPage!.getByTestId('dot-context-panel').count(), 0, 'Beta personal onboarding inherited Alpha conversation context');
    await assertNoVisibleText(betaPage!, alphaPrivateTask);
    await screenshot(betaPage!, '04-beta-isolated');
  });

  await recordStep('Activity shows the task and supports priority and direction changes', async () => {
    await clickNav(alphaPage!, 'Activity');
    const card = alphaPage!.locator('.task-card').filter({ hasText: alphaPrivateTask });
    await card.waitFor({ state: 'visible' });
    await screenshot(alphaPage!, '05-activity');
    await card.getByRole('button', { name: /查看详情/ }).click();
    await alphaPage!.getByRole('button', { name: '提高优先级' }).click();
    await alphaPage!.getByText('任务操作：priority', { exact: true }).waitFor({ state: 'visible' });
    const redirectedText = 'E2E direction update: prioritize the risk register';
    await alphaPage!.getByPlaceholder('调整这项工作的要求').fill(redirectedText);
    await alphaPage!.getByRole('button', { name: '更新', exact: true }).click();
    await alphaPage!.locator('.timeline .message.user p').filter({ hasText: redirectedText }).waitFor({ state: 'visible' });
    await alphaPage!.getByText('任务操作：redirect', { exact: true }).waitFor({ state: 'visible' });
    await screenshot(alphaPage!, '06-task-direction-update');
  });

  const scheduledTask = 'E2E scheduled responsibility — report on the next review';
  await recordStep('Scheduled view exposes a recurring task and its cancellation control', async () => {
    await clickNav(alphaPage!, '你的 dot');
    await createTask(alphaPage!, scheduledTask, true);
    await clickNav(alphaPage!, 'Scheduled');
    await alphaPage!.getByTestId('scheduled-hub').waitFor({ state: 'visible' });
    const item = alphaPage!.locator('.scheduled-item').filter({ hasText: scheduledTask });
    await item.waitFor({ state: 'visible', timeout: 10_000 });
    const detail = alphaPage!.getByTestId('scheduled-detail');
    await detail.getByText('Every 60 minutes', { exact: true }).waitFor({ state: 'visible' });
    assert.ok((await detail.innerText()).includes(scheduledTask));
    await detail.getByText('Failed', { exact: true }).waitFor({ state: 'visible' });
    assert.match(await detail.innerText(), /内核尚未配置或安装/);
    assert.match(await detail.locator('.scheduled-detail-meta').innerText(), /Next run: Not scheduled/);
    const search = alphaPage!.getByLabel('Search scheduled tasks');
    await search.fill('no matching schedule');
    await alphaPage!.getByText('No matching tasks').first().waitFor({ state: 'visible' });
    await search.fill(scheduledTask);
    await item.click();
    await screenshot(alphaPage!, '07-scheduled');
    await alphaPage!.locator('.scheduled-add-watch').click();
    assert.equal(await alphaPage!.locator('.scheduled-add-watch').getAttribute('aria-expanded'), 'true');
    await alphaPage!.getByLabel('HTTPS URL').waitFor({ state: 'visible' });
    await alphaPage!.getByRole('button', { name: 'Close monitor form' }).click();
    await detail.getByRole('button', { name: 'Open conversation' }).click();
    await alphaPage!.locator('.topbar > span').filter({ hasText: scheduledTask }).waitFor({ state: 'visible' });
    await clickNav(alphaPage!, 'Scheduled');
    await alphaPage!.getByTestId('scheduled-detail').getByRole('button', { name: 'Cancel schedule' }).click();
    await alphaPage!.getByText('No scheduled tasks yet').first().waitFor({ state: 'visible' });
    await alphaPage!.getByTestId('scheduled-new-task').click();
    assert.equal(await alphaPage!.getByLabel('定期检查').isChecked(), true, 'New task from Scheduled did not enable the recurring-work option');
    await alphaPage!.getByLabel('重复频率').selectOption('weekly');
    await alphaPage!.getByLabel('星期一').check();
    await alphaPage!.getByLabel('定时时间').fill('23:59');
    await alphaPage!.getByLabel('时区').selectOption('Asia/Shanghai');
    const scheduleEndDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await alphaPage!.getByLabel('结束日期').fill(scheduleEndDate);
    await screenshot(alphaPage!, '07b-weekly-schedule-editor');
    const weeklyTask = 'E2E weekly schedule — summarize the Monday planning changes';
    await alphaPage!.getByPlaceholder('告诉 dot 接下来要负责什么…').fill(weeklyTask);
    await alphaPage!.locator('button.send').click();
    await alphaPage!.locator('.timeline .message.user p').filter({ hasText: weeklyTask }).waitFor({ state: 'visible' });
    await alphaPage!.waitForFunction(() => document.querySelector<HTMLInputElement>('.schedule-toggle input[type="checkbox"]')?.checked === false);
    await clickNav(alphaPage!, 'Scheduled');
    await alphaPage!.locator('.scheduled-item').filter({ hasText: weeklyTask }).waitFor({ state: 'visible' });
    const weeklyDetail = alphaPage!.getByTestId('scheduled-detail');
    await weeklyDetail.getByText('Weekly on Mon at 23:59 (Asia/Shanghai)', { exact: false }).waitFor({ state: 'visible' });
    assert.match(await weeklyDetail.innerText(), new RegExp(`until ${scheduleEndDate}`));
    await screenshot(alphaPage!, '07c-weekly-scheduled');
    await weeklyDetail.getByRole('button', { name: 'Cancel schedule' }).click();
  });

  await recordStep('Dot appearance changes persist within Alpha personal workspace', async () => {
    await alphaPage!.locator('.profile-link').click();
    await alphaPage!.getByLabel('桌面通知').check();
    await alphaPage!.getByText('此工作区已开启任务和网页监控提醒。', { exact: true }).waitFor({ state: 'visible' });
    await alphaPage!.getByLabel('名字').fill('Alpha Dot');
    await alphaPage!.getByRole('button', { name: '保存更改' }).click();
    await alphaPage!.locator('.profile-link strong').filter({ hasText: 'Alpha Dot' }).waitFor({ state: 'visible' });
    assert.equal(await alphaPage!.getByLabel('桌面通知').isChecked(), true);
    await screenshot(alphaPage!, '08-alpha-profile');
  });

  await recordStep('Create a separate shared workspace and task', async () => {
    await alphaPage!.locator('.workspace-switcher .new-workspace').click();
    await alphaPage!.getByLabel('新工作区名称').fill('Alpha Shared');
    await alphaPage!.locator('.workspace-switcher form').getByRole('button', { name: '创建' }).click();
    await alphaPage!.locator('.workspace-switcher select').locator('option', { hasText: 'Alpha Shared' }).waitFor({ state: 'attached' });
    await alphaPage!.waitForFunction(() => document.querySelector<HTMLInputElement>('input[aria-label="桌面通知"]')?.checked === false);
    assert.equal(await alphaPage!.getByLabel('桌面通知').isChecked(), false, 'A new tenant inherited personal notification preferences');
    await alphaPage!.locator('.profile-link strong').filter({ hasText: 'Dot' }).waitFor({ state: 'visible' });
    await clickNav(alphaPage!, '你的 dot');
    await createTask(alphaPage!, 'E2E shared workspace task — prepare the team review');
    await alphaPage!.locator('.task-links button').filter({ hasText: 'E2E shared workspace task' }).waitFor({ state: 'visible' });
    await alphaPage!.locator('.profile-link').click();
    await alphaPage!.getByLabel('名字').fill('Shared Dot');
    await alphaPage!.getByRole('button', { name: '保存更改' }).click();
    await alphaPage!.locator('.profile-link strong').filter({ hasText: 'Shared Dot' }).waitFor({ state: 'visible' });
    await screenshot(alphaPage!, '09-shared-workspace');
  });

  await recordStep('Invite the second signed-in account and verify member permissions', async () => {
    await alphaPage!.getByPlaceholder('teammate@example.com').fill('beta@example.test');
    await alphaPage!.getByRole('button', { name: '添加工作区成员' }).click();
    await alphaPage!.locator('.member-row').filter({ hasText: 'beta@example.test' }).waitFor({ state: 'visible' });
    await betaPage!.reload({ waitUntil: 'domcontentloaded' });
    await betaPage!.getByTestId('app-shell').waitFor({ state: 'visible' });
    await betaPage!.locator('.workspace-switcher option').filter({ hasText: 'Alpha Shared' }).waitFor({ state: 'attached' });
    await selectTenant(betaPage!, 'Alpha Shared');
    await betaPage!.locator('.task-links button').filter({ hasText: 'E2E shared workspace task' }).waitFor({ state: 'visible' });
    assert.equal(await betaPage!.locator('.profile-link strong').innerText(), 'Shared Dot');
    await betaPage!.locator('.profile-link').click();
    await betaPage!.locator('.member-row').filter({ hasText: 'alpha@example.test' }).waitFor({ state: 'visible' });
    assert.equal(await betaPage!.getByRole('button', { name: '添加工作区成员' }).isDisabled(), true, 'A regular member received workspace-admin controls');
    await screenshot(betaPage!, '10-beta-shared-member');
  });

  await recordStep('Tenant switch hides shared data from Beta personal workspace', async () => {
    await clickNav(betaPage!, '你的 dot');
    await selectTenant(betaPage!, 'Beta workspace');
    await betaPage!.locator('.task-links button').filter({ hasText: 'E2E shared workspace task' }).waitFor({ state: 'detached' });
    await assertNoVisibleText(betaPage!, 'E2E shared workspace task — prepare the team review');
    assert.equal(await betaPage!.locator('.task-links button').count(), 0);
    await screenshot(betaPage!, '11-beta-personal-isolation');
  });

  await recordStep('Restart the local service and recover both authenticated tenant sessions and task data', async () => {
    testModelBaseUrl = await startMockModel();
    testModelApiKey = 'e2e-local-only';
    testModelName = 'e2e-model';
    await restartService();
    await alphaPage!.reload({ waitUntil: 'domcontentloaded' });
    await betaPage!.reload({ waitUntil: 'domcontentloaded' });
    await alphaPage!.getByTestId('app-shell').waitFor({ state: 'visible' });
    await betaPage!.getByTestId('app-shell').waitFor({ state: 'visible' });
    await alphaPage!.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true', null, { timeout: 10_000 });
    await betaPage!.waitForFunction(() => document.querySelector('[data-testid="app-shell"]')?.getAttribute('data-state-loaded') === 'true', null, { timeout: 10_000 });
    await selectTenant(alphaPage!, 'Alpha Shared');
    await alphaPage!.locator('.profile-link').click();
    assert.equal(await alphaPage!.getByLabel('桌面通知').isChecked(), false, 'Alpha Shared lost its independent notification preference after restart');
    await selectTenant(alphaPage!, 'Alpha workspace');
    assert.equal(await alphaPage!.getByLabel('桌面通知').isChecked(), true, 'Alpha personal notification preference did not survive service restart');
    await selectTenant(alphaPage!, 'Alpha Shared');
    await clickNav(alphaPage!, '你的 dot');
    await alphaPage!.locator('.task-links button').filter({ hasText: 'E2E shared workspace task' }).waitFor({ state: 'visible' });
    await selectTenant(betaPage!, 'Alpha Shared');
    await betaPage!.locator('.task-links button').filter({ hasText: 'E2E shared workspace task' }).waitFor({ state: 'visible' });
    await screenshot(alphaPage!, '12-alpha-after-service-restart');
    await screenshot(betaPage!, '13-beta-after-service-restart');
    await selectTenant(betaPage!, 'Beta workspace');
    await betaPage!.locator('.task-links button').filter({ hasText: 'E2E shared workspace task' }).waitFor({ state: 'detached' });
  });

  await recordStep('A user reply resumes a waiting task while retaining the original goal', async () => {
    await selectTenant(alphaPage!, 'Alpha workspace');
    assert.equal(await alphaPage!.getByTestId('app-shell').getAttribute('data-tenant-id'), 'legacy');
    const originalGoal = 'Prepare the project launch plan';
    await createTask(alphaPage!, originalGoal);
    await alphaPage!.locator('.timeline .pill.waiting').waitFor({ state: 'visible', timeout: 15_000 });
    await alphaPage!.locator('.timeline .message.dot p').filter({ hasText: 'What launch date should I use?' }).waitFor({ state: 'visible' });
    await alphaPage!.getByPlaceholder('回复 dot 的问题…').fill('Use Friday.');
    await alphaPage!.getByRole('button', { name: '回复并继续' }).click();
    await alphaPage!.locator('.timeline .message.user p').filter({ hasText: 'Use Friday.' }).waitFor({ state: 'visible' });
    await alphaPage!.locator('.timeline .pill.done').waitFor({ state: 'visible', timeout: 15_000 });
    await alphaPage!.locator('.task-links button').filter({ hasText: originalGoal }).waitFor({ state: 'visible' });
    assert.equal(mockModelPrompts.length, 2, 'The model did not receive both the original task and the reply');
    assert.match(mockModelPrompts[1], /Task: Prepare the project launch plan\n\nUser reply: Use Friday\./);
    await screenshot(alphaPage!, '17-waiting-task-resumed');
    await selectTenant(alphaPage!, 'Alpha Shared');
  });

  await recordStep('Recurring work runs again automatically and remains cancellable in Chrome', async () => {
    await selectTenant(alphaPage!, 'Alpha workspace');
    const instruction = 'E2E recurring run — verify due work reruns automatically';
    const promptCount = () => mockModelPrompts.filter(prompt => prompt.includes(instruction)).length;
    const initialCount = promptCount();
    await clickNav(alphaPage!, '你的 dot');
    await alphaPage!.getByLabel('定期检查').check();
    await alphaPage!.getByLabel('重复频率').selectOption('interval');
    await alphaPage!.locator('input.minutes').fill('1');
    await alphaPage!.getByPlaceholder('告诉 dot 接下来要负责什么…').fill(instruction);
    await alphaPage!.locator('button.send').click();
    await alphaPage!.locator('.timeline .message.dot p').filter({ hasText: 'The recurring check completed.' }).waitFor({ state: 'visible', timeout: 15_000 });
    await alphaPage!.locator('.timeline .pill.scheduled').waitFor({ state: 'visible', timeout: 15_000 });
    await waitFor(() => promptCount() === initialCount + 1, 15_000);
    await screenshot(alphaPage!, '07d-recurring-run-completed');

    await waitFor(() => promptCount() === initialCount + 2, 80_000);
    await alphaPage!.waitForFunction(async instructionText => {
      const response = await fetch('/api/state');
      const state = await response.json() as { tasks: { instruction: string; status: string; nextRunAt: string | null }[] };
      const task = state.tasks.find(item => item.instruction === instructionText);
      return task?.status === 'scheduled' && Boolean(task.nextRunAt) && Date.parse(task.nextRunAt!) > Date.now();
    }, instruction, { timeout: 20_000 });

    await clickNav(alphaPage!, 'Scheduled');
    const item = alphaPage!.locator('.scheduled-item').filter({ hasText: instruction });
    await item.waitFor({ state: 'visible' });
    await item.click();
    const detail = alphaPage!.getByTestId('scheduled-detail');
    await detail.getByText('Every 1 minute', { exact: true }).waitFor({ state: 'visible' });
    await detail.getByText('The recurring check completed.', { exact: false }).waitFor({ state: 'visible' });
    await screenshot(alphaPage!, '07e-recurring-run-rescheduled');
    await detail.getByRole('button', { name: 'Cancel schedule' }).click();
    await item.waitFor({ state: 'detached' });
    assert.equal(promptCount(), initialCount + 2, 'The interval did not trigger exactly one automatic follow-up run');
    await selectTenant(alphaPage!, 'Alpha Shared');
  });

  await recordStep('Alpha shared-workspace computer opens under the shared Dot identity', async () => {
    await clickNav(alphaPage!, '电脑');
    await alphaPage!.getByRole('heading', { name: 'Shared Dot 的电脑' }).waitFor({ state: 'visible' });
    await alphaPage!.getByRole('button', { name: '打开电脑' }).click();
    await alphaPage!.getByRole('button', { name: '接管' }).waitFor({ state: 'visible', timeout: 20_000 });
    await alphaPage!.getByRole('status').filter({ hasText: 'Shared Dot 正在控制' }).waitFor({ state: 'visible' });
    await screenshot(alphaPage!, '14-computer-dot-control');
  });

  await recordStep('Beta personal computer remains isolated from Alpha shared computer', async () => {
    await clickNav(betaPage!, '电脑');
    await betaPage!.getByRole('heading', { name: 'Dot 的电脑' }).waitFor({ state: 'visible' });
    await betaPage!.getByRole('button', { name: '打开电脑' }).waitFor({ state: 'visible' });
    assert.equal(await betaPage!.locator('.browser-frame').count(), 0, 'Beta inherited another tenant’s already-open computer');
    await betaPage!.getByRole('button', { name: '打开电脑' }).click();
    await betaPage!.getByRole('status').filter({ hasText: 'Dot 正在控制' }).waitFor({ state: 'visible', timeout: 20_000 });
    assert.equal(await alphaPage!.getByRole('status').filter({ hasText: 'Shared Dot 正在控制' }).count(), 1, 'Opening Beta’s computer changed Alpha’s control owner');
    await screenshot(betaPage!, '14-beta-private-computer');
  });

  await recordStep('Computer user input stays disabled until explicit takeover', async () => {
    const addressBar = alphaPage!.locator('.browser-toolbar input');
    assert.equal(await addressBar.isDisabled(), true, 'Browser navigation is enabled before takeover');
    await alphaPage!.getByRole('button', { name: '接管' }).click();
    await alphaPage!.getByRole('status').filter({ hasText: '你正在控制' }).waitFor({ state: 'visible' });
    await screenshot(alphaPage!, '14-computer-takeover');
  });

  await recordStep('Computer takeover performs real browser navigation, click, text input, and return', async () => {
    const addressBar = alphaPage!.locator('.browser-toolbar input');
    await addressBar.fill(`${baseUrl}/e2e-computer-fixture.html`);
    await addressBar.press('Enter');
    await alphaPage!.getByText('Dot E2E Computer Fixture', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
    const image = alphaPage!.getByAltText('独立浏览器画面');
    await alphaPage!.waitForFunction(() => {
      const screenshot = document.querySelector<HTMLImageElement>('img[alt="独立浏览器画面"]');
      return Boolean(screenshot?.complete && screenshot.naturalWidth >= 1200 && screenshot.naturalHeight >= 650);
    }, null, { timeout: 20_000 });
    const box = await image.boundingBox();
    assert(box && box.width > 0 && box.height > 0, 'Computer screenshot did not have a visible image box');
    await image.click({ position: { x: (112 + 165) * box.width / 1280, y: (82 + 32) * box.height / 720 } });
    await alphaPage!.getByText('Dot E2E Clicked', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
    const refreshedBox = await image.boundingBox();
    assert(refreshedBox, 'Computer screenshot disappeared after click');
    await image.click({ position: { x: (112 + 165) * refreshedBox.width / 1280, y: (180 + 32) * refreshedBox.height / 720 } });
    await alphaPage!.locator('.computer-footer input').fill('typed by takeover');
    await alphaPage!.getByRole('button', { name: '输入' }).click();
    await alphaPage!.getByText('Dot E2E Typed: typed by takeover', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
    await screenshot(alphaPage!, '15-computer-typed');
    await alphaPage!.getByRole('button', { name: '交还控制' }).click();
    await alphaPage!.getByRole('status').filter({ hasText: 'Shared Dot 正在控制' }).waitFor({ state: 'visible' });
    assert.equal(await alphaPage!.locator('.browser-toolbar input').isDisabled(), true, 'Navigation remained enabled after control was returned');
    await screenshot(alphaPage!, '16-computer-returned');
  });

  assert.deepEqual(pageErrors, [], `Browser runtime errors: ${pageErrors.join('; ')}`);
} catch (error) {
  failure = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);
  if (alphaPage) await alphaPage.screenshot({ path: join(artifactRoot, 'failure-alpha.png'), fullPage: true }).catch(() => undefined);
  if (betaPage) await betaPage.screenshot({ path: join(artifactRoot, 'failure-beta.png'), fullPage: true }).catch(() => undefined);
  throw error;
} finally {
  if (alphaContext) await alphaContext.tracing.stop({ path: join(artifactRoot, 'alpha-trace.zip') }).catch(() => undefined);
  if (betaContext) await betaContext.tracing.stop({ path: join(artifactRoot, 'beta-trace.zip') }).catch(() => undefined);
  await alphaContext?.close().catch(() => undefined);
  await betaContext?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await stopServer(server);
  if (mockModelServer) await new Promise<void>(resolvePromise => mockModelServer!.close(() => resolvePromise()));
  testModelBaseUrl = '';
  testModelApiKey = '';
  testModelName = '';
  await writeFile(join(artifactRoot, 'server.log'), serverLogs.join(''));
  const videoFiles = (await readdir(videoDir)).filter(name => name.endsWith('.webm')).map(name => `video/${name}`);
  await writeFile(join(artifactRoot, 'manifest.json'), JSON.stringify({
    runAt: new Date().toISOString(),
    viewport: { width: 1440, height: 1000 },
    testService: `http://127.0.0.1:${e2ePort}`,
    browser: chromePath,
    steps,
    screenshots: screenshotNames,
    videos: videoFiles,
    pageErrors,
    failure,
  }, null, 2) + '\n');
  await appendFile(join(artifactRoot, 'server.log'), '\n');
  await rm(fixtureDestination, { force: true });
  await rm(tempRoot, { recursive: true, force: true });
  console.log(`E2E evidence: ${artifactRoot}`);
}

if (failure) throw new Error(failure);
console.log(`PASS ${steps.length} browser E2E steps`);
