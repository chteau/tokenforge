import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface StoredRecord {
  id: string;
  [k: string]: unknown;
}

export interface Store {
  append(collection: string, record: StoredRecord): void;
  all<T extends { id: string }>(collection: string): T[];
  find<T extends { id: string }>(collection: string, id: string): T | undefined;
  replace(collection: string, record: StoredRecord): void;
}

/**
 * Append-only JSON-lines store. Each collection is one file under dataDir;
 * the latest line for an id wins. dataDir ":memory:" keeps everything in
 * process memory (tests, CLI dry runs).
 */
export class JsonlStore implements Store {
  private readonly dataDir: string;
  private memory = new Map<string, StoredRecord[]>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    if (!this.inMemory && !existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  }

  get inMemory(): boolean {
    return this.dataDir === ':memory:';
  }

  private file(collection: string): string {
    if (!/^[a-z][a-z0-9_-]*$/.test(collection)) throw new Error(`invalid collection name ${collection}`);
    return join(this.dataDir, `${collection}.jsonl`);
  }

  append(collection: string, record: StoredRecord): void {
    const row = { ...record, _writtenAt: new Date().toISOString() };
    if (this.inMemory) {
      const rows = this.memory.get(collection) ?? [];
      rows.push(row);
      this.memory.set(collection, rows);
      return;
    }
    appendFileSync(this.file(collection), JSON.stringify(row) + '\n');
  }

  private rows(collection: string): StoredRecord[] {
    if (this.inMemory) return this.memory.get(collection) ?? [];
    const f = this.file(collection);
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as StoredRecord);
  }

  all<T extends { id: string }>(collection: string): T[] {
    const latest = new Map<string, StoredRecord>();
    for (const r of this.rows(collection)) latest.set(r.id, r);
    return [...latest.values()].filter((r) => r._deleted !== true) as unknown as T[];
  }

  find<T extends { id: string }>(collection: string, id: string): T | undefined {
    return this.all<T>(collection).find((r) => r.id === id);
  }

  replace(collection: string, record: StoredRecord): void {
    this.append(collection, record);
  }

  /** Rewrites a collection keeping only the latest version of each record. */
  compact(collection: string): number {
    const rows = this.all(collection);
    if (this.inMemory) {
      this.memory.set(collection, rows);
    } else {
      writeFileSync(this.file(collection), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
    }
    return rows.length;
  }
}
