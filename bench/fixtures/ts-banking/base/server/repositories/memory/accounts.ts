import type { Account, AccountRepository } from "../../../packages/accounts/src/types.ts";
import { type Persistable, createTable } from "./table.ts";

export function createMemoryAccountRepository(): AccountRepository & Persistable {
  const table = createTable<Account>("accounts", (a) => a.id);
  return {
    insert: (account) => table.insert(account),
    update: (account) => table.update(account),
    findById: (id) => table.get(id),
    findByNumber: (number) => table.find((a) => a.number === number),
    listByOwner: (ownerId) => table.filter((a) => a.ownerId === ownerId),
    list: () => table.all(),
    snapshot: () => table.snapshot(),
    restore: (rows) => table.restore(rows),
  };
}
