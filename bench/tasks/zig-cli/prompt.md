# New tool: `zj`

Build **`zj`**, a small JSON toolkit for the command line, written in Zig. It validates JSON with precise error positions, pretty-prints and minifies it, sorts object keys for canonical output, and extracts values with a small path syntax. The repository is empty apart from a README; create the project from scratch.

## Constraints

- **Zig 0.17**, standard library only (do not use `std.json`; write your own parser). No third-party packages, nothing fetched.
- A `build.zig` at the repository root. From the repository root, `zig build` must produce the executable **`zig-out/bin/zj`**, and `zig build test` must run your tests and pass.
- Organise the code into several source files under `src/` (for example: parser, output, path queries, command line) rather than one big `main.zig`. No mutable global variables.
- The code must be formatted with `zig fmt` (`zig fmt --check .` passes).
- Write your own unit tests (Zig `test` blocks wired into `zig build test`), covering the parser, the output and the queries.
- Update the README with a short build and usage section.

## Command line

```
zj validate [FILE]
zj fmt   [--indent N] [--sort-keys] [--ascii] [FILE]
zj min   [--sort-keys] [--ascii] [FILE]
zj query [--raw] [--sort-keys] [--ascii] PATH [FILE]
zj --help
```

- Input is read from `FILE`, or from stdin when `FILE` is omitted or is `-`. The whole input must be one JSON value.
- Options come after the command and may be mixed freely with the positional arguments. Any other argument starting with `-` (except `-` itself) is an unknown option. An option that is not listed for the command is a usage error.
- `zj --help` (or `-h`) as the only argument prints a usage text starting with `usage: zj` to stdout and exits 0.

| command | stdout on success |
|---|---|
| `validate` | the single line `valid` |
| `fmt` | the value pretty-printed, followed by `\n` |
| `min` | the value with no whitespace at all, followed by `\n` |
| `query` | each result on its own line, minified (see below) |

## JSON accepted

Strict RFC 8259 JSON, UTF-8 encoded:

- Whitespace is space, tab, `\n` and `\r` only. No comments, no trailing commas, no BOM.
- Numbers match `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`. They are never converted: output repeats the original text exactly (`1.0E+2` stays `1.0E+2`, `-0` stays `-0`).
- Strings may not contain raw bytes below `0x20`. Escapes are `\" \\ \/ \b \f \n \r \t` and `\uXXXX` (hex digits in either case). A high surrogate `\uD800`–`\uDBFF` must be immediately followed by a `\u` escape of a low surrogate `\uDC00`–`\uDFFF`; together they encode one code point. Raw bytes must form valid UTF-8 (no overlong forms, no encoded surrogates, nothing above U+10FFFF).
- Object keys are compared after decoding escapes; the same key twice in one object is an error (`{"a":1,"a":2}` is invalid).
- Nesting depth up to **10000** (arrays and objects counted together; a top-level `[]` has depth 1) must work in every command. Opening a container at depth 10001 is an error.

## Errors in the input

Invalid JSON prints exactly one line to stderr and exits 1:

```
error: <source>:<line>:<column>: <message>
```

`<source>` is the `FILE` argument as given, or `<stdin>`. `<line>` and `<column>` start at 1; only `\n` starts a new line, and the column counts **bytes**, not characters. The position and message are those of the first error when reading from the start:

| message | position |
|---|---|
| `unexpected end of input` | just past the last byte (empty input: `1:1`) |
| `unexpected character` | the offending byte (also a wrong letter inside `true`/`false`/`null`) |
| `invalid number` | the first byte of the number; the number is the longest run of the bytes `0-9 + - . e E` starting there, and the whole run must match the grammar (`01`, `1.`, `-`, `1e5.0` are invalid) |
| `invalid escape` | the backslash of an unknown escape such as `\x` |
| `invalid unicode escape` | the backslash of a `\u` without four hex digits, of a high surrogate not followed by a low-surrogate escape, or of a lone low surrogate |
| `control character in string` | the raw byte below `0x20` |
| `invalid utf-8` | the first byte of the invalid or truncated sequence |
| `duplicate key` | the opening quote of the repeated key |
| `nesting too deep` | the bracket that would open depth 10001 |
| `trailing characters` | the first non-whitespace byte after the complete top-level value |

A string or container left open at the end of the input is `unexpected end of input`.

## Output

- **Strings** (keys too) are written from their decoded content: `"` as `\"`, `\` as `\\`, `\b \f \n \r \t` with those short escapes, other bytes below `0x20` as `\u00XX` with lowercase hex, everything else unchanged (so `\/` becomes `/`, `é` becomes the raw UTF-8 `é`, and DEL `0x7F` is written raw).
- `--ascii` additionally writes every non-ASCII code point as `\uXXXX` with lowercase hex, using a surrogate pair above U+FFFF (`😀` → `😀`).
- `--sort-keys` sorts the members of every object, at every depth, by key, comparing the decoded keys as unsigned UTF-8 bytes (`"Z"` < `"a"` < `"é"`). Without it, members keep their input order.
- **`fmt`**: `--indent N` (an integer 1–8, default 2) spaces per level. Each array element and object member goes on its own line, members are written `"key": value`, commas end the line. Empty arrays and objects are written `[]` and `{}`. Example (`--indent 2`):

  ```
  {
    "a": [
      1,
      {}
    ],
    "b": "x"
  }
  ```
- **`min`** writes `{"a":[1,{}],"b":"x"}`.

## Queries

`PATH` is either `.` (the whole input) or a sequence of segments, optionally preceded by a single `.` when the first segment is a bracket (`.[0]` means `[0]`):

- `.name` — object member; `name` is `[A-Za-z_][A-Za-z0-9_]*`
- `["any key"]` — object member, the key written as a JSON string (escapes allowed)
- `[N]` — array element, `N` a decimal integer without leading zeros; `[-N]` counts from the end (`[-1]` is the last element)
- `[*]` — every element of an array or every member value of an object, in input order

Example: `.users[*].emails[0]`, `.a["b c"][-1]`. Anything else is a usage error: `error: invalid path: <PATH>`, exit 2.

A path can produce several results. A segment that does not apply (missing key, index out of range, key on an array, index on an object, anything on a scalar) silently produces nothing for that branch. Results are printed in order, one per line, minified (honouring `--sort-keys` and `--ascii`). With `--raw`, a result that is a string is printed as its decoded content without quotes or escaping; other results are printed as JSON. If there are no results at all, nothing is printed to stdout, stderr gets `error: no match for path: <PATH>`, and the exit code is 4.

## Exit codes

| code | situation |
|---|---|
| 0 | success (and `--help`) |
| 1 | invalid JSON (message format above) |
| 2 | usage error: no arguments, unknown command, unknown or misplaced option, `--indent` missing or not 1–8, missing `PATH`, too many arguments, invalid path |
| 3 | the file cannot be opened or read: `error: cannot read file: <FILE>` |
| 4 | `query` matched nothing |

All error messages go to stderr and start with `error: `. On any error nothing is printed to stdout.
