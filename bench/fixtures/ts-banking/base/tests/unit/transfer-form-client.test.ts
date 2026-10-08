import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { amountPattern, validateTransferForm } from "../../apps/web/client/transfer-form.ts";

const valid = { fromAccountId: "acc_0001", toAccount: "QM-1000-0005", amount: "25.00", memo: "" };

describe("client-side transfer form validation", () => {
  it("accepts a well-formed request", () => {
    assert.deepEqual(validateTransferForm(valid), {});
  });

  it("flags missing and malformed fields", () => {
    const errors = validateTransferForm({ fromAccountId: "", toAccount: "12345", amount: "1.234", memo: "x".repeat(141) });
    assert.deepEqual(Object.keys(errors).sort(), ["amount", "fromAccountId", "memo", "toAccount"]);
  });

  it("rejects zero amounts and fractional yen", () => {
    assert.ok(validateTransferForm({ ...valid, amount: "0.00" }).amount);
    assert.ok(validateTransferForm({ ...valid, amount: "100.5" }, 0).amount);
    assert.ok(amountPattern(0).test("1500"));
  });
});
