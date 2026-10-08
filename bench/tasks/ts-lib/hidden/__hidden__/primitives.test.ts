import assert from "node:assert/strict";
import { test } from "node:test";
import { s } from "../src/index.ts";
import { issuesOf, ok, one } from "./support.ts";

test("PRIM: string, number and boolean accept their type", () => {
  assert.equal(s.string().parse("hi"), "hi");
  assert.equal(s.string().parse(""), "");
  assert.equal(s.number().parse(3.5), 3.5);
  assert.equal(s.number().parse(-0), -0);
  assert.equal(s.number().parse(Infinity), Infinity);
  assert.equal(s.boolean().parse(false), false);
});

test("PRIM: wrong type messages use the received type name", () => {
  assert.deepEqual(issuesOf(s.string(), 42), one([], "Expected string, received number"));
  assert.deepEqual(issuesOf(s.string(), null), one([], "Expected string, received null"));
  assert.deepEqual(issuesOf(s.string(), ["a"]), one([], "Expected string, received array"));
  assert.deepEqual(issuesOf(s.string(), {}), one([], "Expected string, received object"));
  assert.deepEqual(issuesOf(s.number(), "1"), one([], "Expected number, received string"));
  assert.deepEqual(issuesOf(s.number(), NaN), one([], "Expected number, received nan"));
  assert.deepEqual(issuesOf(s.number(), 10n), one([], "Expected number, received bigint"));
  assert.deepEqual(issuesOf(s.boolean(), "true"), one([], "Expected boolean, received string"));
  assert.deepEqual(issuesOf(s.boolean(), () => true), one([], "Expected boolean, received function"));
});

test("PRIM: undefined is reported as Required", () => {
  for (const schema of [s.string(), s.number(), s.boolean(), s.literal("x"), s.enum(["a"]), s.object({}), s.array(s.string())]) {
    assert.deepEqual(issuesOf(schema, undefined), one([], "Required"));
  }
});

test("STRING: length checks and default messages", () => {
  assert.equal(s.string().min(2).max(4).parse("abc"), "abc");
  assert.deepEqual(issuesOf(s.string().min(3), "ab"), one([], "String must contain at least 3 character(s)"));
  assert.deepEqual(issuesOf(s.string().max(2), "abc"), one([], "String must contain at most 2 character(s)"));
  assert.deepEqual(issuesOf(s.string().length(2), "abc"), one([], "String must contain exactly 2 character(s)"));
  assert.equal(s.string().length(2).parse("ab"), "ab");
});

test("STRING: email and regex", () => {
  assert.equal(s.string().email().parse("ada@example.com"), "ada@example.com");
  for (const bad of ["ada", "ada@example", "a da@example.com", "ada@@example.com", "@example.com"]) {
    assert.deepEqual(issuesOf(s.string().email(), bad), one([], "Invalid email"), bad);
  }
  assert.equal(s.string().regex(/^[a-z]+$/).parse("abc"), "abc");
  assert.deepEqual(issuesOf(s.string().regex(/^[a-z]+$/), "ab1"), one([], "Invalid string"));
});

test("STRING: all failing checks are reported in chaining order", () => {
  assert.deepEqual(issuesOf(s.string().email().min(10).regex(/^\d/), "x@y"), [
    { path: [], message: "Invalid email" },
    { path: [], message: "String must contain at least 10 character(s)" },
    { path: [], message: "Invalid string" },
  ]);
  assert.deepEqual(issuesOf(s.string().min(10).email(), 5), one([], "Expected string, received number"));
});

test("STRING: custom messages", () => {
  assert.deepEqual(issuesOf(s.string().min(3, "too short"), "a"), one([], "too short"));
  assert.deepEqual(issuesOf(s.string().max(1, "too long"), "ab"), one([], "too long"));
  assert.deepEqual(issuesOf(s.string().length(1, "one char"), "ab"), one([], "one char"));
  assert.deepEqual(issuesOf(s.string().email("bad email"), "a"), one([], "bad email"));
  assert.deepEqual(issuesOf(s.string().regex(/x/, "needs x"), "a"), one([], "needs x"));
});

test("STRING: trim runs before checks wherever it is chained", () => {
  assert.equal(s.string().trim().parse("  hi  "), "hi");
  assert.equal(s.string().max(2).trim().parse("  hi  "), "hi");
  assert.deepEqual(issuesOf(s.string().min(3).trim(), "  a  "), one([], "String must contain at least 3 character(s)"));
  assert.equal(s.string().trim().email().parse(" ada@example.com\n"), "ada@example.com");
});

test("NUMBER: int, min, max, positive", () => {
  assert.equal(s.number().int().min(1).max(10).positive().parse(5), 5);
  assert.deepEqual(issuesOf(s.number().int(), 1.5), one([], "Expected integer, received float"));
  assert.deepEqual(issuesOf(s.number().min(2), 1), one([], "Number must be greater than or equal to 2"));
  assert.equal(s.number().min(2).parse(2), 2);
  assert.deepEqual(issuesOf(s.number().max(2.5), 3), one([], "Number must be less than or equal to 2.5"));
  assert.equal(s.number().max(2.5).parse(2.5), 2.5);
  assert.deepEqual(issuesOf(s.number().positive(), 0), one([], "Number must be greater than 0"));
  assert.deepEqual(issuesOf(s.number().min(-5), -6), one([], "Number must be greater than or equal to -5"));
});

test("NUMBER: several failing checks and custom messages", () => {
  assert.deepEqual(issuesOf(s.number().positive().int().max(5), -1.5), [
    { path: [], message: "Number must be greater than 0" },
    { path: [], message: "Expected integer, received float" },
  ]);
  assert.deepEqual(issuesOf(s.number().int("whole numbers only").min(0, "no negatives"), -0.5), [
    { path: [], message: "whole numbers only" },
    { path: [], message: "no negatives" },
  ]);
  assert.deepEqual(issuesOf(s.number().positive("must be > 0"), -1), one([], "must be > 0"));
  assert.deepEqual(issuesOf(s.number().max(1, "max one"), 2), one([], "max one"));
});

test("LITERAL-ENUM: literal values", () => {
  assert.equal(s.literal("admin").parse("admin"), "admin");
  assert.equal(s.literal(42).parse(42), 42);
  assert.equal(s.literal(true).parse(true), true);
  assert.equal(s.literal(null).parse(null), null);
  assert.deepEqual(issuesOf(s.literal("admin"), "Admin"), one([], 'Invalid literal value, expected "admin"'));
  assert.deepEqual(issuesOf(s.literal(42), "42"), one([], "Invalid literal value, expected 42"));
  assert.deepEqual(issuesOf(s.literal(false), 0), one([], "Invalid literal value, expected false"));
  assert.deepEqual(issuesOf(s.literal(null), "null"), one([], "Invalid literal value, expected null"));
});

test("LITERAL-ENUM: enum values and messages", () => {
  const Color = s.enum(["red", "green", "blue"]);
  assert.equal(Color.parse("green"), "green");
  assert.deepEqual(
    issuesOf(Color, "pink"),
    one([], "Invalid enum value. Expected 'red' | 'green' | 'blue', received 'pink'"),
  );
  assert.deepEqual(issuesOf(Color, 3), one([], "Invalid enum value. Expected 'red' | 'green' | 'blue', received number"));
  assert.deepEqual(issuesOf(s.enum(["on"]), null), one([], "Invalid enum value. Expected 'on', received null"));
  assert.deepEqual(issuesOf(Color, "RED"), one([], "Invalid enum value. Expected 'red' | 'green' | 'blue', received 'RED'"));
});
