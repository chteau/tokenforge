// Durable storage for the in-memory repositories: the whole data set is
// written to one JSON file after every successful mutating request
// (see persistAfterWrite in server/http/middleware.ts) and loaded on boot.
// Repositories must be registered under a stable name to be persisted.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Persistable } from "./memory/table.ts";

export const STORE_FORMAT_VERSION = 3;

export interface DataStore {
  register(name: string, table: Persistable): void;
  /** Returns true when a file existed and was loaded. */
  load(): boolean;
  save(): void;
  readonly path: string | null;
}

interface StoreFile {
  version: number;
  savedAt: string;
  tables: Record<string, unknown[]>;
}

export function createJsonFileStore(path: string, now: () => Date = () => new Date()): DataStore {
  const tables = new Map<string, Persistable>();
  return {
    path,
    register(name, table) {
      if (tables.has(name)) throw new Error(`store: table ${name} registered twice`);
      tables.set(name, table);
    },
    load() {
      if (!existsSync(path)) return false;
      const parsed = JSON.parse(readFileSync(path, "utf8")) as StoreFile;
      if (parsed.version !== STORE_FORMAT_VERSION) {
        throw new Error(`store: unsupported data file version ${parsed.version} (expected ${STORE_FORMAT_VERSION})`);
      }
      for (const [name, table] of tables) table.restore(parsed.tables[name] ?? []);
      return true;
    },
    save() {
      const file: StoreFile = { version: STORE_FORMAT_VERSION, savedAt: now().toISOString(), tables: {} };
      for (const [name, table] of tables) file.tables[name] = table.snapshot();
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(file, null, 2), "utf8");
      renameSync(tmp, path);
    },
  };
}

/** Store used when no data file is configured (tests, demos). */
export function createNullStore(): DataStore {
  const names = new Set<string>();
  return {
    path: null,
    register(name) {
      if (names.has(name)) throw new Error(`store: table ${name} registered twice`);
      names.add(name);
    },
    load: () => false,
    save: () => {},
  };
}
