// Server-rendered pages. Handlers gather data through services (never
// repositories) and hand plain view models to the pure render functions in
// apps/web/views. Forms post back here; failures re-render the form.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { renderAccountsPage } from "../../apps/web/views/accounts.ts";
import { renderCardsPage } from "../../apps/web/views/cards.ts";
import { renderDashboard } from "../../apps/web/views/dashboard.ts";
import { renderLoginPage } from "../../apps/web/views/login.ts";
import { renderNotificationsPage } from "../../apps/web/views/notifications.ts";
import { renderTransactionsPage } from "../../apps/web/views/transactions.ts";
import { type TransferFormValues, renderTransferForm } from "../../apps/web/views/transfer-form.ts";
import { renderTransfersPage } from "../../apps/web/views/transfers.ts";
import type { Actor } from "../../packages/auth/src/types.ts";
import { SESSION_TTL_MS } from "../../packages/auth/src/sessions.ts";
import { isDomainError } from "../../packages/shared/src/errors.ts";
import { parseOrThrow, queryToObject } from "../../packages/shared/src/validation.ts";
import { statusForCode } from "../http/error-map.ts";
import { SESSION_COOKIE } from "../http/request.ts";
import { html, redirect, serializeCookie, text } from "../http/response.ts";
import type { RequestContext, Route } from "../http/types.ts";
import { bodyRecord, publicWeb, web } from "./helpers.ts";
import { pageSchema } from "./transaction-routes.ts";

const WEB_ROOT = join(import.meta.dirname, "..", "..", "apps", "web");
const staticCache = new Map<string, string>();

function staticAsset(relativePath: string, transform?: (source: string) => string): string {
  let body = staticCache.get(relativePath);
  if (body === undefined) {
    const source = readFileSync(join(WEB_ROOT, relativePath), "utf8");
    body = transform ? transform(source) : source;
    staticCache.set(relativePath, body);
  }
  return body;
}

export function viewUser(ctx: RequestContext, actor: Actor) {
  const me = ctx.deps.services.auth.me(actor);
  return {
    displayName: me.displayName,
    timezone: me.timezone,
    unreadNotifications: ctx.deps.services.notifications.unreadCount(actor.userId),
  };
}

