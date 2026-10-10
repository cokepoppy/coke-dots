export class RendererUnresponsiveError extends Error {
  constructor(timeoutMs = 3_000) {
    super('云电脑里的 Chromium 页面无响应，系统正在自动恢复');
    this.name = 'RendererUnresponsiveError';
    this.code = 'DOTS_RENDERER_UNRESPONSIVE';
    this.timeoutMs = timeoutMs;
  }
}

export class BrowserContextUnavailableError extends RendererUnresponsiveError {
  constructor(timeoutMs = 2_000) {
    super(timeoutMs);
    this.name = 'BrowserContextUnavailableError';
    this.code = 'DOTS_BROWSER_CONTEXT_UNAVAILABLE';
    this.timeoutMs = timeoutMs;
    this.message = `Chromium CDP did not expose its default browser context within ${timeoutMs} ms`;
  }
}

/** Chromium may accept a CDP connection before its default page context is ready. */
export async function waitForDefaultBrowserContext(browser, { timeoutMs = 2_000, pollIntervalMs = 50 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Context timeout must be a positive integer');
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) throw new Error('Context polling interval must be a positive integer');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!browser.isConnected()) throw new BrowserContextUnavailableError(timeoutMs);
    let context;
    try { context = browser.contexts()[0]; }
    catch { throw new BrowserContextUnavailableError(timeoutMs); }
    if (context) return context;
    await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))));
  }
  throw new BrowserContextUnavailableError(timeoutMs);
}

/** A timed-out CDP operation remains pending, so latch unhealthy and never enqueue more work. */
export function createRendererHealthMonitor(timeoutMs = 3_000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Renderer timeout must be a positive integer');
  let unresponsive = false;
  let activeProbe = null;

  function run(operation) {
    if (unresponsive) return Promise.reject(new RendererUnresponsiveError(timeoutMs));
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        unresponsive = true;
        reject(new RendererUnresponsiveError(timeoutMs));
      }, timeoutMs);
    });
    return Promise.race([Promise.resolve().then(operation), deadline]).finally(() => clearTimeout(timer));
  }

  function check(operation) {
    if (unresponsive) return Promise.resolve(false);
    if (activeProbe) return activeProbe;
    const currentProbe = run(operation)
      .then(() => true, () => false)
      .finally(() => { if (activeProbe === currentProbe) activeProbe = null; });
    activeProbe = currentProbe;
    return currentProbe;
  }

  return {
    run,
    check,
    fail() { unresponsive = true; },
    reset() {
      unresponsive = false;
      activeProbe = null;
    },
    get unresponsive() { return unresponsive; },
  };
}
