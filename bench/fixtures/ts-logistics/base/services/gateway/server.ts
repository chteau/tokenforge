import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Container, RequestContext, Router } from '../../packages/core/src/index.ts';
import { readBody, HttpError } from '../../packages/core/src/index.ts';

function headerMap(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  return out;
}

export function createHttpServer(router: Router, services: Container, opts: { bodyLimit: number }): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ctx: RequestContext = {
      req,
      res,
      method: (req.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: url.searchParams,
      params: {},
      headers: headerMap(req),
      body: undefined,
      requestId: '',
      services,
      state: {},
      status: 404,
      responseBody: undefined,
      responseHeaders: {},
    };
    try {
      if (ctx.method !== 'GET' && ctx.method !== 'HEAD') ctx.body = await readBody(req, opts.bodyLimit);
      await router.dispatch(ctx);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      ctx.status = status;
      ctx.responseBody = { error: { code: err instanceof HttpError ? err.code : 'internal', message: String((err as Error).message) } };
    }
    const payload = ctx.responseBody === undefined ? '' : JSON.stringify(ctx.responseBody);
    res.writeHead(ctx.status, { ...ctx.responseHeaders, ...(payload ? { 'content-type': 'application/json; charset=utf-8' } : {}) });
    res.end(payload);
  });
}
