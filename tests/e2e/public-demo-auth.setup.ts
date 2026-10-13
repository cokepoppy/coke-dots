import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { makeDotsOnlyStorageState } from './public-demo-auth-state.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const baseUrl = new URL(process.env.DOTS_PUBLIC_DEMO_URL || 'https://codex.cokeagent.com/dots-demo/');
const basePath = baseUrl.pathname.endsWith('/') ? baseUrl.pathname : `${baseUrl.pathname}/`;
const statePathValue = process.env.DOTS_PUBLIC_DEMO_STORAGE_STATE;
const statePath = statePathValue && resolve(statePathValue);
const browserPath = process.env.DOTS_CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (baseUrl.protocol !== 'https:' || basePath !== baseUrl.pathname) {
  throw new Error('Set DOTS_PUBLIC_DEMO_URL to an HTTPS URL ending in a slash.');
}
if (!statePathValue || !isAbsolute(statePathValue) || !statePath) {
  throw new Error('Set DOTS_PUBLIC_DEMO_STORAGE_STATE to an absolute path outside the repository.');
}
const stateRelativePath = relative(projectRoot, statePath);
if (stateRelativePath === '' || (!stateRelativePath.startsWith('..') && !isAbsolute(stateRelativePath))) {
  throw new Error('The login state must be saved outside the repository.');
}

const temporaryProfile = await mkdtemp(resolve(tmpdir(), 'coke-dots-public-auth-'));
await chmod(temporaryProfile, 0o700);
let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | null = null;
try {
  context = await chromium.launchPersistentContext(temporaryProfile, {
    executablePath: browserPath,
    headless: false,
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = context.pages()[0] || await context.newPage();
  const response = await page.goto(baseUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.bringToFront();
  assert.equal(response?.status(), 200, 'The public Dots sign-in page must load');
  await page.getByRole('link', { name: '使用 Google 登录' }).click();
  await page.waitForURL(url => url.hostname === 'accounts.google.com', { waitUntil: 'commit', timeout: 20_000 });
  await page.bringToFront();
  console.log('Chrome 已打开 Google 登录。请在此窗口完成专用测试账号的登录；脚本不会读取或保存 Google 密码。');

  await page.waitForURL(url => url.origin === baseUrl.origin && url.pathname === basePath, { waitUntil: 'domcontentloaded', timeout: 5 * 60_000 });
  await page.getByTestId('app-shell').waitFor({ state: 'visible', timeout: 30_000 });
  const auth = await page.evaluate(async () => {
    const response = await fetch('api/auth/me', { cache: 'no-store' });
    return { status: response.status, body: response.ok ? await response.json() as { tenant?: { id?: string } } : null };
  });
  assert.equal(auth.status, 200, 'Google sign-in must produce an authenticated Dots session');
  assert(auth.body?.tenant?.id, 'The signed-in response must identify the active tenant');

  const currentState = await context.storageState();
  const minimalState = makeDotsOnlyStorageState(currentState, baseUrl, basePath);

  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  await writeFile(statePath, JSON.stringify(minimalState, null, 2) + '\n', { mode: 0o600 });
  await chmod(statePath, 0o600);
  console.log(`已保存仅含 Coke Dots 会话 Cookie 的登录态：${statePath}`);
  console.log('Google 自身 Cookie、OAuth 临时状态和其他来源的本地存储均未写入该文件。');
} finally {
  if (context) await context.close();
  await rm(temporaryProfile, { recursive: true, force: true });
}
