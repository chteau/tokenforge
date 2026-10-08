import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LAYOUT, build, fixture, item, makeSite, norm, post, read } from "./helpers.mjs";

let out; // default build of the blog fixture
let draftsOut; // build with --drafts
before(() => {
  const r = build(fixture("blog"));
  assert.equal(r.code, 0, r.stderr);
  out = r.out;
  const d = build(fixture("blog"), ["--drafts"]);
  assert.equal(d.code, 0, d.stderr);
  draftsOut = d.out;
});

const SECOND = item("second", "Colons: allowed &amp; &lt;ok&gt;", "2024-05-10");
const HELLO = item("hello-world", "Hello, World", "2024-03-01");
const A = item("a-post", "A post", "2024-01-15");
const B = item("b-post", "B post", "2024-01-15");
const NOTAGS = item("no-tags", "Don&#39;t Panic", "2023-12-31");
const SECRET = item("secret-plans", "Secret Plans", "2024-06-01");

test("SLUG: post paths from file names (date prefix removed, punctuation collapsed)", () => {
  assert.deepEqual(readdirSync(join(out, "posts")).sort(), ["a-post", "b-post", "hello-world", "no-tags", "second"]);
  for (const s of ["a-post", "b-post", "hello-world", "no-tags", "second"]) {
    assert.ok(existsSync(join(out, "posts", s, "index.html")), s);
  }
});

test("SLUG: slugify rules on odd file names", () => {
  const site = makeSite({
    "layouts/base.html": LAYOUT,
    "content/--Weird__Name  2.0--.md": post("W", "2024-01-01"),
    "content/2020-01-01-2021-02-02-x.md": post("X", "2024-01-02"),
  });
  const r = build(site);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(join(r.out, "posts", "weird-name-2-0", "index.html")));
  assert.ok(existsSync(join(r.out, "posts", "2021-02-02-x", "index.html")));
});

test("SLUG: duplicate slugs are a content error", () => {
  const site = makeSite({
    "layouts/base.html": LAYOUT,
    "content/Hello.md": post("A", "2024-01-01"),
    "content/2024-01-02-hello.md": post("B", "2024-01-02"),
  });
  const r = build(site);
  assert.equal(r.code, 1);
  assert.ok(r.stderr.includes("hello.md") || r.stderr.includes("Hello.md"), r.stderr);
});

test("SLUG: non-.md files and subdirectories of content are ignored", () => {
  assert.equal(existsSync(join(out, "posts", "notes")), false);
  assert.equal(existsSync(join(out, "posts", "nested")), false);
});

test("POST: full post page content with tags", () => {
  const html = norm(read(out, "posts/hello-world/index.html"));
  assert.ok(
    html.includes(norm(
      '<main><article><h1>Hello, World</h1><p class="meta"><time datetime="2024-03-01">2024-03-01</time></p>' +
        '<ul class="tags"><li><a href="/tags/javascript/">JavaScript</a></li><li><a href="/tags/web-dev/">Web Dev</a></li></ul>' +
        "<p>First post on this <em>new</em> blog. It has two lines.</p><p>Second paragraph.</p></article></main>",
    )),
    html,
  );
});

test("POST: duplicate tags removed, escaped title", () => {
  const html = norm(read(out, "posts/second/index.html"));
  assert.ok(
    html.includes(norm(
      '<article><h1>Colons: allowed &amp; &lt;ok&gt;</h1><p class="meta"><time datetime="2024-05-10">2024-05-10</time></p>' +
        '<ul class="tags"><li><a href="/tags/javascript/">javascript</a></li><li><a href="/tags/notes/">notes</a></li></ul><h1>Second</h1></article>',
    )),
    html,
  );
});

test("POST: no tags list when a post has no tags", () => {
  for (const s of ["no-tags", "a-post"]) {
    const html = norm(read(out, `posts/${s}/index.html`));
    assert.ok(!html.includes('class="tags"'), html);
  }
  assert.ok(norm(read(out, "posts/no-tags/index.html")).includes("<h1>Don&#39;t Panic</h1>"));
});

