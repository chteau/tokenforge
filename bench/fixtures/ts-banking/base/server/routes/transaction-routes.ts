import { parseOrThrow, queryToObject, v } from "../../packages/shared/src/validation.ts";
import { MAX_PAGE_SIZE } from "../../packages/transactions/src/transaction-service.ts";
import { json } from "../http/response.ts";
import type { Route } from "../http/types.ts";
import { api } from "./helpers.ts";
import { presentEntry } from "./presenters.ts";

export const pageSchema = v.object({
  limit: v.optional(v.integer({ min: 1, max: MAX_PAGE_SIZE })),
  offset: v.optional(v.integer({ min: 0 })),
});

export function transactionRoutes(): Route[] {
  return [
    api("GET", "/api/accounts/:accountId/transactions", "user", (ctx) => {
      const page = parseOrThrow(pageSchema, queryToObject(ctx.query));
      const result = ctx.deps.services.transactions.listForAccount(ctx.actor, ctx.params["accountId"] ?? "", page);
      return json(200, { ...result, items: result.items.map(presentEntry) });
    }),

    api("GET", "/api/transactions/:entryId", "user", (ctx) => {
      const entry = ctx.deps.services.transactions.getEntry(ctx.actor, ctx.params["entryId"] ?? "");
      return json(200, { transaction: presentEntry(entry) });
    }),
  ];
}
