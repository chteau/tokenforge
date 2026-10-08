import type { Card, CardRepository } from "../../../packages/cards/src/types.ts";
import { type Persistable, createTable } from "./table.ts";

export function createMemoryCardRepository(): CardRepository & Persistable {
  const table = createTable<Card>("cards", (c) => c.id);
  return {
    insert: (card) => table.insert(card),
    update: (card) => table.update(card),
    findById: (id) => table.get(id),
    listByOwner: (ownerId) => table.filter((c) => c.ownerId === ownerId),
    listByAccount: (accountId) => table.filter((c) => c.accountId === accountId),
    snapshot: () => table.snapshot(),
    restore: (rows) => table.restore(rows),
  };
}
