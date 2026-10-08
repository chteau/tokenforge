import { formatLocalDate, formatLocalDateTime } from "../../../packages/shared/src/dates.ts";
import { type Currency, formatMoney } from "../../../packages/shared/src/money.ts";
import { type SafeHtml, html } from "../html.ts";

export function money(amountMinor: number, currency: Currency): SafeHtml {
  const cls = amountMinor < 0 ? "amount negative" : "amount";
  return html`<span class="${cls}">${formatMoney(amountMinor, currency)}</span>`;
}

export function signedMoney(type: "credit" | "debit", amountMinor: number, currency: Currency): SafeHtml {
  const signed = type === "credit" ? amountMinor : -amountMinor;
  const text = (signed > 0 ? "+" : "") + formatMoney(signed, currency);
  return html`<span class="amount ${type}">${text}</span>`;
}

export function date(iso: string, timeZone: string): string {
  return formatLocalDate(new Date(iso), timeZone);
}

export function dateTime(iso: string, timeZone: string): string {
  return formatLocalDateTime(new Date(iso), timeZone);
}

export function statusBadge(status: string): SafeHtml {
  return html`<span class="badge badge-${status}">${status.replace(/_/g, " ")}</span>`;
}
