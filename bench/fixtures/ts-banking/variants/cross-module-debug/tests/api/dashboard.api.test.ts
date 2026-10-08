import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { idemKey, setup } from "../support/harness.ts";

type Row = { number: string; balanceMinor: number };
const balanceOf = (body: { accounts: Row[] }, number: string): number | undefined =>
  body.accounts.find((a) => a.number === number)?.balanceMinor;

describe("dashboard API", () => {
  it("summarises balances and month-to-date figures in the customer's time zone", async () => {
    const t = setup();
    const alice = await t.login("alice");
    const res = await alice.get("/api/dashboard");
    assert.equal(res.status, 200);
    const body = res.json();
    const usd = body.totals.find((x: { currency: string }) => x.currency === "USD");
    assert.equal(usd.balanceMinor, 666_055 + 501_874);
    // 2026-10-01T03:45Z is still September in New York and must not count.
    assert.equal(usd.monthOutMinor, 525 + 7145 + 30000);
    assert.equal(usd.monthInMinor, 42);
    assert.equal(body.recent.length, 5);
  });

  it("serves repeated reads from the summary cache", async () => {
    const t = setup();
    const alice = await t.login("alice");
    await alice.get("/api/dashboard");
    const before = t.deps.caches.summary.stats();
    await alice.get("/api/dashboard");
    const after = t.deps.caches.summary.stats();
    assert.equal(after.hits, before.hits + 1);
    assert.equal(after.misses, before.misses);
  });

  it("refreshes after the customer moves money between their own accounts", async () => {
    const t = setup();
    const alice = await t.login("alice");
    await alice.get("/api/dashboard");
    const res = await alice.post(
      "/api/transfers",
      { fromAccountId: t.accountId("QM-1000-0001"), toAccount: "QM-1000-0002", amount: "100.00" },
      { "idempotency-key": idemKey() },
    );
    assert.equal(res.status, 201);
    const body = (await alice.get("/api/dashboard")).json();
    assert.equal(balanceOf(body, "QM-1000-0001"), 666_055 - 10_000);
    assert.equal(balanceOf(body, "QM-1000-0002"), 501_874 + 10_000);
  });

  it("refreshes after an admin deposit", async () => {
    const t = setup();
    const carol = await t.login("carol");
    await carol.get("/api/dashboard");
    const olive = await t.login("olive");
    await olive.post(`/api/admin/accounts/${t.accountId("QM-1000-0006")}/deposits`, { amount: "5000" });
    const body = (await carol.get("/api/dashboard")).json();
    assert.equal(balanceOf(body, "QM-1000-0006"), 1_384_000 + 5_000);
  });

  it("expires cached summaries after the configured TTL", async () => {
    const t = setup({ config: { cache: { summaryTtlMs: 60_000 } } });
    const dana = await t.login("dana");
    await dana.get("/api/dashboard");
    t.clock.advance(61_000);
    await dana.get("/api/dashboard");
    assert.equal(t.deps.caches.summary.stats().expirations, 1);
  });

  it("exposes cache statistics to admins only", async () => {
    const t = setup();
    const olive = await t.login("olive");
    const res = await olive.get("/api/admin/cache");
    assert.equal(res.status, 200);
    assert.equal(typeof res.json().summary.hits, "number");
    const alice = await t.login("alice");
    assert.equal((await alice.get("/api/admin/cache")).status, 403);
  });
});
