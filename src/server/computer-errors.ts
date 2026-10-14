const exposedWorkerStatuses = new Set([400, 403, 409, 422, 503]);
const safeErrorCode = /^[A-Z][A-Z0-9_]{0,63}$/;

export class ComputerControlOwnedByUserError extends Error {
  constructor() {
    super('用户正在接管云电脑，Agent 已暂停。交还控制权后点击“继续”即可恢复。');
    this.name = 'ComputerControlOwnedByUserError';
  }
}

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
