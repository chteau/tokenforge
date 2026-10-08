# New tool: `ledgerstat`

Build `ledgerstat`, a small command-line tool that reads bank-export CSV files and prints spending reports. The repository is empty apart from a README; create the project from scratch.

## Constraints

- Python 3.14, **standard library only** (no third-party packages, nothing to install). Use `tomllib` for the config file and the `csv` module for reading CSV.
- The code lives in a package named `ledgerstat` at the repository root and is run as `python3 -m ledgerstat ...` from the repository root. Organise the package into several modules (for example: parsing, reports, output formatting, command line) rather than one big file, and add type hints to public functions.
- Add tests using `unittest`. `python3 -m unittest discover` run from the repository root must find and pass them.
- Update the README with a short usage section.

## Input files

Every command takes one or more CSV paths. The files are UTF-8 (a leading BOM must be tolerated). The first line is a header that must contain the columns `date`, `merchant`, `category` and `amount`, matched case-insensitively after trimming spaces. Columns may appear in any order and extra columns are ignored. Example:

```csv
date,merchant,category,amount,reference
2026-01-03,Green Grocer,Groceries,-54.20,TX1001
2026-01-05,ACME Corp,Salary,2500.00,TX1002
2026-01-09,"Cafe Lune, Downtown",Dining,-12.5,TX1003
2026-02-01,City Rent,Housing,-950,TX1004
```

Field rules (all fields are trimmed of surrounding spaces first):

- `date`: `YYYY-MM-DD`, a real calendar date.
- `merchant`: must not be empty.
- `category`: lower-cased; an empty category becomes `uncategorized`.
- `amount`: an optional sign, digits, and optionally a `.` followed by one or two digits (`-12.5`, `2500`, `+3.40`). Nothing else is valid (no thousands separators, no currency symbols). Negative amounts are expenses, positive amounts are income, zero is neither. Use exact decimal arithmetic (not floats) for money.

Blank lines are ignored. A data row whose number of fields differs from the header, or that breaks any rule above, is a **bad row**. Bad rows never stop processing: each one is reported on stderr as

```
ledgerstat: PATH:LINE: REASON
```

where `PATH` is the path exactly as given on the command line, `LINE` is the 1-based line number in that file (the header is line 1) and `REASON` is a short human-readable explanation. After all files are read, if any rows were skipped, one more stderr line is printed: `ledgerstat: skipped N invalid row(s)`. Bad rows are detected before any date filtering.

Multiple files are combined into one set of transactions.

## Commands

```
python3 -m ledgerstat categories FILE... [options]
python3 -m ledgerstat monthly    FILE... [options]
python3 -m ledgerstat merchants  FILE... [--top N] [options]
python3 -m ledgerstat budget     FILE... --config PATH [--alerts-only] [options]
```

Options shared by all commands (placed after the command name):

- `--format table|json|csv` (default `table`)
- `--from YYYY-MM-DD` and `--to YYYY-MM-DD`: keep only transactions whose date is within the range, both ends inclusive. Either may be given alone.
- `--strict`: if any bad row is found, report the bad rows as usual, print nothing on stdout and exit with code 1.

`python3 -m ledgerstat --help` and `python3 -m ledgerstat COMMAND --help` print usage and exit 0.

In every report, `income` is the sum of the positive amounts, `expenses` is the sum of the absolute values of the negative amounts (so it is never negative), and `net` is `income - expenses`. `count` is a number of transactions.

### `categories`

One row per category that has at least one transaction. Columns: `category`, `count`, `income`, `expenses`, `net`. Sorted by `expenses` descending, then `category` ascending. Followed by a total over all reported transactions.

### `monthly`

One row per calendar month that has at least one transaction. Columns: `month` (`YYYY-MM`), `count`, `income`, `expenses`, `net`. Sorted by month ascending. Followed by a total.

### `merchants`

