# Feature request: monthly budgets

`tally` users want to set a monthly spending limit per category and see at a glance how the current month is going. Please add a `budget` command with four actions. Everything that exists today must keep working exactly as before, and please add tests for the new behaviour.

## `tally budget set CATEGORY AMOUNT`

Sets the monthly limit for a category, replacing any limit it already had. The category does not need to have any entries yet.

CATEGORY and AMOUNT follow exactly the same rules and error messages as `tally add`: the category is normalised the same way (`" Groceries "` becomes `groceries`), the amount must be greater than zero and at most 1000000.00, an invalid category or out-of-range amount fails with exit code 1, and a malformed amount such as `1.234` is a usage error (exit code 2).

On success it prints the normalised category and the amount with two decimals and no currency symbol:

```console
$ tally budget set Groceries 300
set budget for 'groceries' to 300.00
```

## `tally budget list`

One row per budget, sorted by category, with columns `category` and `limit`. Like every other table in tally it honours `--format` and the configured default format, and the text table shows money with the configured currency symbol:

```console
$ tally budget list
CATEGORY       LIMIT
eating-out   $100.00
groceries    $300.00
rent        $1200.00
$ tally budget list --format csv
category,limit
eating-out,100.00
groceries,300.00
rent,1200.00
```

With no budgets, the output is the usual empty result of each format (`(no rows)`, `[]`, or just the CSV header).

## `tally budget remove CATEGORY`

Deletes a budget. The category is matched after trimming and lower-casing.

```console
$ tally budget remove Groceries
removed budget for 'groceries'
```

If there is no budget for that category it fails with `no budget for category 'groceries'` and exit code 3, like other "not found" errors.

## `tally budget status [--month YYYY-MM]`

Compares every budget with the expenses of one month (default: the current calendar month, UTC). One row per budget, sorted by category, with these columns:

| column      | meaning |
|-------------|---------|
| `category`  | the budgeted category |
| `limit`     | the monthly limit |
| `spent`     | sum of the **expense** amounts in that category dated within the month (income entries do not count) |
| `remaining` | limit minus spent; negative when over budget |
| `used`      | spent as a percentage of the limit, one decimal, rounded half up (displayed like the `share` column of `tally report categories`) |
| `status`    | `over` if spent is greater than the limit; otherwise `warning` if spent is at least `warn_percent` % of the limit; otherwise `ok`. These comparisons use the exact amounts, not the rounded `used` value. |

In the text table, a totals row (sum of limits, sum spent, sum remaining, overall used, empty status) follows a dashed line, exactly like `tally report monthly`. JSON and CSV contain only the budget rows, as for other commands. Example, with $240 of groceries, $45 + $80 of eating out, a $60 groceries refund (income) and some salary in March 2026:

```console
$ tally budget status --month 2026-03
CATEGORY       LIMIT    SPENT  REMAINING    USED  STATUS
eating-out   $100.00  $125.00    -$25.00  125.0%  over
groceries    $300.00  $240.00     $60.00   80.0%  warning
rent        $1200.00    $0.00   $1200.00    0.0%  ok
---------------------------------------------------------
total       $1600.00  $365.00   $1235.00   22.8%
$ tally budget status --month 2026-03 --format csv
category,limit,spent,remaining,used,status
eating-out,100.00,125.00,-25.00,125.0%,over
groceries,300.00,240.00,60.00,80.0%,warning
rent,1200.00,0.00,1200.00,0.0%,ok
$ tally budget status --month 2026-03 --format json
[
  {"category": "eating-out", "limit": 100.00, "spent": 125.00, "remaining": -25.00, "used": 125.0, "status": "over"},
  {"category": "groceries", "limit": 300.00, "spent": 240.00, "remaining": 60.00, "used": 80.0, "status": "warning"},
  {"category": "rent", "limit": 1200.00, "spent": 0.00, "remaining": 1200.00, "used": 0.0, "status": "ok"}
]
```

An invalid `--month` is a usage error (exit code 2).

## Configuration

Add a configuration key `warn_percent` in a new `[budget]` section: a whole number, default `80`. It behaves like every existing key: it can be set in `config.ini`, overridden with the environment variable `TALLY_BUDGET_WARN_PERCENT`, is validated like the other numeric keys, and is shown by `tally config`.

## Storage and other behaviour

- Budgets are stored in a human-readable plain-text file `budgets.txt` in the data directory (never in `ledger.txt`), and must be written as safely as the ledger itself so a crash cannot leave a half-written file.
- All `budget` actions require an initialised ledger and fail with the same error as other commands otherwise.
- `tally rename-category OLD NEW` also moves OLD's budget to NEW. If NEW already has a budget, NEW keeps its own limit and OLD's budget is dropped.
- `tally budget` with a missing or unknown action, or with missing/extra arguments, is a usage error (exit code 2). `tally help budget` prints usage for the command, and the general help lists it.
- Update the README.
