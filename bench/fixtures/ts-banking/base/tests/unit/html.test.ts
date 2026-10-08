import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { escapeHtml, html, queryString, raw } from "../../apps/web/html.ts";

describe("html templating", () => {
  it("escapes interpolated values", () => {
    const name = `<script>alert("x")</script>`;
    assert.equal(html`<p>${name}</p>`.value, "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>");
  });

  it("does not double-escape nested templates or raw values", () => {
    const inner = html`<b>${"a & b"}</b>`;
    assert.equal(html`<div>${inner}${raw("<hr>")}</div>`.value, "<div><b>a &amp; b</b><hr></div>");
  });

  it("renders arrays and skips empty values", () => {
    assert.equal(html`<ul>${["a", "b"].map((x) => html`<li>${x}</li>`)}${null}${false}</ul>`.value, "<ul><li>a</li><li>b</li></ul>");
  });

  it("escapes quotes for attributes", () => {
    assert.equal(escapeHtml(`"'`), "&quot;&#39;");
  });

  it("builds query strings from non-empty values", () => {
    assert.equal(queryString({ a: "1", b: "", c: undefined, d: 0 }), "?a=1&d=0");
    assert.equal(queryString({}), "");
  });
});
