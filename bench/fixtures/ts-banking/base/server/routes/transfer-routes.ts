import { formatDecimal } from "../../packages/shared/src/money.ts";
import { validationError } from "../../packages/shared/src/errors.ts";
import { parseOrThrow, v } from "../../packages/shared/src/validation.ts";
import { MAX_MEMO_LENGTH } from "../../packages/transfers/src/transfer-service.ts";
import { json } from "../http/response.ts";
import type { Route } from "../http/types.ts";
import { api, header } from "./helpers.ts";
import { presentAccount, presentTransfer } from "./presenters.ts";

export const transferBodySchema = v.object({
  fromAccountId: v.id("acc"),
  toAccount: v.string({ min: 1, max: 40 }),
  amount: v.decimalString(),
  memo: v.optional(v.string({ max: MAX_MEMO_LENGTH })),
});

const reverseSchema = v.object({ reason: v.string({ min: 3, max: 200 }) });

export function transferRoutes(): Route[] {
  return [
    api("POST", "/api/transfers", "user", (ctx) => {
      const input = parseOrThrow(transferBodySchema, ctx.body);
      const idempotencyKey = header(ctx, "idempotency-key");
      if (!idempotencyKey) {
        throw validationError([{ field: "Idempotency-Key", message: "header is required" }]);
      }
      const { transfer, replayed } = ctx.deps.services.transfers.createTransfer(ctx.actor, {
        ...input,
        idempotencyKey,
        channel: "api",
      });
      return json(replayed ? 200 : 201, { transfer: presentTransfer(transfer), replayed });
    }),

    api("POST", "/api/transfers/preview", "user", (ctx) => {
      const input = parseOrThrow(transferBodySchema, ctx.body);
      const prepared = ctx.deps.services.transfers.prepare(ctx.actor, input);
      return json(200, {
        from: presentAccount(prepared.from),
        to: { number: prepared.to.number, currency: prepared.to.currency },
        amountMinor: prepared.amountMinor,
        amount: formatDecimal(prepared.amountMinor, prepared.from.currency),
        memo: prepared.memo,
        remainingTodayMinor: prepared.remainingTodayMinor,
      });
    }),

    api("GET", "/api/transfers", "user", (ctx) => {
      return json(200, { items: ctx.deps.services.transfers.listForUser(ctx.actor).map(presentTransfer) });
    }),

    api("GET", "/api/transfers/:transferId", "user", (ctx) => {
      const transfer = ctx.deps.services.transfers.getForActor(ctx.actor, ctx.params["transferId"] ?? "");
      return json(200, { transfer: presentTransfer(transfer) });
    }),

    api("POST", "/api/admin/transfers/:transferId/reverse", ["admin"], (ctx) => {
      const input = parseOrThrow(reverseSchema, ctx.body);
      const transfer = ctx.deps.services.transfers.reverse(ctx.actor, ctx.params["transferId"] ?? "", input.reason);
      return json(200, { transfer: presentTransfer(transfer) });
    }),
  ];
}
