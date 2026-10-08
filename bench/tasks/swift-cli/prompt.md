# New tool: `cronx`

Build **`cronx`**, a command-line tool for standard 5-field cron expressions, written in Swift: it validates expressions with precise error messages, lists the next run times from a given start instant in a fixed UTC offset, and explains an expression in English. The repository is empty apart from a README; create the project from scratch.

## Constraints

- **Swift 6** with **SwiftPM** (`Package.swift` at the repository root), standard library only (Foundation is allowed but not needed). No package dependencies; nothing is downloaded.
- From the repository root, `swift build` must succeed without compiler warnings and produce the executable product **`cronx`** (at `$(swift build --show-bin-path)/cronx`).
- Structure: put the logic (parsing, scheduling, explaining, date arithmetic) in a library target split over several files, and keep the executable target a thin command-line layer. Only the executable target prints or exits.
- Write your own tests in a test target (XCTest or Swift Testing) so that `swift test` runs and passes them.
- Update the README with build, test and usage instructions.

## Command line

```
cronx validate <expr>
cronx next <expr> --from <instant> [--count <n>] [--offset <±HH:MM>]
cronx explain <expr>
cronx --help
```

- `<expr>` is one argument (quote it in the shell). `--help`/`-h` prints a usage text starting with `usage: cronx` to stdout, exit 0.
- Options of `next` may appear in any order after `<expr>`, each at most once.
- Exit codes: 0 success; 1 invalid expression (or no run found, below); 2 usage error (no/unknown command, missing `<expr>`, extra arguments, unknown/repeated/missing option or option value, invalid `--from`, `--count` or `--offset`). Errors go to stderr as one line starting with `error: `; on error nothing goes to stdout. Every stdout line ends with `\n`.

## Expressions

Five fields separated by one or more spaces/tabs (leading and trailing whitespace ignored):

| # | field | values | names |
|---|---|---|---|
| 1 | minute | 0–59 | |
| 2 | hour | 0–23 | |
| 3 | day-of-month | 1–31 | |
| 4 | month | 1–12 | `JAN`–`DEC` |
| 5 | day-of-week | 0–7 (0 and 7 are Sunday) | `SUN`–`SAT` |

Each field is a comma-separated list of items. An item is `*`, `v`, `a-b`, `*/s`, `a-b/s` or `a/s` (same as `a-<field max>/s`). Values are decimal numbers or, where the table allows, three-letter names (case-insensitive), also in ranges (`MON-FRI`). `a-b/s` means a, a+s, a+2s, … ≤ b. A step is a positive decimal number.

The whole expression may instead be a macro (case-insensitive): `@yearly` and `@annually` = `0 0 1 1 *`, `@monthly` = `0 0 1 * *`, `@weekly` = `0 0 * * 0`, `@daily` and `@midnight` = `0 0 * * *`, `@hourly` = `0 * * * *`.

### Errors

`validate` prints `valid` and exits 0, or prints one error and exits 1 (the same check runs for `next` and `explain`). Fields are checked left to right, items left to right; within an item the start value is checked first, then the end value, then start ≤ end, then the step. The first problem found is reported as:

| situation | message |
|---|---|
| not exactly 5 fields | `error: expected 5 fields, got <n>` |
| unknown macro | `error: unknown macro "<expr as given>"` |
| empty item (`1,,2`, `5,`) | `error: <field>: empty item` |
| value that is not a number or an allowed name | `error: <field>: invalid value "<text>"` |
| number outside the field's range | `error: <field>: value <n> out of range <min>-<max>` |
| range with start > end (`5-3`) | `error: <field>: invalid range <a>-<b>` (as written) |
| step missing, not a number, or 0 | `error: <field>: invalid step "<text>"` |

`<field>` is the field name from the table (`minute`, `hour`, `day-of-month`, `month`, `day-of-week`). Numbers may have leading zeros (`05`); range-error numbers are printed in decimal (`value 60 out of range 0-59`). An item with more than one `/` or `-` is an invalid value: report the whole item text, e.g. `invalid value "1-2-3"`.

## Matching

A minute matches when its minute, hour and month are in their fields and its day matches: if both day-of-month and day-of-week are restricted (not exactly `*`), the day matches when **either** matches; otherwise only the restricted one (if any) counts. The calendar is the proleptic Gregorian calendar (leap years: divisible by 4, except centuries not divisible by 400).

## `next`

- `--from` is an instant: `YYYY-MM-DDTHH:MM` followed by `Z` or `±HH:MM`, for example `2026-03-01T10:00Z` or `2026-03-01T10:00-08:00`. It must be a real calendar date and time (no `2026-02-30`, no `24:00`).
- `--offset` (default `+00:00`) is the fixed UTC offset in which the schedule runs and in which times are printed: `+HH:MM` or `-HH:MM`, hours 00–14, minutes 00–59, and at most `14:00` in total. There is no daylight saving time.
- `--count` (default 5) is an integer from 1 to 1000.
- Prints the first `<count>` matching minutes strictly after `--from`, one per line in the `--offset` local time, formatted `YYYY-MM-DDTHH:MM±HH:MM` (a zero offset prints as `+00:00`).
- Only times less than 100 years (36,525 days) after `--from` are considered. If fewer than `<count>` exist, print those found; if none exist, print `error: no run within 100 years` and exit 1. This must stay fast (well under a second), so do not test minute by minute.

## `explain`

Prints one English sentence: `<time>[, <days>][, <months>].` (macros are explained by their expansion). With `L` the field's item list rendered as below:

- `<time>`: if minute and hour are each a single plain value: `At HH:MM` (two digits each). Otherwise the minute part — `*` → `Every minute`; a single `*/s` → `Every s minutes`; else `At minute L` — followed, when the hour is not `*`, by a space and the hour part: a single `*/s` → `past every s hours`; else `past hour L`.
- `<days>`: the day-of-month part — a single `*/s` → `every s days`; else `day L of the month` — and the day-of-week part — a single `*/s` → `every s days of the week`; else `L`. If only one of the two fields is restricted: `on <that part>`; if both: `on <dom part> or <dow part>`; if neither: omitted.
- `<months>`: when the month is not `*`: a single `*/s` → `every s months`; else `in L`.
- List `L`: items in the order written, joined with `, ` except the last with ` and ` (`1`, `1 and 2`, `1, 2 and 3`). Item: `v` → `V`; `a-b` → `A through B`; `a-b/s` (and `a/s`) → `every s from A through B`; `*/s` inside a longer list → `every s`. `V` is the decimal number (no leading zeros) for minute, hour and day-of-month, the full English name for months (`January`) and weekdays (`Sunday` for 0 and 7).

Examples:

```
$ cronx explain '30 9 * * MON-FRI'      →  At 09:30, on Monday through Friday.
$ cronx explain '*/15 9-17 1,15 * *'    →  Every 15 minutes past hour 9 through 17, on day 1 and 15 of the month.
$ cronx explain '0 0 * JAN,jul 0'       →  At 00:00, on Sunday, in January and July.
$ cronx next '0 12 * * *' --from 2026-03-01T05:00Z --offset +05:30 --count 2
2026-03-01T12:00+05:30
2026-03-02T12:00+05:30
```
