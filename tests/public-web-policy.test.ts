import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchPublicPageHtml, isE2EBrowserResearchFixture, isE2EComputerUiFixture, isPublicIpAddress, sanitizePublicHtml, validatePublicHttpsUrl } from '../src/shared/public-web-policy.mjs';

const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];

test('public web policy accepts only ordinary HTTPS URLs with public DNS answers', async () => {
  assert.equal(await validatePublicHttpsUrl('https://research.example.org/launch', { lookup: publicLookup }), 'https://research.example.org/launch');
  for (const url of [
    'http://research.example.org/',
    'file:///etc/passwd',
    'https://user:pass@research.example.org/',
    'https://research.example.org:8443/',
    'https://research.example.org/#private-fragment',
    'https://localhost/',
    'https://service.internal/',
    'https://metadata.google.internal/',
    'https://127.0.0.1/',
    'https://[::1]/',
  ]) await assert.rejects(validatePublicHttpsUrl(url, { lookup: publicLookup }), error => error instanceof Error, url);
  await assert.rejects(validatePublicHttpsUrl('https://mixed.example.org/', { lookup: async () => [
    { address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 },
  ] }), /私有或保留地址/);
});

test('public IP screening excludes private, link-local, documentation, multicast and transition ranges', () => {
  for (const address of [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.0.1', '192.0.0.10', '192.0.2.1', '192.168.1.1', '198.18.0.1',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002::1', '::ffff:192.168.1.2',
  ]) assert.equal(isPublicIpAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicIpAddress(address), true, address);
});

test('E2E web fixture is enabled only for its exact URL in authenticated test mode', () => {
  const environment = { NODE_ENV: 'test', DOTS_E2E_AUTH: '1', DOTS_E2E_COMPUTER_RESEARCH_FIXTURE_URL: 'https://research-fixture.dots.test/launch' } as NodeJS.ProcessEnv;
  assert.equal(isE2EBrowserResearchFixture('https://research-fixture.dots.test/launch', environment), true);
  assert.equal(isE2EBrowserResearchFixture('https://research-fixture.dots.test/launch?extra=1', environment), false);
  assert.equal(isE2EBrowserResearchFixture('https://research-fixture.dots.test/launch', { ...environment, DOTS_E2E_AUTH: '0' }), false);
  assert.equal(isE2EBrowserResearchFixture('https://research-fixture.dots.test/launch', { ...environment, NODE_ENV: 'production' }), false);
});

test('cloud computer UI demo fixture is enabled only for its exact URL in authenticated test mode', async () => {
  const environment = { NODE_ENV: 'test', DOTS_E2E_AUTH: '1', DOTS_E2E_COMPUTER_UI_FIXTURE_URL: 'https://activity-fixture.dots.test/open' } as NodeJS.ProcessEnv;
  assert.equal(isE2EComputerUiFixture('https://activity-fixture.dots.test/open', environment), true);
  assert.equal(isE2EComputerUiFixture('https://activity-fixture.dots.test/open?extra=1', environment), false);
  assert.equal(isE2EComputerUiFixture('https://activity-fixture.dots.test/open', { ...environment, DOTS_E2E_AUTH: '0' }), false);
  assert.equal(await validatePublicHttpsUrl('https://activity-fixture.dots.test/open', { environment }), 'https://activity-fixture.dots.test/open');
});

test('webpage snapshot sanitizer keeps readable text but removes executable and network-capable markup', () => {
  const sanitized = sanitizePublicHtml('<!doctype html><html><head><title>Launch</title><script>steal()</script><link rel="stylesheet" href="https://attacker.invalid/x.css"></head><body><main><h1 id="title" onclick="steal()">Public launch</h1><p style="background:url(https://attacker.invalid/x)">Release criteria: harden session recovery.</p><img src="https://attacker.invalid/pixel" alt="Chart"><iframe src="https://attacker.invalid/frame"></iframe><a href="https://attacker.invalid/">source</a></main></body></html>');
  assert.match(sanitized, /<title>Launch<\/title>/);
  assert.match(sanitized, /Public launch/);
  assert.match(sanitized, /Release criteria: harden session recovery\./);
  assert.match(sanitized, /alt="Chart"/);
  assert.doesNotMatch(sanitized, /steal\(\)|onclick|attacker\.invalid|<script|<iframe|style=/i);
});

test('public page reader revalidates every redirect and bounds its response', async () => {
  const lookedUp: string[] = [];
  const requested: string[] = [];
  const result = await fetchPublicPageHtml('https://source.example.org/start', {
    lookup: async hostname => { lookedUp.push(hostname); return [{ address: '8.8.8.8', family: 4 }]; },
    request: async resolved => {
      requested.push(resolved.url.href);
      if (requested.length === 1) return { status: 302, headers: { location: 'https://final.example.org/notes' }, body: Buffer.alloc(0) };
      return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from('<title>Notes</title><p>Public result</p><script>secret()</script>') };
    },
  });
  assert.deepEqual(lookedUp, ['source.example.org', 'final.example.org']);
  assert.deepEqual(requested, ['https://source.example.org/start', 'https://final.example.org/notes']);
  assert.equal(result.url, 'https://final.example.org/notes');
  assert.match(result.html, /Public result/);
  assert.doesNotMatch(result.html, /secret\(\)/);

  const privateRedirectRequests: string[] = [];
  await assert.rejects(fetchPublicPageHtml('https://source.example.org/start', {
    lookup: async hostname => [{ address: hostname === 'private.example.org' ? '127.0.0.1' : '8.8.8.8', family: 4 }],
    request: async resolved => {
      privateRedirectRequests.push(resolved.url.href);
      return { status: 302, headers: { location: 'https://private.example.org/metadata' }, body: Buffer.alloc(0) };
    },
  }), /私有或保留地址/);
  assert.deepEqual(privateRedirectRequests, ['https://source.example.org/start'], 'A private redirect must be rejected before it is requested');

  await assert.rejects(fetchPublicPageHtml('https://source.example.org/download', {
    lookup: publicLookup,
    request: async () => ({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('binary') }),
  }), /只读取 HTML 或纯文本/);
  await assert.rejects(fetchPublicPageHtml('https://source.example.org/large', {
    lookup: publicLookup,
    request: async () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.alloc(3 * 1024 * 1024 + 1) }),
  }), /超过 3 MB/);
});

test('public DNS validation stops waiting when the task is aborted', async () => {
  const controller = new AbortController();
  const pending = validatePublicHttpsUrl('https://slow.example.org/', {
    signal: controller.signal,
    dnsTimeoutMs: 30_000,
    lookup: async () => new Promise(() => {}),
  });
  controller.abort(new Error('research task stopped'));
  await assert.rejects(pending, /无法验证该网站的公网地址/);
});
