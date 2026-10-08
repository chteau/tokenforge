# New tool: `tpl`

Build **`tpl`**, a command-line template engine with Mustache-style syntax: it renders a template file with data read from a JSON file and writes the result to standard output or a file. The repository is empty apart from a README; create the project from scratch.

## Constraints

- **Lua 5.5**, standard library only. No LuaRocks, no C modules, nothing downloaded. Lua has no built-in JSON support, so you must write your own JSON parser.
- The executable is **`bin/tpl`** (with a `#!/usr/bin/env lua` shebang); `lua bin/tpl ...` must work from any working directory. Keep `bin/tpl` a thin wrapper (at most 15 non-blank lines) that locates the project from its own path and calls into modules under **`tpl/`** (loaded as `require("tpl.<name>")`). Split the code into at least four modules by responsibility (for example JSON parsing, template parsing, rendering, command line).
- No global variables: every module returns a table and everything else is `local` (`luac -p -l` must show no assignment to a global in any file under `bin/` or `tpl/`).
- Write your own tests under `tests/` with a small self-written runner: from the repository root, `lua tests/run.lua` must run them all, print a last line `tests: <N>, failures: <F>`, and exit 0 only when `F` is 0.
- Update the README with a short usage section.

## Command line

```
tpl [options] TEMPLATE
```

| option | meaning |
|---|---|
| `-d FILE`, `--data FILE` | JSON data file (`-` for standard input). Without it the data is an empty object. |
| `-p DIR`, `--partials DIR` | directory holding partial templates |
| `-o FILE`, `--output FILE` | write the result to `FILE` (created or overwritten) instead of standard output |
| `--max-depth N` | maximum partial nesting depth, a non-negative integer (default 10) |
| `-h`, `--help` | print usage text starting with `Usage: tpl` to stdout and exit 0 |

`TEMPLATE` is a file path, or `-` for standard input. Options and `TEMPLATE` may come in any order; a repeated option's last value wins. Option values are always the next argument (`--data FILE`). The output is written exactly as rendered (no newline is added) and only when everything succeeded.

## JSON data

The data file must hold one JSON value (RFC 8259) and it must be an object. Accept exactly the standard grammar: objects, arrays, strings with the escapes `\" \\ \/ \b \f \n \r \t \uXXXX` (surrogate pairs combine into one character; output is UTF-8), numbers (`-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`), `true`, `false`, `null`, and whitespace (space, tab, `\n`, `\r`) between tokens. Nothing else: no comments, no trailing commas, no raw control characters (below 0x20) inside strings, no text after the value. Duplicate keys: the last one wins. Empty arrays and empty objects must remain distinguishable, and `null` must remain distinguishable from a missing key.

An invalid file is reported at the first character where the input stops being the beginning of some valid JSON text (`[1,]` fails at `]`, `{"a" 1}` at `1`, `tru}` at `}`, `01` at `1`, `{} x` at `x`); when the input ends too early, the position is just after its last character. Lines are counted from 1 and split at `\n`; the column is the 1-based byte offset within the line.

## Templates

A **tag** starts with the opening delimiter (`{{` by default) and ends with the next closing delimiter (`}}`). Whitespace around a tag's name is ignored (`{{ user.name }}`). Kinds:

| tag | meaning |
|---|---|
| `{{name}}` | value of `name`, HTML-escaped |
| `{{{name}}}`, `{{& name}}` | value of `name`, not escaped. The triple form exists only while the delimiters are the default `{{ }}`: it starts with `{{{` and ends with the next `}}}`. |
| `{{#name}}...{{/name}}` | section |
| `{{^name}}...{{/name}}` | inverted section |
| `{{! text}}` | comment, ignored; it ends at the next closing delimiter and may span several lines |
| `{{> name}}` | partial |
| `{{=<% %>=}}` | set delimiters |

