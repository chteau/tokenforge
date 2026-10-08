import type { Clock } from "../../packages/shared/src/clock.ts";

export interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  invalidations: number;
  expirations: number;
  size: number;
}

export interface TtlCache<V> {
  get(key: string): V | undefined;
  set(key: string, value: V, ttlMs?: number): void;
  delete(key: string): boolean;
  deleteByPrefix(prefix: string): number;
  clear(): void;
  keys(): string[];
  stats(): CacheStats;
  resetStats(): void;
}

interface Slot<V> {
  value: V;
  expiresAt: number;
}

export function createTtlCache<V>(options: { clock: Clock; defaultTtlMs: number; maxEntries?: number }): TtlCache<V> {
  const { clock, defaultTtlMs, maxEntries = 10_000 } = options;
  const slots = new Map<string, Slot<V>>();
  const counters = { hits: 0, misses: 0, sets: 0, invalidations: 0, expirations: 0 };

  function evictOldest(): void {
    const oldest = slots.keys().next();
    if (!oldest.done) slots.delete(oldest.value);
  }

  return {
    get(key) {
      const slot = slots.get(key);
      if (!slot) {
        counters.misses += 1;
        return undefined;
      }
      if (slot.expiresAt <= clock.now().getTime()) {
        slots.delete(key);
        counters.expirations += 1;
        counters.misses += 1;
        return undefined;
      }
      counters.hits += 1;
      return structuredClone(slot.value);
    },
    set(key, value, ttlMs = defaultTtlMs) {
      if (!slots.has(key) && slots.size >= maxEntries) evictOldest();
      slots.delete(key);
      slots.set(key, { value: structuredClone(value), expiresAt: clock.now().getTime() + ttlMs });
      counters.sets += 1;
    },
    delete(key) {
      const removed = slots.delete(key);
      if (removed) counters.invalidations += 1;
      return removed;
    },
    deleteByPrefix(prefix) {
      let n = 0;
      for (const key of [...slots.keys()]) {
        if (key.startsWith(prefix)) {
          slots.delete(key);
          n += 1;
        }
      }
      counters.invalidations += n;
      return n;
    },
    clear() {
      counters.invalidations += slots.size;
      slots.clear();
    },
    keys: () => [...slots.keys()],
    stats: () => ({ ...counters, size: slots.size }),
    resetStats() {
      counters.hits = counters.misses = counters.sets = counters.invalidations = counters.expirations = 0;
    },
  };
}
