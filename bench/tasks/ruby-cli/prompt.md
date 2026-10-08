# New tool: `logtally`

Build **`logtally`**, a command-line tool that reads web-server access logs (nginx/Apache "combined" format, optionally gzip-compressed) and prints traffic statistics: request counts, status-code breakdown, top paths, bytes sent and latency percentiles, as text or JSON. The repository is empty apart from a README; create the project from scratch.

## Constraints

- **Ruby 4.0**, standard library and default gems only (`zlib`, `json`, `optparse`, `time`, ...). No Bundler, no gems to install, nothing downloaded.
- The executable is **`bin/logtally`** (with a `#!/usr/bin/env ruby` shebang); `ruby bin/logtally ...` must work from any working directory. Keep `bin/logtally` a thin wrapper: the code lives in `lib/logtally.rb` and `lib/logtally/*.rb`, split into several files by responsibility (for example line parsing, filtering, statistics, output formatting, command line). Every file under `lib/` starts with `# frozen_string_literal: true`. Parse options with `OptionParser`.
- The code must be free of warnings under `ruby -w`.
- Write tests with **minitest** in `test/`, named `*_test.rb`. From the repository root this command must run them all and exit 0:

  ```
  ruby -Ilib -Itest -e 'Dir.glob("test/**/*_test.rb").sort.each { |f| require File.expand_path(f) }'
  ```
- Update the README with a short usage section.

## Command line

```
logtally [options] [FILE...]
```

With no `FILE`, or for a `FILE` of `-`, standard input is read. Several files are combined into one report, read in the order given.

| option | meaning |
|---|---|
| `--format text\|json` | output format (default `text`) |
| `--top N` | number of entries in the top-paths list (positive integer, default 10) |
| `--since TIME` | only requests at or after `TIME` |
| `--until TIME` | only requests strictly before `TIME` |
| `--status LIST` | only these statuses: comma-separated exact codes (`404`) or classes `1xx`..`5xx`, e.g. `200,3xx,5xx` |
| `--path GLOB` | only paths matching `GLOB`; may be repeated (a path matching any of them is kept) |
| `--strict` | fail on the first malformed line instead of skipping it |
| `-h`, `--help` | print usage text starting with `Usage: logtally` to stdout and exit 0 |

- `TIME` is `YYYY-MM-DDTHH:MM:SSZ`, `YYYY-MM-DDTHH:MM:SS+HH:MM` / `-HH:MM`, or a date `YYYY-MM-DD` (midnight UTC). `--since` must be earlier than `--until` when both are given.
- `GLOB` matches the whole path (case-sensitive): `*` matches any sequence of characters including `/`, `?` matches exactly one character, `[abc]` / `[a-z]` match one character from the set; every other character matches itself.
- Other repeated options: the last occurrence wins. All filters combine with AND.

## Input format

One request per line (lines end in `\n`; a trailing `\r` is removed). Each line is:

```
<client> <ident> <user> [<time>] "<request>" <status> <bytes> "<referer>" "<user-agent>"[ <request-time>]
```

for example

```
203.0.113.7 - alice [10/Oct/2026:13:55:36 +0200] "GET /api/items?page=2 HTTP/1.1" 200 2326 "-" "curl/8.5.0" 0.042
```

- Fields are separated by single spaces. `client`, `ident`, `user`: non-empty runs of non-space characters.
- `time`: `DD/Mon/YYYY:HH:MM:SS ±HHMM` with English three-letter month names (`Jan` ... `Dec`); it must be a real date and time.
- Quoted fields contain any characters except `"` and `\`, or backslash escapes (`\"`, `\\`, `\x22`: a backslash followed by any one character).
- `request` is `METHOD TARGET PROTOCOL`: three tokens separated by single spaces, `METHOD` made of uppercase letters `A`-`Z`, `PROTOCOL` starting with `HTTP/`. The **path** is `TARGET` up to (not including) the first `?`.
- `status`: three digits, 100 to 599. `bytes`: digits or `-` (zero).
- `request-time` (optional): the request duration in seconds, digits with an optional fraction (`0.042`, `3`), or `-`. A request without it (or with `-`) still counts everywhere except latency.
- Input is bytes: invalid UTF-8 anywhere in a line must not crash the tool or make the line malformed. When a path is printed, each invalid byte sequence is replaced with U+FFFD.
- Empty lines (or lines of only whitespace) are ignored. Any other line that does not match the format exactly is **malformed**.
- A file (or standard input) whose first two bytes are `0x1f 0x8b` is gzip-compressed, regardless of its name, and is decompressed while reading. Multi-member gzip files (several gzip streams concatenated, e.g. `cat a.gz b.gz`) must be read completely.

## Statistics

Only well-formed lines that pass all filters are counted as **requests**.

- `requests`: number of requests. `malformed`: number of malformed lines in all input (filters do not apply to them).
- `bytes`: total `bytes` of the requests.
- time range: the earliest and latest request time, converted to UTC (`YYYY-MM-DDTHH:MM:SSZ`).
- status codes: request count per exact status code, in ascending code order, with the percentage of all requests.
- top paths: request count per path, sorted by count (descending), then path (ascending, byte order); at most `--top` entries.
- latency: over the requests that have a request time. For `p` in 50, 95, 99, with the `n` values sorted ascending, the percentile is the value at 1-based rank `ceil(p * n / 100)` (compute the rank with integer arithmetic).

## Output

**Text** (the default) prints exactly this layout (two-space indents, single spaces, percentages with one decimal as by `format("%.1f")`, latencies with three decimals):

```
Requests: 6
Malformed lines: 1
Bytes: 12345
Time range: 2026-10-10T11:55:36Z .. 2026-10-10T12:10:00Z

Status codes:
  200 4 (66.7%)
  404 2 (33.3%)

Top paths:
  3 /api/items
  2 /
  1 /health

Latency (5 samples):
  p50 0.042
  p95 0.300
  p99 0.300
```

The latency header always reads `samples` (`Latency (1 samples):`). With no requests the time range line is `Time range: n/a`, an empty status or path section contains the single line `  (none)`, and with no latency samples the whole latency section is the single line `Latency: n/a`.

**JSON** (`--format json`) prints one JSON object followed by a newline:

```
{"requests":6,"malformed":1,"bytes":12345,
 "time_range":{"first":"2026-10-10T11:55:36Z","last":"2026-10-10T12:10:00Z"},
 "status":{"200":4,"404":2},
 "top_paths":[{"path":"/api/items","count":3},{"path":"/","count":2},{"path":"/health","count":1}],
 "latency":{"samples":5,"p50":0.042,"p95":0.3,"p99":0.3}}
```

`time_range` and `latency` are `null` when there is nothing to report; `status` keys are the codes as strings in ascending order; latencies are JSON numbers in seconds.

## Errors and exit codes

| code | situation | stderr |
|---|---|---|
| 0 | success (also when malformed lines were skipped) | if any were skipped: `warning: skipped <N> malformed line(s)` |
| 2 | usage error: unknown option, missing option argument, invalid `--format`, `--top`, `--status` or `TIME`, `--since` not before `--until` | `error: <message>` |
| 3 | `--strict` and a malformed line | `error: <file>:<line>: malformed line` (`<file>` as given on the command line, `-` for standard input; `<line>` is 1-based and counts every line, including empty ones) |
| 4 | a file cannot be opened or read, or its gzip data is corrupt or truncated | `error: cannot read <file>: <reason>` |

On exit codes 2, 3 and 4 nothing is printed to stdout.
