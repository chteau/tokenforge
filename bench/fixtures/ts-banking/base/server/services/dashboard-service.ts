// Builds the data behind the dashboard page and GET /api/dashboard.
// The expensive part (balances and month-to-date totals) comes from the
// summary cache; recent activity and unread counts are always read live.

import type { AccountService } from "../../packages/accounts/src/account-service.ts";
import type { Actor, UserRepository } from "../../packages/auth/src/types.ts";
import type { NotificationService } from "../../packages/notifications/src/notification-service.ts";
import type { Clock } from "../../packages/shared/src/clock.ts";
import { startOfLocalMonth } from "../../packages/shared/src/dates.ts";
import { notFound } from "../../packages/shared/src/errors.ts";
import type { Currency } from "../../packages/shared/src/money.ts";
import type { TransactionService } from "../../packages/transactions/src/transaction-service.ts";
import type { LedgerEntry, LedgerRepository } from "../../packages/transactions/src/types.ts";
import type { AccountSummary, CurrencyTotal, SummaryCache } from "../cache/summary-cache.ts";

export const RECENT_ACTIVITY_LIMIT = 5;

export interface Dashboard {
  user: { id: string; displayName: string; timezone: string };
  summary: AccountSummary;
  recent: LedgerEntry[];
  unreadNotifications: number;
}

export interface DashboardService {
  getDashboard(actor: Actor): Dashboard;
  /** Recompute the summary without touching the cache. */
  computeSummary(actor: Actor): AccountSummary;
}

export interface DashboardDeps {
  users: UserRepository;
  accounts: AccountService;
  entries: LedgerRepository;
  transactions: TransactionService;
  notifications: NotificationService;
  summaryCache: SummaryCache;
  clock: Clock;
}

export function createDashboardService(deps: DashboardDeps): DashboardService {
  const { users, accounts, entries, transactions, notifications, summaryCache, clock } = deps;

  function computeSummary(actor: Actor): AccountSummary {
    const user = users.findById(actor.userId);
    if (!user) throw notFound("User");
    const now = clock.now();
    const monthStart = startOfLocalMonth(now, user.timezone);
    const owned = accounts.listForUser(actor);
    const totals = new Map<Currency, CurrencyTotal>();
    for (const account of owned) {
      const total = totals.get(account.currency) ?? {
        currency: account.currency,
        balanceMinor: 0,
        monthInMinor: 0,
        monthOutMinor: 0,
      };
      total.balanceMinor += account.balanceMinor;
      for (const entry of entries.listByAccountSince(account.id, monthStart)) {
        if (entry.category === "transfer" && isInternalMove(entry, owned.map((a) => a.id))) continue;
        if (entry.type === "credit") total.monthInMinor += entry.amountMinor;
        else total.monthOutMinor += entry.amountMinor;
      }
      totals.set(account.currency, total);
    }
    return {
      userId: user.id,
      accounts: owned.map((a) => ({
        id: a.id,
        number: a.number,
        name: a.name,
        type: a.type,
        currency: a.currency,
        status: a.status,
        balanceMinor: a.balanceMinor,
      })),
      totals: [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
      computedAt: now.toISOString(),
    };
  }

  /** Moves between two of the customer's own accounts are not income or spending. */
  function isInternalMove(entry: LedgerEntry, ownAccountIds: string[]): boolean {
    if (!entry.transferId) return false;
    const legs = entries.listByTransfer(entry.transferId);
    return legs.length === 2 && legs.every((leg) => ownAccountIds.includes(leg.accountId));
  }

  return {
    computeSummary,

    getDashboard(actor) {
      const user = users.findById(actor.userId);
      if (!user) throw notFound("User");
      let summary = summaryCache.get(user.id);
      if (!summary) {
        summary = computeSummary(actor);
        summaryCache.set(summary);
      }
      return {
        user: { id: user.id, displayName: user.displayName, timezone: user.timezone },
        summary,
        recent: transactions.recentForAccounts(
          summary.accounts.map((a) => a.id),
          RECENT_ACTIVITY_LIMIT,
        ),
        unreadNotifications: notifications.unreadCount(user.id),
      };
    },
  };
}
