import type { User, UserRepository } from "../../../packages/auth/src/types.ts";
import { type Persistable, createTable } from "./table.ts";

export function createMemoryUserRepository(): UserRepository & Persistable {
  const table = createTable<User>("users", (u) => u.id);
  return {
    insert: (user) => {
      if (table.find((u) => u.username === user.username)) throw new Error(`users: duplicate username ${user.username}`);
      return table.insert(user);
    },
    update: (user) => table.update(user),
    findById: (id) => table.get(id),
    findByUsername: (username) => table.find((u) => u.username === username),
    list: () => table.all(),
    snapshot: () => table.snapshot(),
    restore: (rows) => table.restore(rows),
  };
}
