// Domain errors. Services throw `DomainError`; the HTTP layer maps `code` to a
// status code (see server/http/error-map.ts). Never throw plain `Error` for
// expected business failures.

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_TRANSITION"
  | "INSUFFICIENT_FUNDS"
  | "DAILY_LIMIT_EXCEEDED"
  | "CURRENCY_MISMATCH"
  | "ACCOUNT_FROZEN"
  | "CARD_BLOCKED"
  | "TOO_MANY_ATTEMPTS"
  | "INTERNAL";

export interface ErrorDetail {
  field?: string;
  message: string;
  [key: string]: unknown;
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetail[] | undefined;

  constructor(code: ErrorCode, message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export function isDomainError(err: unknown): err is DomainError {
  return err instanceof DomainError;
}

export function notFound(what: string): DomainError {
  return new DomainError("NOT_FOUND", `${what} not found`);
}

export function forbidden(message = "You are not allowed to perform this action"): DomainError {
  return new DomainError("FORBIDDEN", message);
}

export function validationError(details: ErrorDetail[], message = "Request validation failed"): DomainError {
  return new DomainError("VALIDATION_ERROR", message, details);
}

export function invalidTransition(entity: string, from: string, to: string): DomainError {
  return new DomainError("INVALID_TRANSITION", `Cannot move ${entity} from ${from} to ${to}`);
}
