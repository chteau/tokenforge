import type { Session, SessionRepository } from "../../../packages/auth/src/types.ts";
import { type Persistable, createTable } from "./table.ts";

export function createMemorySessionRepository(): SessionRepository & Persistable {
  const table = createTable<Session>("sessions", (s) => s.token);
  return {
    insert: (session) => table.insert(session),
    update: (session) => table.update(session),
    findByToken: (token) => table.get(token),
    delete: (token) => {
      table.delete(token);
    },
    deleteForUser: (userId) => {
      const mine = table.filter((s) => s.userId === userId);
      for (const s of mine) table.delete(s.token);
      return mine.length;
    },
    snapshot: () => table.snapshot(),
    restore: (rows) => table.restore(rows),
  };
}
