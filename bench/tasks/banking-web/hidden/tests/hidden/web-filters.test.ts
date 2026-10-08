import assert from "node:assert/strict";
import { test } from "node:test";
import { descriptions, fields, world } from "./web-support.ts";

const ACC = "QM-1000-0001";

test("WEB-FILTER-DATE: from/to are inclusive local calendar dates", async () => {
  const w = world();
  const alice = await w.login("alice");
  const id = w.accountId(ACC);
  const res = await alice.get(`/api/accounts/${id}/transactions?from=2026-08-31&to=2026-09-01`);
  assert.equal(res.status, 200);
  assert.deepEqual(descriptions(res), ["Gym membership", "Late-night pharmacy"]);
  assert.equal(res.json().total, 2);
});

test("WEB-FILTER-DATE: open-ended ranges use the user's time zone", async () => {
  const w = world();
  const alice = await w.login("alice");
  const id = w.accountId(ACC);
  const from = await alice.get(`/api/accounts/${id}/transactions?from=2026-10-01`);
  assert.deepEqual(descriptions(from), ["Interest", "=Concert tickets", "Greenleaf Market", "Blue Kettle Coffee"]);
  const to = await alice.get(`/api/accounts/${id}/transactions?to=2026-07-10`);
  assert.deepEqual(descriptions(to), ["Greenleaf Market", "Blue Kettle Coffee", "Opening deposit"]);
});

test("WEB-FILTER-DATE: changing the profile time zone changes which day an entry falls on", async () => {
  const w = world();
  const alice = await w.login("alice");
  const id = w.accountId(ACC);
  const ny = await alice.get(`/api/accounts/${id}/transactions?from=2026-09-01&to=2026-09-01`);
  assert.deepEqual(descriptions(ny), ["Gym membership"]);
  assert.equal((await alice.patch("/api/me", { timezone: "Europe/Berlin" })).status, 200);
  const berlin = await alice.get(`/api/accounts/${id}/transactions?from=2026-09-01&to=2026-09-01`);
  assert.deepEqual(descriptions(berlin), ["Gym membership", "Late-night pharmacy"]);
});

test("WEB-FILTER-TYPE-AMOUNT: type filter", async () => {
  const w = world();
  const alice = await w.login("alice");
  const id = w.accountId(ACC);
  const credits = await alice.get(`/api/accounts/${id}/transactions?type=credit`);
  assert.equal(credits.json().total, 6);
  assert.ok(credits.json().items.every((i: { type: string }) => i.type === "credit"));
  const debits = await alice.get(`/api/accounts/${id}/transactions?type=debit`);
  assert.equal(debits.json().total, 19);
});

test("WEB-FILTER-TYPE-AMOUNT: amount bounds are inclusive and combine with type", async () => {
  const w = world();
  const alice = await w.login("alice");
  const id = w.accountId(ACC);
  const range = await alice.get(`/api/accounts/${id}/transactions?minAmount=1450&maxAmount=2500.00`);
  assert.deepEqual(descriptions(range), ["Rent September", "Rent August", "Rent July", "Opening deposit"]);
  const debitRange = await alice.get(`/api/accounts/${id}/transactions?minAmount=1450&maxAmount=2500&type=debit`);
  assert.equal(debitRange.json().total, 3);
  const small = await alice.get(`/api/accounts/${id}/transactions?maxAmount=4.75`);
  assert.deepEqual(descriptions(small), ["Interest", "Blue Kettle Coffee", "Blue Kettle Coffee"]);
  const big = await alice.get(`/api/accounts/${id}/transactions?minAmount=3150`);
  assert.equal(big.json().total, 3);
});

test("WEB-FILTER-TEXT: q is a case-insensitive substring search on description", async () => {
  const w = world();
  const alice = await w.login("alice");
  const id = w.accountId(ACC);
  const res = await alice.get(`/api/accounts/${id}/transactions?q=KETTLE`);
  assert.equal(res.json().total, 4);
  const trimmed = await alice.get(`/api/accounts/${id}/transactions?q=${encodeURIComponent("  anchor ")}`);
  assert.deepEqual(descriptions(trimmed), ['Dinner at "The Anchor", Pier 9']);
});

