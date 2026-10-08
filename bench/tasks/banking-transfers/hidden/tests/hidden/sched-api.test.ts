import assert from "node:assert/strict";
import { test } from "node:test";
import { fields, key, world } from "./sched-support.ts";

test("SCHED-CREATE: schedules at 09:00 local time and returns the full object", async () => {
  const w = world();
  const alice = await w.login("alice");
  const res = await alice.schedule({
    fromAccountId: w.accountId("QM-1000-0001"),
    toAccount: "QM-1000-0005",
    amount: "25.00",
    memo: "Rent share",
    scheduledDate: "2026-10-30",
  });
  assert.equal(res.status, 201);
  const s = res.json().scheduledTransfer;
  assert.equal(typeof s.id, "string");
  assert.equal(s.fromAccountId, w.accountId("QM-1000-0001"));
  assert.equal(s.toAccountId, w.accountId("QM-1000-0005"));
  assert.equal(s.amountMinor, 2500);
  assert.equal(s.amount, "25.00");
  assert.equal(s.currency, "USD");
  assert.equal(s.memo, "Rent share");
  assert.equal(s.scheduledDate, "2026-10-30");
  assert.equal(s.timezone, "America/New_York");
  assert.equal(s.executeAt, "2026-10-30T13:00:00.000Z");
  assert.equal(s.status, "scheduled");
  assert.equal(s.transferId, null);
  assert.equal(s.failureReason, null);
  assert.equal(w.balance("QM-1000-0001"), 666_055, "no money moves when scheduling");
});

test("SCHED-CREATE: executeAt follows daylight saving changes", async () => {
  const w = world();
  const alice = await w.login("alice");
  const res = await alice.schedule({ fromAccountId: w.accountId("QM-1000-0001"), toAccount: "QM-1000-0002", amount: "1", scheduledDate: "2026-11-02" });
  assert.equal(res.status, 201);
  assert.equal(res.json().scheduledTransfer.executeAt, "2026-11-02T14:00:00.000Z");
});

test("SCHED-CREATE: uses the profile time zone at scheduling time", async () => {
  const w = world();
  const carol = await w.login("carol");
  const tokyo = await carol.schedule({ fromAccountId: w.accountId("QM-1000-0007"), toAccount: "QM-1000-0001", amount: "5.00", scheduledDate: "2026-10-08" });
  assert.equal(tokyo.status, 201, tokyo.body);
  assert.equal(tokyo.json().scheduledTransfer.executeAt, "2026-10-08T00:00:00.000Z");
  assert.equal(tokyo.json().scheduledTransfer.timezone, "Asia/Tokyo");

  const alice = await w.login("alice");
  assert.equal((await alice.patch("/api/me", { timezone: "Europe/Berlin" })).status, 200);
  const berlin = await alice.schedule({ fromAccountId: w.accountId("QM-1000-0001"), toAccount: "QM-1000-0002", amount: "5.00", scheduledDate: "2026-10-20" });
  const s = berlin.json().scheduledTransfer;
  assert.equal(s.executeAt, "2026-10-20T07:00:00.000Z");
  assert.equal(s.timezone, "Europe/Berlin");
  await alice.patch("/api/me", { timezone: "America/Los_Angeles" });
  const again = await alice.get(`/api/scheduled-transfers/${s.id}`);
  assert.equal(again.status, 200);
  assert.equal(again.json().scheduledTransfer.executeAt, "2026-10-20T07:00:00.000Z");
});

test("SCHED-VALIDATE: scheduledDate must be a real date", async () => {
  const w = world();
  const alice = await w.login("alice");
  const base = { fromAccountId: w.accountId("QM-1000-0001"), toAccount: "QM-1000-0002", amount: "5.00" };
  for (const scheduledDate of ["2026-02-30", "next friday", "2026-11-31", undefined]) {
    const res = await alice.schedule({ ...base, scheduledDate });
    assert.equal(res.status, 400, String(scheduledDate));
    assert.equal(res.json().error.code, "VALIDATION_ERROR");
    assert.ok(fields(res).includes("scheduledDate"), `${scheduledDate}: ${fields(res)}`);
  }
  assert.equal((await alice.get("/api/scheduled-transfers")).json().items.length, 0);
});

