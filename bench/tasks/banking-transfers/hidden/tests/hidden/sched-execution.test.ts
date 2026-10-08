import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { world } from "./sched-support.ts";

test("SCHED-EXECUTE: only transfers that are due are executed", async () => {
  const w = world();
  const alice = await w.login("alice");
  await alice.schedule({ fromAccountId: w.accountId("QM-1000-0001"), toAccount: "QM-1000-0005", amount: "25.00", scheduledDate: "2026-10-09" });
  assert.deepEqual((await w.run()).json(), { processed: 0, completed: 0, failed: 0 });
  w.clock.set("2026-10-09T12:59:59.999Z");
  assert.equal((await w.run()).json().processed, 0);
  w.clock.set("2026-10-09T13:00:00.000Z");
  assert.deepEqual((await w.run()).json(), { processed: 1, completed: 1, failed: 0 });
});

test("SCHED-EXECUTE: execution goes through the normal transfer flow", async () => {
  const w = world();
  const alice = await w.login("alice");
  const created = await alice.schedule({
    fromAccountId: w.accountId("QM-1000-0001"),
    toAccount: "QM-1000-0005",
    amount: "25.00",
    memo: "Book club",
    scheduledDate: "2026-10-09",
  });
  const id = created.json().scheduledTransfer.id;
  w.clock.set("2026-10-09T15:00:00.000Z");
  assert.equal((await w.run()).json().completed, 1);

  const alice2 = await w.login("alice");
  const s = (await alice2.get(`/api/scheduled-transfers/${id}`)).json().scheduledTransfer;
  assert.equal(s.status, "completed");
  assert.equal(typeof s.transferId, "string");
  assert.equal(s.failureReason, null);
  const transfers = (await alice2.get("/api/transfers")).json().items;
  const t = transfers.find((x: { id: string }) => x.id === s.transferId);
  assert.ok(t, "resulting transfer is listed");
  assert.equal(t.channel, "scheduled");
  assert.equal(t.status, "completed");
  assert.equal(t.amountMinor, 2500);
  assert.equal(t.memo, "Book club");
  assert.equal(w.balance("QM-1000-0001"), 666_055 - 2500);
  assert.equal(w.balance("QM-1000-0005"), 36_500 + 2500);
  assert.equal(w.deps.repos.ledger.listByTransfer(s.transferId).length, 2);
  const bob = await w.login("bob");
  const kinds = (await bob.get("/api/notifications")).json().items.map((n: { kind: string }) => n.kind);
  assert.ok(kinds.includes("transfer_received"));
  const dash = (await bob.get("/api/dashboard")).json();
  assert.equal(dash.accounts.find((a: { number: string }) => a.number === "QM-1000-0005").balanceMinor, 36_500 + 2500);
});

test("SCHED-EXECUTE: running the executor again never executes twice", async () => {
  const w = world();
  const alice = await w.login("alice");
  await alice.schedule({ fromAccountId: w.accountId("QM-1000-0001"), toAccount: "QM-1000-0002", amount: "70.00", scheduledDate: "2026-10-08" });
  w.clock.set("2026-10-08T13:30:00.000Z");
  assert.equal((await w.run()).json().completed, 1);
  assert.deepEqual((await w.run()).json(), { processed: 0, completed: 0, failed: 0 });
  w.clock.advance(86_400_000);
  assert.equal((await w.run()).json().processed, 0);
  assert.equal(w.balance("QM-1000-0002"), 501_874 + 7000);
  assert.equal(w.deps.repos.transfers.listByUser(w.deps.repos.users.findByUsername("alice")!.id).length, 1);
});

test("SCHED-EXECUTE: due transfers run in executeAt order", async () => {
  const w = world();
  const olive = await w.login("olive");
  const carolId = w.deps.repos.users.findByUsername("carol")!.id;
  const opened = await olive.post("/api/admin/accounts", { ownerId: carolId, name: "Yen pot", type: "savings", currency: "JPY" });
  assert.equal(opened.status, 201);
  const target = opened.json().account.number;
  const carol = await w.login("carol");
  const from = w.accountId("QM-1000-0006");
  const later = await carol.schedule({ fromAccountId: from, toAccount: target, amount: "300000", scheduledDate: "2026-10-10" });
  const earlier = await carol.schedule({ fromAccountId: from, toAccount: target, amount: "650000", scheduledDate: "2026-10-09" });
  assert.equal(later.status, 201);
  assert.equal(earlier.status, 201);
  w.clock.set("2026-10-11T00:00:00.000Z");
  assert.deepEqual((await w.run()).json(), { processed: 2, completed: 1, failed: 1 });
  const carol2 = await w.login("carol");
  const byDate = Object.fromEntries(
    (await carol2.get("/api/scheduled-transfers")).json().items.map((s: { scheduledDate: string }) => [s.scheduledDate, s]),
  );
  assert.equal(byDate["2026-10-09"].status, "completed");
  assert.equal(byDate["2026-10-10"].status, "failed");
  assert.equal(byDate["2026-10-10"].failureReason, "DAILY_LIMIT_EXCEEDED");
});

