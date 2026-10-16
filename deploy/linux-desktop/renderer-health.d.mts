export declare class RendererUnresponsiveError extends Error {
  readonly code: string;
  readonly timeoutMs: number;

  constructor(timeoutMs?: number);
}

export interface RendererHealthMonitor {
  run<T>(operation: () => T | Promise<T>): Promise<T>;
  check(operation: () => unknown | Promise<unknown>): Promise<boolean>;
  fail(): void;
  reset(): void;
  readonly unresponsive: boolean;
}

export declare function createRendererHealthMonitor(timeoutMs?: number): RendererHealthMonitor;