test("SCHED-VALIDATE: execution time must be in the future in local time", async () => {
  const w = world(); // 12:00 in New York
  const alice = await w.login("alice");
  const base = { fromAccountId: w.accountId("QM-1000-0001"), toAccount: "QM-1000-0002", amount: "5.00" };
  for (const scheduledDate of ["2026-10-06", "2026-10-07"]) {
    const res = await alice.schedule({ ...base, scheduledDate });
    assert.equal(res.status, 400, scheduledDate);
    assert.ok(fields(res).includes("scheduledDate"));
  }
  const early = world({ now: "2026-10-07T12:00:00.000Z" }); // 08:00 in New York
  const alice2 = await early.login("alice");
  const today = await alice2.schedule({ ...base, fromAccountId: early.accountId("QM-1000-0001"), scheduledDate: "2026-10-07" });
  assert.equal(today.status, 201, today.body);
  assert.equal(today.json().scheduledTransfer.executeAt, "2026-10-07T13:00:00.000Z");
});

test("SCHED-VALIDATE: at most 365 days ahead", async () => {
  const w = world();
  const alice = await w.login("alice");
  const base = { fromAccountId: w.accountId("QM-1000-0001"), toAccount: "QM-1000-0002", amount: "5.00" };
  assert.equal((await alice.schedule({ ...base, scheduledDate: "2027-10-07" })).status, 201);
  const tooFar = await alice.schedule({ ...base, scheduledDate: "2027-10-08" });
  assert.equal(tooFar.status, 400);
  assert.ok(fields(tooFar).includes("scheduledDate"));
});

test("SCHED-VALIDATE: reuses the immediate transfer rules", async () => {
  const w = world();
  const alice = await w.login("alice");
  const from = w.accountId("QM-1000-0001");
  const d = "2026-10-20";
  assert.equal((await alice.schedule({ fromAccountId: w.accountId("QM-1000-0004"), toAccount: "QM-1000-0001", amount: "1.00", scheduledDate: d })).status, 404);
  assert.equal((await alice.schedule({ fromAccountId: from, toAccount: "QM-9999-0000", amount: "1.00", scheduledDate: d })).status, 404);
  assert.equal((await alice.schedule({ fromAccountId: from, toAccount: "QM-1000-0001", amount: "1.00", scheduledDate: d })).status, 400);
  assert.equal((await alice.schedule({ fromAccountId: from, toAccount: "QM-1000-0002", amount: "12.345", scheduledDate: d })).status, 400);
  const fx = await alice.schedule({ fromAccountId: from, toAccount: "QM-1000-0003", amount: "1.00", scheduledDate: d });
  assert.equal(fx.status, 422);
  assert.equal(fx.json().error.code, "CURRENCY_MISMATCH");
  const noKey = await alice.schedule({ fromAccountId: from, toAccount: "QM-1000-0002", amount: "1.00", scheduledDate: d }, null);
  assert.equal(noKey.status, 400);
  const dana = await w.login("dana");
  const frozen = await dana.schedule({ fromAccountId: w.accountId("QM-1000-0008"), toAccount: "QM-1000-0009", amount: "1.00", scheduledDate: d });
  assert.equal(frozen.status, 422);
  assert.equal(frozen.json().error.code, "ACCOUNT_FROZEN");
  assert.equal((await alice.get("/api/scheduled-transfers")).json().items.length, 0);
});

test("SCHED-VALIDATE: limits and funds are not checked when scheduling", async () => {
  const w = world();
  const bob = await w.login("bob");
  const res = await bob.schedule({ fromAccountId: w.accountId("QM-1000-0004"), toAccount: "QM-1000-0004", amount: "1.00", scheduledDate: "2026-10-20" });
  assert.equal(res.status, 400, "sanity: same account is still rejected");
  const big = await bob.schedule({ fromAccountId: w.accountId("QM-1000-0005"), toAccount: "QM-1000-0001", amount: "9000.00", scheduledDate: "2026-10-20" });
  assert.equal(big.status, 201, big.body);
});

