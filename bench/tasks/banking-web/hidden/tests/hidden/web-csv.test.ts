import assert from "node:assert/strict";
import { test } from "node:test";
import { header, world } from "./web-support.ts";

const ACC = "QM-1000-0001";
const HEADER = "date,description,counterparty,reference,type,amount,currency,balance_after\r\n";

test("WEB-CSV-FORMAT: response headers", async () => {
  const w = world();
  const alice = await w.login("alice");
  const res = await alice.get(`/api/accounts/${w.accountId(ACC)}/transactions.csv`);
  assert.equal(res.status, 200);
  assert.match(header(res, "content-type"), /^text\/csv\s*;\s*charset=utf-8$/i);
  assert.equal(header(res, "content-disposition"), 'attachment; filename="QM-1000-0001-transactions.csv"');
});

test("WEB-CSV-FORMAT: exact rows, signs, quoting and CRLF", async () => {
  const w = world();
  const alice = await w.login("alice");
  const res = await alice.get(`/api/accounts/${w.accountId(ACC)}/transactions.csv?from=2026-08-27&to=2026-09-01`);
  assert.equal(
    res.body,
    HEADER +
      "2026-09-01,Gym membership,Ironworks Gym,,debit,-120.00,USD,5531.52\r\n" +
      "2026-08-31,Late-night pharmacy,Lindqvist Pharmacy,,debit,-23.80,USD,5651.52\r\n" +
      '2026-08-27,"Dinner at ""The Anchor"", Pier 9",The Anchor,,debit,-38.40,USD,5675.32\r\n',
  );
  const credits = await alice.get(`/api/accounts/${w.accountId(ACC)}/transactions.csv?q=salary%20july`);
  assert.equal(credits.body, HEADER + "2026-07-15,Salary July,Northwind Fabrication LLC,PAY-2026-07,credit,3150.00,USD,5559.05\r\n");
});

test("WEB-CSV-FORMAT: formula protection on text fields only", async () => {
  const w = world();
  const alice = await w.login("alice");
  const res = await alice.get(`/api/accounts/${w.accountId(ACC)}/transactions.csv?q=concert`);
  assert.equal(res.body, HEADER + "2026-10-05,'=Concert tickets,Lyric Hall Box Office,,debit,-300.00,USD,6660.13\r\n");
});

test("WEB-CSV-FORMAT: line breaks, quotes and formula prefixes combined", async () => {
  const w = world();
  const id = w.accountId("QM-1000-0007");
  w.deps.ledger.post(id, {
    type: "credit",
    amountMinor: 1234,
    description: "Line one\nLine two",
    counterparty: "@handle",
    reference: "+44 ref",
    transferId: null,
    category: "adjustment",
  });
  w.clock.advance(60_000);
  w.deps.ledger.post(id, {
    type: "debit",
    amountMinor: 34,
    description: '=SUM("a")',
    counterparty: "-minus, co",
    reference: null,
    transferId: null,
    category: "fee",
  });
  const carol = await w.login("carol");
  const res = await carol.get(`/api/accounts/${id}/transactions.csv?from=2026-10-08`);
  assert.equal(
    res.body,
    HEADER +
      `2026-10-08,"'=SUM(""a"")","'-minus, co",,debit,-0.34,USD,1212.00\r\n` +
      `2026-10-08,"Line one\nLine two",'@handle,'+44 ref,credit,12.34,USD,1212.34\r\n`,
  );
});

test("WEB-CSV-FORMAT: zero-decimal currencies and empty results", async () => {
  const w = world();
  const carol = await w.login("carol");
  const id = w.accountId("QM-1000-0006");
  const res = await carol.get(`/api/accounts/${id}/transactions.csv?to=2026-08-03`);
  assert.equal(
    res.body,
    HEADER +
      "2026-08-03,Rent,Sakura Heights,,debit,-98000,JPY,662000\r\n" +
      "2026-07-25,Salary July,Kisaragi Design KK,,credit,410000,JPY,760000\r\n" +
      "2026-07-02,Opening deposit,Quillmoor Bank,,credit,350000,JPY,350000\r\n",
  );
  const empty = await carol.get(`/api/accounts/${id}/transactions.csv?q=nothing-matches`);
  assert.equal(empty.status, 200);
  assert.equal(empty.body, HEADER);
});

test("WEB-CSV-SCOPE: export contains every matching entry, ignoring paging", async () => {
  const w = world();
  const id = w.accountId(ACC);
  for (let i = 0; i < 60; i++) {
    w.clock.advance(1000);
    w.deps.ledger.post(id, {
      type: "debit",
      amountMinor: 100,
      description: `Parking meter ${i}`,
      counterparty: "City Parking",
      reference: null,
      transferId: null,
      category: "card",
    });
  }
  const alice = await w.login("alice");
  const res = await alice.get(`/api/accounts/${id}/transactions.csv?limit=5&offset=10`);
  assert.equal(res.status, 200);
  const lines = res.body.split("\r\n");
  assert.equal(lines.length, 1 + 85 + 1);
  assert.equal(lines[lines.length - 1], "");
  assert.match(lines[1] ?? "", /^2026-10-07,Parking meter 59,/);
  assert.match(lines[85] ?? "", /^2026-07-01,Opening deposit,/);
});

test("WEB-CSV-SCOPE: filters apply to the export and are validated", async () => {
  const w = world();
  const alice = await w.login("alice");
  const id = w.accountId(ACC);
  const credits = await alice.get(`/api/accounts/${id}/transactions.csv?type=credit&minAmount=45`);
  const rows = credits.body.split("\r\n").filter(Boolean).slice(1);
  assert.deepEqual(
    rows.map((r) => r.split(",")[1]),
    ["Refund: returned boots", "Salary September", "Salary August", "Salary July", "Opening deposit"],
  );
  const bad = await alice.get(`/api/accounts/${id}/transactions.csv?minAmount=abc`);
  assert.equal(bad.status, 400);
  assert.equal(bad.json().error.code, "VALIDATION_ERROR");
  assert.equal(bad.json().error.details[0].field, "minAmount");
});

test("WEB-CSV-SCOPE: dates follow the signed-in user's time zone", async () => {
  const w = world();
  const alice = await w.login("alice");
  await alice.patch("/api/me", { timezone: "Asia/Tokyo" });
  const res = await alice.get(`/api/accounts/${w.accountId(ACC)}/transactions.csv?q=pharmacy`);
  assert.equal(res.body, HEADER + "2026-09-01,Late-night pharmacy,Lindqvist Pharmacy,,debit,-23.80,USD,5651.52\r\n");
});

test("WEB-AUTHZ: customers can only export their own accounts", async () => {
  const w = world();
  const alice = await w.login("alice");
  const bob = await w.login("bob");
  const id = w.accountId(ACC);
  assert.equal((await alice.get(`/api/accounts/${id}/transactions.csv`)).status, 200);
  const res = await bob.get(`/api/accounts/${id}/transactions.csv`);
  assert.equal(res.status, 404);
  assert.doesNotMatch(res.body, /Blue Kettle/);
  const anon = await w.app.inject({ method: "GET", url: `/api/accounts/${id}/transactions.csv` });
  assert.equal(anon.status, 401);
});

test("WEB-AUTHZ: support staff keep read access for exports", async () => {
  const w = world();
  const sam = await w.login("sam");
  const res = await sam.get(`/api/accounts/${w.accountId("QM-1000-0004")}/transactions.csv?type=debit`);
  assert.equal(res.status, 200);
  assert.equal(res.body.split("\r\n").filter(Boolean).length, 1 + 3);
});
