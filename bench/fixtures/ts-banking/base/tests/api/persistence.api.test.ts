import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { idemKey, setup } from "../support/harness.ts";

const dir = mkdtempSync(join(tmpdir(), "qm-persist-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("persistence", () => {
  it("keeps transfers and balances across restarts", async () => {
    const dataFile = join(dir, "bank.json");
    const first = setup({ dataFile });
    const alice = await first.login("alice");
    const res = await alice.post(
      "/api/transfers",
      { fromAccountId: first.accountId("QM-1000-0001"), toAccount: "QM-1000-0002", amount: "33.00" },
      { "idempotency-key": idemKey() },
    );
    assert.equal(res.status, 201);

    const second = setup({ dataFile });
    const alice2 = await second.login("alice");
    const transfers = (await alice2.get("/api/transfers")).json().items;
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0].amountMinor, 3300);
    assert.equal(second.deps.repos.accounts.findByNumber("QM-1000-0002")?.balanceMinor, 501_874 + 3300);
  });
});
