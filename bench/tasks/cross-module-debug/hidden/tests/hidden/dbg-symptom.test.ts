import assert from "node:assert/strict";
import { test } from "node:test";
import { balanceOf, total, world } from "./dbg-support.ts";

test("DBG-SYMPTOM: recipient's dashboard API reflects an incoming transfer immediately", async () => {
  const w = world();
  const alice = await w.login("alice");
  const bob = await w.login("bob");
  assert.equal(balanceOf(await bob.dashboard(), "QM-1000-0005"), 36_500);
  await alice.transfer("QM-1000-0001", "QM-1000-0005", "15.00");
  assert.equal(balanceOf(await bob.dashboard(), "QM-1000-0005"), 38_000);
});

test("DBG-SYMPTOM: recipient's currency totals include the incoming transfer", async () => {
  const w = world();
  const alice = await w.login("alice");
  const bob = await w.login("bob");
  const before = total(await bob.dashboard(), "USD");
  await alice.transfer("QM-1000-0001", "QM-1000-0005", "15.00");
  const after = total(await bob.dashboard(), "USD");
  assert.equal(after.balanceMinor, before.balanceMinor + 1500);
  assert.equal(after.monthInMinor, before.monthInMinor + 1500);
});

test("DBG-SYMPTOM: recipient's Overview page shows the new balance", async () => {
  const w = world();
  const alice = await w.login("alice");
  const bob = await w.login("bob");
  const first = await bob.page("/dashboard");
  assert.match(first.body, /\$365\.00/);
  await alice.transfer("QM-1000-0001", "QM-1000-0005", "15.00");
  const second = await bob.page("/dashboard");
  assert.equal(second.status, 200);
  assert.match(second.body, /\$380\.00/);
  assert.doesNotMatch(second.body, /\$365\.00/);
});

test("DBG-SYMPTOM: transfers made through the web form refresh the recipient too", async () => {
  const w = world();
  const bob = await w.login("bob");
  const carol = await w.login("carol");
  await bob.dashboard();
  const res = await carol.form("/transfers", {
    fromAccountId: w.accountId("QM-1000-0007"),
    toAccount: "QM-1000-0005",
    amount: "100.00",
    memo: "Concert",
    idempotencyKey: "web-dbg-key-0001",
  });
  assert.equal(res.status, 303);
  assert.equal(balanceOf(await bob.dashboard(), "QM-1000-0005"), 46_500);
});

test("DBG-SYMPTOM: successive incoming transfers are each reflected", async () => {
  const w = world();
  const alice = await w.login("alice");
  const carol = await w.login("carol");
  const bob = await w.login("bob");
  await bob.dashboard();
  await alice.transfer("QM-1000-0001", "QM-1000-0005", "10.00");
  assert.equal(balanceOf(await bob.dashboard(), "QM-1000-0005"), 37_500);
  await carol.transfer("QM-1000-0007", w.accountId("QM-1000-0005"), "2.50");
  assert.equal(balanceOf(await bob.dashboard(), "QM-1000-0005"), 37_750);
  await alice.transfer("QM-1000-0001", "QM-1000-0005", "0.25");
  assert.equal(balanceOf(await bob.dashboard(), "QM-1000-0005"), 37_775);
});

test("DBG-SYMPTOM: works for every currency and recipient", async () => {
  const w = world();
  const dana = await w.login("dana");
  const alice = await w.login("alice");
  await alice.dashboard();
  await dana.transfer("QM-1000-0008", "QM-1000-0003", "50.00");
  assert.equal(balanceOf(await alice.dashboard(), "QM-1000-0003"), 71_750 + 5000);
  assert.equal(total(await alice.dashboard(), "EUR").balanceMinor, 71_750 + 5000);
});
