import assert from "node:assert/strict";
import { test } from "node:test";
import { s } from "../src/index.ts";
import { issuesOf, ok, one } from "./support.ts";

const User = s.object({
  id: s.number().int(),
  name: s.string().min(1),
  email: s.string().email().optional(),
  role: s.enum(["admin", "member"]).default("member"),
});

test("OBJECT: parses a valid object into a new object", () => {
  const input = { id: 1, name: "Ada", email: "ada@example.com", role: "admin" };
  const out = User.parse(input);
  assert.deepStrictEqual(out, { id: 1, name: "Ada", email: "ada@example.com", role: "admin" });
  assert.notEqual(out, input);
});

test("OBJECT: unknown keys are dropped, absent optional keys stay absent, defaults are filled", () => {
  const input = { id: 2, name: "Bob", extra: true, other: [1] };
  const out = User.parse(input);
  assert.deepStrictEqual(out, { id: 2, name: "Bob", role: "member" });
  assert.equal(Object.prototype.hasOwnProperty.call(out, "email"), false);
  assert.deepStrictEqual(input, { id: 2, name: "Bob", extra: true, other: [1] });
});

test("OBJECT: property issues use the key path, in shape order", () => {
  assert.deepEqual(issuesOf(User, { name: "", id: "7", email: "nope", role: "owner" }), [
    { path: ["id"], message: "Expected number, received string" },
    { path: ["name"], message: "String must contain at least 1 character(s)" },
    { path: ["email"], message: "Invalid email" },
    { path: ["role"], message: "Invalid enum value. Expected 'admin' | 'member', received 'owner'" },
  ]);
  assert.deepEqual(issuesOf(User, {}), [
    { path: ["id"], message: "Required" },
    { path: ["name"], message: "Required" },
  ]);
});

test("OBJECT: non-object inputs", () => {
  assert.deepEqual(issuesOf(User, null), one([], "Expected object, received null"));
  assert.deepEqual(issuesOf(User, [1, 2]), one([], "Expected object, received array"));
  assert.deepEqual(issuesOf(User, "x"), one([], "Expected object, received string"));
});

test("OBJECT: nested objects extend the path", () => {
  const Order = s.object({ customer: s.object({ address: s.object({ zip: s.string().length(5) }) }) });
  assert.deepEqual(issuesOf(Order, { customer: { address: { zip: "123" } } }), [
    { path: ["customer", "address", "zip"], message: "String must contain exactly 5 character(s)" },
  ]);
  assert.deepEqual(issuesOf(Order, { customer: {} }), one(["customer", "address"], "Required"));
  assert.deepStrictEqual(Order.parse({ customer: { address: { zip: "12345", x: 1 }, y: 2 } }), {
    customer: { address: { zip: "12345" } },
  });
});

test("OBJECT: strict reports unknown keys once, after property issues", () => {
  const Point = s.object({ x: s.number(), y: s.number() }).strict();
  assert.deepStrictEqual(Point.parse({ x: 1, y: 2 }), { x: 1, y: 2 });
  assert.deepEqual(issuesOf(Point, { z: 0, x: "1", y: 2, w: 1 }), [
    { path: ["x"], message: "Expected number, received string" },
    { path: [], message: "Unrecognized key(s) in object: 'z', 'w'" },
  ]);
  const Wrapper = s.object({ p: Point });
  assert.deepEqual(issuesOf(Wrapper, { p: { x: 1, y: 2, q: 3 } }), one(["p"], "Unrecognized key(s) in object: 'q'"));
});

test("ARRAY: elements are validated with index paths", () => {
  const Tags = s.array(s.string().min(2));
  assert.deepStrictEqual(Tags.parse(["ab", "cd"]), ["ab", "cd"]);
  assert.deepStrictEqual(Tags.parse([]), []);
  assert.deepEqual(issuesOf(Tags, ["ab", "c", 3]), [
    { path: [1], message: "String must contain at least 2 character(s)" },
    { path: [2], message: "Expected string, received number" },
  ]);
  assert.deepEqual(issuesOf(Tags, "ab"), one([], "Expected array, received string"));
  assert.deepEqual(issuesOf(Tags, { 0: "ab" }), one([], "Expected array, received object"));
});

test("ARRAY: length checks come after element issues", () => {
  const A = s.array(s.number()).min(2).max(3);
  assert.deepStrictEqual(A.parse([1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(issuesOf(A, [1]), one([], "Array must contain at least 2 element(s)"));
  assert.deepEqual(issuesOf(A, [1, 2, 3, 4]), one([], "Array must contain at most 3 element(s)"));
  assert.deepEqual(issuesOf(A, ["x"]), [
    { path: [0], message: "Expected number, received string" },
    { path: [], message: "Array must contain at least 2 element(s)" },
  ]);
  assert.deepEqual(issuesOf(s.array(s.number()).min(1, "need one"), []), one([], "need one"));
  assert.deepEqual(issuesOf(s.array(s.number()).max(0, "none allowed"), [1]), one([], "none allowed"));
});

test("ARRAY: nested arrays and objects build full paths; output is a new array", () => {
  const Order = s.object({ lines: s.array(s.object({ sku: s.string(), qty: s.number().int().positive() })) });
  assert.deepEqual(issuesOf(Order, { lines: [{ sku: "a", qty: 1 }, { qty: 0 }] }), [
    { path: ["lines", 1, "sku"], message: "Required" },
    { path: ["lines", 1, "qty"], message: "Number must be greater than 0" },
  ]);
  const input = [[1, 2], [3]];
  const out = s.array(s.array(s.number())).parse(input);
  assert.deepStrictEqual(out, [[1, 2], [3]]);
  assert.notEqual(out, input);
  assert.deepEqual(issuesOf(s.array(s.array(s.number())), [[1], [2, "x"]]), one([1, 1], "Expected number, received string"));
});

test("UNION: first matching option wins", () => {
  const U = s.union([s.string().trim(), s.number()]);
  assert.equal(U.parse(" a "), "a");
  assert.equal(U.parse(5), 5);
  const Shape = s.union([
    s.object({ kind: s.literal("circle"), r: s.number() }),
    s.object({ kind: s.literal("square"), side: s.number() }),
  ]);
  assert.deepStrictEqual(Shape.parse({ kind: "square", side: 2, extra: 1 }), { kind: "square", side: 2 });
});

test("UNION: no match reports a single Invalid input issue at the union path", () => {
  const U = s.union([s.string(), s.number()]);
  assert.deepEqual(issuesOf(U, true), one([], "Invalid input"));
  assert.deepEqual(issuesOf(U, undefined), one([], "Invalid input"));
  const O = s.object({ v: s.union([s.literal("a"), s.literal(1)]) });
  assert.deepEqual(issuesOf(O, { v: "b" }), one(["v"], "Invalid input"));
  assert.equal(s.union([s.string(), s.number()]).optional().parse(undefined), undefined);
});
