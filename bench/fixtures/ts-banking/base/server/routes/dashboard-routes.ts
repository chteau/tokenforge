import { json } from "../http/response.ts";
import type { Route } from "../http/types.ts";
import { api } from "./helpers.ts";
import { presentEntry } from "./presenters.ts";

export function dashboardRoutes(): Route[] {
  return [
    api("GET", "/api/dashboard", "user", (ctx) => {
      const dashboard = ctx.deps.services.dashboard.getDashboard(ctx.actor);
      return json(200, {
        user: dashboard.user,
        accounts: dashboard.summary.accounts,
        totals: dashboard.summary.totals,
        computedAt: dashboard.summary.computedAt,
        recent: dashboard.recent.map(presentEntry),
        unreadNotifications: dashboard.unreadNotifications,
      });
    }),
  ];
}
