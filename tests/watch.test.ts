import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.ts';
import { WatchRunner, validateWatchUrl } from '../src/server/watch.ts';

test('only explicit HTTPS pages can be monitored', () => {
  assert.equal(validateWatchUrl('https://example.com/page'), 'https://example.com/page');
  assert.throws(() => validateWatchUrl('http://example.com'));
  assert.throws(() => validateWatchUrl('https://user:pass@example.com'));
});

test('watch establishes baseline and reports a later change', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'coke-dots-watch-'));
  const store = new Store(directory);
  let content = 'first';
  const fakeFetch = async () => new Response(content, { headers: { 'content-type': 'text/plain' } });
  const notifications: { title: string; body: string }[] = [];
  const runner = new WatchRunner(store, () => {}, fakeFetch as typeof fetch, (title, body) => notifications.push({ title, body }));
  try {
    const watch = store.createWatch('https://example.com/', 5);
    await runner.tick();
    await waitFor(() => store.getWatch(watch.id)?.lastStatus === '已建立基线');
    assert.equal(store.snapshot(false).entries.filter(e => e.kind === 'dot').length, 0);
    assert.equal(notifications.length, 0, 'Establishing the initial baseline should not send a notification');
    store.setSetting('desktopNotifications', 'true');
    content = 'second';
    store.updateWatch(watch.id, { nextCheckAt: new Date(0).toISOString() });
    await runner.tick();
    await waitFor(() => store.getWatch(watch.id)?.lastStatus === '内容有变化');
    assert.equal(store.snapshot(false).entries.filter(e => e.kind === 'dot').length, 1);
    assert.deepEqual(notifications, [{ title: 'Dot', body: '你关注的网页有新变化。' }]);
  } finally { runner.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});

async function waitFor(predicate: () => boolean) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 3000) throw new Error('Timed out waiting for watch');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
