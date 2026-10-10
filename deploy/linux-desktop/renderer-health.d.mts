export declare class RendererUnresponsiveError extends Error {
  readonly code: string;
  readonly timeoutMs: number;

  constructor(timeoutMs?: number);
}

export declare class BrowserContextUnavailableError extends RendererUnresponsiveError {
  readonly code: 'DOTS_BROWSER_CONTEXT_UNAVAILABLE';
  readonly timeoutMs: number;

  constructor(timeoutMs?: number);
}

export interface CdpBrowserLike {
  isConnected(): boolean;
  contexts(): Array<unknown>;
}

export declare function waitForDefaultBrowserContext<T>(
  browser: CdpBrowserLike & { contexts(): Array<T> },
  options?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<T>;

export interface RendererHealthMonitor {
  run<T>(operation: () => T | Promise<T>): Promise<T>;
  check(operation: () => unknown | Promise<unknown>): Promise<boolean>;
  fail(): void;
  reset(): void;
  readonly unresponsive: boolean;
}

export declare function createRendererHealthMonitor(timeoutMs?: number): RendererHealthMonitor;
