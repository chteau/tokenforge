import type { Method, Route } from "./types.ts";

interface CompiledRoute {
  route: Route;
  pattern: RegExp;
  paramNames: string[];
}

export type RouteMatch =
  | { kind: "found"; route: Route; params: Record<string, string> }
  | { kind: "method-not-allowed"; allowed: Method[] }
  | { kind: "not-found" };

function compile(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const source = path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        paramNames.push(segment.slice(1));
        return "([^/]+)";
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { pattern: new RegExp(`^${source}/?$`), paramNames };
}

export interface Router {
  match(method: string, path: string): RouteMatch;
  routes(): readonly Route[];
}

export function createRouter(routes: readonly Route[]): Router {
  const compiled: CompiledRoute[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    const id = `${route.method} ${route.path}`;
    if (seen.has(id)) throw new Error(`Duplicate route: ${id}`);
    seen.add(id);
    compiled.push({ route, ...compile(route.path) });
  }

  return {
    match(method, path) {
      const allowed: Method[] = [];
      for (const c of compiled) {
        const m = c.pattern.exec(path);
        if (!m) continue;
        if (c.route.method !== method) {
          allowed.push(c.route.method);
          continue;
        }
        const params: Record<string, string> = {};
        c.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(m[i + 1] ?? "");
        });
        return { kind: "found", route: c.route, params };
      }
      return allowed.length ? { kind: "method-not-allowed", allowed } : { kind: "not-found" };
    },
    routes: () => routes,
  };
}
