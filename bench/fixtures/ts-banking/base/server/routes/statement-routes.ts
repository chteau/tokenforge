import { renderStatementText } from "../../packages/statements/src/statement-service.ts";
import { parseOrThrow, queryToObject, v } from "../../packages/shared/src/validation.ts";
import { json, text } from "../http/response.ts";
import type { Route } from "../http/types.ts";
import { api } from "./helpers.ts";
import { presentEntry } from "./presenters.ts";

const formatSchema = v.object({ format: v.withDefault(v.oneOf(["json", "text"] as const), "json") });

export function statementRoutes(): Route[] {
  return [
    api("GET", "/api/accounts/:accountId/statements", "user", (ctx) => {
      return json(200, { periods: ctx.deps.services.statements.availablePeriods(ctx.actor, ctx.params["accountId"] ?? "") });
    }),

    api("GET", "/api/accounts/:accountId/statements/:period", "user", (ctx) => {
      const { format } = parseOrThrow(formatSchema, queryToObject(ctx.query));
      const statement = ctx.deps.services.statements.monthly(ctx.actor, ctx.params["accountId"] ?? "", ctx.params["period"] ?? "");
      if (format === "text") {
        return text(200, renderStatementText(statement), "text/plain; charset=utf-8", {
          "content-disposition": `attachment; filename="statement-${statement.accountNumber}-${statement.period}.txt"`,
        });
      }
      return json(200, { statement: { ...statement, entries: statement.entries.map(presentEntry) } });
    }),
  ];
}
