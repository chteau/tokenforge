import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setup } from "../support/harness.ts";

describe("transactions API", () => {
  it("pages through account activity newest first", async () => {
    const t = setup();
    const alice = await t.login("alice");
    const id = t.accountId("QM-1000-0001");
    const first = await alice.get(`/api/accounts/${id}/transactions?limit=5`);
    assert.equal(first.status, 200);
    const body = first.json();
    assert.equal(body.total, 25);
    assert.equal(body.items.length, 5);
    assert.equal(body.items[0].description, "Interest");
    assert.equal(body.items[0].amount, "0.42");
    const second = await alice.get(`/api/accounts/${id}/transactions?limit=5&offset=5`);
    assert.equal(second.json().items[0].description, "Refund: returned boots");
  });

  it("validates paging parameters", async () => {
    const t = setup();
    const alice = await t.login("alice");
    const id = t.accountId("QM-1000-0001");
    const res = await alice.get(`/api/accounts/${id}/transactions?limit=0`);
    assert.equal(res.status, 400);
    assert.equal(res.json().error.details[0].field, "limit");
  });

  it("does not expose other customers' activity", async () => {
    const t = setup();
    const bob = await t.login("bob");
    const res = await bob.get(`/api/accounts/${t.accountId("QM-1000-0001")}/transactions`);
    assert.equal(res.status, 404);
  });

  it("fetches a single transaction", async () => {
    const t = setup();
    const alice = await t.login("alice");
    const list = await alice.get(`/api/accounts/${t.accountId("QM-1000-0003")}/transactions`);
    const entryId = list.json().items[0].id;
    const res = await alice.get(`/api/transactions/${entryId}`);
    assert.equal(res.status, 200);
    assert.equal(res.json().transaction.currency, "EUR");
    const bob = await t.login("bob");
    assert.equal((await bob.get(`/api/transactions/${entryId}`)).status, 404);
  });
});
