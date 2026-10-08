# Follow-up: clearing budgets and an alerts-only status view

Following up on yesterday's budget work: after trying `tally budget` for a day, two things are missing. Please add them, keep everything that exists today working exactly as before (including the current `budget status` output when the new option is not used), and add tests for the new behaviour.

## `tally budget clear [--yes]`

Deletes every budget at once (for example, to start over at the beginning of a year). Entries in the ledger are never touched.

- With no budgets at all, it prints `no budgets to clear` and succeeds (exit code 0), with or without `--yes`.
- Otherwise, without `--yes` it refuses, leaves the budgets unchanged and fails with exit code 1 and this message (with the right count, `1 budget` / `N budgets`):

  ```console
  $ tally budget clear
  this would remove 3 budgets; re-run with --yes to confirm
  ```

- With `--yes` it removes all budgets and prints how many were removed:

  ```console
  $ tally budget clear --yes
  cleared 3 budgets
  ```

  Afterwards `tally budget list` shows the usual empty result, and new budgets can be set as before. The budgets must be stored exactly as safely as they are today after this operation, too.

- Any positional argument or unknown option (`tally budget clear all`, `tally budget clear --force`) is a usage error (exit code 2). Like every `budget` action it requires an initialised ledger.

## `tally budget status --alerts`

A new flag for `budget status` that shows only the categories needing attention, i.e. whose status is `warning` or `over`. It combines with `--month` and with `--format`, and uses the same thresholds (`warn_percent`) as the normal view. Rows, columns, sorting and formatting are exactly the same as the normal status view; the text table still ends with the totals row, but the totals cover only the rows shown. With $240 of groceries and $125 of eating out in March 2026 and budgets of 300 (groceries), 100 (eating-out) and 1200 (rent):

```console
$ tally budget status --month 2026-03 --alerts
CATEGORY      LIMIT    SPENT  REMAINING    USED  STATUS
eating-out  $100.00  $125.00    -$25.00  125.0%  over
groceries   $300.00  $240.00     $60.00   80.0%  warning
--------------------------------------------------------
total       $400.00  $365.00     $35.00   91.3%
$ tally budget status --month 2026-03 --alerts --format csv
category,limit,spent,remaining,used,status
eating-out,100.00,125.00,-25.00,125.0%,over
groceries,300.00,240.00,60.00,80.0%,warning
```

When no category needs attention (or there are no budgets), the output is the usual empty result of each format: `(no rows)`, `[]`, or just the CSV header. `--alerts` takes no value (`--alerts=yes` is a usage error, exit code 2).

## Help and docs

`tally help budget` must document both additions (`clear`, `--yes`, `--alerts`), the general help must still list the `budget` command, the error for an unknown or missing `budget` action must mention `clear` among the valid actions, and the user documentation should describe the new action and flag.
