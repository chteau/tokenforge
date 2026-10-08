# New tool: `csvq`

Build **`csvq`**, a small command-line tool that runs simple queries over a CSV file: pick columns, filter rows, sort, and aggregate with optional grouping. It is written in C. The repository is empty apart from a README; create the project from scratch.

## Constraints

- **C11**, C standard library only, plus POSIX headers if you need them. No third-party libraries, no code fetched or installed.
- Build with **Make** (a `Makefile` at the repository root) and the system `gcc` (13). From the repository root, `make` must produce the executable **`./csvq`**, and `make test` must build and run your tests, exiting non-zero if any fails.
- Compile with **`-std=c11 -Wall -Wextra`** (set them in the `Makefile`); the build must be free of compiler warnings. The `Makefile` must also append the variable **`EXTRA_CFLAGS`** to both the compile and the link flags, so that `make EXTRA_CFLAGS="-fsanitize=address,undefined"` builds an instrumented binary. The program must run cleanly under AddressSanitizer and UBSan.
- Organise the code into several modules, each a `.c` file with its own header (for example: CSV reading/writing, query evaluation, command-line handling), not one big `main.c`. Every header has an include guard (or `#pragma once`). Do not use `gets`, `strcpy`, `strcat` or `sprintf`.
- Write your own tests (a small hand-written assertion harness is fine) under `tests/`, run by `make test`.
- Update the README with a short build and usage section.

## Command line

```
csvq [OPTIONS] [FILE]
```

`FILE` is the CSV file to read; when it is omitted or is `-`, standard input is read. At most one `FILE` may be given. Options may appear before or after `FILE`, each written as `--name VALUE` (two arguments):

| option | meaning |
|---|---|
| `--select COLS` | output only these columns, in this order (duplicates allowed) |
| `--where EXPR` | keep only rows matching `EXPR`; may be repeated, a row must match all of them |
| `--sort KEYS` | sort the output rows |
| `--group-by COLS` | group rows; output one row per distinct combination of these columns |
| `--agg LIST` | compute aggregates (per group, or over all rows without `--group-by`) |
| `--limit N` | output at most `N` rows (`N` is a non-negative decimal integer: `0`, `10`; not `-1`, `x`, `1.5`) |
| `-h`, `--help` | print a usage text starting with `usage: csvq` to stdout and exit 0 |

Every option except `--where` may be given at most once. `--select` cannot be combined with `--group-by` or `--agg`.

`COLS`, `KEYS` and `LIST` are comma-separated lists; spaces around each item are ignored (`--select "name, age"` works). An empty item (`a,,b`, or an empty value) is a usage error. Column names are matched exactly (case-sensitive) against the header; if the header contains the same name twice, the first one is used.

### Input format (RFC 4180)

- Fields are separated by `,`; records end with `\n` or `\r\n`. The last record may lack a line ending. A UTF-8 byte order mark at the very start of the input is ignored.
- A field may be enclosed in double quotes; then it may contain commas, line breaks and quotes (written as `""`). Outside a quoted field a `"` is an error, and so is any character other than `,` or a line ending right after a closing quote.
- Empty lines (outside quoted fields) are skipped.
- The first record is the header (column names). Every other record must have the same number of fields as the header.

### Values, numbers and comparisons

A field **is a number** when it matches `[+-]?[0-9]+(\.[0-9]+)?` exactly (`12`, `-3.50`, `+7`; not ` 12`, `1e3`, `.5`, `1.`, or the empty string).

- **`--where EXPR`**: `EXPR` is `COLUMN OP VALUE` with `OP` one of `=`, `!=`, `<`, `<=`, `>`, `>=`, or the word `contains` with a single space on each side (` contains `). The operator is the leftmost one found when scanning the expression from the left (at each position `!=`, `<=`, `>=` are tried before `=`, `<`, `>`). Spaces around `COLUMN` and `VALUE` are trimmed. `COLUMN` must not be empty; `VALUE` may be (`--where "note="` matches empty fields). An expression without an operator is a usage error.
  - `contains`: true when `VALUE` occurs as a substring of the field (case-sensitive; always textual).
  - other operators: if both the field and `VALUE` are numbers they are compared numerically (`1.0 = 1`, `9 < 10`); otherwise they are compared as byte strings (`strcmp` order).