function safeNext(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/dashboard";
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function webRoutes(): Route[] {
  return [
    publicWeb("GET", "/", (ctx) => redirect(ctx.cookies[SESSION_COOKIE] ? "/dashboard" : "/login", 302)),

    publicWeb("GET", "/static/app.css", () => text(200, staticAsset("static/app.css"), "text/css; charset=utf-8")),

    publicWeb("GET", "/static/transfer-form.js", () =>
      text(200, staticAsset("client/transfer-form.ts", (src) => stripTypeScriptTypes(src)), "text/javascript; charset=utf-8"),
    ),

    publicWeb("GET", "/login", (ctx) => {
      if (ctx.actor) return redirect("/dashboard");
      return html(200, renderLoginPage({ next: safeNext(ctx.query.get("next")) }));
    }),

    publicWeb("POST", "/login", async (ctx) => {
      const form = bodyRecord(ctx);
      const username = str(form["username"]);
      try {
        const result = await ctx.deps.services.auth.login(username, str(form["password"]));
        const cookie = serializeCookie(SESSION_COOKIE, result.token, { maxAgeSeconds: SESSION_TTL_MS / 1000 });
        return redirect(safeNext(form["next"]), 303, { "set-cookie": cookie });
      } catch (error) {
        if (!isDomainError(error)) throw error;
        return html(statusForCode(error.code), renderLoginPage({ username, error: error.message, next: safeNext(form["next"]) }));
      }
    }),

    web("POST", "/logout", "user", (ctx) => {
      if (ctx.sessionToken) ctx.deps.services.auth.logout(ctx.sessionToken);
      return redirect("/login", 303, { "set-cookie": serializeCookie(SESSION_COOKIE, "", { maxAgeSeconds: 0 }) });
    }),

    web("GET", "/dashboard", "user", (ctx) => {
      const dashboard = ctx.deps.services.dashboard.getDashboard(ctx.actor);
      return html(
        200,
        renderDashboard({
          user: dashboard.user,
          summary: dashboard.summary,
          recent: dashboard.recent,
          unreadNotifications: dashboard.unreadNotifications,
        }),
      );
    }),

    web("GET", "/accounts", "user", (ctx) => {
      const accounts = ctx.deps.services.accounts.listForUser(ctx.actor);
      return html(200, renderAccountsPage({ user: viewUser(ctx, ctx.actor), accounts }));
    }),

    web("GET", "/accounts/:accountId/transactions", "user", (ctx) => {
      const page = parseOrThrow(pageSchema, queryToObject(ctx.query));
      const accountId = ctx.params["accountId"] ?? "";
      const account = ctx.deps.services.accounts.getForActor(ctx.actor, accountId);
      const result = ctx.deps.services.transactions.listForAccount(ctx.actor, accountId, { limit: page.limit ?? 25, offset: page.offset });
      return html(200, renderTransactionsPage({ user: viewUser(ctx, ctx.actor), account, page: result }));
    }),

    web("GET", "/transfers", "user", (ctx) => {
      const transfers = ctx.deps.services.transfers.listForUser(ctx.actor);
      const accounts = ctx.deps.services.accounts.listForUser(ctx.actor);
      return html(
        200,
        renderTransfersPage({ user: viewUser(ctx, ctx.actor), transfers, accounts, createdId: ctx.query.get("created") ?? undefined }),
      );
    }),

    web("GET", "/transfers/new", "user", (ctx) => {
      const accounts = ctx.deps.services.accounts.listForUser(ctx.actor);
      return html(
        200,
        renderTransferForm({
          user: viewUser(ctx, ctx.actor),
          accounts,
          values: { fromAccountId: ctx.query.get("from") ?? accounts[0]?.id },
          errors: {},
          idempotencyKey: `web-${randomUUID()}`,
        }),
      );
    }),

    web("POST", "/transfers", "user", (ctx) => {
      const form = bodyRecord(ctx);
      const values: TransferFormValues = {
        fromAccountId: str(form["fromAccountId"]),
        toAccount: str(form["toAccount"]),
        amount: str(form["amount"]),
        memo: str(form["memo"]),
      };
      const idempotencyKey = str(form["idempotencyKey"]) || `web-${randomUUID()}`;
      try {
        const { transfer } = ctx.deps.services.transfers.createTransfer(ctx.actor, {
          fromAccountId: values.fromAccountId ?? "",
          toAccount: values.toAccount ?? "",
          amount: values.amount ?? "",
          memo: values.memo,
          idempotencyKey,
          channel: "web",
        });
        return redirect(`/transfers?created=${encodeURIComponent(transfer.id)}`);
      } catch (error) {
        if (!isDomainError(error)) throw error;
        const errors: Record<string, string> = {};
        for (const d of error.details ?? []) if (d.field) errors[d.field] = d.message;
        if (Object.keys(errors).length === 0 || error.code !== "VALIDATION_ERROR") errors["form"] = error.message;
        return html(
          statusForCode(error.code),
          renderTransferForm({
            user: viewUser(ctx, ctx.actor),
            accounts: ctx.deps.services.accounts.listForUser(ctx.actor),
            values,
            errors,
            idempotencyKey,
          }),
        );
      }
    }),

    web("GET", "/cards", "user", (ctx) => {
      const accounts = ctx.deps.services.accounts.listForUser(ctx.actor);
      return html(
        200,
        renderCardsPage({
          user: viewUser(ctx, ctx.actor),
          cards: ctx.deps.services.cards.listForUser(ctx.actor),
          currencyByAccount: new Map(accounts.map((a) => [a.id, a.currency])),
        }),
      );
    }),

    web("GET", "/notifications", "user", (ctx) => {
      return html(
        200,
        renderNotificationsPage({ user: viewUser(ctx, ctx.actor), notifications: ctx.deps.services.notifications.list(ctx.actor) }),
      );
    }),
  ];
}
