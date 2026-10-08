# New tool: `surveystat`

Build **`surveystat`**, a command-line tool that summarises survey responses: it reads a CSV of responses and a small schema describing each question, and prints per-question summaries or a cross-tabulation of two questions with a chi-square test, as text or JSON. The repository is empty apart from a README; create the project from scratch.

## Constraints

- **R 4.6**, base R and the packages that ship with it only (`stats`, `utils`, ...). Nothing installed from CRAN, nothing downloaded; testthat is not available.
- The executable is **`bin/surveystat`** (with a `#!/usr/bin/env Rscript` shebang); `Rscript bin/surveystat ...` must work from any working directory. Keep it a thin wrapper (at most 20 non-blank lines) that finds the project from its own path and sources the code in **`R/*.R`**, split into at least four files by responsibility (for example CSV/schema reading, validation, statistics, formatting, command line). Files under `R/` only define functions and constants (sourcing them runs nothing); the process exit status is decided in one place.
- Write your own tests under `tests/` with a small self-written runner (e.g. using `stopifnot`): from the repository root, `Rscript tests/run.R` must run them all, print a last line `tests: <N>, failures: <F>`, and exit 0 only when `F` is 0.
- Update the README with a short usage section.

## Command line

```
surveystat summary  --schema FILE [options] DATA
surveystat crosstab --schema FILE [options] DATA ROW_QUESTION COL_QUESTION
```

| option | commands | meaning |
|---|---|---|
| `--schema FILE` | both | schema file (required) |
| `--filter COLUMN=VALUE` | both | keep only respondents whose `COLUMN` equals `VALUE`; may be repeated |
| `--format text\|json` | both | output format (default `text`) |
| `--lenient` | both | treat invalid answers as missing instead of failing |
| `--question ID` | summary | summarise only these questions (repeatable; output stays in schema order) |
| `--missing exclude\|include` | summary | percentage base, see below (default `exclude`) |
| `--digits D` | summary | decimals of percentages, an integer 0 to 4 (default 1) |
| `-h`, `--help` | | print usage text starting with `Usage: surveystat` to stdout and exit 0 |

Giving a command an option it does not take is a usage error. Option values are always the next argument. A repeated single-value option's last value wins. Options may come before or after the positional arguments.

## Schema file

A CSV file without quoting, header line exactly `question,type,levels`, then one question per line: three comma-separated fields, each trimmed of surrounding spaces and tabs. Empty lines are ignored.

- `question`: an id matching `[A-Za-z][A-Za-z0-9_]*`, unique.
- `type`: `likert` (answers `1` to `5`), `single` (one level), `multi` (several levels), or `numeric`.
- `levels`: for `single` and `multi`, the possible answers separated by `;` (each trimmed, non-empty, unique; their order is the output order). Must be empty for `likert` and `numeric`. The levels of a likert question are `1` to `5`.

## Responses file

CSV with a header row; fields are separated by commas and may be enclosed in double quotes (then they may contain commas, and `""` stands for one `"`; no field contains a line break). Lines end in `\n` or `\r\n`; empty lines are ignored. Every field is trimmed of surrounding spaces and tabs after unquoting. Column names must be unique, and every schema question must be a column; other columns (e.g. `country`, `cohort`) are respondent attributes. Each non-empty line after the header is a **row** (respondent), numbered from 1.

A trimmed value that is empty or exactly `NA` is **missing**. Otherwise it must be valid for the question type: likert `1`..`5`; numeric `-?[0-9]+(\.[0-9]+)?`; single exactly one of the levels (case-sensitive); multi one or more levels separated by `;` (items trimmed, no empty item; a level repeated in one answer counts once). Without `--lenient`, the first invalid answer (rows in order, questions in schema order within a row) is an error; with `--lenient`, invalid answers count as missing and, after the report has been printed, stderr gets `warning: <N> invalid value(s) treated as missing` (N over all rows, before filtering; nothing when N is 0).

`--filter COLUMN=VALUE` (split at the first `=`) compares against the trimmed raw value of any data column. Filters on different columns must all match; several filters on the same column match when any of them does. The rows that pass are the **respondents**.

## Summary

For each question: `missing` = respondents whose answer is missing, `n` = respondents minus `missing`.

- **single / likert / multi**: a count per level (for multi: respondents who chose the level). Percent = count / base × 100, where the base is `n` with `--missing exclude` and the number of respondents with `--missing include`; with `include` the missing count is reported as an extra `(missing)` entry with the same base.
- **likert / numeric**: `mean`, `median` (average of the two middle values for even `n`), `sd` (sample standard deviation, divisor `n - 1`); numeric also `min` and `max`. Computed over the `n` answered values.
- **Rounding**: percentages are rounded half up on the exact value to `--digits` decimals (1 of 8 is `12.5`, or `13` with `--digits 0`; 1 of 16 is `6.3` with `--digits 1`) and always printed with exactly that many decimals. Statistics are printed with two decimals as by `sprintf("%.2f")`. A percentage with base 0, a statistic over no values, or `sd` with `n < 2` is `n/a` in text and `null` in JSON.