- **Names** are `.` or one or more segments of ASCII letters, digits, `_` and `-` separated by single dots (`a`, `user.first-name`, `order.address.city`). A partial name is one or more such segments (without dots) separated by `/` (`header`, `mail/footer`).
- **Lookup** of `a.b.c`: search the context stack from the innermost frame outwards for the first frame that is an object having the key `a` (a key whose value is `null` counts as present and stops the search); then look up `b`, then `c`, each inside the previous value, which must be an object having that key (otherwise the result is missing; no further stack search). Dotted segments only look into objects, never into arrays. `.` is the innermost frame itself. The data object is the outermost frame.
- **Text of a value**: a string as is; `true`/`false` as `true`/`false`; `null` or missing as the empty string; a number that is a mathematical integer with absolute value below 10^15 as an integer without a decimal point (`3`, `2.0` gives `2`, `-7`), any other number formatted as by `string.format("%.14g")` (`1.5`, `1e+20`). Interpolating an array or an object is an error.
- **Escaping**: `&` `<` `>` `"` `'` become `&amp;` `&lt;` `&gt;` `&quot;` `&#39;`.
- **Sections**: a value is *falsy* when it is missing, `null`, `false`, the empty string, or an empty array; everything else is truthy (including `0` and `{}`). A section over an array renders its content once per element, in order, with the element pushed as the innermost frame. Over another truthy value (object, string, number, `true`) it renders once with that value pushed. Over a falsy value it renders nothing. An inverted section renders its content (without pushing anything) exactly when the value is falsy. Closing tags must name the innermost open section exactly.
- **Set delimiters**: `{{=OPEN CLOSE=}}`: the content between the two `=` is trimmed and must consist of exactly two whitespace-separated parts, neither containing `=`. The new delimiters apply from right after the tag to the end of the current file or the next change. Every file (the template and each partial) starts with `{{ }}`.
- **Partials**: `{{> name}}` renders the file `DIR/name.mustache` (`DIR` from `--partials`) in place, with the current context stack. The main template is at depth 0 and a partial included from depth `d` is at depth `d + 1`; including a partial deeper than `--max-depth` is an error. Partials are read only when rendered, so recursive partials work while the data ends the recursion.

## Standalone lines

A line (text up to and including `\n`, or the final text after the last `\n`) is **standalone** when it contains exactly one tag, that tag is a section open, inverted open, section close, comment, partial or set-delimiter tag, and everything else on the line is spaces and tabs (apart from the line ending `\n` or `\r\n`). A comment spanning several lines is standalone when only spaces and tabs precede it on its first line and follow it on its last line. A standalone line produces no output at all: its whitespace, the tag and its line ending are removed. For a standalone partial, the whitespace before the tag becomes the partial's **indentation**: it is inserted at the start of the partial's text and after every `\n` in it except one that ends the text, before the partial is parsed. A partial that is not standalone is not indented. Variable tags never make a line standalone.

Example, with data `{"name": "<Ann>", "items": [{"n": 1}, {"n": 2}], "none": []}`:

```
Hello {{name}}!
{{#items}}
  - {{n}}
{{/items}}
{{^none}}none{{/none}}
```

renders as

```
Hello &lt;Ann&gt;!
  - 1
  - 2
none
```

## Errors and exit codes

Messages go to stderr as one line `error: <message>`; nothing is written to stdout (or to the `--output` file) when the exit code is not 0. Steps run in this order and the first failure wins: options, data, template file, parsing, rendering, writing the output.

| code | situation | message |
|---|---|---|
| 2 | unknown option, missing option value, missing or extra `TEMPLATE`, invalid `--max-depth`, data and template both `-` | free text |
| 3 | template error (below) | `<source>:<line>: <problem>` |
| 4 | data file unreadable / invalid JSON / not an object | `cannot read <path>: <reason>` / `<path>: invalid JSON at line <L>, column <C>` / `<path>: top-level value must be an object` |
| 5 | template file unreadable / output file not writable | `cannot read <path>: <reason>` / `cannot write <path>: <reason>` |

`<path>` is as given on the command line (`-` for standard input). For template errors, `<source>` is the template path as given, or for a partial `DIR/name.mustache` with `DIR` as given (no doubled `/` when it already ends in one); `<line>` is the 1-based line where the offending tag's opening delimiter is. A file is parsed from start to end and the first problem found is reported:

| problem | when |
|---|---|
| `unclosed tag` | an opening delimiter has no closing delimiter after it |
| `invalid tag name '<content>'` | a tag's (trimmed) name is not a valid name, e.g. `{{}}` or `{{a b}}` |
| `invalid partial name '<name>'` | a partial name is not valid |
| `invalid delimiter tag` | a malformed set-delimiter tag |
| `unexpected closing tag '<name>'` | a closing tag with no open section |
| `mismatched closing tag '<name>', expected '<open>'` | a closing tag that does not match the innermost open section |
| `unclosed section '<name>'` | the file ends with a section still open (the innermost one is reported, at its opening tag) |
| `partial not found: <name>` | rendering a partial whose file cannot be read (also without `--partials`) |
| `partial depth limit exceeded: <name>` | rendering a partial deeper than `--max-depth` (reported at the partial tag) |
| `cannot interpolate array: <name>` / `cannot interpolate object: <name>` | a variable tag whose value is an array or object |
