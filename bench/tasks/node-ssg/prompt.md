# Build `ssg`: a small static site generator

This repository is empty apart from a README. Build **`ssg`**, a command-line static site generator for Node.js that turns a folder of Markdown posts into a static HTML blog.

## Ground rules

- Plain Node.js (version 26). Write JavaScript (ES modules) or TypeScript that runs directly under Node's native type stripping (erasable syntax only: no enums, namespaces or parameter properties; no build step).
- **No npm dependencies at all** (no `dependencies` in `package.json`, no `node_modules`), only Node built-in modules. Do not shell out to other programs.
- The entry point is **`bin/ssg.mjs`**, run as `node bin/ssg.mjs ...`. Organise the rest of the code as you see fit, but keep it reasonably modular: the Markdown renderer and front-matter parser should be pure functions, separate from the code that reads and writes files.
- Add automated tests using the built-in test runner (`node:test`); they must pass with `node --test`.
- The output must be deterministic: running the same build twice gives byte-identical files.

## Command line

```
node bin/ssg.mjs build <src> <out> [--drafts]
node bin/ssg.mjs --help
```

- `--help` (anywhere in the arguments) prints a usage text to stdout and exits 0.
- `build` reads the site in directory `<src>` and writes the generated site into `<out>` (created if needed, including parents; it is always a fresh, empty directory in the checks). On success the exit code is 0. `--drafts` may appear anywhere after `build`.

Exit codes (error messages go to stderr; stdout content on error does not matter):

| code | situation |
|------|-----------|
| 0 | success (or `--help`) |
| 1 | content error: invalid front matter, duplicate slug, invalid `site.json`. The message must contain the file name of the offending file (e.g. `hello.md`, `site.json`). |
| 2 | usage error: no arguments, unknown command or option, missing `<src>`/`<out>`, extra arguments, `<src>` is not an existing directory |
| 3 | the layout file `<src>/layouts/base.html` is missing. The message must contain the word `layout`. |

## Site layout (input)

```
<src>/
  site.json            optional: {"title": "My Blog", "url": "https://example.com"}
  layouts/base.html    required: the page template
  content/*.md         the posts (top level of content/ only)
  static/**            optional: copied as-is
```

- `site.json`: `title` defaults to `Untitled Site`, `url` defaults to `""`. A trailing `/` on `url` is removed. If the file exists but is not valid JSON or is not a JSON object, it is a content error (exit 1).
- Only files directly inside `content/` whose name ends in `.md` are posts. Subdirectories and other files there are ignored. A missing `content/` directory means the site has no posts.

## Front matter

Every post must start with a front-matter block: the very first line is exactly `---`, and the block ends at the next line that is exactly `---` (trailing spaces and `\r` are ignored on these lines; files may use CRLF line endings). Everything after the closing line is the Markdown body.

Inside the block each non-blank line has the form `key: value` (split at the first `:`; key and value are trimmed). Supported keys:

| key | required | rules |
|-----|----------|-------|
| `title` | yes | any non-empty string |
| `date` | yes | `YYYY-MM-DD`, must be a real calendar date (`2024-02-30` is invalid) |
| `tags` | no | inline list `[a, b, c]`: items split on `,` and trimmed, empty items dropped; `[]` is an empty list. Default: no tags. |
| `draft` | no | `true` or `false`. Default `false`. |

A value wrapped in a matching pair of double or single quotes has the quotes removed (`title: "Colons: allowed"` gives `Colons: allowed`). Quotes are not processed inside tag lists.

Each of these is a content error (exit 1, message contains the file name): no opening `---` on the first line, no closing `---`, a non-blank line without `:`, an unknown key, a key given twice, missing or empty `title`, missing or invalid `date`, `tags` not of the form `[...]`, `draft` not `true`/`false`.

## Slugs and URLs

- `slugify(s)`: lower-case; replace every run of characters other than `a-z` and `0-9` by a single `-`; remove leading and trailing `-`.
- Post slug: the file name without `.md`, with a leading `YYYY-MM-DD-` prefix removed if present, then slugified. `2024-03-01-Hello World!.md` → `hello-world`. Two posts with the same slug are a content error (exit 1; the message names one of the files).
- Tag slug: `slugify(tag)`. Tags whose slugs are equal are the same tag.

Output files (all URLs below are root-relative and end with `/`):

| page | file | URL |
|------|------|-----|
| post | `<out>/posts/<slug>/index.html` | `/posts/<slug>/` |
| index | `<out>/index.html` | `/` |
| tag | `<out>/tags/<tag-slug>/index.html` | `/tags/<tag-slug>/` |
| feed | `<out>/feed.xml` | |

Everything under `<src>/static/` is copied byte-for-byte into `<out>/` keeping relative paths (`static/css/site.css` → `<out>/css/site.css`).

## Drafts and ordering

