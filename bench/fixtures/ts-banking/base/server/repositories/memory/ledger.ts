import type { LedgerEntry, LedgerRepository } from "../../../packages/transactions/src/types.ts";
import { type Persistable, createTable } from "./table.ts";

const newestFirst = (a: LedgerEntry, b: LedgerEntry): number =>
  b.postedAt.localeCompare(a.postedAt) || b.id.localeCompare(a.id);
const oldestFirst = (a: LedgerEntry, b: LedgerEntry): number => -newestFirst(a, b);

export function createMemoryLedgerRepository(): LedgerRepository & Persistable {
  const table = createTable<LedgerEntry>("ledger", (e) => e.id);
  return {
    append: (entry) => table.insert(entry),
    findById: (id) => table.get(id),
    listByAccount: (accountId, page) => {
      const rows = table.filter((e) => e.accountId === accountId).sort(newestFirst);
      return page ? rows.slice(page.offset, page.offset + page.limit) : rows;
    },
    countByAccount: (accountId) => table.filter((e) => e.accountId === accountId).length,
    listByAccountSince: (accountId, since) => {
      const from = since.toISOString();
      return table.filter((e) => e.accountId === accountId && e.postedAt >= from).sort(oldestFirst);
    },
    listByAccountBetween: (accountId, from, to) => {
      const lo = from.toISOString();
      const hi = to.toISOString();
      return table.filter((e) => e.accountId === accountId && e.postedAt >= lo && e.postedAt < hi).sort(oldestFirst);
    },
    listByTransfer: (transferId) => table.filter((e) => e.transferId === transferId).sort(oldestFirst),
    snapshot: () => table.snapshot(),
    restore: (rows) => table.restore(rows),
  };
}
