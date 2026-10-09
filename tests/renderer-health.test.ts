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
