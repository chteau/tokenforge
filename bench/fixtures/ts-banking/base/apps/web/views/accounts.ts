import { ACCOUNT_TYPE_LABELS, type Account } from "../../../packages/accounts/src/types.ts";
import { html } from "../html.ts";
import { date, money, statusBadge } from "./format.ts";
import { layout } from "./layout.ts";

export interface AccountsViewModel {
  user: { displayName: string; timezone: string; unreadNotifications: number };
  accounts: Account[];
}

export function renderAccountsPage(model: AccountsViewModel): string {
  const { user } = model;
  return layout(
    { title: "Accounts", nav: "accounts", user },
    html`<h1>Accounts</h1>
    <div class="grid">
      ${model.accounts.map(
        (a) => html`<article class="card account" data-account-id="${a.id}">
          <h2>${a.name}</h2>
          <p class="muted">${ACCOUNT_TYPE_LABELS[a.type]} · ${a.number} · ${a.currency}</p>
          <p class="balance">${money(a.balanceMinor, a.currency)}</p>
          <p>${statusBadge(a.status)} <small>Opened ${date(a.openedAt, user.timezone)}</small></p>
          <p class="actions">
            <a href="/accounts/${a.id}/transactions">View activity</a>
            <a href="/transfers/new?from=${a.id}">Transfer from this account</a>
          </p>
        </article>`,
      )}
    </div>`,
  );
}
