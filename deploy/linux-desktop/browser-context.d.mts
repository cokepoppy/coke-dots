export declare class BrowserContextNotReadyError extends Error {
  code: 'DOTS_BROWSER_CONTEXT_UNAVAILABLE';
}

export declare function waitForDefaultBrowserContext<T extends object>(
  browser: { contexts(): T[] },
  options?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<T>;

export declare function getBrowserPage<TPage>(
  context: { pages(): TPage[]; newPage?(): Promise<TPage> } | undefined,
): Promise<TPage>;
