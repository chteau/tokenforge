import type { Handler, Middleware, RequestContext } from './context.ts';
import { notFound, HttpError } from './errors.ts';

interface Route {
  method: string;
  pattern: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
  middleware: Middleware[];
}

function compile(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const src = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${src}/?$`), keys };
}

/**
 * Tiny router: global middleware (use) runs for every request, in
 * registration order, before the matched route's own middleware and handler.
 */
export class Router {
  private routes: Route[] = [];
  private global: Middleware[] = [];
  private prefixMiddleware: Array<{ prefix: string; mw: Middleware }> = [];

  use(mw: Middleware): this;
  use(prefix: string, mw: Middleware): this;
  use(a: string | Middleware, b?: Middleware): this {
    if (typeof a === 'string') this.prefixMiddleware.push({ prefix: a, mw: b as Middleware });
    else this.global.push(a);
    return this;
  }

  route(method: string, pattern: string, handler: Handler, middleware: Middleware[] = []): this {
    const { regex, keys } = compile(pattern);
    this.routes.push({ method: method.toUpperCase(), pattern, regex, keys, handler, middleware });
    return this;
  }

  get(p: string, h: Handler, mw?: Middleware[]) { return this.route('GET', p, h, mw); }
  post(p: string, h: Handler, mw?: Middleware[]) { return this.route('POST', p, h, mw); }
  put(p: string, h: Handler, mw?: Middleware[]) { return this.route('PUT', p, h, mw); }
  delete(p: string, h: Handler, mw?: Middleware[]) { return this.route('DELETE', p, h, mw); }

  list(): Array<{ method: string; pattern: string }> {
    return this.routes.map((r) => ({ method: r.method, pattern: r.pattern }));
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.regex.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route, params };
    }
    if (pathMatched) throw new HttpError(405, 'method_not_allowed', `${method} not allowed on ${path}`);
    return undefined;
  }

  async dispatch(ctx: RequestContext): Promise<void> {
    const scoped = this.prefixMiddleware.filter((p) => ctx.path.startsWith(p.prefix)).map((p) => p.mw);
    const found = this.match(ctx.method, ctx.path);
    const terminal: Handler = found
      ? async (c) => {
          c.params = found.params;
          await compose(found.route.middleware, found.route.handler)(c);
        }
      : async () => {
          throw notFound(`no route for ${ctx.method} ${ctx.path}`);
        };
    await compose([...this.global, ...scoped], terminal)(ctx);
  }
}

export function compose(stack: Middleware[], terminal: Handler): Handler {
  return (ctx) => {
    let index = -1;
    const run = async (i: number): Promise<void> => {
      if (i <= index) throw new Error('next() called multiple times');
      index = i;
      if (i === stack.length) return terminal(ctx);
      await stack[i](ctx, () => run(i + 1));
    };
    return run(0);
  };
}
