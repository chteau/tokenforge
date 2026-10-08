import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setup } from "../support/harness.ts";

describe("cards API", () => {
  it("freezes, unfreezes and replaces a lost card", async () => {
    const t = setup();
    const alice = await t.login("alice");
    const cards = (await alice.get("/api/cards")).json().items;
    const active = cards.find((c: { last4: string }) => c.last4 === "4417");
    assert.equal((await alice.post(`/api/cards/${active.id}/freeze`)).json().card.status, "frozen");
    assert.equal((await alice.post(`/api/cards/${active.id}/unfreeze`)).json().card.status, "active");
    const lost = await alice.post(`/api/cards/${active.id}/report-lost`);
    assert.equal(lost.status, 200);
    assert.equal(lost.json().lost.status, "replaced");
    assert.equal(lost.json().replacement.status, "active");
    assert.equal((await alice.post(`/api/cards/${active.id}/freeze`)).status, 409);
  });

  it("does not let customers touch other people's cards", async () => {
    const t = setup();
    const alice = await t.login("alice");
    const bob = await t.login("bob");
    const bobCard = (await bob.get("/api/cards")).json().items[0];
    assert.equal((await alice.post(`/api/cards/${bobCard.id}/freeze`)).status, 404);
  });

  it("updates the monthly limit within bounds", async () => {
    const t = setup();
    const bob = await t.login("bob");
    const card = (await bob.get("/api/cards")).json().items[0];
    const ok = await bob.put(`/api/cards/${card.id}/limit`, { monthlySpendLimit: "750.00" });
    assert.equal(ok.json().card.monthlySpendLimitMinor, 75_000);
    const tooHigh = await bob.put(`/api/cards/${card.id}/limit`, { monthlySpendLimit: "999999" });
    assert.equal(tooHigh.status, 400);
  });
});

describe("support tickets API", () => {
  it("lets customers open tickets and staff reply", async () => {
    const t = setup();
    const bob = await t.login("bob");
    const opened = await bob.post("/api/support/tickets", { subject: "Statement question", category: "account", body: "Where is my PDF?" });
    assert.equal(opened.status, 201);
    const id = opened.json().ticket.id;
    const sam = await t.login("sam");
    const all = (await sam.get("/api/support/tickets")).json().items;
    assert.equal(all.length, 2);
    const reply = await sam.post(`/api/support/tickets/${id}/messages`, { body: "Statements are under Accounts." });
    assert.equal(reply.json().ticket.status, "awaiting_customer");
    const inbox = (await bob.get("/api/notifications")).json();
    assert.equal(inbox.items[0].kind, "ticket_reply");
    const alice = await t.login("alice");
    assert.equal((await alice.get(`/api/support/tickets/${id}`)).status, 404);
  });
});

describe("statements API", () => {
  it("builds a monthly statement in the owner's time zone", async () => {
    const t = setup();
    const alice = await t.login("alice");
    const id = t.accountId("QM-1000-0001");
    const res = await alice.get(`/api/accounts/${id}/statements/2026-08`);
    assert.equal(res.status, 200);
    const s = res.json().statement;
    // The 2026-09-01T02:30Z pharmacy purchase happened on Aug 31 in New York.
    assert.ok(s.entries.some((e: { description: string }) => e.description === "Late-night pharmacy"));
    assert.equal(s.closingBalanceMinor - s.openingBalanceMinor, s.totalCreditsMinor - s.totalDebitsMinor);
    const text = await alice.get(`/api/accounts/${id}/statements/2026-08?format=text`);
    assert.match(text.headers["content-type"] as string, /^text\/plain/);
    assert.match(text.body, /QUILLMOOR BANK - ACCOUNT STATEMENT/);
  });

  it("rejects malformed and future periods", async () => {
    const t = setup();
    const alice = await t.login("alice");
    const id = t.accountId("QM-1000-0001");
    assert.equal((await alice.get(`/api/accounts/${id}/statements/2026-13`)).status, 400);
    assert.equal((await alice.get(`/api/accounts/${id}/statements/2027-01`)).status, 400);
    const periods = (await alice.get(`/api/accounts/${id}/statements`)).json().periods;
    assert.deepEqual(periods, ["2026-10", "2026-09", "2026-08", "2026-07"]);
  });
});
