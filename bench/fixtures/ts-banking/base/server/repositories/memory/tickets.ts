import type { Ticket, TicketRepository } from "../../../packages/support/src/types.ts";
import { type Persistable, createTable } from "./table.ts";

export function createMemoryTicketRepository(): TicketRepository & Persistable {
  const table = createTable<Ticket>("tickets", (t) => t.id);
  return {
    insert: (t) => table.insert(t),
    update: (t) => table.update(t),
    findById: (id) => table.get(id),
    listByUser: (userId) => table.filter((t) => t.userId === userId),
    list: () => table.all(),
    snapshot: () => table.snapshot(),
    restore: (rows) => table.restore(rows),
  };
}
