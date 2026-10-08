# New tool: `habits`

Build **`habits`**, a command-line habit tracker written in Dart. You register habits with a weekly goal, mark the days you did them, and the tool computes day streaks, weekly-goal streaks and a weekly text report. Data is stored in a JSON file. The repository is empty apart from a README; create the project from scratch.

## Constraints

- **Dart 3** (the installed SDK is 3.13), **standard library only** (`dart:core`, `dart:io`, `dart:convert`, ...). No packages from pub: `pubspec.yaml` must have no `dependencies` or `dev_dependencies` (that includes `package:test` and `package:args`). Everything must work offline.
- A `pubspec.yaml` at the repository root with `name: habits`. The entry point is **`bin/habits.dart`**, so both `dart run bin/habits.dart ...` and `dart compile exe bin/habits.dart -o build/habits` work from the repository root.
- Put the logic in libraries under `lib/` (for example: date arithmetic, the habit/streak model, JSON storage, the report, command-line handling), not in one big file; keep `bin/habits.dart` a thin wrapper. All reads and writes of the data file go through a single storage library. `dart analyze` must report no issues, and code should be formatted with `dart format`.
- Write your own tests. Since `package:test` is not available, write a small assertion harness: each test file is `test/<something>_test.dart` with a `main()` that runs its checks and exits with a non-zero code (for example via `exitCode = 1` or an uncaught exception) if any check fails. Each file must pass when run as `dart run test/<file>_test.dart` from the repository root.
- Update the README with a short build, test and usage section.

## Command line

```
habits [--file <path>] add <name> [--goal <n>]
habits [--file <path>] remove <name>
habits [--file <path>] done <name> [<date>]
habits [--file <path>] undo <name> [<date>]
habits [--file <path>] list
habits [--file <path>] streak <name>
habits [--file <path>] report [<date>]
habits --help
```

- `--file <path>`, if given, must be the first two arguments. The default data file is `habits.json` in the current working directory.
- `habits --help` (or `-h`) as the only argument prints a usage text starting with `usage: habits` to stdout and exits 0.
- **Today** is the value of the environment variable `HABITS_TODAY` (format `YYYY-MM-DD`) when it is set and non-empty, otherwise the local calendar date. An invalid `HABITS_TODAY` is a usage error.
- A **date** argument is exactly `YYYY-MM-DD` (4-digit year, 2-digit month and day) and must be a real calendar date, including leap years (`2024-02-29` is valid, `2023-02-29`, `2026-04-31`, `2026-1-05` and `20260105` are not).
- A **habit name** is 1 to 32 characters from `a-z`, `0-9` and `-`, starting with a letter.
- For `add`, `--goal <n>` may come before or after the name. The goal is the number of days per week the habit should be done, an integer from 1 to 7; the default is 7.

### Commands

| command | stdout on success | errors |
|---|---|---|
| `add` | `added <name>` | exists: exit 1, `error: habit already exists: <name>` |
| `remove` | `removed <name>` | missing: exit 1, `error: no such habit: <name>` |
| `done` | `done <name> <date>`; if already marked: `already done <name> <date>` (exit 0, file not rewritten) | date after today: exit 2, `error: date is in the future: <date>` |
| `undo` | `undone <name> <date>` | not marked that day: exit 1, `error: not done: <name> <date>` |
| `list` | one line per habit, sorted by name: `<name>\tgoal <g>\tcurrent <c>\tbest <b>\ttotal <t>` (tab separated); no habits: nothing | |
| `streak` | five lines, see below | |
| `report` | the weekly report, see below | |

`<date>` defaults to today. `done`, `undo` and `streak` of an unknown habit fail with exit 1 and `error: no such habit: <name>`. Every stdout line ends with `\n`; nothing else is printed to stdout.

### Streaks

Done dates **after today are ignored** by `list`, `streak` and `report` (they can exist if today moves backwards).

- **current**: if the habit is done today, the number of consecutive days ending today; otherwise, if it is done yesterday, the number of consecutive days ending yesterday (the streak stays alive until today is over); otherwise 0. Runs cross month, year and leap-day boundaries naturally.
- **best**: the longest run of consecutive days ever.
- **total**: the number of done days.
- **weekly**: weeks are ISO weeks (Monday to Sunday). A week *meets the goal* if the habit is done on at least `goal` of its days. Start at the week containing today if it already meets the goal, otherwise at the previous week, and count consecutive weeks going backwards that meet the goal.
- **last**: the most recent done date, or `never`.

`streak <name>` prints exactly:

```
current: <n>
best: <n>
total: <n>
weekly: <n>
last: <date or never>
```

### Weekly report

`report [<date>]` reports on the ISO week containing `<date>` (default today; any valid date is allowed, also in the future). Example for today = `2026-10-08` (a Thursday):

```
Week 2026-W41 (2026-10-05 to 2026-10-11)
read     x x . x - - -  3/5  need 2
run      . x . . - - -  1/6  missed
stretch  x x x x - - -  4/3  met
1 of 3 goals met
```

- The header is `Week <ISO year>-W<2-digit ISO week> (<monday> to <sunday>)`. Use the ISO week-numbering year: `2027-01-01` is in `2026-W53`, `2024-12-30` is in `2025-W01`.
- One line per habit, sorted by name: the name left-aligned and padded with spaces to the length of the longest habit name, two spaces, seven cells for Monday to Sunday separated by single spaces, two spaces, `<done>/<goal>`, two spaces, the status. No trailing spaces.
- A cell is `-` if the day is after today, else `x` if the habit is done that day, else `.`. `<done>` is the number of `x` cells.
- Status: `met` if done ≥ goal. Otherwise let *remaining* be the number of days of that week after today, plus one if today is in that week and not done; the status is `missed` if done + remaining < goal, else `need <goal − done>`.
- The last line is `<m> of <n> goals met`. With no habits, the report is the header followed by `no habits`.

## Data file

The data file is JSON with exactly this shape (whitespace is up to you):

```json
{"habits": [{"name": "read", "goal": 5, "done": ["2026-10-05", "2026-10-06"]}]}
```

- When writing: habits sorted by name, each `done` list sorted ascending with no duplicates.
- When reading, accept habits and dates in any order and with duplicate dates (normalise them). A file that is not valid JSON or does not have this shape (missing `habits`, invalid name, goal not an integer 1–7, invalid date, duplicate habit names) is corrupt: exit 3 with `error: corrupt data file: <path>`.
- A missing file means no habits. Read-only commands (`list`, `streak`, `report`) never create or modify the file. Commands that change data create the file, and missing parent directories, as needed.
- Write atomically: write a temporary file in the same directory, then rename it over the data file. No temporary files may remain after a command finishes.

## Exit codes and errors

| code | situation |
|---|---|
| 0 | success (and `--help`) |
| 1 | unknown habit, habit already exists, `undo` of a day that is not marked |
| 2 | usage error: no command, unknown command, missing or extra arguments, missing `--file` value, invalid name, goal, date or `HABITS_TODAY`, future date in `done` |
| 3 | I/O error or corrupt data file (for example the data file path is a directory) |

Arguments are validated before the data file is read. All error messages go to stderr and start with `error: `. On an error nothing is printed to stdout and the data file is left unchanged.
