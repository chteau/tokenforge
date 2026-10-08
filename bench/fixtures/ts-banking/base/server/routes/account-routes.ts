import { parseOrThrow, v } from "../../packages/shared/src/validation.ts";
import { SUPPORTED_CURRENCIES } from "../../packages/shared/src/money.ts";
import { json } from "../http/response.ts";
import type { Route } from "../http/types.ts";
import { api } from "./helpers.ts";
import { presentAccount, presentEntry } from "./presenters.ts";

const renameSchema = v.object({ name: v.string({ min: 1, max: 40 }) });
const depositSchema = v.object({ amount: v.decimalString(), description: v.withDefault(v.string({ min: 1, max: 140 }), "Deposit") });
const openSchema = v.object({
  ownerId: v.id("usr"),
  name: v.string({ min: 1, max: 40 }),
  type: v.oneOf(["checking", "savings", "travel"] as const),
  currency: v.oneOf(SUPPORTED_CURRENCIES),
});

export function accountRoutes(): Route[] {
  return [
    api("GET", "/api/accounts", "user", (ctx) => {
      const items = ctx.deps.services.accounts.listForUser(ctx.actor).map(presentAccount);
      return json(200, { items });
    }),

    api("GET", "/api/accounts/:accountId", "user", (ctx) => {
      const account = ctx.deps.services.accounts.getForActor(ctx.actor, ctx.params["accountId"] ?? "");
      return json(200, { account: presentAccount(account) });
    }),

    api("PATCH", "/api/accounts/:accountId", "user", (ctx) => {
      const input = parseOrThrow(renameSchema, ctx.body);
      const account = ctx.deps.services.accounts.rename(ctx.actor, ctx.params["accountId"] ?? "", input.name);
      return json(200, { account: presentAccount(account) });
    }),

    api("POST", "/api/admin/accounts", ["admin"], (ctx) => {
      const input = parseOrThrow(openSchema, ctx.body);
      return json(201, { account: presentAccount(ctx.deps.services.accounts.open(ctx.actor, input)) });
    }),

    api("POST", "/api/admin/accounts/:accountId/deposits", ["admin"], (ctx) => {
      const input = parseOrThrow(depositSchema, ctx.body);
      const entry = ctx.deps.services.accounts.deposit(ctx.actor, ctx.params["accountId"] ?? "", input);
      return json(201, { entry: presentEntry(entry) });
    }),

    api("POST", "/api/admin/accounts/:accountId/freeze", ["admin"], (ctx) => {
      const account = ctx.deps.services.accounts.setFrozen(ctx.actor, ctx.params["accountId"] ?? "", true);
      return json(200, { account: presentAccount(account) });
    }),

    api("POST", "/api/admin/accounts/:accountId/unfreeze", ["admin"], (ctx) => {
      const account = ctx.deps.services.accounts.setFrozen(ctx.actor, ctx.params["accountId"] ?? "", false);
      return json(200, { account: presentAccount(account) });
    }),
  ];
}
