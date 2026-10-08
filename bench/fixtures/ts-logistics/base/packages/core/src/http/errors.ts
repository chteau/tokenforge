export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'missing or invalid credentials') => new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'insufficient scope') => new HttpError(403, 'forbidden', msg);
export const notFound = (msg = 'not found') => new HttpError(404, 'not_found', msg);
export const conflict = (msg: string) => new HttpError(409, 'conflict', msg);
export const tooMany = (msg = 'rate limit exceeded') => new HttpError(429, 'rate_limited', msg);

export class ValidationError extends HttpError {
  constructor(message: string, issues: Array<{ path: string; message: string }>) {
    super(422, "validation_failed", message, { issues });
  }
}
