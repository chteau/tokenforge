// Route conventions:
//  - API routes live under /api, return JSON via `json()`, and parse input with
//    `parseOrThrow(schema, ctx.body | queryToObject(ctx.query))`.
//  - Handlers stay thin: validate, call ONE service method with `ctx.actor`,
//    present the result. Business rules belong in packages/*.
//  - Throw DomainError for failures; errorBoundary maps them to HTTP.

import type { Actor } from "../../packages/auth/src/types.ts";
import { DomainError } from "../../packages/shared/src/errors.ts";
import type { AuthedContext, Handler, Method, RequestContext, Route, RouteAuth } from "../http/types.ts";

export function api(method: Method, path: string, auth: RouteAuth, handler: (ctx: AuthedContext) => ReturnType<Handler>): Route {
  return { method, path, kind: "api", auth, handler: handler as Handler };
}

export function publicApi(method: Method, path: string, handler: Handler): Route {
  return { method, path, kind: "api", auth: "public", handler };
}

export function web(method: Method, path: string, auth: RouteAuth, handler: (ctx: AuthedContext) => ReturnType<Handler>): Route {
  return { method, path, kind: "web", auth, handler: handler as Handler };
}

export function publicWeb(method: Method, path: string, handler: Handler): Route {
  return { method, path, kind: "web", auth: "public", handler };
}

export function requireActor(ctx: RequestContext): Actor {
  if (!ctx.actor) throw new DomainError("UNAUTHENTICATED", "Sign in required");
  return ctx.actor;
}

export function header(ctx: RequestContext, name: string): string | undefined {
  return ctx.headers[name.toLowerCase()];
}

/** Request body as a record (form posts and JSON objects). */
export function bodyRecord(ctx: RequestContext): Record<string, unknown> {
  return typeof ctx.body === "object" && ctx.body !== null && !Array.isArray(ctx.body) ? (ctx.body as Record<string, unknown>) : {};
}
