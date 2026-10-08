import assert from "node:assert/strict";
import { test } from "node:test";
import { s } from "../src/index.ts";
import { issuesOf, ok, one } from "./support.ts";

test("MODIFIERS: optional accepts undefined only", () => {
  const O = s.string().min(2).optional();
  assert.equal(O.parse(undefined), undefined);
  assert.equal(O.parse("ab"), "ab");
  assert.deepEqual(issuesOf(O, null), one([], "Expected string, received null"));
  assert.deepEqual(issuesOf(O, "a"), one([], "String must contain at least 2 character(s)"));
});

test("MODIFIERS: nullable accepts null only", () => {
  const N = s.number().nullable();
  assert.equal(N.parse(null), null);
  assert.equal(N.parse(1), 1);
  assert.deepEqual(issuesOf(N, undefined), one([], "Required"));
  const NO = s.number().nullable().optional();
  assert.equal(NO.parse(undefined), undefined);
  assert.equal(NO.parse(null), null);
});

test("MODIFIERS: default replaces undefined without validating it", () => {
  const D = s.number().int().default(3);
  assert.equal(D.parse(undefined), 3);
  assert.equal(D.parse(7), 7);
  assert.deepEqual(issuesOf(D, 1.5), one([], "Expected integer, received float"));
  assert.deepEqual(issuesOf(D, null), one([], "Expected number, received null"));
  assert.equal(s.string().min(5).default("x").parse(undefined), "x");
  const list = ["a"];
  assert.equal(s.array(s.string()).default(list).parse(undefined), list);
  assert.equal(s.string().optional().default("d").parse(undefined), "d");
});

test("MODIFIERS: refine runs after the wrapped schema succeeds", () => {
  let calls = 0;
  const Even = s.number().int().refine((n) => {
    calls++;
    return n % 2 === 0;
  }, "Must be even");
  assert.equal(Even.parse(4), 4);
  assert.deepEqual(issuesOf(Even, 3), one([], "Must be even"));
  const before = calls;
  assert.deepEqual(issuesOf(Even, 2.5), one([], "Expected integer, received float"));
  assert.equal(calls, before);
  assert.deepEqual(issuesOf(s.string().refine((v) => v !== "x"), "x"), one([], "Invalid input"));
});

test("MODIFIERS: refine on objects receives the parsed value and reports at the object path", () => {
  const Range = s
    .object({ from: s.number(), to: s.number() })
    .refine((r) => r.from <= r.to && !("junk" in r), "from must be <= to");
  assert.deepStrictEqual(Range.parse({ from: 1, to: 2, junk: 1 }), { from: 1, to: 2 });
  assert.deepEqual(issuesOf(Range, { from: 3, to: 2 }), one([], "from must be <= to"));
  const Form = s.object({ range: Range });
  assert.deepEqual(issuesOf(Form, { range: { from: 5, to: 1 } }), one(["range"], "from must be <= to"));
  assert.deepEqual(issuesOf(Form, { range: { from: "5", to: 1 } }), one(["range", "from"], "Expected number, received string"));
});

test("MODIFIERS: schemas are immutable", () => {
  const base = s.string();
  const min = base.min(3);
  base.max(1);
  base.optional();
  assert.equal(base.parse("ab"), "ab");
  assert.equal(min.parse("abcdef"), "abcdef");
  assert.deepEqual(issuesOf(base, undefined), one([], "Required"));
  const n = s.number();
  n.int();
  assert.equal(n.parse(1.5), 1.5);
  const obj = s.object({ a: s.number() });
  obj.strict();
  assert.deepStrictEqual(obj.parse({ a: 1, b: 2 }), { a: 1 });
  const arr = s.array(s.number());
  arr.min(2);
  assert.deepStrictEqual(arr.parse([]), []);
});
