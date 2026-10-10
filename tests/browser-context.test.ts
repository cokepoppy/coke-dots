import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserContextNotReadyError, getBrowserPage, waitForDefaultBrowserContext } from '../deploy/linux-desktop/browser-context.mjs';

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

test('normalizes a missing pages context into a recoverable browser error', async () => {
  await assert.rejects(getBrowserPage(undefined), error => {
    assert(error instanceof BrowserContextNotReadyError);
    assert.equal(error.code, 'DOTS_BROWSER_CONTEXT_UNAVAILABLE');
    return true;
  });
});

test('normalizes the observed Chromium pages TypeError without swallowing unrelated errors', async () => {
  const pagesFailure = { pages() { throw new TypeError("Cannot read properties of undefined (reading 'pages')"); } };
  await assert.rejects(getBrowserPage(pagesFailure), BrowserContextNotReadyError);
  await assert.rejects(getBrowserPage({ pages() { throw new Error('unrelated'); } }), /unrelated/);
});

test('returns the current page or creates one when the default context is ready', async () => {
  const existingPage = { id: 'existing' };
  assert.equal(await getBrowserPage({ pages: () => [existingPage] }), existingPage);
  await assert.rejects(getBrowserPage({ pages: () => [] }), BrowserContextNotReadyError);
  let created = false;
  const newPage = { id: 'new' };
  assert.equal(await getBrowserPage({ pages: () => [], newPage: async () => { created = true; return newPage; } }), newPage);
  assert.equal(created, true);
});
