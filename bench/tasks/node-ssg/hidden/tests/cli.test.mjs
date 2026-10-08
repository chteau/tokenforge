import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LAYOUT, build, fixture, makeSite, post, run, tmp } from "./helpers.mjs";

test("CLI: --help prints usage and exits 0", () => {
  const r = run(["--help"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /build/);
  const r2 = run(["build", "--help"]);
  assert.equal(r2.code, 0, r2.stderr);
});

test("CLI: successful build exits 0 and creates nested out dir", () => {
  const out = join(tmp(), "a", "b", "out");
  const r = run(["build", fixture("blog"), out]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(join(out, "index.html")));
});

test("CLI: no arguments is a usage error (2)", () => {
  assert.equal(run([]).code, 2);
});

test("CLI: unknown command is a usage error (2)", () => {
  assert.equal(run(["serve", fixture("blog"), join(tmp(), "o")]).code, 2);
});

test("CLI: missing out argument and extra arguments are usage errors (2)", () => {
  assert.equal(run(["build", fixture("blog")]).code, 2);
  assert.equal(run(["build", fixture("blog"), join(tmp(), "o"), join(tmp(), "p")]).code, 2);
});

test("CLI: unknown option is a usage error (2)", () => {
  assert.equal(run(["build", fixture("blog"), join(tmp(), "o"), "--fast"]).code, 2);
});

test("CLI: src that is not a directory is a usage error (2)", () => {
  assert.equal(run(["build", join(tmp(), "does-not-exist"), join(tmp(), "o")]).code, 2);
  const site = makeSite({ "file.txt": "x" });
  assert.equal(run(["build", join(site, "file.txt"), join(tmp(), "o")]).code, 2);
});

test("CLI: missing layout exits 3 and mentions layout", () => {
  const site = makeSite({ "content/a.md": post("A", "2024-01-01") });
  const r = build(site);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /layout/i);
});

test("CLI: --drafts may come before src", () => {
  const site = makeSite({ "layouts/base.html": LAYOUT, "content/d.md": post("D", "2024-01-01", "draft: true\n") });
  const out = join(tmp(), "out");
  const r = run(["build", "--drafts", site, out]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(join(out, "posts", "d", "index.html")));
});
