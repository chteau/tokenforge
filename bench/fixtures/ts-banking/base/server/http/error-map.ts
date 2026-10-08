import { type ErrorCode, isDomainError } from "../../packages/shared/src/errors.ts";
import type { HttpResponse } from "./types.ts";
import { json } from "./response.ts";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  INVALID_TRANSITION: 409,
  INSUFFICIENT_FUNDS: 422,
  DAILY_LIMIT_EXCEEDED: 422,
  CURRENCY_MISMATCH: 422,
  ACCOUNT_FROZEN: 422,
  CARD_BLOCKED: 422,
  TOO_MANY_ATTEMPTS: 429,
  INTERNAL: 500,
};

export function statusForCode(code: ErrorCode): number {
  return STATUS_BY_CODE[code];
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown[]; requestId?: string };
}

/** Normalise any thrown value into { status, body }. Unknown errors become a generic 500. */
export function describeError(error: unknown, requestId: string): { status: number; body: ErrorBody } {
  if (isDomainError(error)) {
    const body: ErrorBody = { error: { code: error.code, message: error.message, requestId } };
    if (error.details?.length) body.error.details = error.details;
    return { status: statusForCode(error.code), body };
  }
  return {
    status: 500,
    body: { error: { code: "INTERNAL", message: "Something went wrong on our side", requestId } },
  };
}

export function errorResponse(error: unknown, requestId: string): HttpResponse {
  const { status, body } = describeError(error, requestId);
  return json(status, body);
}
