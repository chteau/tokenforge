# New tool: `mdc`

Build **`mdc`**, a command-line converter from a defined subset of Markdown to an HTML fragment, written in Kotlin. It can also add a table of contents and extract YAML-like front matter as JSON. The repository is empty apart from a README; create the project from scratch.

## Constraints

- **Kotlin (JVM)**, Kotlin standard library and the JDK only. No Gradle, Maven or third-party libraries; nothing is downloaded.
- Main sources live under `src/main/kotlin/`, tests under `src/test/kotlin/`. From the repository root these commands must succeed (kotlinc 2.4) and be free of compiler warnings:

  ```
  kotlinc src/main/kotlin -include-runtime -d build/mdc.jar
  java -jar build/mdc.jar --help
  ```

  so `src/main/kotlin` must contain exactly one `main` function.
- Split the code into several files in a package (for example front matter, block parser, inline renderer, table of contents, command line). Conversion is a pure function from text to text: only the command-line entry point reads files, prints or exits.
- Write your own tests: `src/test/kotlin/TestMain.kt` with a top-level `fun main()` (no package) that runs them, prints a summary and exits non-zero if any fails. No test framework is available, so a tiny assertion harness is fine. Tests may only use public declarations. They must pass with:

  ```
  kotlinc src/test/kotlin -cp build/mdc.jar -d build/test-classes
  java -cp build/mdc.jar:build/test-classes TestMainKt
  ```
- Update the README with build, test and usage instructions.

## Command line

```
mdc [--toc] [--toc-depth <n>] [--front-matter] [-o <file>] [<input>]
mdc --help
```

- Reads `<input>` (UTF-8), or stdin when it is omitted or `-`. Writes UTF-8 to stdout, or to `<file>` with `-o` (then stdout stays empty).
- `--help`/`-h` prints a usage text starting with `usage: mdc` to stdout, exit 0.
- `--toc` adds a table of contents; `--toc-depth <n>` (an integer 1–6, default 3) limits it to headings of level ≤ n.
- `--front-matter` prints only the front matter as JSON (below) instead of HTML.
- Options may come in any order, before or after `<input>`.
- Exit codes: 0 success; 1 the input or output file cannot be read/written (`error: cannot read <path>` / `error: cannot write <path>`); 2 usage error (unknown option, missing or invalid option value, more than one input); 3 invalid front matter. Errors go to stderr, start with `error: `, and nothing goes to stdout.

## Input and output

Line endings `\r\n` are treated as `\n`. HTML output puts every block on its own line(s) as shown below, with nothing between blocks; the output ends with exactly one `\n` (empty input gives empty output). Wherever text is written to HTML (text, code, attribute values), `&`, `<`, `>` and `"` become `&amp;`, `&lt;`, `&gt;`, `&quot;`. Raw HTML is not supported: it is escaped.

## Front matter

If the first line is exactly `---`, everything up to the next line that is exactly `---` is front matter and is not part of the document. No closing line: exit 3 with `error: unterminated front matter`. Inside, blank lines and lines starting with `#` are skipped; every other line must be `key: value` where the key matches `[A-Za-z_][A-Za-z0-9_-]*` and is followed directly by `:` (then optional spaces); otherwise exit 3 with `error: front matter line <n>: invalid line` (`<n>` = 1-based line number in the file). A repeated key is `error: front matter line <n>: duplicate key <key>` (exit 3). The value (trimmed) is typed: empty → `null`; `true`/`false` → boolean; `-?[0-9]+` → number; `"..."` → the string between the quotes; `[a, b]` → array of strings (items split on `,` and trimmed; `[]` is empty); anything else → string.