test("LAYOUT: placeholders with any inner whitespace, unknown ones become empty", () => {
  const html = norm(read(out, "posts/hello-world/index.html"));
  assert.ok(html.includes("<title>Hello, World | Notes &amp; Thoughts</title>"), html);
  assert.ok(html.includes("<header>Notes &amp; Thoughts</header>"), html);
  assert.ok(html.includes("<footer>[]</footer>"), html);
  assert.ok(!html.includes("{{"), html);
});

test("LAYOUT: page titles for index and tag pages", () => {
  assert.ok(norm(read(out, "index.html")).includes("<title>Notes &amp; Thoughts | Notes &amp; Thoughts</title>"));
  assert.ok(norm(read(out, "tags/web-dev/index.html")).includes("<title>Tag: Web Dev | Notes &amp; Thoughts</title>"));
});

test("LAYOUT: substitution is single pass", () => {
  const site = makeSite({
    "layouts/base.html": "<title>{{title}}</title>{{ content }}",
    "content/t.md": post("{{ site_title }}", "2024-01-01", "", "Use `{{ title }}` here.\n"),
  });
  const r = build(site);
  assert.equal(r.code, 0, r.stderr);
  const html = norm(read(r.out, "posts/t/index.html"));
  assert.ok(html.includes("<title>{{ site_title }}</title>"), html);
  assert.ok(html.includes("<code>{{ title }}</code>"), html);
});

test("LAYOUT: default site title without site.json", () => {
  const site = makeSite({ "layouts/base.html": "{{site_title}}|{{title}}|{{content}}" });
  const r = build(site);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(norm(read(r.out, "index.html")), norm('Untitled Site|Untitled Site|<h1>Untitled Site</h1><ul class="posts"></ul>'));
});

test("INDEX: posts sorted by date desc then slug, drafts excluded", () => {
  const html = norm(read(out, "index.html"));
  assert.ok(html.includes(norm(`<main><h1>Notes &amp; Thoughts</h1><ul class="posts">${SECOND}${HELLO}${A}${B}${NOTAGS}</ul></main>`)), html);
});

test("INDEX: empty site has an empty list", () => {
  const site = makeSite({ "layouts/base.html": "{{ content }}", "site.json": '{"title": "Empty"}' });
  const r = build(site);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(norm(read(r.out, "index.html")), '<h1>Empty</h1><ul class="posts"></ul>');
});

test("TAGS: one page per tag slug, drafts' tags excluded", () => {
  assert.deepEqual(readdirSync(join(out, "tags")).sort(), ["javascript", "notes", "web-dev"]);
});

test("TAGS: tag page lists posts in sorted order, name from first post", () => {
  const js = norm(read(out, "tags/javascript/index.html"));
  assert.ok(js.includes(norm(`<main><h1>Tag: javascript</h1><ul class="posts">${SECOND}${HELLO}</ul></main>`)), js);
  const notes = norm(read(out, "tags/notes/index.html"));
  assert.ok(notes.includes(norm(`<h1>Tag: notes</h1><ul class="posts">${SECOND}${B}</ul>`)), notes);
  const web = norm(read(out, "tags/web-dev/index.html"));
  assert.ok(web.includes(norm(`<h1>Tag: Web Dev</h1><ul class="posts">${HELLO}</ul>`)), web);
});

const FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Notes &amp; Thoughts</title>
<link href="https://blog.example.com/"/>
<id>https://blog.example.com/</id>
<updated>2024-05-10T00:00:00Z</updated>
${[
  ["second", "Colons: allowed &amp; &lt;ok&gt;", "2024-05-10"],
  ["hello-world", "Hello, World", "2024-03-01"],
  ["a-post", "A post", "2024-01-15"],
  ["b-post", "B post", "2024-01-15"],
  ["no-tags", "Don&#39;t Panic", "2023-12-31"],
]
  .map(
    ([s, t, d]) =>
      `<entry><title>${t}</title><link href="https://blog.example.com/posts/${s}/"/><id>https://blog.example.com/posts/${s}/</id><updated>${d}T00:00:00Z</updated></entry>`,
  )
  .join("\n")}
