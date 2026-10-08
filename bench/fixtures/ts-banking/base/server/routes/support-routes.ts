import { parseOrThrow, queryToObject, v } from "../../packages/shared/src/validation.ts";
import { json } from "../http/response.ts";
import type { Route } from "../http/types.ts";
import { api } from "./helpers.ts";

const openSchema = v.object({
  subject: v.string({ min: 3, max: 120 }),
  category: v.oneOf(["cards", "transfers", "account", "technical", "other"] as const),
  body: v.string({ min: 1, max: 4000 }),
});
const replySchema = v.object({ body: v.string({ min: 1, max: 4000 }) });
const listSchema = v.object({ status: v.optional(v.oneOf(["open", "awaiting_customer", "closed"] as const)) });

export function supportRoutes(): Route[] {
  return [
    api("GET", "/api/support/tickets", "user", (ctx) => {
      const filter = parseOrThrow(listSchema, queryToObject(ctx.query));
      return json(200, { items: ctx.deps.services.tickets.list(ctx.actor, filter) });
    }),

    api("POST", "/api/support/tickets", "user", (ctx) => {
      const input = parseOrThrow(openSchema, ctx.body);
      return json(201, { ticket: ctx.deps.services.tickets.open(ctx.actor, input) });
    }),

    api("GET", "/api/support/tickets/:ticketId", "user", (ctx) => {
      return json(200, { ticket: ctx.deps.services.tickets.get(ctx.actor, ctx.params["ticketId"] ?? "") });
    }),

    api("POST", "/api/support/tickets/:ticketId/messages", "user", (ctx) => {
      const input = parseOrThrow(replySchema, ctx.body);
      return json(201, { ticket: ctx.deps.services.tickets.reply(ctx.actor, ctx.params["ticketId"] ?? "", input.body) });
    }),

    api("POST", "/api/support/tickets/:ticketId/close", "user", (ctx) => {
      return json(200, { ticket: ctx.deps.services.tickets.close(ctx.actor, ctx.params["ticketId"] ?? "") });
    }),
  ];
}