`--front-matter` prints one line: a JSON object with keys in file order, formatted like `{"title": "Hello", "draft": false, "tags": ["a", "b"], "n": 3, "x": null}` (`": "` and `", "` separators, `{}` when there is no front matter). Strings escape `"` and `\` with a backslash, `\n` `\r` `\t` as such, other characters below U+0020 as `\u00XX` (lowercase hex); everything else is written as-is.

## Blocks

Block markers are recognised at the start of a line (no indentation), except list items.

- **Heading**: 1–6 `#`, a space, text → `<h2 id="slug">text</h2>`. Text is trimmed and inline-formatted. `#x` or 7 `#` is a paragraph.
- **Thematic break**: a line of 3 or more `-`, or of `*`, or of `_` (nothing else) → `<hr>`.
- **Fenced code**: a line starting with three backticks; the rest of the line, trimmed, is the info string and its first word the language. It ends at a line that is exactly three backticks (or the end of input). Content lines are copied verbatim (escaped, no inline formatting): ``<pre><code class="language-kotlin">`` + each line followed by `\n` + `</code></pre>`. Without a language: `<pre><code>`.
- **Blockquote**: consecutive lines starting with `>`; remove the `>` and one following space if present, then parse those lines as blocks recursively → `<blockquote>`, the inner blocks, `</blockquote>`, each on its own line.
- **List item**: optional leading spaces, then `-`, `*` or `+` (unordered) or 1–9 digits and `.` (ordered), then at least one space, then the item text (inline-formatted). Depth = leading spaces / 2 (integer division), capped at the previous item's depth + 1; the first item of a list has depth 0. A deeper item opens a nested list inside the previous item. At the same depth, switching between ordered and unordered closes the list and opens a new one. An ordered list whose first number is not 1 gets `start`: `<ol start="3">`. Blank lines between items are ignored; any other line ends the list. Format:

  ```
  <ul>
  <li>one</li>
  <li>two
  <ol>
  <li>sub</li>
  </ol>
  </li>
  </ul>
  ```
- **Table**: a line containing `|` followed by a delimiter line whose cells are `-+` with optional `:` on either side, with the same number of cells. Cells: strip one leading and one trailing `|`, split on `|` (but `\|` is a literal `|`), trim. The table continues with following lines that contain `|`. Body rows are padded with empty cells or truncated to the header's cell count. Alignment `:--` left, `--:` right, `:-:` center adds `align="..."` to every cell of that column. Format (omit `<tbody>` lines when there are no body rows):

  ```
  <table>
  <thead>
  <tr><th>Name</th><th align="right">Qty</th></tr>
  </thead>
  <tbody>
  <tr><td>Apple</td><td align="right">3</td></tr>
  </tbody>
  </table>
  ```
- **Paragraph**: consecutive lines that do not start any other block (all of the above interrupt a paragraph; a table starts when the current and next line form one). Each line is trimmed; lines are joined with `\n` → `<p>line one\nline two</p>`.

## Inline formatting

Scanned left to right:

- `\` before one of ``\ ` * _ [ ] ( ) # + - . ! | > `` gives that character literally; any other `\` is literal.
- **Code span**: a run of N backticks up to the next run of exactly N backticks; the content is verbatim (escaped) → `<code>…</code>`. No closing run: the backticks are literal.
- **Image** `![alt](url)` → `<img src="url" alt="alt">`; **link** `[text](url)` → `<a href="url">text</a>`. The url has no spaces; an optional title follows after a space: `[t](u "Title")` adds ` title="Title"` (after `alt` for images). Link text is inline-formatted (no nested links); alt text is literal. The text ends at the first unescaped `]`. Anything that does not match is literal text.
- **Strong** `**x**` / `__x__` and **emphasis** `*x*` / `_x_`. The opener must be followed by a non-space; the closer is the next occurrence of the same delimiter (for single ones: a delimiter character not adjacent to another of the same character) preceded by a non-space. The content is formatted recursively. No closer: literal. An `_` with a letter or digit on both sides is always literal (`snake_case_name`).

## Slugs and table of contents

Every heading gets an `id`. The slug is made from the heading's plain text (its inline output without tags, code-span content and alt text included, before escaping): lowercase it, keep letters and digits (any script), turn spaces and `-` into `-`, drop everything else, collapse repeated `-`, trim `-` at both ends; if empty, use `section`. If the slug is already taken by an earlier heading, append `-1`, `-2`, … choosing the smallest unused one.

With `--toc`, the output starts with a `<nav class="toc">` line, a nested list of links `<a href="#slug">plain text</a>` (escaped) to the headings with level ≤ toc depth, and a `</nav>` line. Nesting uses the list format above with `<ul>`, where depth = level − (smallest included level), capped at the previous entry's depth + 1. No matching headings: no nav at all.

## Example

````
# Hello *World*

Some `code` & [a link](http://x.io).

- a
  - b
````
→
```
<h1 id="hello-world">Hello <em>World</em></h1>
<p>Some <code>code</code> &amp; <a href="http://x.io">a link</a>.</p>
<ul>
<li>a
<ul>
<li>b</li>
</ul>
</li>
</ul>
```
