import assert from "node:assert/strict";
import { test } from "node:test";
import { anchors, inputValue, world } from "./web-support.ts";

const ACC = "QM-1000-0001";

test("WEB-VIEW: the page lists only matching entries with the filtered count", async () => {
  const w = world();
  const alice = await w.login("alice");
  const id = w.accountId(ACC);
  const res = await alice.page(`/accounts/${id}/transactions?type=credit&q=salary`);
  assert.equal(res.status, 200);
  assert.match(res.body, /Salary July/);
  assert.match(res.body, /Salary September/);
  assert.doesNotMatch(res.body, /Blue Kettle Coffee/);
  assert.doesNotMatch(res.body, /Opening deposit/);
  assert.match(res.body, /Showing 1–3 of 3/);
});

test("WEB-VIEW: date filters on the page use the user's time zone", async () => {
  const w = world();
  const alice = await w.login("alice");
  const res = await alice.page(`/accounts/${w.accountId(ACC)}/transactions?from=2026-08-31&to=2026-08-31`);
  assert.equal(res.status, 200);
  assert.match(res.body, /Late-night pharmacy/);
  assert.doesNotMatch(res.body, /Gym membership/);
});

test("WEB-VIEW: filter form fields are present and pre-filled", async () => {
  const w = world();
  const alice = await w.login("alice");
  const id = w.accountId(ACC);
  const res = await alice.page(
    `/accounts/${id}/transactions?from=2026-07-01&to=2026-09-30&type=debit&minAmount=5&maxAmount=100&q=market`,
  );
  assert.equal(res.status, 200);
  assert.match(res.body, /<form\b[^>]*method=["']get["']/i);
  assert.equal(inputValue(res.body, "from"), "2026-07-01");
  assert.equal(inputValue(res.body, "to"), "2026-09-30");
  assert.equal(inputValue(res.body, "minAmount"), "5");
  assert.equal(inputValue(res.body, "maxAmount"), "100");
  assert.equal(inputValue(res.body, "q"), "market");
  assert.match(res.body, /<select\b[^>]*name=["']type["']/i);
  assert.match(res.body, /<option(?=[^>]*value=["']debit["'])(?=[^>]*\bselected\b)[^>]*>/i);
  assert.doesNotMatch(res.body, /<option(?=[^>]*value=["']credit["'])(?=[^>]*\bselected\b)[^>]*>/i);
  assert.match(res.body, /<option(?=[^>]*value=["']["'])[^>]*>/i);
  assert.match(res.body, /Showing 1–2 of 2/);
});

test("WEB-VIEW: filter values are HTML-escaped", async () => {
  const w = world();
  const alice = await w.login("alice");
  const evil = `"><script>alert(1)</script>`;
  const res = await alice.page(`/accounts/${w.accountId(ACC)}/transactions?q=${encodeURIComponent(evil)}`);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.body, /<script>alert\(1\)<\/script>/);
  assert.equal(inputValue(res.body, "q"), evil);
});

test("WEB-VIEW: export link carries the active filters only", async () => {
  const w = world();
  const alice = await w.login("alice");
  const id = w.accountId(ACC);
  const res = await alice.page(`/accounts/${id}/transactions?type=credit&q=salary&minAmount=&limit=2&offset=0`);
  const link = anchors(res.body).find((a) => a.href.startsWith(`/api/accounts/${id}/transactions.csv`));
  assert.ok(link, "export link present");
  const params = new URL(link.href, "http://x").searchParams;
  assert.equal(params.get("type"), "credit");
  assert.equal(params.get("q"), "salary");
  assert.equal(params.has("minAmount"), false);
  assert.equal(params.has("limit"), false);
  assert.equal(params.has("offset"), false);
  const plain = await alice.page(`/accounts/${id}/transactions`);
  const plainLink = anchors(plain.body).find((a) => a.href.startsWith(`/api/accounts/${id}/transactions.csv`));
  assert.ok(plainLink);
  assert.equal(new URL(plainLink.href, "http://x").searchParams.toString(), "");
});

test("WEB-VIEW: pagination links keep the active filters", async () => {
  const w = world();
  const alice = await w.login("alice");
  const id = w.accountId(ACC);
  const res = await alice.page(`/accounts/${id}/transactions?type=debit&limit=5&offset=5`);
  assert.match(res.body, /Showing 6–10 of 19/);
  const next = anchors(res.body).find((a) => /\brel=["']next["']/.test(a.tag));
  const prev = anchors(res.body).find((a) => /\brel=["']prev["']/.test(a.tag));
  assert.ok(next && prev);
  const n = new URL(next.href, "http://x");
  assert.equal(n.pathname, `/accounts/${id}/transactions`);
  assert.equal(n.searchParams.get("type"), "debit");
  assert.equal(n.searchParams.get("offset"), "10");
  assert.equal(new URL(prev.href, "http://x").searchParams.get("type"), "debit");
});

test("WEB-VIEW: invalid filters respond with 400", async () => {
  const w = world();
  const alice = await w.login("alice");
  const id = w.accountId(ACC);
  assert.equal((await alice.page(`/accounts/${id}/transactions?from=yesterday`)).status, 400);
  assert.equal((await alice.page(`/accounts/${id}/transactions?minAmount=9&maxAmount=1`)).status, 400);
  assert.equal((await alice.page(`/accounts/${id}/transactions`)).status, 200);
});
