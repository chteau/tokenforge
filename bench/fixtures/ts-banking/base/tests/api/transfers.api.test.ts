import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { idemKey, setup } from "../support/harness.ts";

describe("transfers API", () => {
  it("moves money between customers and notifies both sides", async () => {
    const t = setup();
    const alice = await t.login("alice");
    const from = t.accountId("QM-1000-0001");
    const res = await alice.post(
      "/api/transfers",
      { fromAccountId: from, toAccount: "QM-1000-0005", amount: "40.00", memo: "Concert ticket" },
      { "idempotency-key": idemKey() },
    );
    assert.equal(res.status, 201);
    const { transfer } = res.json();
    assert.equal(transfer.status, "completed");
    assert.equal(transfer.amountMinor, 4000);
    assert.equal(t.deps.repos.accounts.findById(from)?.balanceMinor, 666_055 - 4000);
    assert.equal(t.deps.repos.accounts.findByNumber("QM-1000-0005")?.balanceMinor, 36_500 + 4000);

    const bob = await t.login("bob");
    const inbox = (await bob.get("/api/notifications")).json();
    assert.equal(inbox.items[0].kind, "transfer_received");
    assert.equal(inbox.unread, 1);
    assert.equal(t.deps.repos.outbox.list().length, 1, "alice opted into email, bob did not");
  });

  it("requires an Idempotency-Key header and replays identical requests", async () => {
    const t = setup();
    const alice = await t.login("alice");
    const body = { fromAccountId: t.accountId("QM-1000-0001"), toAccount: "QM-1000-0002", amount: "10.00" };
    assert.equal((await alice.post("/api/transfers", body)).status, 400);
    const key = idemKey();
    const first = await alice.post("/api/transfers", body, { "idempotency-key": key });
    const second = await alice.post("/api/transfers", body, { "idempotency-key": key });
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.json().replayed, true);
    assert.equal(second.json().transfer.id, first.json().transfer.id);
    const conflict = await alice.post("/api/transfers", { ...body, amount: "11.00" }, { "idempotency-key": key });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json().error.code, "IDEMPOTENCY_CONFLICT");
  });

  it("enforces ownership, currency and account status", async () => {
    const t = setup();
    const alice = await t.login("alice");
    const notMine = await alice.post(
      "/api/transfers",
      { fromAccountId: t.accountId("QM-1000-0004"), toAccount: "QM-1000-0001", amount: "1.00" },
      { "idempotency-key": idemKey() },
    );
    assert.equal(notMine.status, 404);
    const fx = await alice.post(
      "/api/transfers",
      { fromAccountId: t.accountId("QM-1000-0001"), toAccount: "QM-1000-0003", amount: "1.00" },
      { "idempotency-key": idemKey() },
    );
    assert.equal(fx.json().error.code, "CURRENCY_MISMATCH");
    const dana = await t.login("dana");
    const frozen = await dana.post(
      "/api/transfers",
      { fromAccountId: t.accountId("QM-1000-0008"), toAccount: "QM-1000-0009", amount: "1.00" },
      { "idempotency-key": idemKey() },
    );
    assert.equal(frozen.status, 422);
    assert.equal(frozen.json().error.code, "ACCOUNT_FROZEN");
  });

  it("rejects transfers above the available balance", async () => {
    const t = setup();
    const bob = await t.login("bob");
    const res = await bob.post(
      "/api/transfers",
      { fromAccountId: t.accountId("QM-1000-0005"), toAccount: "QM-1000-0001", amount: "365.01" },
      { "idempotency-key": idemKey() },
    );
    assert.equal(res.status, 422);
    assert.equal(res.json().error.code, "INSUFFICIENT_FUNDS");
    assert.equal(t.deps.repos.transfers.listByUser(t.userId("bob")).length, 0);
  });

  it("enforces the daily limit per local calendar day", async () => {
    const t = setup({ now: "2026-10-07T12:00:00.000Z" }); // 13:00 in London
    const bob = await t.login("bob");
    // Bob has a single GBP account, so send to a fresh GBP account owned by Dana.
    const olive = await t.login("olive");
    const opened = await olive.post("/api/admin/accounts", { ownerId: t.userId("dana"), name: "Pfund", type: "checking", currency: "GBP" });
    const target = opened.json().account.number;
    const to = (amount: string) =>
      bob.post("/api/transfers", { fromAccountId: t.accountId("QM-1000-0004"), toAccount: target, amount }, { "idempotency-key": idemKey() });
    assert.equal((await to("2000.00")).status, 201);
    const over = await to("500.01");
    assert.equal(over.status, 422);
    assert.equal(over.json().error.code, "DAILY_LIMIT_EXCEEDED");
    const same = await bob.post(
      "/api/transfers",
      { fromAccountId: t.accountId("QM-1000-0004"), toAccount: "QM-1000-0004", amount: "1.00" },
      { "idempotency-key": idemKey() },
    );
    assert.equal(same.status, 400, "same-account transfers are rejected");
    t.clock.set("2026-10-07T23:00:01.000Z"); // 00:00:01 on Oct 8 in London
    const bobTomorrow = await t.login("bob");
    const next = await bobTomorrow.post(
      "/api/transfers",
      { fromAccountId: t.accountId("QM-1000-0004"), toAccount: target, amount: "500.01" },
      { "idempotency-key": idemKey() },
    );
    assert.equal(next.status, 201);
  });

  it("previews a transfer without moving money", async () => {
    const t = setup();
    const alice = await t.login("alice");
    const res = await alice.post("/api/transfers/preview", {
      fromAccountId: t.accountId("QM-1000-0001"),
      toAccount: "qm-1000-0002",
      amount: "12.5",
    });
    assert.equal(res.status, 200);
    assert.equal(res.json().amountMinor, 1250);
    assert.equal(res.json().remainingTodayMinor, 5_000_00);
    assert.equal(t.deps.repos.transfers.listByUser(t.userId("alice")).length, 0);
  });

  it("lets admins reverse a completed transfer once", async () => {
    const t = setup();
    const alice = await t.login("alice");
    const created = await alice.post(
      "/api/transfers",
      { fromAccountId: t.accountId("QM-1000-0001"), toAccount: "QM-1000-0007", amount: "5.00" },
      { "idempotency-key": idemKey() },
    );
    const id = created.json().transfer.id;
    const olive = await t.login("olive");
    const reversed = await olive.post(`/api/admin/transfers/${id}/reverse`, { reason: "Sent in error" });
    assert.equal(reversed.status, 200);
    assert.equal(reversed.json().transfer.status, "reversed");
    assert.equal(t.deps.repos.accounts.findByNumber("QM-1000-0007")?.balanceMinor, 120_000);
    const twice = await olive.post(`/api/admin/transfers/${id}/reverse`, { reason: "Again" });
    assert.equal(twice.status, 409);
    assert.equal((await alice.post(`/api/admin/transfers/${id}/reverse`, { reason: "nope" })).status, 403);
  });
});
