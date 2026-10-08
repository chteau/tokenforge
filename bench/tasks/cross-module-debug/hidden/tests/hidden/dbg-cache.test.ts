import assert from "node:assert/strict";
import { test } from "node:test";
import { balanceOf, world } from "./dbg-support.ts";

test("DBG-CACHE: repeated dashboard reads are served from the summary cache", async () => {
  const w = world();
  const bob = await w.login("bob");
  await bob.dashboard();
  const before = w.stats();
  await bob.dashboard();
  await bob.page("/dashboard");
  const after = w.stats();
  assert.equal(after.hits, before.hits + 2);
  assert.equal(after.misses, before.misses);
});

test("DBG-CACHE: the recipient's summary is recomputed once and then cached again", async () => {
  const w = world();
  const alice = await w.login("alice");
  const bob = await w.login("bob");
  await bob.dashboard();
  await alice.transfer("QM-1000-0001", "QM-1000-0005", "15.00");
  assert.equal(balanceOf(await bob.dashboard(), "QM-1000-0005"), 38_000);
  const before = w.stats();
  assert.equal(balanceOf(await bob.dashboard(), "QM-1000-0005"), 38_000);
  const after = w.stats();
  assert.equal(after.hits, before.hits + 1);
  assert.equal(after.misses, before.misses);
});

test("DBG-CACHE: other customers' cached summaries survive a transfer", async () => {
  const w = world();
  const alice = await w.login("alice");
  const carol = await w.login("carol");
  const dana = await w.login("dana");
  await carol.dashboard();
  await dana.dashboard();
  await alice.transfer("QM-1000-0001", "QM-1000-0005", "15.00");
  const before = w.stats();
  await carol.dashboard();
  await dana.dashboard();
  const after = w.stats();
  assert.equal(after.hits, before.hits + 2);
  assert.equal(after.misses, before.misses);
});

test("DBG-CACHE: the sender's dashboard is still refreshed", async () => {
  const w = world();
  const alice = await w.login("alice");
  await alice.dashboard();
  await alice.transfer("QM-1000-0001", "QM-1000-0005", "15.00");
  assert.equal(balanceOf(await alice.dashboard(), "QM-1000-0001"), 666_055 - 1500);
  await alice.transfer("QM-1000-0001", "QM-1000-0002", "5.00");
  const d = await alice.dashboard();
  assert.equal(balanceOf(d, "QM-1000-0001"), 666_055 - 2000);
  assert.equal(balanceOf(d, "QM-1000-0002"), 501_874 + 500);
});

test("DBG-CACHE: cached summaries are kept for the configured TTL when nothing changes", async () => {
  const w = world();
  const bob = await w.login("bob");
  await bob.dashboard();
  w.clock.advance(4 * 60_000);
  const bob2 = await w.login("bob");
  const before = w.stats();
  await bob2.dashboard();
  assert.equal(w.stats().hits, before.hits + 1);
  w.clock.advance(2 * 60_000);
  const bob3 = await w.login("bob");
  const mid = w.stats();
  await bob3.dashboard();
  assert.equal(w.stats().misses, mid.misses + 1, "expired after five minutes");
});

test("DBG-CACHE: admin deposits still refresh the dashboard", async () => {
  const w = world();
  const carol = await w.login("carol");
  const olive = await w.login("olive");
  await carol.dashboard();
  const res = await olive.post(`/api/admin/accounts/${w.accountId("QM-1000-0006")}/deposits`, { amount: "5000" });
  assert.equal(res.status, 201);
  assert.equal(balanceOf(await carol.dashboard(), "QM-1000-0006"), 1_384_000 + 5000);
});