</feed>`;

test("FEED: feed.xml matches the specified Atom document", () => {
  const xml = read(out, "feed.xml");
  assert.ok(xml, "feed.xml missing");
  assert.equal(xml.split(/\r?\n/)[0], '<?xml version="1.0" encoding="utf-8"?>');
  assert.equal(norm(xml), norm(FEED));
});

test("FEED: at most 10 newest entries", () => {
  const files = { "layouts/base.html": LAYOUT, "site.json": '{"title": "Many", "url": "http://x.test"}' };
  for (let i = 1; i <= 12; i++) files[`content/p${i}.md`] = post(`P${i}`, `2024-01-${String(i).padStart(2, "0")}`);
  const r = build(makeSite(files));
  assert.equal(r.code, 0, r.stderr);
  const xml = norm(read(r.out, "feed.xml"));
  const ids = [...xml.matchAll(/<entry><title>(P\d+)<\/title>/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["P12", "P11", "P10", "P9", "P8", "P7", "P6", "P5", "P4", "P3"]);
  assert.ok(xml.includes('<link href="http://x.test/posts/p12/"/>'), xml);
  assert.ok(xml.includes("<updated>2024-01-12T00:00:00Z</updated><entry>"), xml);
});

test("FEED: empty site uses epoch and default url", () => {
  const r = build(makeSite({ "layouts/base.html": LAYOUT }));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(
    norm(read(r.out, "feed.xml")),
    norm(
      '<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Untitled Site</title><link href="/"/><id>/</id><updated>1970-01-01T00:00:00Z</updated></feed>',
    ),
  );
});

test("STATIC: static files copied byte-for-byte keeping paths", () => {
  for (const rel of ["css/site.css", "robots.txt", "img/dot.png"]) {
    const a = readFileSync(join(fixture("blog"), "static", rel));
    assert.ok(existsSync(join(out, rel)), rel);
    assert.ok(a.equals(readFileSync(join(out, rel))), rel);
  }
});

test("STATIC: site without static dir still builds", () => {
  const r = build(makeSite({ "layouts/base.html": LAYOUT, "content/a.md": post("A", "2024-01-01") }));
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(join(r.out, "posts", "a", "index.html")));
});

test("DRAFTS: drafts excluded everywhere by default", () => {
  assert.equal(existsSync(join(out, "posts", "secret-plans")), false);
  assert.ok(!read(out, "index.html").includes("Secret Plans"));
  assert.ok(!read(out, "feed.xml").includes("Secret Plans"));
  assert.ok(!read(out, "tags/notes/index.html").includes("Secret Plans"));
});

test("DRAFTS: --drafts includes drafts like normal posts", () => {
  assert.ok(existsSync(join(draftsOut, "posts", "secret-plans", "index.html")));
  assert.ok(norm(read(draftsOut, "index.html")).includes(norm(`<ul class="posts">${SECRET}${SECOND}${HELLO}`)));
  assert.ok(norm(read(draftsOut, "tags/secret/index.html")).includes(norm(`<h1>Tag: secret</h1><ul class="posts">${SECRET}</ul>`)));
  assert.ok(norm(read(draftsOut, "tags/notes/index.html")).includes(norm(`<ul class="posts">${SECRET}${SECOND}${B}</ul>`)));
  const xml = norm(read(draftsOut, "feed.xml"));
  assert.ok(xml.includes(norm("<updated>2024-06-01T00:00:00Z</updated><entry><title>Secret Plans</title>")), xml);
});

test("DETERMINISM: two builds produce identical files", () => {
  const again = build(fixture("blog"));
  assert.equal(again.code, 0, again.stderr);
  for (const rel of ["index.html", "feed.xml", "posts/second/index.html", "tags/notes/index.html"]) {
    assert.equal(read(again.out, rel), read(out, rel), rel);
  }
});
