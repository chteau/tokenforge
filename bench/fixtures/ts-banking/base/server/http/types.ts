import type { Actor, Role } from "../../packages/auth/src/types.ts";
import type { AppDeps } from "../deps.ts";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
}

/** Who may call a route: anyone, any signed-in user, or only the listed roles. */
export type RouteAuth = "public" | "user" | readonly Role[];

/** "api" routes answer with JSON errors; "web" routes render HTML / redirect to /login. */
export type RouteKind = "api" | "web";

export interface RequestContext {
  method: Method;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  headers: Record<string, string | undefined>;
  cookies: Record<string, string>;
  /** Parsed JSON or form body (object), or undefined when there is none. */
  body: unknown;
  rawBody: string;
  route: Route;
  /** Set by the authenticate middleware; non-null inside handlers of non-public routes. */
  actor: Actor | null;
  sessionToken: string | null;
  requestId: string;
  deps: AppDeps;
}

/** Context for authenticated routes, where `actor` is guaranteed. */
export type AuthedContext = RequestContext & { actor: Actor };

export type Handler = (ctx: RequestContext) => HttpResponse | Promise<HttpResponse>;

export type Middleware = (ctx: RequestContext, next: () => Promise<HttpResponse>) => Promise<HttpResponse>;

export interface Route {
  method: Method;
  path: string;
  kind: RouteKind;
  auth: RouteAuth;
  handler: Handler;
}

export interface RawRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: string;
}
