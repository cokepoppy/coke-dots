import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import sharp from 'sharp';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifactRoot = resolve(process.env.DOTS_E2E_ARTIFACTS || join(projectRoot, 'artifacts', 'e2e', `public-demo-${runStamp}`));
const screenshotPath = join(artifactRoot, 'public-demo-login.png');
const videoDirectory = join(artifactRoot, 'video');
const showcaseVideos = await Promise.all([
  { file: 'proactive-release-date-conflict.webp', width: 1152, height: 800 },
  { file: 'cloud-computer-handoff.webp', width: 1152, height: 784 },
  { file: 'cloud-computer-agent-actions.webp', width: 1152, height: 784, minimumDurationSeconds: 9, minimumFrames: 80 },
].map(async video => {
  const bytes = await readFile(join(projectRoot, 'public', 'demos', video.file));
  const metadata = await sharp(bytes, { animated: true }).metadata();
  return {
    ...video,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    frames: metadata.pages || 0,
    durationSeconds: (metadata.delay || []).reduce((sum, delay) => sum + delay, 0) / 1000,
  };
}));
const baseUrl = new URL(process.env.DOTS_PUBLIC_DEMO_URL || 'https://codex.cokeagent.com/dots-demo/');
const basePath = baseUrl.pathname.endsWith('/') ? baseUrl.pathname : `${baseUrl.pathname}/`;
const browserPath = findChromePath();
const result: { checks: string[]; failures: string[]; statuses: Record<string, number>; googleConfigured: boolean | null } = { checks: [], failures: [], statuses: {}, googleConfigured: null };
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

