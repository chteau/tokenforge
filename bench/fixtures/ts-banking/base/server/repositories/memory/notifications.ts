import type {
  Notification,
  NotificationRepository,
  OutboxEmail,
  OutboxRepository,
} from "../../../packages/notifications/src/types.ts";
import { type Persistable, createTable } from "./table.ts";

export function createMemoryNotificationRepository(): NotificationRepository & Persistable {
  const table = createTable<Notification>("notifications", (n) => n.id);
  return {
    insert: (n) => table.insert(n),
    update: (n) => table.update(n),
    findById: (id) => table.get(id),
    listByUser: (userId) =>
      table.filter((n) => n.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)),
    snapshot: () => table.snapshot(),
    restore: (rows) => table.restore(rows),
  };
}

export function createMemoryOutboxRepository(): OutboxRepository & Persistable {
  const table = createTable<OutboxEmail>("outbox", (e) => e.id);
  return {
    insert: (e) => table.insert(e),
    update: (e) => table.update(e),
    listPending: () => table.filter((e) => e.sentAt === null),
    list: () => table.all(),
    snapshot: () => table.snapshot(),
    restore: (rows) => table.restore(rows),
  };
}