- **`--sort KEYS`**: each key is a column name optionally followed by `:asc` (default) or `:desc`. Rows are compared key by key. Two values compare numerically if both are numbers; a number sorts before a non-number; two non-numbers compare as byte strings. `:desc` reverses the order for that key. The sort is **stable**: rows that compare equal keep their input order.

### Aggregates

`LIST` items are `count`, `sum(COL)`, `avg(COL)`, `min(COL)`, `max(COL)` (lowercase, no spaces inside). Anything else is a usage error.

- With `--group-by` and/or `--agg`, the output has one column per group-by column (header: the column name) followed by one column per aggregate (header: the item exactly as written after trimming, for example `sum(amount)`).
- Groups appear in the order in which they first occur in the (filtered) input. `--group-by` without `--agg` lists the distinct combinations. `--agg` without `--group-by` produces exactly one row, even when no rows match.
- `count` is the number of rows. `sum`, `avg`, `min` and `max` only consider fields of the column that are numbers; other fields (including empty ones) are skipped. With no numeric field, `sum` is `0` and `avg`, `min`, `max` are empty.
- Numeric results are printed with `printf("%.6f")`, then trailing zeros and a trailing `.` are removed, and `-0` becomes `0`: `3`, `2.5`, `0.333333`, `0.3` (for `0.1 + 0.2`).

### Processing order and output

1. Read and parse the whole input. 2. Apply the `--where` filters. 3. If `--group-by`/`--agg` is given, aggregate. 4. Sort. 5. Apply `--limit`. 6. Apply `--select`.

Without aggregation, `--where`, `--sort` and `--select` refer to input columns (a sort column need not be selected). With aggregation, `--where`, `--group-by` and the aggregate columns refer to input columns, while `--sort` refers to the **output** columns (for example `--sort "count:desc"` or `--sort "sum(amount)"`).

The output is CSV on stdout: the header row, then the data rows, each ending with `\n` (never `\r\n`). A field is enclosed in double quotes (with inner quotes doubled) only if it contains a comma, a double quote, `\r` or `\n`. A header row is printed even when no rows match.

## Exit codes and errors

| code | situation |
|---|---|
| 0 | success (and `--help`) |
| 2 | usage error: unknown option, missing option value, option repeated, unexpected extra argument, invalid expression, list, aggregate or limit, `--select` combined with aggregation, a column name that is not in the header |
| 3 | input error: the file cannot be opened or read, malformed CSV, wrong number of fields, empty input |

All error messages go to stderr as a single line starting with `error: `. On any error nothing at all is written to stdout. These messages must be exact:

- `error: unknown column: <name>`
- `error: invalid expression: <expr>`, `error: invalid aggregate: <list>`, `error: invalid limit: <value>`
- `error: line <N>: unterminated quoted field` — `<N>` is the line on which the quoted field starts
- `error: line <N>: expected <H> fields, got <M>` — `<N>` is the line on which the record starts
- `error: empty input` — the input contains no header record (empty, or only empty lines)
- other malformed CSV: `error: line <N>: <description of the problem>`

Line numbers count physical lines of the input starting at 1, including skipped empty lines and line breaks inside quoted fields. Errors in the options are reported before the input is read; a malformed input is reported before unknown columns.

## Examples

```
$ cat sales.csv
region,rep,amount
north,ann,120.5
south,bob,80
north,cid,40
$ csvq sales.csv --where "amount > 50" --select rep,amount --sort amount:desc
rep,amount
ann,120.5
bob,80
$ csvq sales.csv --group-by region --agg "count,sum(amount),avg(amount)"
region,count,sum(amount),avg(amount)
north,2,160.5,80.25
south,1,80,80
$ csvq sales.csv --select nope
error: unknown column: nope        (stderr, exit 2)
```
