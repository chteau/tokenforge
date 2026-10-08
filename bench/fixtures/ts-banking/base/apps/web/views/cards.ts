import type { Card } from "../../../packages/cards/src/types.ts";
import { formatMoney } from "../../../packages/shared/src/money.ts";
import { html } from "../html.ts";
import { statusBadge } from "./format.ts";
import { layout } from "./layout.ts";

export function renderCardsPage(model: {
  user: { displayName: string; unreadNotifications: number };
  cards: Card[];
  currencyByAccount: Map<string, "USD" | "EUR" | "GBP" | "CHF" | "JPY">;
}): string {
  return layout(
    { title: "Cards", nav: "cards", user: model.user },
    html`<h1>Cards</h1>
    <div class="grid">
      ${model.cards.map((c) => {
        const currency = model.currencyByAccount.get(c.accountId) ?? "USD";
        return html`<article class="card bank-card" data-card-id="${c.id}">
          <p class="card-number">•••• ${c.last4}</p>
          <p>${c.network} · expires ${String(c.expiresMonth).padStart(2, "0")}/${String(c.expiresYear).slice(-2)}</p>
          <p>${statusBadge(c.status)}</p>
          <p class="muted">Monthly limit ${formatMoney(c.monthlySpendLimitMinor, currency)}</p>
        </article>`;
      })}
    </div>`,
  );
}
