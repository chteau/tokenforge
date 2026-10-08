import { test } from "node:test";
import assert from "node:assert/strict";
import { LAYOUT, build, makeSite, norm, post, read } from "./helpers.mjs";

function siteWith(name, content) {
  return makeSite({ "layouts/base.html": LAYOUT, [`content/${name}`]: content, "content/ok.md": post("OK", "2024-01-01") });
}

function expectContentError(name, content) {
  const r = build(siteWith(name, content));
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}; stderr: ${r.stderr}`);
  assert.ok(r.stderr.includes(name), `stderr should name ${name}: ${r.stderr}`);
}

test("FM-PARSE: quotes stripped, colons kept in values, blank lines allowed", () => {
  const r = build(siteWith("q.md", `---\ntitle: "Colons: here"\n\ndate: '2024-02-29'\ndraft: false\n---\nx\n`));
  assert.equal(r.code, 0, r.stderr);
  assert.ok(norm(read(r.out, "posts/q/index.html")).includes("<h1>Colons: here</h1>"));
  assert.ok(norm(read(r.out, "posts/q/index.html")).includes('<time datetime="2024-02-29">2024-02-29</time>'));
});

test("FM-PARSE: tag list items trimmed, empty items dropped", () => {
  const r = build(siteWith("t.md", post("T", "2024-01-02", "tags: [ alpha ,beta,, Gamma Ray ]\n")));
  assert.equal(r.code, 0, r.stderr);
  const html = norm(read(r.out, "posts/t/index.html"));
  assert.ok(
    html.includes('<ul class="tags"><li><a href="/tags/alpha/">alpha</a></li><li><a href="/tags/beta/">beta</a></li><li><a href="/tags/gamma-ray/">Gamma Ray</a></li></ul>'),
    html,
  );
});

test("FM-PARSE: CRLF front matter is accepted", () => {
  const r = build(siteWith("c.md", "---\r\ntitle: Win\r\ndate: 2024-01-03\r\n---\r\nhi\r\n"));
  assert.equal(r.code, 0, r.stderr);
  assert.ok(norm(read(r.out, "posts/c/index.html")).includes("<h1>Win</h1>"));
});

test("FM-ERROR: missing opening or closing delimiter", () => {
  expectContentError("open.md", "title: X\ndate: 2024-01-01\n---\nbody\n");
  expectContentError("close.md", "---\ntitle: X\ndate: 2024-01-01\nbody\n");
});

test("FM-ERROR: line without colon, unknown key, duplicate key", () => {
  expectContentError("nocolon.md", "---\ntitle: X\ndate: 2024-01-01\njust words\n---\n");
  expectContentError("unknown.md", "---\ntitle: X\ndate: 2024-01-01\nauthor: Me\n---\n");
  expectContentError("dup.md", "---\ntitle: X\ntitle: Y\ndate: 2024-01-01\n---\n");
});

test("FM-ERROR: missing or empty title", () => {
  expectContentError("notitle.md", "---\ndate: 2024-01-01\n---\n");
  expectContentError("emptytitle.md", '---\ntitle: ""\ndate: 2024-01-01\n---\n');
});

test("FM-ERROR: missing or invalid date", () => {
  expectContentError("nodate.md", "---\ntitle: X\n---\n");
  expectContentError("baddate.md", "---\ntitle: X\ndate: 2024-02-30\n---\n");
  expectContentError("fmtdate.md", "---\ntitle: X\ndate: 2024-1-5\n---\n");
});

test("FM-ERROR: invalid tags or draft values", () => {
  expectContentError("tags.md", "---\ntitle: X\ndate: 2024-01-01\ntags: a, b\n---\n");
  expectContentError("draft.md", "---\ntitle: X\ndate: 2024-01-01\ndraft: yes\n---\n");
});

test("FM-ERROR: drafts are validated too", () => {
  expectContentError("baddraft.md", "---\ntitle: X\ndate: 2024-13-01\ndraft: true\n---\n");
});

test("FM-ERROR: invalid site.json exits 1 naming site.json", () => {
  const site = makeSite({ "layouts/base.html": LAYOUT, "site.json": "{title: nope", "content/a.md": post("A", "2024-01-01") });
  const r = build(site);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("site.json"), r.stderr);
  const arr = makeSite({ "layouts/base.html": LAYOUT, "site.json": "[1, 2]" });
  assert.equal(build(arr).code, 1);
});
