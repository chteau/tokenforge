import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setup } from "../support/harness.ts";

describe("accounts API", () => {
  it("lists only the caller's accounts", async () => {
    const t = setup();
    const alice = await t.login("alice");
    const res = await alice.get("/api/accounts");
    assert.equal(res.status, 200);
    const numbers = res.json().items.map((a: { number: string }) => a.number);
    assert.deepEqual(numbers, ["QM-1000-0001", "QM-1000-0002", "QM-1000-0003"]);
  });

  it("hides other customers' accounts behind 404", async () => {
    const t = setup();
    const alice = await t.login("alice");
    const res = await alice.get(`/api/accounts/${t.accountId("QM-1000-0004")}`);
    assert.equal(res.status, 404);
  });

  it("lets support staff read any account but not move money", async () => {
    const t = setup();
    const sam = await t.login("sam");
    const res = await sam.get(`/api/accounts/${t.accountId("QM-1000-0004")}`);
    assert.equal(res.status, 200);
    const deposit = await sam.post(`/api/admin/accounts/${t.accountId("QM-1000-0004")}/deposits`, { amount: "10.00" });
    assert.equal(deposit.status, 403);
  });

  it("lets admins deposit and freeze accounts", async () => {
    const t = setup();
    const olive = await t.login("olive");
    const id = t.accountId("QM-1000-0007");
    const deposit = await olive.post(`/api/admin/accounts/${id}/deposits`, { amount: "50.00", description: "Goodwill credit" });
    assert.equal(deposit.status, 201);
    assert.equal(deposit.json().entry.balanceAfterMinor, 125_000);
    const frozen = await olive.post(`/api/admin/accounts/${id}/freeze`);
    assert.equal(frozen.json().account.status, "frozen");
    const again = await olive.post(`/api/admin/accounts/${id}/deposits`, { amount: "1.00" });
    assert.equal(again.status, 422);
  });

  it("renames an owned account", async () => {
    const t = setup();
    const bob = await t.login("bob");
    const id = t.accountId("QM-1000-0005");
    const res = await bob.patch(`/api/accounts/${id}`, { name: "Holiday dollars" });
    assert.equal(res.status, 200);
    assert.equal(res.json().account.name, "Holiday dollars");
  });
});
