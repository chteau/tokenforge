import { DomainError } from "../../packages/shared/src/errors.ts";

export const MAX_BODY_BYTES = 1024 * 1024;
export const SESSION_COOKIE = "qm_session";

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function normalizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/** Parse a JSON or urlencoded body according to the content type. */
export function parseBody(raw: string, contentType: string | undefined): unknown {
  if (raw.length === 0) return undefined;
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    throw new DomainError("VALIDATION_ERROR", "Request body too large");
  }
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
  if (type === "application/x-www-form-urlencoded") {
    const out: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(raw)) out[key] = value;
    return out;
  }
  if (type === "application/json" || type === "") {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new DomainError("VALIDATION_ERROR", "Malformed JSON body", [{ field: "body", message: "is not valid JSON" }]);
    }
  }
  throw new DomainError("VALIDATION_ERROR", `Unsupported content type: ${type}`);
}

export function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization);
  return match?.[1] ?? null;
}
