import assert from "node:assert/strict";
import { test } from "node:test";
import { world } from "./sched-support.ts";

function hasField(htmlText: string, tag: "input" | "select", name: string): boolean {
  return new RegExp(`<${tag}\\b[^>]*\\bname\\s*=\\s*["']${name}["']`, "i").test(htmlText);
}

test("SCHED-WEB: the page lists scheduled transfers and offers the form", async () => {
  const w = world();
  const alice = await w.login("alice");
  await alice.schedule({ fromAccountId: w.accountId("QM-1000-0001"), toAccount: "QM-1000-0002", amount: "64.00", memo: "Piano lessons", scheduledDate: "2026-10-21" });
  const res = await alice.page("/transfers/scheduled");
  assert.equal(res.status, 200);
  assert.match(res.body, /Piano lessons/);
  assert.match(res.body, /2026-10-21|Oct 21, 2026/);
  assert.match(res.body, /\$64\.00|64\.00/);
  assert.match(res.body, /<form\b(?=[^>]*method=["']post["'])(?=[^>]*action=["']\/transfers\/scheduled["'])[^>]*>/i);
  assert.ok(hasField(res.body, "select", "fromAccountId") || hasField(res.body, "input", "fromAccountId"));
  for (const name of ["toAccount", "amount", "scheduledDate", "memo"]) assert.ok(hasField(res.body, "input", name), name);
  assert.match(res.body, /<input\b(?=[^>]*type=["']hidden["'])(?=[^>]*name=["']idempotencyKey["'])[^>]*>/i);
});

test("SCHED-WEB: submitting the form schedules and redirects", async () => {
  const w = world();
  const alice = await w.login("alice");
  const res = await alice.form("/transfers/scheduled", {
    fromAccountId: w.accountId("QM-1000-0001"),
    toAccount: "QM-1000-0005",
    amount: "15.50",
    scheduledDate: "2026-10-25",
    memo: "Snacks",
    idempotencyKey: "web-form-key-0001",
  });
  assert.equal(res.status, 303);
  assert.equal(new URL(String(res.headers["location"]), "http://x").pathname, "/transfers/scheduled");
  const items = (await alice.get("/api/scheduled-transfers")).json().items;
  assert.equal(items.length, 1);
  assert.equal(items[0].amountMinor, 1550);
  assert.equal(items[0].memo, "Snacks");
  assert.equal(items[0].executeAt, "2026-10-25T13:00:00.000Z");
});

test("SCHED-WEB: invalid submissions re-render with the error status", async () => {
  const w = world();
  const alice = await w.login("alice");
  const res = await alice.form("/transfers/scheduled", {
    fromAccountId: w.accountId("QM-1000-0001"),
    toAccount: "QM-1000-0005",
    amount: "15.50",
    scheduledDate: "2026-10-01",
    memo: "",
    idempotencyKey: "web-form-key-0002",
  });
  assert.equal(res.status, 400);
  assert.match(res.body, /<form\b[^>]*action=["']\/transfers\/scheduled["']/i);
  assert.equal((await alice.get("/api/scheduled-transfers")).json().items.length, 0);
});

test("SCHED-WEB: the cancel form cancels and redirects", async () => {
  const w = world();
  const alice = await w.login("alice");
  const created = await alice.schedule({ fromAccountId: w.accountId("QM-1000-0001"), toAccount: "QM-1000-0002", amount: "5.00", scheduledDate: "2026-10-28" });
  const id = created.json().scheduledTransfer.id;
  const page = await alice.page("/transfers/scheduled");
  assert.match(page.body, new RegExp(`action=["']/transfers/scheduled/${id}/cancel["']`));
  const res = await alice.form(`/transfers/scheduled/${id}/cancel`, {});
  assert.equal(res.status, 303);
  assert.equal(new URL(String(res.headers["location"]), "http://x").pathname, "/transfers/scheduled");
  assert.equal((await alice.get(`/api/scheduled-transfers/${id}`)).json().scheduledTransfer.status, "cancelled");
  const after = await alice.page("/transfers/scheduled");
  assert.doesNotMatch(after.body, new RegExp(`action=["']/transfers/scheduled/${id}/cancel["']`));
  const bob = await w.login("bob");
  const other = await bob.form(`/transfers/scheduled/${id}/cancel`, {});
  assert.equal(other.status, 404);
});
