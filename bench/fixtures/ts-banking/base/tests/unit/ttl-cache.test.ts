import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createManualClock } from "../../packages/shared/src/clock.ts";
import { createSummaryCache, summaryKey } from "../../server/cache/summary-cache.ts";
import { createTtlCache } from "../../server/cache/ttl-cache.ts";

describe("TtlCache", () => {
  it("serves values until they expire", () => {
    const clock = createManualClock("2026-01-01T00:00:00Z");
    const cache = createTtlCache<number>({ clock, defaultTtlMs: 1000 });
    cache.set("a", 1);
    assert.equal(cache.get("a"), 1);
    clock.advance(999);
    assert.equal(cache.get("a"), 1);
    clock.advance(1);
    assert.equal(cache.get("a"), undefined);
    assert.deepEqual(cache.stats(), { hits: 2, misses: 1, sets: 1, invalidations: 0, expirations: 1, size: 0 });
  });

  it("returns copies so callers cannot mutate cached values", () => {
    const clock = createManualClock("2026-01-01T00:00:00Z");
    const cache = createTtlCache<{ n: number }>({ clock, defaultTtlMs: 1000 });
    cache.set("k", { n: 1 });
    const got = cache.get("k");
    assert.ok(got);
    got.n = 99;
    assert.equal(cache.get("k")?.n, 1);
  });

  it("invalidates by key and prefix and evicts the oldest entry when full", () => {
    const clock = createManualClock("2026-01-01T00:00:00Z");
    const cache = createTtlCache<string>({ clock, defaultTtlMs: 1000, maxEntries: 3 });
    cache.set("x:1", "a");
    cache.set("x:2", "b");
    cache.set("y:1", "c");
    cache.set("y:2", "d");
    assert.deepEqual(cache.keys(), ["x:2", "y:1", "y:2"]);
    assert.equal(cache.deleteByPrefix("y:"), 2);
    assert.ok(cache.delete("x:2"));
    assert.equal(cache.stats().invalidations, 3);
  });
});

describe("SummaryCache", () => {
  it("keys summaries per user and invalidates on account changes", () => {
    const clock = createManualClock("2026-01-01T00:00:00Z");
    const cache = createSummaryCache({ clock, ttlMs: 60_000 });
    cache.set({ userId: "usr_1", accounts: [], totals: [], computedAt: clock.now().toISOString() });
    cache.set({ userId: "usr_2", accounts: [], totals: [], computedAt: clock.now().toISOString() });
    assert.equal(summaryKey("usr_1"), "summary:usr_1");
    cache.invalidate({ ownerId: "usr_1", accountId: "acc_9" });
    assert.equal(cache.get("usr_1"), undefined);
    assert.ok(cache.get("usr_2"));
  });
});
