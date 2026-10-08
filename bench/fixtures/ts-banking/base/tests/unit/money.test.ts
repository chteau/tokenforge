import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDecimal, formatMoney, isCurrency, parseAmount, sumByCurrency } from "../../packages/shared/src/money.ts";

describe("parseAmount", () => {
  it("converts decimal strings into minor units", () => {
    assert.equal(parseAmount("12.5", "USD"), 1250);
    assert.equal(parseAmount("0.99", "EUR"), 99);
    assert.equal(parseAmount("1200", "GBP"), 120000);
    assert.equal(parseAmount(" 7.00 ", "USD"), 700);
  });

  it("respects zero-decimal currencies", () => {
    assert.equal(parseAmount("1500", "JPY"), 1500);
    assert.equal(parseAmount("1500.5", "JPY"), null);
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "abc", "-1", "1.234", "1,000.00", "1e3", ".5"]) {
      assert.equal(parseAmount(bad, "USD"), null, bad);
    }
  });
});

describe("formatDecimal", () => {
  it("formats minor units without symbols or grouping", () => {
    assert.equal(formatDecimal(123456, "USD"), "1234.56");
    assert.equal(formatDecimal(-300, "EUR"), "-3.00");
    assert.equal(formatDecimal(5, "GBP"), "0.05");
    assert.equal(formatDecimal(1500, "JPY"), "1500");
    assert.equal(formatDecimal(0, "USD"), "0.00");
  });
});

describe("formatMoney", () => {
  it("formats with currency symbols", () => {
    assert.equal(formatMoney(123456, "USD"), "$1,234.56");
    assert.equal(formatMoney(1500, "JPY"), "¥1,500");
    assert.equal(formatMoney(-250, "EUR"), "-€2.50");
  });
});

describe("currency helpers", () => {
  it("recognises supported currencies", () => {
    assert.ok(isCurrency("CHF"));
    assert.ok(!isCurrency("usd"));
    assert.ok(!isCurrency("XYZ"));
  });

  it("sums per currency", () => {
    const totals = sumByCurrency([
      { amountMinor: 100, currency: "USD" },
      { amountMinor: 250, currency: "EUR" },
      { amountMinor: 50, currency: "USD" },
    ]);
    assert.equal(totals.get("USD"), 150);
    assert.equal(totals.get("EUR"), 250);
  });
});
