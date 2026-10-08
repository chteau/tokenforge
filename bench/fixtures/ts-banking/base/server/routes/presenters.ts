// JSON representations returned by the API. Amounts are exposed both as
// integer minor units (`*Minor`) and as decimal strings for display.

import type { Account } from "../../packages/accounts/src/types.ts";
import type { Card } from "../../packages/cards/src/types.ts";
import { formatDecimal } from "../../packages/shared/src/money.ts";
import type { LedgerEntry } from "../../packages/transactions/src/types.ts";
import type { Transfer } from "../../packages/transfers/src/types.ts";

export function presentAccount(a: Account) {
  return {
    id: a.id,
    number: a.number,
    name: a.name,
    type: a.type,
    currency: a.currency,
    status: a.status,
    balanceMinor: a.balanceMinor,
    balance: formatDecimal(a.balanceMinor, a.currency),
    openedAt: a.openedAt,
  };
}

export function presentEntry(e: LedgerEntry) {
  return {
    id: e.id,
    accountId: e.accountId,
    postedAt: e.postedAt,
    type: e.type,
    amountMinor: e.amountMinor,
    amount: formatDecimal(e.amountMinor, e.currency),
    currency: e.currency,
    description: e.description,
    counterparty: e.counterparty,
    reference: e.reference,
    category: e.category,
    balanceAfterMinor: e.balanceAfterMinor,
    transferId: e.transferId,
  };
}

export function presentTransfer(t: Transfer) {
  return {
    id: t.id,
    fromAccountId: t.fromAccountId,
    toAccountId: t.toAccountId,
    amountMinor: t.amountMinor,
    amount: formatDecimal(t.amountMinor, t.currency),
    currency: t.currency,
    memo: t.memo,
    status: t.status,
    failureReason: t.failureReason,
    channel: t.channel,
    createdAt: t.createdAt,
    completedAt: t.completedAt,
  };
}

export function presentCard(c: Card) {
  return {
    id: c.id,
    accountId: c.accountId,
    last4: c.last4,
    network: c.network,
    status: c.status,
    expires: `${String(c.expiresMonth).padStart(2, "0")}/${c.expiresYear}`,
    monthlySpendLimitMinor: c.monthlySpendLimitMinor,
  };
}
