import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPath, s, ValidationError } from "../src/index.ts";

const Schema = s.object({
  user: s.object({ name: s.string(), tags: s.array(s.object({ name: s.string() })) }),
  count: s.number(),
});

test("ERRORS: parse throws a ValidationError with all issues", () => {
  let caught: unknown;
  try {
    Schema.parse({ user: { name: 1, tags: [{ name: "a" }, {}, { name: 2 }] }, count: "x" });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ValidationError);
  assert.ok(caught instanceof Error);
  const err = caught as ValidationError;
  assert.equal(err.name, "ValidationError");
  assert.deepEqual(
    err.issues.map((i) => ({ path: [...i.path], message: i.message })),
    [
      { path: ["user", "name"], message: "Expected string, received number" },
      { path: ["user", "tags", 1, "name"], message: "Required" },
      { path: ["user", "tags", 2, "name"], message: "Expected string, received number" },
      { path: ["count"], message: "Expected number, received string" },
    ],
  );
  assert.equal(
    err.message,
    "user.name: Expected string, received number\n" +
      "user.tags[1].name: Required\n" +
      "user.tags[2].name: Expected string, received number\n" +
      "count: Expected number, received string",
  );
});

test("ERRORS: root issues format as (root)", () => {
  assert.throws(() => s.string().parse(1), (e: unknown) => {
    assert.ok(e instanceof ValidationError);
    assert.equal(e.message, "(root): Expected string, received number");
    return true;
  });
  assert.throws(() => s.array(s.number()).min(2).parse(["a"]), {
    message: "[0]: Expected number, received string\n(root): Array must contain at least 2 element(s)",
  });
});

test("ERRORS: formatPath", () => {
  assert.equal(formatPath([]), "(root)");
  assert.equal(formatPath(["user", "name"]), "user.name");
  assert.equal(formatPath(["tags", 2, "name"]), "tags[2].name");
  assert.equal(formatPath([0]), "[0]");
  assert.equal(formatPath([0, "id"]), "[0].id");
  assert.equal(formatPath(["a", 0, 1, "b", "c"]), "a[0][1].b.c");
});

test("ERRORS: safeParse returns exactly success/data or success/error", () => {
  const good = Schema.safeParse({ user: { name: "a", tags: [] }, count: 1 });
  assert.deepStrictEqual(Object.keys(good).sort(), ["data", "success"]);
  assert.equal(good.success, true);
  const bad = s.number().safeParse("x");
  assert.deepStrictEqual(Object.keys(bad).sort(), ["error", "success"]);
  assert.equal(bad.success, false);
  if (!bad.success) {
    assert.ok(bad.error instanceof ValidationError);
    assert.equal(bad.error.issues.length, 1);
    assert.deepStrictEqual(Object.keys(bad.error.issues[0]!).sort(), ["message", "path"]);
    assert.deepStrictEqual([...bad.error.issues[0]!.path], []);
  }
  assert.doesNotThrow(() => s.string().safeParse(Symbol("x")));
});

test("ERRORS: parsing does not mutate the input and returns new containers", () => {
  const input = { user: { name: "Ada", tags: [{ name: "x", extra: 1 }] }, count: 2, more: true };
  const snapshot = structuredClone(input);
  const out = Schema.parse(input);
  assert.deepStrictEqual(input, snapshot);
  assert.deepStrictEqual(out, { user: { name: "Ada", tags: [{ name: "x" }] }, count: 2 });
  assert.notEqual(out.user, input.user);
  assert.notEqual(out.user.tags, input.user.tags);
});
