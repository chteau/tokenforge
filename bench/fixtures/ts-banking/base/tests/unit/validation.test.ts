import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DomainError } from "../../packages/shared/src/errors.ts";
import { parse, parseOrThrow, queryToObject, v } from "../../packages/shared/src/validation.ts";

describe("schema validation", () => {
  const schema = v.object({
    name: v.string({ min: 1, max: 10 }),
    count: v.optional(v.integer({ min: 0, max: 5 })),
    kind: v.withDefault(v.oneOf(["a", "b"] as const), "a"),
    date: v.optional(v.isoDate()),
  });

  it("returns typed values and applies defaults", () => {
    const result = parse(schema, { name: "  Ada ", count: "3" });
    assert.ok(result.ok);
    assert.deepEqual(result.value, { name: "Ada", count: 3, kind: "a" });
  });

  it("collects every issue with field names", () => {
    const result = parse(schema, { name: "", count: 9, kind: "z", date: "2026-02-30" });
    assert.ok(!result.ok);
    assert.deepEqual(
      result.error.map((i) => i.field),
      ["name", "count", "kind", "date"],
    );
  });

  it("throws VALIDATION_ERROR from parseOrThrow", () => {
    assert.throws(
      () => parseOrThrow(schema, "nope"),
      (err: unknown) => err instanceof DomainError && err.code === "VALIDATION_ERROR",
    );
  });

  it("validates decimal strings and ids", () => {
    assert.ok(parse(v.decimalString(), "12.50").ok);
    assert.ok(!parse(v.decimalString(), "-1").ok);
    assert.ok(parse(v.id("acc"), "acc_0001").ok);
    assert.ok(!parse(v.id("acc"), "usr_0001").ok);
  });

  it("converts query strings to objects", () => {
    assert.deepEqual(queryToObject(new URLSearchParams("a=1&b=2&a=3")), { a: "3", b: "2" });
  });
});
