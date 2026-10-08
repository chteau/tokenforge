import type { Currency } from "../../shared/src/money.ts";

export type EntryType = "credit" | "debit";

export type EntryCategory = "deposit" | "transfer" | "card" | "fee" | "interest" | "salary" | "adjustment";

/** One immutable ledger line. `amountMinor` is always positive; `type` gives the direction. */
export interface LedgerEntry {
  id: string;
  accountId: string;
  postedAt: string;
  type: EntryType;
  amountMinor: number;
  currency: Currency;
  description: string;
  counterparty: string | null;
  reference: string | null;
  category: EntryCategory;
  balanceAfterMinor: number;
  transferId: string | null;
}

export interface Page {
  limit: number;
  offset: number;
}

export interface LedgerRepository {
  append(entry: LedgerEntry): LedgerEntry;
  findById(id: string): LedgerEntry | undefined;
  /** Newest first (postedAt desc, then id desc). */
  listByAccount(accountId: string, page?: Page): LedgerEntry[];
  countByAccount(accountId: string): number;
  /** Entries with postedAt >= since, oldest first. */
  listByAccountSince(accountId: string, since: Date): LedgerEntry[];
  /** Entries with from <= postedAt < to, oldest first. */
  listByAccountBetween(accountId: string, from: Date, to: Date): LedgerEntry[];
  listByTransfer(transferId: string): LedgerEntry[];
}

export function signedAmount(entry: Pick<LedgerEntry, "type" | "amountMinor">): number {
  return entry.type === "credit" ? entry.amountMinor : -entry.amountMinor;
}
