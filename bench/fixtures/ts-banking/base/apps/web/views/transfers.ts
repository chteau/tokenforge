import type { Account } from "../../../packages/accounts/src/types.ts";
import type { Transfer } from "../../../packages/transfers/src/types.ts";
import { html } from "../html.ts";
import { dateTime, money, statusBadge } from "./format.ts";
import { layout } from "./layout.ts";

export interface TransfersViewModel {
  user: { displayName: string; timezone: string; unreadNotifications: number };
  transfers: Transfer[];
  accounts: Account[];
  createdId?: string;
}

export function renderTransfersPage(model: TransfersViewModel): string {
  const { user } = model;
  const names = new Map(model.accounts.map((a) => [a.id, `${a.name} (${a.number})`]));
  return layout(
    {
      title: "Transfers",
      nav: "transfers",
      user,
      flash: model.createdId ? { kind: "info", message: "Your transfer was sent." } : undefined,
    },
    html`<header class="page-header">
      <h1>Transfers</h1>
      <a class="button" href="/transfers/new">New transfer</a>
    </header>
    <section class="card">
      ${model.transfers.length === 0
        ? html`<p class="empty">You haven't made any transfers yet.</p>`
        : html`<table class="transfers">
            <thead><tr><th>Date</th><th>From</th><th>To</th><th>Memo</th><th>Status</th><th class="num">Amount</th></tr></thead>
            <tbody>
              ${model.transfers.map(
                (t) => html`<tr data-transfer-id="${t.id}"${t.id === model.createdId ? html` class="highlight"` : ""}>
                  <td>${dateTime(t.createdAt, user.timezone)}</td>
                  <td>${names.get(t.fromAccountId) ?? t.fromAccountId}</td>
                  <td>${names.get(t.toAccountId) ?? t.toAccountId}</td>
                  <td>${t.memo}</td>
                  <td>${statusBadge(t.status)}</td>
                  <td class="num">${money(t.amountMinor, t.currency)}</td>
                </tr>`,
              )}
            </tbody>
          </table>`}
    </section>`,
  );
}
