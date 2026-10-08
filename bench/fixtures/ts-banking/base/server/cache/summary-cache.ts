// Per-customer cache of the dashboard's account summary (balances, totals and
// month-to-date figures). Computing the summary walks the ledger for every
// account, so the dashboard reads it from here and domain events invalidate it
// whenever an account changes (see wiring in server/deps.ts).

import type { Clock } from "../../packages/shared/src/clock.ts";
import type { AccountChange } from "../../packages/shared/src/events.ts";
import type { Currency } from "../../packages/shared/src/money.ts";
import type { AccountStatus, AccountType } from "../../packages/accounts/src/types.ts";
import { type CacheStats, createTtlCache } from "./ttl-cache.ts";

export interface AccountSummaryRow {
  id: string;
  number: string;
  name: string;
  type: AccountType;
  currency: Currency;
  status: AccountStatus;
  balanceMinor: number;
}

export interface CurrencyTotal {
  currency: Currency;
  balanceMinor: number;
  monthInMinor: number;
  monthOutMinor: number;
}

export interface AccountSummary {
  userId: string;
  accounts: AccountSummaryRow[];
  totals: CurrencyTotal[];
  computedAt: string;
}

export interface SummaryCache {
  get(userId: string): AccountSummary | undefined;
  set(summary: AccountSummary): void;
  invalidate(change: AccountChange): void;
  invalidateUser(userId: string): void;
  clear(): void;
  stats(): CacheStats;
}

export function summaryKey(userId: string): string {
  return `summary:${userId}`;
}

export function createSummaryCache(options: { clock: Clock; ttlMs: number }): SummaryCache {
  const cache = createTtlCache<AccountSummary>({ clock: options.clock, defaultTtlMs: options.ttlMs });
  return {
    get: (userId) => cache.get(summaryKey(userId)),
    set: (summary) => cache.set(summaryKey(summary.userId), summary),
    invalidate: (change) => {
      cache.delete(summaryKey(change.ownerId));
    },
    invalidateUser: (userId) => {
      cache.delete(summaryKey(userId));
    },
    clear: () => cache.clear(),
    stats: () => cache.stats(),
  };
}
