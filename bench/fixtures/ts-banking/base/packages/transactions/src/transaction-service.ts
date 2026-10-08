import type { AccountService } from "../../accounts/src/account-service.ts";
import type { Actor } from "../../auth/src/types.ts";
import { notFound } from "../../shared/src/errors.ts";
import type { LedgerEntry, LedgerRepository, Page } from "./types.ts";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export interface TransactionPage {
  items: LedgerEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface TransactionService {
  listForAccount(actor: Actor, accountId: string, page?: Partial<Page>): TransactionPage;
  getEntry(actor: Actor, entryId: string): LedgerEntry;
  recentForAccounts(accountIds: readonly string[], limit: number): LedgerEntry[];
}

export function createTransactionService(deps: { entries: LedgerRepository; accounts: AccountService }): TransactionService {
  const { entries, accounts } = deps;

  return {
    listForAccount(actor, accountId, page = {}) {
      const account = accounts.getForActor(actor, accountId);
      const limit = Math.min(Math.max(page.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
      const offset = Math.max(page.offset ?? 0, 0);
      return {
        items: entries.listByAccount(account.id, { limit, offset }),
        total: entries.countByAccount(account.id),
        limit,
        offset,
      };
    },

    getEntry(actor, entryId) {
      const entry = entries.findById(entryId);
      if (!entry) throw notFound("Transaction");
      accounts.getForActor(actor, entry.accountId);
      return entry;
    },

    recentForAccounts(accountIds, limit) {
      return accountIds
        .flatMap((id) => entries.listByAccount(id, { limit, offset: 0 }))
        .sort((a, b) => b.postedAt.localeCompare(a.postedAt) || b.id.localeCompare(a.id))
        .slice(0, limit);
    },
  };
}
