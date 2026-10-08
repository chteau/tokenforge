import { ACCOUNT_TYPE_LABELS } from "../../../packages/accounts/src/types.ts";
import type { LedgerEntry } from "../../../packages/transactions/src/types.ts";
import type { AccountSummary } from "../../../server/cache/summary-cache.ts";
import { html } from "../html.ts";
import { date, money, signedMoney, statusBadge } from "./format.ts";
import { layout } from "./layout.ts";

export interface DashboardViewModel {
  user: { displayName: string; timezone: string };
  summary: AccountSummary;
  recent: LedgerEntry[];
  unreadNotifications: number;
}

export function renderDashboard(model: DashboardViewModel): string {
  const { summary, user } = model;
  const accountNames = new Map(summary.accounts.map((a) => [a.id, a.name]));
  return layout(
    { title: "Overview", nav: "dashboard", user: { displayName: user.displayName, unreadNotifications: model.unreadNotifications } },
    html`<section class="totals" aria-label="Balances by currency">
      ${summary.totals.map(
        (t) => html`<article class="tile" data-currency="${t.currency}">
          <h2>${t.currency} balance</h2>
          <p class="balance">${money(t.balanceMinor, t.currency)}</p>
          <dl class="month">
            <div><dt>In this month</dt><dd>${money(t.monthInMinor, t.currency)}</dd></div>
            <div><dt>Out this month</dt><dd>${money(t.monthOutMinor, t.currency)}</dd></div>
          </dl>
        </article>`,
      )}
    </section>
    <section class="card">
      <header class="card-header">
        <h2>Your accounts</h2>
        <a class="button" href="/transfers/new">Move money</a>
      </header>
      <table class="accounts">
        <thead><tr><th>Account</th><th>Number</th><th>Status</th><th class="num">Balance</th></tr></thead>
        <tbody>
          ${summary.accounts.map(
            (a) => html`<tr data-account-id="${a.id}">
              <td><a href="/accounts/${a.id}/transactions">${a.name}</a><br><small>${ACCOUNT_TYPE_LABELS[a.type]}</small></td>
              <td>${a.number}</td>
              <td>${statusBadge(a.status)}</td>
              <td class="num">${money(a.balanceMinor, a.currency)}</td>
            </tr>`,
          )}
        </tbody>
      </table>
    </section>
    <section class="card">
      <h2>Recent activity</h2>
      ${model.recent.length === 0
        ? html`<p class="empty">No transactions yet.</p>`
        : html`<ul class="activity">
            ${model.recent.map(
              (e) => html`<li>
                <span class="when">${date(e.postedAt, user.timezone)}</span>
                <span class="what">${e.description}<small>${accountNames.get(e.accountId) ?? ""}</small></span>
                ${signedMoney(e.type, e.amountMinor, e.currency)}
              </li>`,
            )}
          </ul>`}
    </section>`,
  );
}