- Posts with `draft: true` are left out completely (no post page, not on the index, tag pages or feed, and their tags produce no tag page) unless `--drafts` is given, in which case they are treated exactly like normal posts. Front matter of drafts is still validated.
- "Sorted order" everywhere means: date descending (newest first), ties broken by slug ascending.

## Escaping

`escape(s)` replaces `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`, `"` → `&quot;`, `'` → `&#39;` (`&` first). All text that comes from posts, tags or `site.json` is escaped wherever it is written into HTML or XML, unless stated otherwise.

## Markdown subset

The body is processed line by line (after converting CRLF to LF). Blocks:

1. **Fenced code block**: a line starting with three backticks opens it; the rest of that line, trimmed, is the optional language. It ends at the next line that is exactly three backticks (trailing whitespace ignored), or at the end of the body. Output: `<pre><code>` (or `<pre><code class="language-LANG">` when a language is given) + the escaped content lines joined with `\n` + `</code></pre>`. No other processing happens inside; whitespace is kept exactly.
2. **Heading**: 1 to 6 `#` followed by a space, then the text → `<hN>INLINE</hN>` (text trimmed). `#tag` without a space is not a heading.
3. **Unordered list**: consecutive lines starting with `- ` or `* `. Each line is an item: `<ul><li>INLINE</li>...</ul>`.
4. **Ordered list**: consecutive lines matching digits + `. ` (e.g. `1. `, `10. `) → `<ol><li>INLINE</li>...</ol>`. A list ends at the first line that is not an item of the same type (a line of the other list type starts a new list; any other non-blank line starts a paragraph). No nesting.
5. **Blank lines** (empty or whitespace only) separate blocks and produce nothing.
6. **Paragraph**: any other run of consecutive lines; it ends at a blank line or at a line that starts a code block, heading or list item. Lines are trimmed and joined with a single space: `<p>INLINE</p>`.

INLINE processing of a piece of text, in this order:

1. Escape the text with `escape()` (so raw HTML in Markdown is never passed through).
2. Code spans: `` `x` `` → `<code>x</code>`; their content gets no further inline processing.
3. Links: `[text](url)` → `<a href="url">text</a>`. `text` has no `]`, `url` has no spaces and no `)`. The link text still gets emphasis processing.
4. Strong: `**x**` → `<strong>x</strong>` (shortest match, at least one character).
5. Emphasis: `*x*` → `<em>x</em>` (shortest match, at least one character).

Blocks are joined with `\n`.

## Layout template

`layouts/base.html` is a text template. Placeholders have the form `{{ name }}` with optional whitespace inside the braces (`{{title}}` works too). Known names:

- `title` — the escaped page title (see below)
- `site_title` — the escaped site title
- `content` — the page's HTML (inserted as-is)

Unknown names are replaced with the empty string. Substitution is a single pass over the template: text inserted for a placeholder is never scanned for placeholders again (a post that shows `{{ title }}` in a code block must keep it).

## Pages

The tables below give each page's title and its `content` HTML. Whitespace around tags is not significant: the checks collapse whitespace runs to one space and remove whitespace directly before or after a tag (except that `<pre>` blocks are compared exactly). Lists of posts use this item markup, in sorted order:

```html
<li><a href="/posts/SLUG/">TITLE</a> <time datetime="DATE">DATE</time></li>
```

**Post page** — title: the post title.

```html
<article>
<h1>TITLE</h1>
<p class="meta"><time datetime="DATE">DATE</time></p>
<ul class="tags"><li><a href="/tags/TAG-SLUG/">TAG</a></li> ...</ul>
BODY
</article>
```

The `<ul class="tags">` element lists the post's tags in front-matter order (duplicates by slug removed, first one kept) and is omitted entirely when the post has no tags. BODY is the rendered Markdown.

**Index page** — title: the site title.

```html
<h1>SITE TITLE</h1>
<ul class="posts">ITEMS</ul>
```

With no posts, the list is `<ul class="posts"></ul>`.

**Tag page** (one per tag used by at least one included post) — title: `Tag: NAME`.

```html
<h1>Tag: NAME</h1>
<ul class="posts">ITEMS</ul>
```

ITEMS are the included posts having that tag. NAME is the tag exactly as written in the first post (in sorted order) that has it.

## Feed

`<out>/feed.xml` is an Atom feed with the 10 newest included posts (sorted order). Using `URL` = the site url without trailing slash and `TITLE`s escaped:

```xml
<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>SITE TITLE</title>
<link href="URL/"/>
<id>URL/</id>
<updated>NEWEST-DATET00:00:00Z</updated>
<entry>
<title>POST TITLE</title>
<link href="URL/posts/SLUG/"/>
<id>URL/posts/SLUG/</id>
<updated>DATET00:00:00Z</updated>
</entry>
</feed>
```

The first line must be exactly the XML declaration shown. `NEWEST-DATE` is the date of the first entry, or `1970-01-01` when there are no posts. The same whitespace rule as for HTML applies.
