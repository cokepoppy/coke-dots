export class BrowserContextNotReadyError extends Error {
  constructor() {
    super('Chromium default browser context is not ready');
    this.name = 'BrowserContextNotReadyError';
    this.code = 'BROWSER_CONTEXT_NOT_READY';
  }
}

export async function waitForDefaultBrowserContext(browser, { timeoutMs = 10_000, pollIntervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const context = browser.contexts()[0];
    if (context) return context;
    if (Date.now() >= deadline) throw new BrowserContextNotReadyError();
    await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))));
  }
}
