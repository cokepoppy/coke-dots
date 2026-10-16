import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRendererHealthMonitor, RendererUnresponsiveError } from '../deploy/linux-desktop/renderer-health.mjs';

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
  assert.equal(calls, 1, 'concurrent readiness checks must share one CDP operation');
  finish();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(monitor.unresponsive, false);
});

test('a stalled renderer fails closed without accumulating pending CDP calls', async () => {
  const monitor = createRendererHealthMonitor(25);
  let calls = 0;
  const pendingProbe = () => { calls += 1; return new Promise<void>(() => undefined); };

  const started = Date.now();
  assert.equal(await monitor.check(pendingProbe), false);
  assert(Date.now() - started < 250, 'a timed out CDP probe must return before the control-plane timeout');
  assert.equal(monitor.unresponsive, true);
  assert.equal(await monitor.check(pendingProbe), false);
  assert.equal(calls, 1, 'the worker must not queue another CDP call while Chromium is being recovered');
  await assert.rejects(monitor.run(pendingProbe), RendererUnresponsiveError);
  assert.equal(calls, 1);
  monitor.reset();
  assert.equal(monitor.unresponsive, false);
});

test('page operations fail with a typed timeout and remain latched until reset', async () => {
  const monitor = createRendererHealthMonitor(20);
  await assert.rejects(monitor.run(() => new Promise<void>(() => undefined)), RendererUnresponsiveError);
  assert.equal(monitor.unresponsive, true);
  await assert.rejects(monitor.run(async () => undefined), RendererUnresponsiveError);
});