function findChromePath() {
  const candidates = [process.env.DOTS_CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  const path = candidates.find(candidate => candidate && existsSync(candidate));
  if (!path) throw new Error('Chrome was not found. Set DOTS_CHROME_BIN to a local Chrome executable.');
  return path;
}

async function get(pathname: string, options: { redirect?: RequestRedirect } = {}) {
  const url = new URL(pathname, baseUrl.origin);
  const response = await fetch(url, { redirect: options.redirect || 'follow', signal: AbortSignal.timeout(20_000) });
  result.statuses[`${url.origin}${url.pathname}`] = response.status;
  return response;
}

async function check(name: string, run: () => Promise<void>) {
  await run();
  result.checks.push(name);
  console.log(`PASS ${name}`);
}

await mkdir(videoDirectory, { recursive: true });

try {
  assert.equal(baseUrl.protocol, 'https:', 'The public demo must use HTTPS');
  assert.equal(basePath, baseUrl.pathname, 'DOTS_PUBLIC_DEMO_URL must end with a slash');
  await check('the public no-slash URL redirects only to the Dots path', async () => {
    const response = await get(basePath.slice(0, -1), { redirect: 'manual' });
    assert.equal(response.status, 301);
    const location = response.headers.get('location');
    assert(location, 'The no-slash Dots route must provide a redirect target');
    const target = new URL(location, baseUrl.origin);
    assert.equal(target.origin, baseUrl.origin);
    assert.equal(target.pathname, basePath);
    assert.equal(target.search, '');
    await response.body?.cancel();
  });

  await check('the public Dots health and auth configuration endpoints are healthy', async () => {
    const health = await get(`${basePath}api/health`);
    assert.equal(health.status, 200);
    assert.match(health.headers.get('content-type') || '', /^application\/json/i);
    assert.deepEqual(await health.json(), { ok: true });
    const config = await get(`${basePath}api/auth/config`);
    assert.equal(config.status, 200);
    assert.match(config.headers.get('content-type') || '', /^application\/json/i);
    const body = await config.json() as { googleConfigured?: unknown; e2eAuthAvailable?: unknown };
    assert.equal(typeof body.googleConfigured, 'boolean');
    assert.equal(body.googleConfigured, true, 'The public demo must keep Google sign-in enabled');
    assert.equal(body.e2eAuthAvailable, false, 'Production must not expose the E2E sign-in fixture');
    result.googleConfigured = body.googleConfigured as boolean;
  });

  await check('the existing public application routes still respond', async () => {
    const routes = [
      { path: '/', status: 200, type: /^text\/html/i },
      { path: '/auth/', status: 200, type: /^text\/html/i },
      { path: '/router/', status: 200, type: /^text\/html/i },
      { path: '/app/', status: 200, type: /^text\/html/i },
      { path: '/block-crush/', status: 200, type: /^text\/html/i },
      { path: '/rpg/', status: 200, type: /^text\/html/i },
      { path: '/fish-sort/', status: 200, type: /^text\/html/i },
      { path: '/sandbox/', status: 200, type: /^text\/html/i },
      { path: '/finance-gateway/', status: 401, type: /^application\/json/i },
      { path: '/web-research-gateway/', status: 401, type: /^application\/json/i },
      { path: '/assets/', status: 403, type: /^text\/html/i },
      { path: '/home/', status: 403, type: /^text\/html/i },
      { path: '/downloads/', status: 403, type: /^text\/html/i },
    ];
    for (const route of routes) {
      const { path, status: expectedStatus, type } = route;
      const response = await fetch(new URL(path, baseUrl.origin), { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
      result.statuses[`${baseUrl.origin}${path}`] = response.status;
      assert.equal(response.status, expectedStatus, `${path} returned unexpected HTTP ${response.status}`);
      assert.match(response.headers.get('content-type') || '', type, `${path} returned an unexpected content type`);
      await response.body?.cancel();
    }
  });

  await check('hosted demos are complete animated WebP artifacts with readable timing', async () => {
    for (const video of showcaseVideos) {
      const minimumFrames = 'minimumFrames' in video && typeof video.minimumFrames === 'number' ? video.minimumFrames : 16;
      assert(video.frames >= minimumFrames, `${video.file} must contain a full animated sequence, not a short slide show`);
      if ('minimumDurationSeconds' in video && typeof video.minimumDurationSeconds === 'number') {
        assert(video.durationSeconds >= video.minimumDurationSeconds, `${video.file} must remain long enough to read the computer actions at the documented presentation speed`);
      }
      const response = await get(`${basePath}demos/${video.file}`);
      assert.equal(response.status, 200, `${video.file} must be hosted`);
      assert.match(response.headers.get('content-type') || '', /^image\/webp/i, `${video.file} must use the WebP media type`);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert(bytes.length > 10_000, `${video.file} is unexpectedly small`);
      assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF');
      assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WEBP');
      assert.equal(createHash('sha256').update(bytes).digest('hex'), video.sha256, `${video.file} must match the locally verified WebP byte-for-byte`);
    }
  });

  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, recordVideo: { dir: videoDirectory, size: { width: 1440, height: 1000 } } });
  page = await context.newPage();
  page.on('pageerror', error => result.failures.push(error.message));
  page.on('response', response => {
    const url = new URL(response.url());
    const expectedAnonymousState = response.status() === 401 && url.pathname.endsWith('/api/auth/me');
    if (url.origin === baseUrl.origin && response.status() >= 400 && !expectedAnonymousState) result.failures.push(`${response.status()} ${url.pathname}`);
  });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

  await check('Chrome loads the public Dots page and prefixed assets', async () => {
    // The app keeps its event stream open, so networkidle is not a valid readiness signal.
    const response = await page!.goto(baseUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    assert.equal(response?.status(), 200);
    assert.match(response?.headers()['content-type'] || '', /^text\/html/i);
    await page!.getByRole('heading', { name: '让你的个人代理持续推进工作' }).waitFor({ state: 'visible' });
    assert.equal(await page!.title(), 'Coke Dots');
    const assets = await page!.locator('script[src], link[rel="stylesheet"][href]').evaluateAll(elements => elements.map(element => {
      const attribute = element instanceof HTMLScriptElement ? 'src' : 'href';
      return new URL(element.getAttribute(attribute) || '', location.href).pathname;
    }));
    assert(assets.length >= 2, 'The public page did not load its JavaScript and stylesheet bundles');
    for (const asset of assets) assert(asset.startsWith(basePath), `Asset escaped the mounted Dots path: ${asset}`);
    await page!.screenshot({ path: screenshotPath, animations: 'disabled' });
  });

  await check('Chrome presents the auth state without opening an external consent screen', async () => {
    const config = await page!.evaluate(async () => await fetch('api/auth/config').then(response => response.json()) as { googleConfigured: boolean; e2eAuthAvailable: boolean });
    assert.equal(config.googleConfigured, true, 'The public demo must keep Google sign-in enabled');
    assert.equal(config.e2eAuthAvailable, false);
    await page!.getByRole('link', { name: '使用 Google 登录' }).waitFor({ state: 'visible' });
    await page!.getByText('仅申请基本身份信息；Coke Dots 不会取得 Gmail 或 Google Drive 权限。', { exact: true }).waitFor({ state: 'visible' });
    assert.deepEqual(result.failures, [], `Public browser errors: ${result.failures.join('; ')}`);
  });

  await check('Chrome login click preserves OAuth state through the public callback', async () => {
    const config = await page!.evaluate(async () => await fetch('api/auth/config').then(response => response.json()) as { googleConfigured: boolean });
    assert.equal(config.googleConfigured, true, 'The public demo must keep Google sign-in enabled');
    const googleNavigation = page!.waitForURL(url => url.hostname === 'accounts.google.com', { waitUntil: 'commit', timeout: 20_000 });
    await page!.getByRole('link', { name: '使用 Google 登录' }).click();
    await googleNavigation;
    const oauth = new URL(page!.url());
    assert.equal(oauth.searchParams.get('redirect_uri'), `${baseUrl.origin}${basePath}auth/google/callback`);
    const callbackUrl = new URL('auth/google/callback', baseUrl).toString();
    const stateCookie = (await page!.context().cookies(callbackUrl)).find(cookie => cookie.name === 'coke_dots_oauth_state');
    assert(stateCookie, 'Chrome must retain the OAuth state cookie for the prefixed callback path');
    assert.equal(stateCookie.path, `${basePath}auth/google/callback`);
    assert.equal(stateCookie.httpOnly, true);
    assert.equal(stateCookie.secure, true);
    assert.equal(stateCookie.sameSite, 'Lax');
    assert.equal(oauth.searchParams.get('response_type'), 'code');
    assert.equal(oauth.searchParams.get('scope'), 'openid email profile');
    assert.equal(oauth.searchParams.get('code_challenge_method'), 'S256');
    const state = oauth.searchParams.get('state');
    assert(state);
    assert(oauth.searchParams.get('nonce'));

    // Exercise the deployed callback's state lookup without signing in a real account
    // or contacting Google's token endpoint. With no code, a valid cookie and flow
    // reach `invalid`; if either is missing, the app instead redirects with `expired`.
    const syntheticCallback = new URL('auth/google/callback', baseUrl);
    syntheticCallback.searchParams.set('state', state);
    await page!.goto(syntheticCallback.toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    assert.equal(new URL(page!.url()).pathname, basePath);
    assert.equal(new URL(page!.url()).searchParams.get('authError'), 'invalid', 'A fresh callback must pass state validation before rejecting the missing code');
    await page!.getByText('登录返回信息无效。', { exact: true }).waitFor({ state: 'visible' });
  });

  await check('Chrome decodes and plays changing frames from all hosted WebPs', async () => {
    await page!.goto(baseUrl.toString(), { waitUntil: 'domcontentloaded', timeout: 45_000 });
    for (const video of showcaseVideos) {
      await page!.evaluate(videoUrl => {
        document.body.innerHTML = '';
        document.body.style.margin = '0';
        const image = document.createElement('img');
        image.id = 'webp-playback';
        image.src = videoUrl;
        document.body.append(image);
      }, `${basePath}demos/${video.file}`);
      const image = page!.locator('#webp-playback');
      await image.evaluate(element => (element as HTMLImageElement).decode());
      assert.equal(await image.evaluate(element => (element as HTMLImageElement).naturalWidth), video.width, `${video.file} width`);
      assert.equal(await image.evaluate(element => (element as HTMLImageElement).naturalHeight), video.height, `${video.file} height`);
      const firstFrame = createHash('sha256').update(await page!.screenshot()).digest('hex');
      await page!.waitForTimeout('minimumDurationSeconds' in video ? 6000 : 2500);
      const laterFrame = createHash('sha256').update(await page!.screenshot()).digest('hex');
      assert.notEqual(firstFrame, laterFrame, `${video.file} should advance beyond its initial frame`);
      if ('minimumDurationSeconds' in video) {
        await page!.waitForTimeout(5000);
        const laterActionFrame = createHash('sha256').update(await page!.screenshot()).digest('hex');
        assert.notEqual(laterFrame, laterActionFrame, `${video.file} should continue through the cloud computer actions at normal speed`);
      }
    }
  });
} catch (error) {
  result.failures.push(error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error));
  if (page) await page.screenshot({ path: join(artifactRoot, 'failure.png'), fullPage: true }).catch(() => undefined);
  throw error;
} finally {
  if (context) {
    await context.tracing.stop({ path: join(artifactRoot, 'public-demo-trace.zip') }).catch(() => undefined);
    await context.close().catch(() => undefined);
  }
  await browser?.close().catch(() => undefined);
  const videoFiles = await readdir(videoDirectory).then(names => names.filter(name => name.endsWith('.webm')).map(name => `video/${name}`)).catch(() => [] as string[]);
  await writeFile(join(artifactRoot, 'manifest.json'), JSON.stringify({
    runAt: new Date().toISOString(),
    origin: baseUrl.origin,
    basePath,
    viewport: { width: 1440, height: 1000 },
    browser: browserPath,
    googleConfigured: result.googleConfigured,
    statuses: result.statuses,
    checks: result.checks,
    failures: result.failures,
    screenshots: existsSync(screenshotPath) ? ['public-demo-login.png'] : [],
    videos: videoFiles,
  }, null, 2) + '\n');
  console.log(`Public demo E2E evidence: ${artifactRoot}`);
}

if (result.failures.length) throw new Error(result.failures.join('\n'));
console.log(`PASS ${result.checks.length} public demo E2E checks`);
