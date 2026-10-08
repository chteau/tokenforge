import type { Account } from "../../../packages/accounts/src/types.ts";
import { formatMoney } from "../../../packages/shared/src/money.ts";
import { type SafeHtml, html } from "../html.ts";
import { layout } from "./layout.ts";

export interface TransferFormValues {
  fromAccountId?: string;
  toAccount?: string;
  amount?: string;
  memo?: string;
}

export interface TransferFormModel {
  user: { displayName: string; unreadNotifications: number };
  accounts: Account[];
  values: TransferFormValues;
  /** Field name -> message. The key "form" holds errors not tied to one field. */
  errors: Record<string, string>;
  idempotencyKey: string;
}

export function fieldError(errors: Record<string, string>, field: string): SafeHtml | "" {
  const message = errors[field];
  return message ? html`<span class="field-error" id="${field}-error">${message}</span>` : "";
}

export function renderTransferForm(model: TransferFormModel): string {
  const { values, errors } = model;
  const active = model.accounts.filter((a) => a.status === "active");
  return layout(
    {
      title: "Move money",
      nav: "transfers",
      user: model.user,
      flash: errors["form"] ? { kind: "error", message: errors["form"] } : undefined,
      scripts: ["/static/transfer-form.js"],
    },
    html`<section class="card narrow">
      <h1>Move money</h1>
      <form method="post" action="/transfers" class="stack" id="transfer-form" novalidate>
        <input type="hidden" name="idempotencyKey" value="${model.idempotencyKey}">
        <label>From
          <select name="fromAccountId" required>
            ${active.map(
              (a) => html`<option value="${a.id}" data-currency="${a.currency}"${a.id === values.fromAccountId ? html` selected` : ""}>${a.name} (${a.number}) · ${formatMoney(a.balanceMinor, a.currency)}</option>`,
            )}
          </select>
          ${fieldError(errors, "fromAccountId")}
        </label>
        <label>To account number
          <input name="toAccount" required placeholder="QM-1000-0000" value="${values.toAccount ?? ""}">
          ${fieldError(errors, "toAccount")}
        </label>
        <label>Amount
          <input name="amount" inputmode="decimal" required placeholder="0.00" value="${values.amount ?? ""}">
          ${fieldError(errors, "amount")}
        </label>
        <label>Memo <small>(optional)</small>
          <input name="memo" maxlength="140" value="${values.memo ?? ""}">
          ${fieldError(errors, "memo")}
        </label>
        <button type="submit" class="primary">Send transfer</button>
      </form>
    </section>`,
  );
}
