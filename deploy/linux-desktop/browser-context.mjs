export class BrowserContextNotReadyError extends Error {
  constructor() {
    super('云电脑中的 Chromium 浏览器上下文暂不可用，正在重新连接');
    this.name = 'BrowserContextNotReadyError';
    this.code = 'DOTS_BROWSER_CONTEXT_UNAVAILABLE';
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

export async function getBrowserPage(context) {
  try {
    if (!context || typeof context.pages !== 'function') throw new BrowserContextNotReadyError();
    const pages = context.pages();
    if (!Array.isArray(pages)) throw new BrowserContextNotReadyError();
    if (pages[0]) return pages[0];
    if (typeof context.newPage !== 'function') throw new BrowserContextNotReadyError();
    return await context.newPage();
  } catch (error) {
    if (error instanceof BrowserContextNotReadyError) throw error;
    if (error instanceof TypeError && /Cannot read properties of (?:undefined|null) \(reading ['"]pages['"]\)/.test(error.message)) {
      throw new BrowserContextNotReadyError();
    }
    throw error;
  }
}
