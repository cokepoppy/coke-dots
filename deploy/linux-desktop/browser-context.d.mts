export declare class BrowserContextNotReadyError extends Error {
  code: 'BROWSER_CONTEXT_NOT_READY';
}

export declare function waitForDefaultBrowserContext<T extends object>(
  browser: { contexts(): T[] },
  options?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<T>;
