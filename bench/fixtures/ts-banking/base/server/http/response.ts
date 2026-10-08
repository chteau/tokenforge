import type { HttpResponse } from "./types.ts";

export function json(status: number, body: unknown, headers: Record<string, string | string[]> = {}): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
    body: status === 204 ? "" : JSON.stringify(body),
  };
}

export function html(status: number, body: string, headers: Record<string, string | string[]> = {}): HttpResponse {
  return { status, headers: { "content-type": "text/html; charset=utf-8", ...headers }, body };
}

export function text(status: number, body: string, contentType = "text/plain; charset=utf-8", headers: Record<string, string | string[]> = {}): HttpResponse {
  return { status, headers: { "content-type": contentType, ...headers }, body };
}

export function redirect(location: string, status: 302 | 303 = 303, headers: Record<string, string | string[]> = {}): HttpResponse {
  return { status, headers: { location, ...headers }, body: "" };
}

export function noContent(): HttpResponse {
  return { status: 204, headers: {}, body: "" };
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  httpOnly?: boolean;
  path?: string;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? "/"}`, "SameSite=Strict"];
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${options.maxAgeSeconds}`);
  return parts.join("; ");
}

export function withHeader(response: HttpResponse, name: string, value: string): HttpResponse {
  return { ...response, headers: { ...response.headers, [name.toLowerCase()]: value } };
}
