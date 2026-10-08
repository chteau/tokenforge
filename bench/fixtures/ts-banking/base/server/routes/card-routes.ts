import { parseAmount } from "../../packages/shared/src/money.ts";
import { validationError } from "../../packages/shared/src/errors.ts";
import { parseOrThrow, v } from "../../packages/shared/src/validation.ts";
import { json } from "../http/response.ts";
import type { Route } from "../http/types.ts";
import { api } from "./helpers.ts";
import { presentCard } from "./presenters.ts";

const limitSchema = v.object({ monthlySpendLimit: v.decimalString() });

export function cardRoutes(): Route[] {
  return [
    api("GET", "/api/cards", "user", (ctx) => json(200, { items: ctx.deps.services.cards.listForUser(ctx.actor).map(presentCard) })),

    api("POST", "/api/accounts/:accountId/cards", "user", (ctx) => {
      const card = ctx.deps.services.cards.issue(ctx.actor, ctx.params["accountId"] ?? "");
      return json(201, { card: presentCard(card) });
    }),

    api("POST", "/api/cards/:cardId/freeze", "user", (ctx) => {
      return json(200, { card: presentCard(ctx.deps.services.cards.freeze(ctx.actor, ctx.params["cardId"] ?? "")) });
    }),

    api("POST", "/api/cards/:cardId/unfreeze", "user", (ctx) => {
      return json(200, { card: presentCard(ctx.deps.services.cards.unfreeze(ctx.actor, ctx.params["cardId"] ?? "")) });
    }),

    api("POST", "/api/cards/:cardId/report-lost", "user", (ctx) => {
      const { lost, replacement } = ctx.deps.services.cards.reportLost(ctx.actor, ctx.params["cardId"] ?? "");
      return json(200, { lost: presentCard(lost), replacement: presentCard(replacement) });
    }),

    api("PUT", "/api/cards/:cardId/limit", "user", (ctx) => {
      const input = parseOrThrow(limitSchema, ctx.body);
      const card = ctx.deps.repos.cards.findById(ctx.params["cardId"] ?? "");
      const account = card ? ctx.deps.repos.accounts.findById(card.accountId) : undefined;
      const limitMinor = parseAmount(input.monthlySpendLimit, account?.currency ?? "USD");
      if (limitMinor === null) throw validationError([{ field: "monthlySpendLimit", message: "is not a valid amount" }]);
      const updated = ctx.deps.services.cards.setMonthlyLimit(ctx.actor, ctx.params["cardId"] ?? "", limitMinor);
      return json(200, { card: presentCard(updated) });
    }),
  ];
}
