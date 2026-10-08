import type { Transfer, TransferRepository } from "../../../packages/transfers/src/types.ts";
import { type Persistable, createTable } from "./table.ts";

export function createMemoryTransferRepository(): TransferRepository & Persistable {
  const table = createTable<Transfer>("transfers", (t) => t.id);
  return {
    insert: (transfer) => {
      if (table.find((t) => t.userId === transfer.userId && t.idempotencyKey === transfer.idempotencyKey)) {
        throw new Error(`transfers: duplicate idempotency key for ${transfer.userId}`);
      }
      return table.insert(transfer);
    },
    update: (transfer) => table.update(transfer),
    findById: (id) => table.get(id),
    findByIdempotencyKey: (userId, key) => table.find((t) => t.userId === userId && t.idempotencyKey === key),
    listByUser: (userId) =>
      table.filter((t) => t.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)),
    listCompletedByUserSince: (userId, currency, since) => {
      const from = since.toISOString();
      return table.filter(
        (t) => t.userId === userId && t.currency === currency && t.status === "completed" && t.createdAt >= from,
      );
    },
    snapshot: () => table.snapshot(),
    restore: (rows) => table.restore(rows),
  };
}
