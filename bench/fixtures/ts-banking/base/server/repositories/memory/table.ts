// Generic in-memory table. Every repository keeps its rows in one of these so
// the JSON file store can snapshot and restore them uniformly.
//
// Rows are cloned on the way in and out: callers can never mutate stored state
// by accident, and must call `update` to persist a change.

export interface Persistable {
  snapshot(): unknown[];
  restore(rows: unknown[]): void;
}

export interface Table<T> extends Persistable {
  insert(row: T): T;
  update(row: T): T;
  get(key: string): T | undefined;
  delete(key: string): boolean;
  all(): T[];
  filter(predicate: (row: T) => boolean): T[];
  find(predicate: (row: T) => boolean): T | undefined;
  size(): number;
}

export function createTable<T>(name: string, keyOf: (row: T) => string): Table<T> {
  const rows = new Map<string, T>();
  const clone = (row: T): T => structuredClone(row);

  return {
    insert(row) {
      const key = keyOf(row);
      if (rows.has(key)) throw new Error(`${name}: duplicate key ${key}`);
      rows.set(key, clone(row));
      return clone(row);
    },
    update(row) {
      const key = keyOf(row);
      if (!rows.has(key)) throw new Error(`${name}: cannot update missing row ${key}`);
      rows.set(key, clone(row));
      return clone(row);
    },
    get(key) {
      const row = rows.get(key);
      return row === undefined ? undefined : clone(row);
    },
    delete(key) {
      return rows.delete(key);
    },
    all() {
      return [...rows.values()].map(clone);
    },
    filter(predicate) {
      const out: T[] = [];
      for (const row of rows.values()) if (predicate(row)) out.push(clone(row));
      return out;
    },
    find(predicate) {
      for (const row of rows.values()) if (predicate(row)) return clone(row);
      return undefined;
    },
    size() {
      return rows.size;
    },
    snapshot() {
      return [...rows.values()].map(clone);
    },
    restore(data) {
      rows.clear();
      for (const row of data as T[]) rows.set(keyOf(row), clone(row));
    },
  };
}
