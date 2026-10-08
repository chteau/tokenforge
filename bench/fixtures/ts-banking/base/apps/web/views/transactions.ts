import type { Account } from "../../../packages/accounts/src/types.ts";
import type { TransactionPage } from "../../../packages/transactions/src/transaction-service.ts";
import { html, queryString } from "../html.ts";
import { date, money, signedMoney } from "./format.ts";
import { layout } from "./layout.ts";

export interface TransactionsViewModel {
  user: { displayName: string; timezone: string; unreadNotifications: number };
  account: Account;
  page: TransactionPage;
}

export function renderTransactionsPage(model: TransactionsViewModel): string {
  const { user, account, page } = model;
  const prevOffset = page.offset - page.limit;
  const nextOffset = page.offset + page.limit;
  const first = page.total === 0 ? 0 : page.offset + 1;
  const last = Math.min(page.offset + page.items.length, page.total);
  return layout(
    { title: `${account.name} activity`, nav: "accounts", user },
    html`<header class="page-header">
      <h1>${account.name}</h1>
      <p class="muted">${account.number} · Balance ${money(account.balanceMinor, account.currency)}</p>
    </header>
    <section class="card">
      <h2>Activity</h2>
      ${page.items.length === 0
        ? html`<p class="empty">No transactions to show.</p>`
        : html`<table class="transactions">
            <thead>
              <tr><th>Date</th><th>Description</th><th>Counterparty</th><th class="num">Amount</th><th class="num">Balance</th></tr>
            </thead>
            <tbody>
              ${page.items.map(
                (e) => html`<tr data-entry-id="${e.id}" class="${e.type}">
                  <td>${date(e.postedAt, user.timezone)}</td>
                  <td>${e.description}${e.reference ? html`<br><small>${e.reference}</small>` : ""}</td>
                  <td>${e.counterparty ?? ""}</td>
                  <td class="num">${signedMoney(e.type, e.amountMinor, e.currency)}</td>
                  <td class="num">${money(e.balanceAfterMinor, e.currency)}</td>
                </tr>`,
              )}
            </tbody>
          </table>`}
      <nav class="pager" aria-label="Pagination">
        <span>Showing ${first}–${last} of ${page.total}</span>
        ${page.offset > 0
          ? html`<a rel="prev" href="/accounts/${account.id}/transactions${queryString({ offset: Math.max(prevOffset, 0) || undefined })}">Newer</a>`
          : ""}
        ${nextOffset < page.total
          ? html`<a rel="next" href="/accounts/${account.id}/transactions${queryString({ offset: nextOffset })}">Older</a>`
          : ""}
      </nav>
    </section>`,
  );
}