test("SCHED-FAILURE: insufficient funds at execution fails it and notifies the owner", async () => {
  const w = world();
  const bob = await w.login("bob");
  const created = await bob.schedule({ fromAccountId: w.accountId("QM-1000-0005"), toAccount: "QM-1000-0001", amount: "300.00", scheduledDate: "2026-10-09" });
  const id = created.json().scheduledTransfer.id;
  assert.equal((await bob.transfer({ fromAccountId: w.accountId("QM-1000-0005"), toAccount: "QM-1000-0001", amount: "100.00" })).status, 201);
  w.clock.set("2026-10-09T08:00:00.000Z"); // 09:00 in London
  assert.deepEqual((await w.run()).json(), { processed: 1, completed: 0, failed: 1 });
  const bob2 = await w.login("bob");
  const s = (await bob2.get(`/api/scheduled-transfers/${id}`)).json().scheduledTransfer;
  assert.equal(s.status, "failed");
  assert.equal(s.failureReason, "INSUFFICIENT_FUNDS");
  assert.equal(s.transferId, null);
  assert.equal(w.balance("QM-1000-0005"), 26_500);
  assert.equal(w.balance("QM-1000-0001"), 666_055 + 10_000);
  const completed = (await bob2.get("/api/transfers")).json().items.filter((t: { status: string }) => t.status === "completed");
  assert.equal(completed.length, 1);
  const kinds = (await bob2.get("/api/notifications")).json().items.map((n: { kind: string }) => n.kind);
  assert.ok(kinds.includes("scheduled_transfer_failed"), kinds.join(","));
});

test("SCHED-FAILURE: the daily limit counts earlier transfers on the local day of execution", async () => {
  const w = world();
  const olive = await w.login("olive");
  const danaId = w.deps.repos.users.findByUsername("dana")!.id;
  const target = (await olive.post("/api/admin/accounts", { ownerId: danaId, name: "Sterling", type: "checking", currency: "GBP" })).json().account.number;
  const bob = await w.login("bob");
  const from = w.accountId("QM-1000-0004");
  await bob.schedule({ fromAccountId: from, toAccount: target, amount: "1500.00", scheduledDate: "2026-10-09" });
  await bob.schedule({ fromAccountId: from, toAccount: target, amount: "1500.00", scheduledDate: "2026-10-10", memo: "second" });
  w.clock.set("2026-10-09T07:30:00.000Z");
  const bob2 = await w.login("bob");
  assert.equal((await bob2.transfer({ fromAccountId: from, toAccount: target, amount: "1200.00" })).status, 201);
  w.clock.set("2026-10-09T08:00:00.000Z");
  assert.deepEqual((await w.run()).json(), { processed: 1, completed: 0, failed: 1 });
  w.clock.set("2026-10-10T08:00:00.000Z");
  assert.deepEqual((await w.run()).json(), { processed: 1, completed: 1, failed: 0 });
  const bob3 = await w.login("bob");
  const items = (await bob3.get("/api/scheduled-transfers")).json().items;
  assert.equal(items[0].failureReason, "DAILY_LIMIT_EXCEEDED");
  assert.equal(items[1].status, "completed");
  assert.equal(w.balance("QM-1000-0004"), 645_000 - 120_000 - 150_000);
});

test("SCHED-FAILURE: one failure does not stop the rest of the run", async () => {
  const w = world();
  const alice = await w.login("alice");
  const from = w.accountId("QM-1000-0001");
  const toFrozen = await alice.schedule({ fromAccountId: from, toAccount: "QM-1000-0007", amount: "10.00", scheduledDate: "2026-10-08" });
  const toSavings = await alice.schedule({ fromAccountId: from, toAccount: "QM-1000-0002", amount: "20.00", scheduledDate: "2026-10-08" });
  const olive = await w.login("olive");
  assert.equal((await olive.post(`/api/admin/accounts/${w.accountId("QM-1000-0007")}/freeze`)).status, 200);
  w.clock.set("2026-10-08T13:00:00.000Z");
  assert.deepEqual((await w.run()).json(), { processed: 2, completed: 1, failed: 1 });
  const alice2 = await w.login("alice");
  const a = (await alice2.get(`/api/scheduled-transfers/${toFrozen.json().scheduledTransfer.id}`)).json().scheduledTransfer;
  const b = (await alice2.get(`/api/scheduled-transfers/${toSavings.json().scheduledTransfer.id}`)).json().scheduledTransfer;
  assert.equal(a.status, "failed");
  assert.equal(a.failureReason, "ACCOUNT_FROZEN");
  assert.equal(b.status, "completed");
  assert.equal(w.balance("QM-1000-0001"), 666_055 - 2000);
});

test("SCHED-PERSIST: scheduled transfers survive a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qm-sched-"));
  try {
    const dataFile = join(dir, "bank.json");
    const first = world({ dataFile });
    const alice = await first.login("alice");
    const created = await alice.schedule({ fromAccountId: first.accountId("QM-1000-0001"), toAccount: "QM-1000-0002", amount: "12.00", scheduledDate: "2026-10-12" });
    assert.equal(created.status, 201);

    const second = world({ dataFile, now: "2026-10-12T13:05:00.000Z" });
    const alice2 = await second.login("alice");
    const items = (await alice2.get("/api/scheduled-transfers")).json().items;
    assert.equal(items.length, 1);
    assert.equal(items[0].executeAt, "2026-10-12T13:00:00.000Z");
    assert.equal((await second.run()).json().completed, 1);

    const third = world({ dataFile, now: "2026-10-12T13:10:00.000Z" });
    const alice3 = await third.login("alice");
    assert.equal((await alice3.get("/api/scheduled-transfers")).json().items[0].status, "completed");
    assert.equal((await third.run()).json().processed, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
