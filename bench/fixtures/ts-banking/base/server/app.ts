import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppDeps } from "./deps.ts";
import { errorResponse } from "./http/error-map.ts";
import { authenticate, errorBoundary, persistAfterWrite, runChain, securityHeaders } from "./http/middleware.ts";
import { normalizeHeaders, parseBody, parseCookies } from "./http/request.ts";
import { json } from "./http/response.ts";
import { type Router, createRouter } from "./http/router.ts";
import type { HttpResponse, Method, Middleware, RawRequest, RequestContext } from "./http/types.ts";
import { accountRoutes } from "./routes/account-routes.ts";
import { adminRoutes } from "./routes/admin-routes.ts";
import { authRoutes } from "./routes/auth-routes.ts";
import { cardRoutes } from "./routes/card-routes.ts";
import { dashboardRoutes } from "./routes/dashboard-routes.ts";
import { notificationRoutes } from "./routes/notification-routes.ts";
import { statementRoutes } from "./routes/statement-routes.ts";
import { supportRoutes } from "./routes/support-routes.ts";
import { transactionRoutes } from "./routes/transaction-routes.ts";
import { transferRoutes } from "./routes/transfer-routes.ts";
import { webRoutes } from "./routes/web-routes.ts";

const METHODS: readonly Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const MIDDLEWARE: readonly Middleware[] = [securityHeaders, errorBoundary, authenticate, persistAfterWrite];

export interface InjectRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  /** Objects are sent as JSON; strings are sent as-is. */
  body?: unknown;
}

export interface InjectResponse extends HttpResponse {
  json(): any;
}

export interface App {
  deps: AppDeps;
  router: Router;
  /** Handle one request without a socket (tests, scripts). */
  dispatch(request: RawRequest): Promise<HttpResponse>;
  /** Convenience wrapper around dispatch() for tests. */
  inject(request: InjectRequest): Promise<InjectResponse>;
  /** node:http request listener. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export function createApp(deps: AppDeps): App {
  const router = createRouter([
    ...authRoutes(),
    ...dashboardRoutes(),
    ...accountRoutes(),
    ...transactionRoutes(),
    ...transferRoutes(),
    ...cardRoutes(),
    ...statementRoutes(),
    ...notificationRoutes(),
    ...supportRoutes(),
    ...adminRoutes(),
    ...webRoutes(),
  ]);
  let requestCounter = 0;

  async function dispatch(request: RawRequest): Promise<HttpResponse> {
    requestCounter += 1;
    const requestId = `req-${requestCounter.toString(36)}`;
    const url = new URL(request.url, "http://localhost");
    const method = request.method.toUpperCase();
    if (!(METHODS as readonly string[]).includes(method)) {
      return json(405, { error: { code: "VALIDATION_ERROR", message: `Unsupported method ${method}` } });
    }
    const match = router.match(method, url.pathname);
    if (match.kind === "not-found") {
      return json(404, { error: { code: "NOT_FOUND", message: `No route for ${method} ${url.pathname}`, requestId } });
    }
    if (match.kind === "method-not-allowed") {
      return json(405, { error: { code: "VALIDATION_ERROR", message: "Method not allowed", requestId } }, { allow: match.allowed.join(", ") });
    }
    const headers = normalizeHeaders(request.headers);
    const ctx: RequestContext = {
      method: method as Method,
      path: url.pathname,
      query: url.searchParams,
      params: match.params,
      headers,
      cookies: parseCookies(headers["cookie"]),
      body: undefined,
      rawBody: request.body ?? "",
      route: match.route,
      actor: null,
      sessionToken: null,
      requestId,
      deps,
    };
    return runChain(MIDDLEWARE, ctx, async () => {
      ctx.body = parseBody(ctx.rawBody, headers["content-type"]);
      return match.route.handler(ctx);
    });
  }

  return {
    deps,
    router,
    dispatch,

    async inject(request) {
      const headers: Record<string, string> = { ...(request.headers ?? {}) };
      let body: string | undefined;
      if (typeof request.body === "string") {
        body = request.body;
      } else if (request.body !== undefined) {
        body = JSON.stringify(request.body);
        if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
      }
      const res = await dispatch({ method: request.method, url: request.url, headers, body });
      return { ...res, json: () => JSON.parse(res.body) };
    },

    async handle(req, res) {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const out = await dispatch({
          method: req.method ?? "GET",
          url: req.url ?? "/",
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(out.status, out.headers);
        res.end(out.body);
      } catch (error) {
        deps.logger.error("unhandled request failure", error);
        const out = errorResponse(error, "unhandled");
        if (!res.headersSent) res.writeHead(out.status, out.headers);
        res.end(out.body);
      }
    },
  };
}
