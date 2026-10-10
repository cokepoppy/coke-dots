import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserContextUnavailableError, createRendererHealthMonitor, getBrowserPage, isMissingBrowserContextPagesError, RendererUnresponsiveError, waitForDefaultBrowserContext } from '../deploy/linux-desktop/renderer-health.mjs';

test('CDP context startup races wait for Chromium to publish its default context', async () => {
  const expectedContext = { pages: () => [] };
  let available = false;
  const browser = { isConnected: () => true, contexts: () => available ? [expectedContext] : [] };
  setTimeout(() => { available = true; }, 20);
  assert.equal(await waitForDefaultBrowserContext(browser, { timeoutMs: 150, pollIntervalMs: 5 }), expectedContext);
});

test('a CDP client without a default context returns a typed recoverable health error', async () => {
  const browser = { isConnected: () => true, contexts: () => [] };
  await assert.rejects(
    waitForDefaultBrowserContext(browser, { timeoutMs: 15, pollIntervalMs: 2 }),
    BrowserContextUnavailableError,
  );
});

test('a disconnected CDP client does not leak a raw context or pages TypeError', async () => {
  const browser = { isConnected: () => false, contexts: () => [] };
  await assert.rejects(waitForDefaultBrowserContext(browser), BrowserContextUnavailableError);
});

test('only the missing default-context pages TypeError is classified for Chromium recovery', () => {
  assert.equal(isMissingBrowserContextPagesError(new TypeError("Cannot read properties of undefined (reading 'pages')")), true);
  assert.equal(isMissingBrowserContextPagesError(new TypeError("Cannot read properties of null (reading 'pages')")), true);
  assert.equal(isMissingBrowserContextPagesError(new TypeError("Cannot read properties of undefined (reading 'cookies')")), false);
  assert.equal(isMissingBrowserContextPagesError(new Error("Cannot read properties of undefined (reading 'pages')")), false);
});

test('a context that disappears before page access becomes a typed recoverable error', async () => {
  await assert.rejects(getBrowserPage(undefined), BrowserContextUnavailableError);
  await assert.rejects(getBrowserPage(null), BrowserContextUnavailableError);
});

test('renderer health checks share one successful page probe', async () => {
  const monitor = createRendererHealthMonitor(100);
  let calls = 0;
  let finish!: () => void;
  const probe = () => {
    calls += 1;
    return new Promise<void>(resolve => { finish = resolve; });
  };

  const first = monitor.check(probe);
  const second = monitor.check(probe);
  await Promise.resolve();
  assert.equal(calls, 1, 'concurrent liveness and readiness requests must share one CDP operation');
  finish();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(monitor.unresponsive, false);
});

test('a stalled renderer fails closed and does not accumulate pending CDP calls', async () => {
  const monitor = createRendererHealthMonitor(25);
  let calls = 0;
  const pendingProbe = () => { calls += 1; return new Promise<void>(() => undefined); };

  const started = Date.now();
  assert.equal(await monitor.check(pendingProbe), false);
  assert(Date.now() - started < 250, 'the worker must answer before the control-plane 30-second timeout');
  assert.equal(monitor.unresponsive, true);
  assert.equal(await monitor.check(pendingProbe), false);
  assert.equal(calls, 1, 'a hung CDP promise must not be retried while Chromium is being recovered');
  await assert.rejects(monitor.run(pendingProbe), RendererUnresponsiveError);
  assert.equal(calls, 1);
  monitor.reset();
  assert.equal(monitor.unresponsive, false, 'the monitor can resume probes after Chromium is relaunched');
});

test('page operations become a sticky renderer failure when their deadline expires', async () => {
  const monitor = createRendererHealthMonitor(20);
  await assert.rejects(monitor.run(() => new Promise<void>(() => undefined)), RendererUnresponsiveError);
  assert.equal(monitor.unresponsive, true);
  await assert.rejects(monitor.run(async () => undefined), RendererUnresponsiveError);
});
