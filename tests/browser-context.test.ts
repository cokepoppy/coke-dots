import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserContextNotReadyError, waitForDefaultBrowserContext } from '../deploy/linux-desktop/browser-context.mjs';

test('waits for Chromium to create its default context after CDP connects', async () => {
  const context = { pages: () => [] };
  let checks = 0;
  const browser = { contexts: () => ++checks < 4 ? [] : [context] };
  assert.equal(await waitForDefaultBrowserContext(browser, { timeoutMs: 100, pollIntervalMs: 1 }), context);
  assert.equal(checks, 4);
});

test('returns a typed startup error if Chromium never creates a default context', async () => {
  const browser = { contexts: () => [] };
  await assert.rejects(waitForDefaultBrowserContext(browser, { timeoutMs: 5, pollIntervalMs: 1 }), BrowserContextNotReadyError);
});