Text output: `Respondents: <N>`, then (only with filters) `Filter: <col>=<value>, ...` in command-line order, then for each question a blank line and its block:

```
Respondents: 8
Filter: wave=2

sat (likert)
  n: 7, missing: 1
  1: 0 (0.0%)
  2: 1 (14.3%)
  3: 2 (28.6%)
  4: 3 (42.9%)
  5: 1 (14.3%)
  mean: 3.57
  median: 4.00
  sd: 0.98

age (numeric)
  n: 8, missing: 0
  mean: 42.00
  median: 39.50
  sd: 10.18
  min: 30.00
  max: 61.00
```

Single and multi blocks list their levels like the likert block, without statistics; with `--missing include` the line `  (missing): <count> (<pct>%)` follows the levels. A percentage of `n/a` is printed as `  <level>: 0 (n/a)`.

JSON output (`--format json`): one line holding

```
{"respondents":8,"filters":[{"column":"wave","value":"2"}],"questions":[
 {"id":"sat","type":"likert","n":7,"missing":1,"counts":[{"level":"1","count":0,"percent":0.0},...],"mean":3.57,"median":4.00,"sd":0.98},
 {"id":"age","type":"numeric","n":8,"missing":0,"mean":42.00,"median":39.50,"sd":10.18,"min":30.00,"max":61.00}]}
```

followed by a newline. Numbers are written with the same digits as in the text output; with `--missing include` each question with levels also has `"missing_percent"`. Strings are escaped as JSON requires.

## Cross-tabulation

`crosstab` counts the respondents who answered both questions (each must be `single` or `likert`, and they must differ). Rows are the levels of `ROW_QUESTION`, columns those of `COL_QUESTION`, in level order, all shown even with zero counts, plus a `Total` column and row. For the test, rows and columns with total 0 are dropped; with fewer than 2 rows or 2 columns left the test is `n/a`. Otherwise it is Pearson's chi-square test exactly as R's `chisq.test` with default arguments computes it (statistic, `df = (r - 1)(c - 1)`, upper-tail p-value; for a 2×2 table this includes the continuity correction).

```
Respondents: 10

Crosstab: region x plan (n = 9)

       basic  pro  Total
north      3    1      4
south      1    4      5
Total      4    5      9

chi-square: 0.9506, df: 1, p: 0.3296
note: some expected counts are below 5
```

The first column is left-aligned and padded to its widest entry (`Total` included, empty in the header line); every other column is right-aligned to its widest entry; columns are separated by two spaces. The statistic has 4 decimals; the p-value has 4 decimals, or is `<0.0001` when below 0.0001. The `note` line appears when an expected count of the tested table is below 5. When the test is `n/a`, the line reads `chi-square: n/a` and there is no note. JSON: `{"respondents":..,"filters":[..],"row":"region","column":"plan","n":9,"row_levels":[..],"column_levels":[..],"counts":[[3,1],[1,4]],"chi_square":{"statistic":0.9506,"df":1,"p_value":0.3296,"low_expected":true}}` (`counts` without totals; `chi_square` is `null` when `n/a`; `p_value` is the string `"<0.0001"` when below 0.0001).

## Errors and exit codes

Messages go to stderr as one line `error: <message>`; nothing is printed to stdout on failure. Checks run in this order and the first failure wins: options, schema file, responses file, then question names and filter columns.

| code | situation | message |
|---|---|---|
| 2 | unknown command or option, missing option value, missing `--schema`, wrong number of positional arguments, invalid `--format` / `--missing` / `--digits` / `--filter` syntax | free text |
| 2 | unknown question in `--question` or `crosstab`; crosstab question of the wrong type or the same twice; unknown filter column | `unknown question '<id>'` / free text / free text / `unknown filter column '<col>'` |
| 3 | schema problems | `cannot read <path>` or `schema line <L>: <problem>` (physical line, header = 1) or `schema has no questions` |
| 4 | responses problems | `cannot read <path>`, `data file is empty`, `duplicate column '<name>'`, `missing column '<question>'`, `row <R>: expected <K> fields, got <M>`, `row <R>: invalid value for '<question>': '<value>'` (the trimmed value) |

Schema `<problem>` texts: `invalid header`, `expected 3 fields`, `invalid question id '<id>'`, `duplicate question '<id>'`, `unknown type '<type>'`, `levels required for <type>`, `levels not allowed for <type>`, `duplicate level '<level>'`, `empty level`.
