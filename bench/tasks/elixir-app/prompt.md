# New tool: `jobq`

Build **`jobq`**, a small persistent job queue written in Elixir: priorities, delayed jobs, retries with exponential backoff, a dead-letter state, and a command-line front-end. Each CLI invocation loads the queue from a state file, applies one command, and saves it again. The repository is empty apart from a README; create the project from scratch.

## Constraints

- **Elixir 1.20 / OTP 29**, standard library only: no dependencies in `mix.exs` (nothing fetched from Hex).
- A Mix project for the OTP application `:jobq`. From the repository root, `mix escript.build` must produce the executable **`./jobq`** (escript), and `mix compile --warnings-as-errors`, `mix test` and `mix format --check-formatted` must all succeed.
- Structure: the application starts a supervisor, and the queue state lives in a **GenServer** (for example `Jobq.Queue`) under that supervisor. The CLI only parses arguments, calls the GenServer's client API, and prints. Keep persistence (reading and writing the state file) in its own module, and the queue rules (ordering, retries, backoff) testable without the CLI. Several modules under `lib/`, not one big file.
- Write your own ExUnit tests under `test/` (queue rules, persistence, CLI parsing). Update the README with build and usage notes.

## Environment

- `JOBQ_STATE` — path of the state file (default: `jobq.state` in the current directory). A missing file means an empty queue. The file format is up to you.
- `JOBQ_NOW` — the current time as a non-negative integer number of Unix seconds. When unset, use the system clock. Any other value is a usage error: `error: invalid JOBQ_NOW`. All times in this tool are integer Unix seconds.

## Jobs

A job has: an `id` (1, 2, 3, … assigned in order and never reused, even after jobs are removed), a `name`, a `payload`, a `priority`, `max_attempts`, a `backoff` base, the number of `attempts` made so far, a `run_at` time, a status (queued, running, done, dead), a `lease_until` time while running, and the `last_error`.

The **displayed state** of a job is one of: `scheduled` (queued and `run_at` > now), `ready` (queued and `run_at` <= now), `running`, `done`, `dead`.

## Command line

```
jobq add NAME [--payload TEXT] [--priority N] [--delay SECONDS | --at TIME] [--max-attempts N] [--backoff SECONDS]
jobq take [--lease SECONDS]
jobq ack ID
jobq fail ID [--error TEXT]
jobq retry ID
jobq cancel ID
jobq list [--state STATE]
jobq show ID
jobq stats
jobq purge
jobq --help
```

Options come after the command and may be mixed with the positional argument. An option's value is always the next argument, taken literally. `jobq --help` (or `-h`) prints a text starting with `usage: jobq` and exits 0.

Validation (anything else is a usage error, exit 2): `NAME` is 1–64 characters from `A-Z a-z 0-9 _ . : -`; `TEXT` is at most 1024 bytes and contains no `\n` or `\r`; numbers are plain decimal digits; `ID` is a positive integer; `--priority` 0–9 (default 0, **higher runs first**); `--delay` ≥ 0; `--at` ≥ 0; `--delay` and `--at` together are an error; `--max-attempts` 1–100 (default 3); `--backoff` 1–3600 (default 10); `--lease` 1–86400 (default 60); `--state` one of the five displayed states. Unknown options, repeated options, options of another command, missing or extra arguments are usage errors.

| command | effect | stdout |
|---|---|---|
| `add` | new queued job, `attempts` 0, `run_at` = now + delay, or `--at`, or now | the new id, e.g. `7` |
| `take` | picks the next ready job (below); it becomes running, `attempts` + 1, `lease_until` = now + lease | `<id>\t<name>\t<payload>` |
| `ack` | running job → done | `done <id>` |
| `fail` | failure of a running job at time now (below); default error text `failed` | `retry <id> at <run_at>` or `dead <id>` |
| `retry` | dead job → queued, `attempts` 0, `run_at` = now | `requeued <id>` |
| `cancel` | queued job (ready or scheduled) is deleted | `cancelled <id>` |
| `list` | jobs ordered by id, optionally only one displayed state | `<id>\t<state>\t<priority>\t<attempts>/<max_attempts>\t<run_at>\t<name>` per job |
| `show` | one job | the block below |
| `stats` | counts | the block below |
| `purge` | deletes all done jobs | `purged <count>` |

**Next job** for `take`: among ready jobs, the highest priority; ties go to the earliest `run_at`, then the lowest id. When no job is ready, `take` prints nothing, writes `error: no job ready` to stderr and exits 4.

**Failure** of a job at time `t` sets `last_error` and clears the lease. If `attempts` < `max_attempts` the job is queued again with `run_at = t + min(backoff * 2^(attempts - 1), 3600)` (so with backoff 10: 10, 20, 40, … seconds after the 1st, 2nd, 3rd attempt). Otherwise it becomes dead (`run_at` unchanged). Only `add`, a retry after failure, and `retry` change `run_at`.

**Lease expiry**: before running any command, every running job whose `lease_until` <= now fails with the error `lease expired` at time `lease_until`, processed in order of `lease_until`, then id. This happens first, so e.g. `ack` of a job whose lease has expired sees it as no longer running.

`show ID` prints exactly these lines (`-` when there is no lease or no error):

```
id: 3
name: email.send
state: running
priority: 5
attempts: 1/3
backoff: 10
run_at: 1000
lease_until: 1060
last_error: -
payload: to=ann@example.com
```

`stats` prints exactly:

```
ready: <n>
scheduled: <n>
running: <n>
done: <n>
dead: <n>
total: <n>
next_run_at: <smallest run_at among scheduled jobs, or ->
oldest_ready_age: <now minus the smallest run_at among ready jobs, or ->
```

## Persistence

- After a command that changed anything (including lease expiries), the whole queue is written to a temporary file in the same directory and renamed over `JOBQ_STATE`. Commands that change nothing leave the file untouched and do not create it. No other files remain afterwards.
- An unreadable or corrupt state file: `error: cannot load state: <path>`, exit 3, file left as it is. A failed write: `error: cannot save state: <path>`, exit 3.

## Errors and exit codes

| code | situation |
|---|---|
| 0 | success (and `--help`) |
| 1 | unknown job id: `error: job not found: <id>` |
| 2 | usage error (see validation above) |
| 3 | state file cannot be read, parsed or written |
| 4 | `take` found no ready job |
| 5 | the job is in the wrong state for the command: `error: job <id> is <displayed state>` |

All errors go to stderr, start with `error: `, and nothing is printed to stdout on an error. A failing command does not modify the state file (lease expiries included).