test("SCHED-IDEMPOTENCY: replays return the original and conflicts are rejected", async () => {
  const w = world();
  const alice = await w.login("alice");
  const body = { fromAccountId: w.accountId("QM-1000-0001"), toAccount: "QM-1000-0002", amount: "40.00", memo: "Save", scheduledDate: "2026-10-15" };
  const k = key("idem");
  const first = await alice.schedule(body, k);
  const second = await alice.schedule(body, k);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.json().scheduledTransfer.id, first.json().scheduledTransfer.id);
  const conflict = await alice.schedule({ ...body, scheduledDate: "2026-10-16" }, k);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json().error.code, "IDEMPOTENCY_CONFLICT");
  const conflictAmount = await alice.schedule({ ...body, amount: "41.00" }, k);
  assert.equal(conflictAmount.status, 409);
  assert.equal((await alice.get("/api/scheduled-transfers")).json().items.length, 1);
  const bob = await w.login("bob");
  const bobs = await bob.schedule({ fromAccountId: w.accountId("QM-1000-0005"), toAccount: "QM-1000-0001", amount: "1.00", scheduledDate: "2026-10-15" }, k);
  assert.equal(bobs.status, 201, "keys are per customer");
});

test("SCHED-AUTHZ: customers only see their own scheduled transfers, ordered by executeAt", async () => {
  const w = world();
  const alice = await w.login("alice");
  const bob = await w.login("bob");
  const from = w.accountId("QM-1000-0001");
  for (const scheduledDate of ["2026-12-01", "2026-10-09", "2026-11-15"]) {
    assert.equal((await alice.schedule({ fromAccountId: from, toAccount: "QM-1000-0002", amount: "1.00", scheduledDate })).status, 201);
  }
  await bob.schedule({ fromAccountId: w.accountId("QM-1000-0005"), toAccount: "QM-1000-0001", amount: "1.00", scheduledDate: "2026-10-08" });
  const mine = (await alice.get("/api/scheduled-transfers")).json().items;
  assert.deepEqual(mine.map((s: { scheduledDate: string }) => s.scheduledDate), ["2026-10-09", "2026-11-15", "2026-12-01"]);
  const bobs = (await bob.get("/api/scheduled-transfers")).json().items;
  assert.equal(bobs.length, 1);
  assert.equal((await bob.get(`/api/scheduled-transfers/${mine[0].id}`)).status, 404);
  assert.equal((await w.app.inject({ method: "GET", url: "/api/scheduled-transfers" })).status, 401);
});

test("SCHED-AUTHZ: only admins can run the executor", async () => {
  const w = world();
  const alice = await w.login("alice");
  const sam = await w.login("sam");
  assert.equal((await alice.post("/api/admin/scheduled-transfers/run")).status, 403);
  assert.equal((await sam.post("/api/admin/scheduled-transfers/run")).status, 403);
  assert.equal((await w.app.inject({ method: "POST", url: "/api/admin/scheduled-transfers/run" })).status, 401);
  const res = await w.run();
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { processed: 0, completed: 0, failed: 0 });
});

test("SCHED-CANCEL: owners cancel scheduled transfers once; others get 404", async () => {
  const w = world();
  const alice = await w.login("alice");
  const bob = await w.login("bob");
  const created = await alice.schedule({ fromAccountId: w.accountId("QM-1000-0001"), toAccount: "QM-1000-0005", amount: "10.00", scheduledDate: "2026-10-09" });
  const id = created.json().scheduledTransfer.id;
  assert.equal((await bob.del(`/api/scheduled-transfers/${id}`)).status, 404);
  assert.equal((await alice.get(`/api/scheduled-transfers/${id}`)).json().scheduledTransfer.status, "scheduled");
  const cancelled = await alice.del(`/api/scheduled-transfers/${id}`);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json().scheduledTransfer.status, "cancelled");
  const again = await alice.del(`/api/scheduled-transfers/${id}`);
  assert.equal(again.status, 409);
  assert.equal(again.json().error.code, "INVALID_TRANSITION");
  w.clock.set("2026-10-09T14:00:00.000Z");
  const run = await w.run();
  assert.equal(run.json().processed, 0);
  assert.equal(w.balance("QM-1000-0005"), 36_500);
});

test("SCHED-CANCEL: executed transfers can no longer be cancelled", async () => {
  const w = world();
  const alice = await w.login("alice");
  const created = await alice.schedule({ fromAccountId: w.accountId("QM-1000-0001"), toAccount: "QM-1000-0002", amount: "10.00", scheduledDate: "2026-10-08" });
  const id = created.json().scheduledTransfer.id;
  w.clock.set("2026-10-08T13:00:00.000Z");
  assert.equal((await w.run()).json().completed, 1);
  const alice2 = await w.login("alice");
  const res = await alice2.del(`/api/scheduled-transfers/${id}`);
  assert.equal(res.status, 409);
  assert.equal(res.json().error.code, "INVALID_TRANSITION");
});