test("WEB-FILTER-TEXT: q also matches counterparty and reference", async () => {
  const w = world();
  const alice = await w.login("alice");
  const id = w.accountId(ACC);
  const byCounterparty = await alice.get(`/api/accounts/${id}/transactions?q=northwind`);
  assert.deepEqual(descriptions(byCounterparty), ["Salary September", "Salary August", "Salary July"]);
  const byReference = await alice.get(`/api/accounts/${id}/transactions?q=${encodeURIComponent("unit 4b")}`);
  assert.equal(byReference.json().total, 3);
  const none = await alice.get(`/api/accounts/${id}/transactions?q=zzzz-nothing`);
  assert.equal(none.json().total, 0);
  assert.deepEqual(none.json().items, []);
});

test("WEB-PAGING: paging applies after filtering and empty params are ignored", async () => {
  const w = world();
  const alice = await w.login("alice");
  const id = w.accountId(ACC);
  const res = await alice.get(`/api/accounts/${id}/transactions?type=debit&limit=5&offset=15`);
  assert.equal(res.status, 200);
  const body = res.json();
  assert.equal(body.total, 19);
  assert.equal(body.limit, 5);
  assert.equal(body.offset, 15);
  assert.deepEqual(descriptions(res), ["Streamly subscription", "Rent July", "Greenleaf Market", "Blue Kettle Coffee"]);
  const empty = await alice.get(`/api/accounts/${id}/transactions?q=&type=&from=&limit=3`);
  assert.equal(empty.status, 200);
  assert.equal(empty.json().total, 25);
  assert.equal(empty.json().items.length, 3);
});

test("WEB-VALIDATION: malformed dates and types are rejected with the parameter name", async () => {
  const w = world();
  const alice = await w.login("alice");
  const id = w.accountId(ACC);
  for (const [query, field] of [
    ["from=2026-02-30", "from"],
    ["to=07%2F10%2F2026", "to"],
    ["type=pending", "type"],
  ] as const) {
    const res = await alice.get(`/api/accounts/${id}/transactions?${query}`);
    assert.equal(res.status, 400, query);
    assert.equal(res.json().error.code, "VALIDATION_ERROR", query);
    assert.ok(fields(res).includes(field), `${query} -> ${fields(res).join(",")}`);
  }
});

test("WEB-VALIDATION: amounts must fit the account currency", async () => {
  const w = world();
  const alice = await w.login("alice");
  const id = w.accountId(ACC);
  for (const [query, field] of [
    ["minAmount=abc", "minAmount"],
    ["minAmount=-5", "minAmount"],
    ["maxAmount=1.234", "maxAmount"],
  ] as const) {
    const res = await alice.get(`/api/accounts/${id}/transactions?${query}`);
    assert.equal(res.status, 400, query);
    assert.ok(fields(res).includes(field), `${query} -> ${fields(res).join(",")}`);
  }
  const carol = await w.login("carol");
  const yen = await carol.get(`/api/accounts/${w.accountId("QM-1000-0006")}/transactions?minAmount=10.5`);
  assert.equal(yen.status, 400);
  assert.ok(fields(yen).includes("minAmount"));
  const yenOk = await carol.get(`/api/accounts/${w.accountId("QM-1000-0006")}/transactions?minAmount=98000&maxAmount=98000`);
  assert.equal(yenOk.json().total, 2);
});

test("WEB-VALIDATION: inverted ranges and overlong searches are rejected", async () => {
  const w = world();
  const alice = await w.login("alice");
  const id = w.accountId(ACC);
  const dates = await alice.get(`/api/accounts/${id}/transactions?from=2026-09-10&to=2026-09-01`);
  assert.equal(dates.status, 400);
  assert.ok(fields(dates).includes("to"));
  const amounts = await alice.get(`/api/accounts/${id}/transactions?minAmount=10&maxAmount=5`);
  assert.equal(amounts.status, 400);
  assert.ok(fields(amounts).includes("maxAmount"));
  const long = await alice.get(`/api/accounts/${id}/transactions?q=${"x".repeat(101)}`);
  assert.equal(long.status, 400);
  assert.ok(fields(long).includes("q"));
  const sameDay = await alice.get(`/api/accounts/${id}/transactions?from=2026-09-01&to=2026-09-01&minAmount=120&maxAmount=120`);
  assert.equal(sameDay.status, 200);
  assert.deepEqual(descriptions(sameDay), ["Gym membership"]);
});

test("WEB-AUTHZ: filtered lists stay limited to accounts the caller may see", async () => {
  const w = world();
  const alice = await w.login("alice");
  const bob = await w.login("bob");
  const id = w.accountId(ACC);
  assert.equal((await alice.get(`/api/accounts/${id}/transactions?type=credit`)).status, 200);
  const res = await bob.get(`/api/accounts/${id}/transactions?type=credit`);
  assert.equal(res.status, 404);
});
