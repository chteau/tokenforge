import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createManualClock } from "../../packages/shared/src/clock.ts";
import { DomainError } from "../../packages/shared/src/errors.ts";
import { sequentialIds } from "../../packages/shared/src/ids.ts";
import { createLedger } from "../../packages/transactions/src/ledger.ts";
import { createMemoryAccountRepository } from "../../server/repositories/memory/accounts.ts";
import { createMemoryLedgerRepository } from "../../server/repositories/memory/ledger.ts";

function fixture() {
  const clock = createManualClock("2026-05-01T10:00:00Z");
  const accounts = createMemoryAccountRepository();
  const entries = createMemoryLedgerRepository();
  const ledger = createLedger({ entries, accounts, clock, ids: sequentialIds() });
  for (const id of ["acc_a001", "acc_b001"]) {
    accounts.insert({
      id,
      ownerId: "usr_1",
      number: `QM-0000-${id.slice(-4)}`,
      name: id,
      type: "checking",
      currency: "USD",
      balanceMinor: 0,
      status: "active",
      openedAt: "2026-01-01T00:00:00Z",
    });
  }
  const base = { counterparty: null, reference: null, transferId: null, category: "deposit" as const };
  return { clock, accounts, entries, ledger, base };
}

describe("ledger", () => {
  it("keeps balances and balanceAfter in sync", () => {
    const { ledger, accounts, base } = fixture();
    ledger.post("acc_a001", { ...base, type: "credit", amountMinor: 10_000, description: "in" });
    const e = ledger.post("acc_a001", { ...base, type: "debit", amountMinor: 2_550, description: "out" });
    assert.equal(e.balanceAfterMinor, 7_450);
    assert.equal(accounts.findById("acc_a001")?.balanceMinor, 7_450);
  });

  it("refuses to overdraw", () => {
    const { ledger, base } = fixture();
    assert.throws(
      () => ledger.post("acc_a001", { ...base, type: "debit", amountMinor: 1, description: "x" }),
      (err: unknown) => err instanceof DomainError && err.code === "INSUFFICIENT_FUNDS",
    );
  });

  it("posts both legs of a transfer", () => {
    const { ledger, entries, base } = fixture();
    ledger.post("acc_a001", { ...base, type: "credit", amountMinor: 5_000, description: "in" });
    const { debit, credit } = ledger.postTransfer({
      fromAccountId: "acc_a001",
      toAccountId: "acc_b001",
      amountMinor: 1_200,
      transferId: "trf_x001",
      reference: null,
      debitDescription: "to b",
      creditDescription: "from a",
      debitCounterparty: "B",
      creditCounterparty: "A",
    });
    assert.equal(debit.type, "debit");
    assert.equal(credit.balanceAfterMinor, 1_200);
    assert.equal(entries.listByTransfer("trf_x001").length, 2);
  });

  it("lists entries newest first with paging and by time window", () => {
    const { ledger, entries, clock, base } = fixture();
    for (let i = 1; i <= 5; i++) {
      clock.advance(60_000);
      ledger.post("acc_a001", { ...base, type: "credit", amountMinor: i * 100, description: `#${i}` });
    }
    assert.deepEqual(
      entries.listByAccount("acc_a001", { limit: 2, offset: 1 }).map((e) => e.description),
      ["#4", "#3"],
    );
    assert.equal(entries.countByAccount("acc_a001"), 5);
    const since = new Date("2026-05-01T10:03:00Z");
    assert.deepEqual(
      entries.listByAccountSince("acc_a001", since).map((e) => e.description),
      ["#3", "#4", "#5"],
    );
  });
});