The top N merchants by expenses (default N = 5; `--top` must be a positive integer). Only expense transactions count: a merchant without any expense is not listed. Merchant names are compared exactly (case-sensitive, after trimming). Columns: `rank` (1, 2, ...), `merchant`, `count` (number of expense transactions), `expenses`. Sorted by `expenses` descending, then `merchant` ascending. No total.

### `budget`

Requires `--config PATH`, a TOML file:

```toml
[budgets]
groceries = 300
dining = 120.50

[settings]
warn_ratio = 0.8
```

- `[budgets]` is required and maps a category (lower-cased when read) to a monthly limit: a non-negative integer or float (booleans and other types are invalid).
- `[settings]` is optional. `warn_ratio` defaults to `0.8` and must be a number greater than 0 and at most 1.

The report has one row for every (month, budgeted category) pair, where the months are the months that have at least one transaction in the (filtered) data, even if that category had no spending that month. Columns: `month`, `category`, `budget`, `spent`, `remaining`, `status`. `spent` is the category's expenses in that month, `remaining` is `budget - spent` (negative when over). `status` is `over` if spent > budget, else `warning` if spent >= warn_ratio × budget, else `ok`. Sorted by month ascending, then category ascending. With `--alerts-only`, rows with status `ok` are left out. No total.

## Output formats

Money is always printed with exactly two decimals, a leading `-` when negative, and no thousands separator or currency symbol (`1234.50`, `-12.00`, `0.00`).

**table** (default): a header line with the column names exactly as listed above, a separator line, then one line per row. Each column is as wide as its longest cell (header included). Text columns (`category`, `month`, `merchant`, `status`) are left-aligned; numeric columns (`count`, `rank` and money) are right-aligned. Cells are joined by two spaces and trailing spaces are removed from every line. The separator line consists of `-` repeated to each column's width, joined by two spaces. For reports with a total, the data rows are followed by another separator line and a row whose first cell is `TOTAL`. If there are no rows at all, the table output is the single line `No transactions.` instead.

```
category   count   income  expenses      net
---------  -----  -------  --------  -------
housing        1     0.00    950.00  -950.00
groceries      1     0.00     54.20   -54.20
dining         1     0.00     12.50   -12.50
salary         1  2500.00      0.00  2500.00
---------  -----  -------  --------  -------
TOTAL          4  2500.00   1016.70  1483.30
```

**csv**: a header line with the column names, then one line per row, written with the `csv` module. No total row. With no rows, only the header.

**json**: one JSON document on stdout. Money values are JSON numbers rounded to two decimals; counts and ranks are integers; other values are strings. Shapes:

- categories: `{"categories": [{"category", "count", "income", "expenses", "net"}, ...], "total": {"count", "income", "expenses", "net"}}`
- monthly: `{"months": [{"month", "count", "income", "expenses", "net"}, ...], "total": {"count", "income", "expenses", "net"}}`
- merchants: `{"merchants": [{"rank", "merchant", "count", "expenses"}, ...]}`
- budget: `{"budgets": [{"month", "category", "budget", "spent", "remaining", "status"}, ...]}`

With no rows the lists are empty (and the total has zero count and amounts).

## Errors and exit codes

Fatal errors print one line `ledgerstat: error: MESSAGE` on stderr (argparse's own usage errors are fine for bad arguments) and exit with code 2, printing nothing on stdout. Fatal errors are:

- invalid arguments: unknown command or option, `--from`/`--to` that is not a valid `YYYY-MM-DD` date, `--from` later than `--to`, `--top` that is not a positive integer, a missing `--config` for `budget`;
- an input file that does not exist or cannot be read (the message includes the path);
- an input file whose header lacks a required column (the message includes the path and the missing column names), including an empty file;
- a config file that cannot be read, is not valid TOML, has no `[budgets]` table, or has an invalid budget or `warn_ratio` value (the message starts with `config:`).

Otherwise the exit code is:

- `1` if at least one bad row was skipped (the report is still printed, unless `--strict`);
- else `3` for the `budget` command when at least one printed row has status `over`;
- else `0`.
