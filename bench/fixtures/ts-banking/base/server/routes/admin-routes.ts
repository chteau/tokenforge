import { toPublicUser } from "../../packages/auth/src/types.ts";
import { drainOutbox } from "../../packages/notifications/src/outbox.ts";
import { json, text } from "../http/response.ts";
import type { Route } from "../http/types.ts";
import { api, publicApi } from "./helpers.ts";

export function adminRoutes(): Route[] {
  return [
    publicApi("GET", "/healthz", (ctx) => text(200, `ok ${ctx.deps.clock.now().toISOString()}\n`)),

    api("GET", "/api/admin/users", ["admin", "support"], (ctx) => {
      return json(200, { items: ctx.deps.repos.users.list().map(toPublicUser) });
    }),

    api("GET", "/api/admin/cache", ["admin"], (ctx) => json(200, { summary: ctx.deps.caches.summary.stats() })),

    api("POST", "/api/admin/cache/clear", ["admin"], (ctx) => {
      ctx.deps.caches.summary.clear();
      return json(200, { cleared: true });
    }),

    api("POST", "/api/admin/outbox/drain", ["admin"], (ctx) => {
      const sent = drainOutbox({ outbox: ctx.deps.repos.outbox, transport: ctx.deps.mail, clock: ctx.deps.clock });
      return json(200, { sent });
    }),
  ];
}
