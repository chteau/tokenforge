import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setup } from "../support/harness.ts";

describe("web pages", () => {
  it("redirects anonymous visitors to the login page", async () => {
    const t = setup();
    const res = await t.app.inject({ method: "GET", url: "/dashboard" });
    assert.equal(res.status, 303);
    assert.equal(res.headers["location"], "/login?next=%2Fdashboard");
  });

  it("signs in through the login form and sets a session cookie", async () => {
    const t = setup();
    const res = await t.app.inject({
      method: "POST",
      url: "/login",
      body: "username=alice&password=alice-harbor-2026&next=%2Faccounts",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers["location"], "/accounts");
    assert.match(String(res.headers["set-cookie"]), /^qm_session=[^;]+; Path=\/; SameSite=Strict; HttpOnly/);
    const bad = await t.app.inject({
      method: "POST",
      url: "/login",
      body: "username=alice&password=nope&next=%2F%2Fevil.example",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    assert.equal(bad.status, 401);
    assert.match(bad.body, /Invalid username or password/);
    assert.match(bad.body, /name="next" value="\/dashboard"/);
  });

  it("renders the dashboard with balances", async () => {
    const t = setup();
    const alice = await t.login("alice");
    const res = await alice.page("/dashboard");
    assert.equal(res.status, 200);
    assert.match(res.body, /Hello, Alice Marlow/);
    assert.match(res.body, /\$6,660\.55/);
    assert.match(res.body, /data-currency="EUR"/);
  });

  it("renders account activity with escaping and pagination", async () => {
    const t = setup();
    const alice = await t.login("alice");
    const id = t.accountId("QM-1000-0001");
    const res = await alice.page(`/accounts/${id}/transactions`);
    assert.equal(res.status, 200);
    assert.match(res.body, /Dinner at &quot;The Anchor&quot;, Pier 9/);
    assert.match(res.body, /Showing 1–25 of 25/);
    const paged = await alice.page(`/accounts/${id}/transactions?limit=10&offset=10`);
    assert.match(paged.body, /Showing 11–20 of 25/);
    assert.match(paged.body, /rel="prev"/);
    assert.match(paged.body, /rel="next"/);
  });

  it("shows an error page for other customers' accounts", async () => {
    const t = setup();
    const bob = await t.login("bob");
    const res = await bob.page(`/accounts/${t.accountId("QM-1000-0001")}/transactions`);
    assert.equal(res.status, 404);
    assert.match(res.body, /We couldn&#39;t find that page/);
  });

  it("submits the transfer form and re-renders it with errors", async () => {
    const t = setup();
    const alice = await t.login("alice");
    const formPage = await alice.page("/transfers/new");
    const key = /name="idempotencyKey" value="([^"]+)"/.exec(formPage.body)?.[1];
    assert.ok(key);
    const bad = await alice.form("/transfers", {
      fromAccountId: t.accountId("QM-1000-0001"),
      toAccount: "QM-1000-0002",
      amount: "abc",
      idempotencyKey: key,
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body, /class="field-error" id="amount-error"/);
    const good = await alice.form("/transfers", {
      fromAccountId: t.accountId("QM-1000-0001"),
      toAccount: "QM-1000-0002",
      amount: "20.00",
      memo: "savings",
      idempotencyKey: key,
    });
    assert.equal(good.status, 303);
    assert.match(String(good.headers["location"]), /^\/transfers\?created=trf_/);
    const list = await alice.page(String(good.headers["location"]));
    assert.match(list.body, /Your transfer was sent/);
  });

  it("serves static assets", async () => {
    const t = setup();
    const css = await t.app.inject({ method: "GET", url: "/static/app.css" });
    assert.match(String(css.headers["content-type"]), /text\/css/);
    const js = await t.app.inject({ method: "GET", url: "/static/transfer-form.js" });
    assert.equal(js.status, 200);
    assert.doesNotMatch(js.body, /: TransferFormInput/);
    assert.match(js.body, /export function validateTransferForm/);
  });
});
