// Middleware run around every route handler, outermost first:
//   securityHeaders -> errorBoundary -> authenticate -> persistAfterWrite -> handler
// Body parsing happens before the chain (see app.ts) so validation errors are
// mapped by errorBoundary like any other DomainError.

import { DomainError, forbidden } from "../../packages/shared/src/errors.ts";
import { renderErrorPage } from "../../apps/web/views/error.ts";
import { describeError } from "./error-map.ts";
import { SESSION_COOKIE, bearerToken } from "./request.ts";
import { html, json, redirect } from "./response.ts";
import type { HttpResponse, Middleware } from "./types.ts";

export const securityHeaders: Middleware = async (ctx, next) => {
  const res = await next();
  return {
    ...res,
    headers: {
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "same-origin",
      "x-request-id": ctx.requestId,
      ...res.headers,
    },
  };
};

export const errorBoundary: Middleware = async (ctx, next) => {
  try {
    return await next();
  } catch (error) {
    const { status, body } = describeError(error, ctx.requestId);
    if (status >= 500) ctx.deps.logger.error(`[${ctx.requestId}] ${ctx.method} ${ctx.path} failed`, error);
    if (ctx.route.kind === "web") {
      if (status === 401) return redirect(`/login?next=${encodeURIComponent(ctx.path)}`);
      return html(status, renderErrorPage({ status, message: body.error.message, actorPresent: ctx.actor !== null }));
    }
    return json(status, body);
  }
};

export const authenticate: Middleware = async (ctx, next) => {
  const token = bearerToken(ctx.headers["authorization"]) ?? ctx.cookies[SESSION_COOKIE] ?? null;
  if (token) {
    const actor = ctx.deps.services.auth.authenticate(token);
    if (actor) {
      ctx.actor = actor;
      ctx.sessionToken = token;
    }
  }
  const { auth } = ctx.route;
  if (auth === "public") return next();
  if (!ctx.actor) throw new DomainError("UNAUTHENTICATED", "Sign in required");
  if (auth !== "user" && !auth.includes(ctx.actor.role)) throw forbidden();
  return next();
};

export const persistAfterWrite: Middleware = async (ctx, next) => {
  const res: HttpResponse = await next();
  if (ctx.method !== "GET" && res.status < 400) ctx.deps.store.save();
  return res;
};

export async function runChain(middleware: readonly Middleware[], ctx: Parameters<Middleware>[0], last: () => Promise<HttpResponse>): Promise<HttpResponse> {
  const dispatch = (i: number): Promise<HttpResponse> => {
    const mw = middleware[i];
    return mw ? mw(ctx, () => dispatch(i + 1)) : last();
  };
  return dispatch(0);
}
