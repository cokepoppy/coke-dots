export class LinuxDesktopWorkerError extends Error {
  readonly statusCode: number;
  readonly code?: string;

  constructor(message: string, upstreamStatus: number, code?: string) {
    super(message);
    this.name = 'LinuxDesktopWorkerError';
    this.statusCode = [400, 403, 409, 422, 503].includes(upstreamStatus) ? upstreamStatus : 502;
    this.code = code && /^[A-Z0-9_]{1,64}$/.test(code) ? code : undefined;
  }
}

export function apiErrorResponse(error: unknown) {
  if (error instanceof LinuxDesktopWorkerError) {
    return {
      status: error.statusCode,
      body: { error: error.message, ...(error.code ? { code: error.code } : {}) },
    };
  }
  return {
    status: error instanceof SyntaxError ? 400 : 500,
    body: { error: error instanceof Error ? error.message : String(error) },
  };
}
