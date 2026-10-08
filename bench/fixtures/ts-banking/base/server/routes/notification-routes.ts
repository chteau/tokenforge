import { parseOrThrow, queryToObject, v } from "../../packages/shared/src/validation.ts";
import { json } from "../http/response.ts";
import type { Route } from "../http/types.ts";
import { api } from "./helpers.ts";

const listSchema = v.object({ unread: v.optional(v.boolean()) });

export function notificationRoutes(): Route[] {
  return [
    api("GET", "/api/notifications", "user", (ctx) => {
      const { unread } = parseOrThrow(listSchema, queryToObject(ctx.query));
      const items = ctx.deps.services.notifications.list(ctx.actor, { unreadOnly: unread === true });
      return json(200, { items, unread: ctx.deps.services.notifications.unreadCount(ctx.actor.userId) });
    }),

    api("POST", "/api/notifications/read-all", "user", (ctx) => {
      return json(200, { marked: ctx.deps.services.notifications.markAllRead(ctx.actor) });
    }),

    api("POST", "/api/notifications/:notificationId/read", "user", (ctx) => {
      return json(200, { notification: ctx.deps.services.notifications.markRead(ctx.actor, ctx.params["notificationId"] ?? "") });
    }),
  ];
}
