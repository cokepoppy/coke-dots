const exposedWorkerStatuses = new Set([400, 403, 409, 422, 503]);
const safeErrorCode = /^[A-Z][A-Z0-9_]{0,63}$/;

export class LinuxDesktopWorkerError extends Error {
  readonly statusCode: number;
  readonly code?: string;

  constructor(message: string, upstreamStatus: number, code?: string) {
    super(message.slice(0, 240));
    this.name = 'LinuxDesktopWorkerError';
    this.statusCode = exposedWorkerStatuses.has(upstreamStatus) ? upstreamStatus : 502;
    if (code && safeErrorCode.test(code)) this.code = code;
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
