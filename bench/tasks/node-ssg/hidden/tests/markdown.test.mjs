import { test, before } from "node:test";
import assert from "node:assert/strict";
import { build, fixture, norm, postBody, read } from "./helpers.mjs";

let out;
before(() => {
  const r = build(fixture("markdown"));
  assert.equal(r.code, 0, r.stderr);
  out = r.out;
});

const body = (slug) => postBody(read(out, `posts/${slug}/index.html`));
const expectBody = (slug, expected) => assert.equal(body(slug), norm(expected));

test("MD-HEADING: levels 1-6, inline in headings, no space or 7 hashes is a paragraph", () => {
  expectBody("headings", "<h1>One</h1><h2>Two <em>em</em></h2><h6>Six</h6><p>####### Seven #NoSpace</p>");
});

test("MD-PARAGRAPH: lines trimmed and joined, interrupted by headings and list items", () => {
  expectBody("paragraphs",
    "<p>First line second line</p><p>Another paragraph.</p><h1>Heading interrupts</h1><p>after heading</p><ul><li>item interrupts</li></ul>",
  );
});

test("MD-INLINE: strong, emphasis, links and code spans", () => {
  expectBody("inline",
    "<p>This is <strong>strong</strong> and <em>em</em> and <strong>bold <em>mixed</em> text</strong> end. " +
      'A <a href="https://example.com/a?x=1&amp;y=2">link <em>here</em></a> and <code>code *not em* [x](y)</code> done.</p>',
  );
});

test("MD-ESCAPE: raw HTML and quotes in text are escaped", () => {
  expectBody("escaping",
    "<p>Raw &lt;b&gt;html&lt;/b&gt; &amp; &quot;quotes&quot; &#39;single&#39; stay escaped &lt;script&gt;alert(1)&lt;/script&gt;</p>",
  );
});

test("MD-CODE: fenced block keeps whitespace exactly and escapes HTML", () => {
  const raw = read(out, "posts/code/index.html");
  assert.ok(
    raw.includes(
      '<pre><code class="language-js">if (a &lt; b &amp;&amp; c &gt; &quot;d&quot;) {\n    return &#39;{{ title }}&#39;;\n}</code></pre>',
    ),
    raw,
  );
  assert.ok(raw.includes("<pre><code>plain   spaced</code></pre>"), raw);
});

test("MD-CODE: blocks around code are rendered normally", () => {
  const b = body("code");
  assert.ok(b.startsWith(norm("<p>Before.</p><pre>")), b);
  assert.ok(b.includes(norm("</pre><p>After <em>x</em>.</p><pre>")), b);
});

test("MD-CODE: unclosed fence runs to end of body", () => {
  const raw = read(out, "posts/unclosed/index.html");
  assert.match(raw, /<pre><code># not a heading\n- not a list\n?<\/code><\/pre>/);
});

test("MD-LIST: unordered and ordered lists, type switch starts a new list", () => {
  expectBody("lists",
    "<ul><li>one</li><li>two <strong>b</strong></li></ul><ol><li>first</li><li>tenth</li></ol><ul><li>back</li></ul><p>plain text</p>",
  );
});

test("MD-CRLF: CRLF bodies render like LF", () => {
  expectBody("crlf", "<h1>Title</h1><p>line one line two</p><ul><li>a</li><li>b</li></ul>");
});
