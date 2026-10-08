# New tool: `rotate`

Build **`rotate`**, a backup rotation tool written in Bash. It snapshots a directory into timestamped `.tar.gz` archives in a repository directory, lists and restores snapshots, and prunes old ones with a grandfather-father-son (daily/weekly/monthly) retention policy. The repository is empty apart from a README; create the project from scratch.

## Constraints

- **Bash 5 only.** Allowed external commands: GNU coreutils (`date`, `sort`, `mkdir`, `mv`, `rm`, `stat`, `mktemp`, ...), `tar`, `gzip`, `find`, `grep` and `sed`. **No other languages or interpreters** anywhere in the solution or its tests: no `awk`, Perl, Python, Ruby, Node, `bc`, and no `flock` either.
- The entry point is the executable script **`rotate`** at the repository root (`#!/usr/bin/env bash`, executable bit committed). Split the code into several files: `rotate` sources helper libraries from `lib/*.sh`, located relative to the script itself (not the current directory). Use strict mode (`set -euo pipefail`), quote expansions, and use functions with `local` variables. Code should be clean under `shellcheck`.
- Write your own tests in Bash: **`tests/run.sh`**, run as `bash tests/run.sh` from the repository root, exits 0 when all pass and non-zero otherwise. Use temporary directories, never the real home directory.
- Update the README with a short usage and test section.

## Command line

```
rotate snapshot --repo <dir> [--exclude <pattern>]... <source-dir>
rotate list     --repo <dir>
rotate prune    --repo <dir> [--keep-daily <n>] [--keep-weekly <n>] [--keep-monthly <n>] [--dry-run]
rotate restore  --repo <dir> <id|latest> <target-dir>
rotate --help
```

- After the command, options and positional arguments may appear in any order. Every option except `--exclude` may be given at most once. `--repo` is required.
- `rotate --help` (or `-h`) as the only argument prints a usage text starting with `usage: rotate` to stdout and exits 0.
- **Time:** the current time is taken from the environment variable `ROTATE_NOW` when it is set and non-empty, in the form `YYYY-MM-DDTHH:MM:SSZ` (UTC, must be a real date and time), otherwise from the system clock. All times are UTC. Only `snapshot` uses the time; for it, an invalid `ROTATE_NOW` is a usage error: `error: invalid ROTATE_NOW: <value>`.
- A **snapshot id** is the snapshot time formatted as `YYYYMMDDTHHMMSSZ` (for example `20260301T143000Z`). The snapshot is stored as `<repo>/snap-<id>.tar.gz`. Only files whose name is exactly `snap-` + an id + `.tar.gz` are snapshots; every other file in the repository is ignored and never touched.

### snapshot

Creates `snap-<id>.tar.gz` for the current time: a gzip-compressed tar archive of the *contents* of `<source-dir>` (member paths relative to the source directory, such as `./notes.txt` or `notes.txt`), including hidden files, empty directories, symlinks and permissions. Each `--exclude <pattern>` is passed to `tar --exclude`.

- Prints `created <id>`.
- The repository directory is created (with missing parents) if needed.
- `<source-dir>` missing or not a directory: exit 3, `error: source is not a directory: <source-dir>`.
- A snapshot with that id already exists: exit 1, `error: snapshot already exists: <id>`.
- The archive is written to a temporary file in the repository whose name starts with `.` and renamed into place when complete. If `tar` fails (for example an unreadable file), exit 3 and leave no archive or temporary file behind.

### list

One line per snapshot, oldest first: `<id>\t<YYYY-MM-DD HH:MM:SS>\t<size in bytes>` (tab separated; the time is the snapshot time from the id). An empty repository prints nothing. A missing repository: exit 3, `error: repository not found: <dir>`.

### prune

Applies the retention policy, deciding only from the snapshot ids (archives are not opened). Defaults: `--keep-daily 7 --keep-weekly 4 --keep-monthly 6`; `<n>` is a non-negative decimal integer, and an option given replaces only its own default. If all three are 0: exit 2, `error: nothing to keep`.

Rules (the same as common backup tools): walk the snapshots from newest to oldest. For the daily rule, a snapshot is kept if it is the newest snapshot of its calendar day, until `keep-daily` days have been kept; snapshots in days with no snapshot are not counted, so "7 days" means the 7 most recent days *that have snapshots*. The weekly rule does the same with ISO weeks (Monday to Sunday, ISO week-numbering year, as `date +%G-%V`), and the monthly rule with calendar months. A snapshot is kept if any rule keeps it; all others are deleted.

Output, one line per snapshot from newest to oldest, then a summary:

```
keep 20260301T120000Z daily,weekly,monthly
keep 20260228T120000Z daily
delete 20260228T060000Z
...
deleted 5 of 12 snapshots
```

- A kept snapshot lists the rules that keep it, comma separated, in the order `daily,weekly,monthly`.
- With `--dry-run`, nothing is deleted and the last line is `would delete <d> of <n> snapshots` instead.
- A missing repository: exit 3, `error: repository not found: <dir>`.

### restore

Extracts a snapshot into `<target-dir>`; `latest` means the newest snapshot. Prints `restored <id> to <target-dir>`.

- `<id>` that is neither `latest` nor a well-formed id: exit 2, `error: invalid snapshot id: <id>`.
- No such snapshot (or `latest` in an empty repository): exit 1, `error: snapshot not found: <id>` (with `latest` as `<id>` in the second case). A missing repository: exit 3, `error: repository not found: <dir>`.
- `<target-dir>` may be missing (it is created, with missing parents) or an empty directory. If it exists and is not an empty directory: exit 1, `error: target not empty: <target-dir>`.
- Extract into a temporary directory next to the target and move it into place only when extraction succeeded. If the archive is damaged: exit 3, the target is left as it was (not created if it was missing), and no temporary directories remain.

## Locking

`snapshot` and `prune` (including `--dry-run`) lock the repository with the file **`<repo>/.rotate.lock`**, which contains the PID of the holder followed by a newline. Create it atomically (for example with `set -o noclobber`). If the lock file already exists:

- if its content is a PID of a running process (`kill -0` succeeds): exit 4 with `error: repository is locked by pid <pid>`, changing nothing;
- otherwise the lock is stale: print `warning: removing stale lock` to stderr, replace it, and continue.

The lock is removed when the command finishes, whether it succeeds, fails or is interrupted (`INT`/`TERM`); the lock file never remains after `rotate` exits. `list` and `restore` do not lock.

## Exit codes and errors

| code | situation |
|---|---|
| 0 | success (and `--help`) |
| 1 | snapshot already exists, snapshot not found, target not empty |
| 2 | usage error: no or unknown command, unknown or repeated option, missing option value, missing or extra positional arguments, missing `--repo`, invalid `<n>`, invalid id, invalid `ROTATE_NOW`, `nothing to keep` |
| 3 | I/O error: source not a directory, repository not found, `tar` failure, cannot write |
| 4 | repository locked by another running process |

Arguments are validated before anything is read or written. Error messages go to stderr and start with `error: `; on an error nothing is printed to stdout.
