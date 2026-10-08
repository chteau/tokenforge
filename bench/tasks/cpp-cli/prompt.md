# New tool: `kvdb`

Build **`kvdb`**, a tiny persistent key-value store with a command-line interface, written in C++. Data lives in an append-only write-ahead log inside a database directory; the log can be compacted. The repository is empty apart from a README; create the project from scratch.

## Constraints

- **C++20**, standard library only, plus POSIX system headers if you need them (for example `<unistd.h>`/`<fcntl.h>` for `fsync`). No third-party libraries or packages of any kind (no GoogleTest, no Boost, nothing fetched or installed).
- Build with **CMake** (a `CMakeLists.txt` at the repository root). From the repository root, these commands must succeed with the system compiler (g++ 13; clang++ 18 should also work):

  ```
  cmake -S . -B build -G Ninja
  cmake --build build
  ```

  and must produce the executable **`build/kvdb`**.
- Compile with **`-Wall -Wextra`** (set them in your `CMakeLists.txt`). The build must be free of compiler warnings.
- Organise the code into several components, each a separate source file with its own header (for example: log/storage, the in-memory index, command-line handling) rather than one big `main.cpp`. All writes to files in the database directory must go through a single storage component. Manage file handles with RAII. Do not put `using namespace std;` in headers.
- Add automated tests and register them with CTest (`enable_testing()` / `add_test`), so that `ctest --test-dir build` runs and passes them after the build above. A small hand-written assertion harness is fine.
- Update the README with a short build and usage section.

## Command line

```
kvdb --db <dir> set <key> <value>
kvdb --db <dir> get <key>
kvdb --db <dir> del <key>
kvdb --db <dir> scan [--prefix <p>] [--limit <n>]
kvdb --db <dir> compact
kvdb --db <dir> stats
kvdb --help
```

- `--db <dir>` must be the first two arguments; the command follows. The directory is created (including missing parents) if it does not exist.
- `kvdb --help` (or `-h`) as the only argument prints a usage text starting with `usage: kvdb` to stdout and exits 0.
- The positional arguments of `set`/`get`/`del` are taken literally: `kvdb --db d set k --x` stores the value `--x`.

### Keys and values

- A **key** is 1 to 256 bytes and must not contain any byte `<= 0x20` (space, tab, newline, other control characters) or `0x7F`. Any other bytes, including UTF-8, are allowed.
- A **value** is 0 to 65536 bytes and must not contain `\n` or `\r`. Everything else is allowed (spaces, tabs, `=`, UTF-8, the empty string).
- An invalid key or value is a usage error (exit 2).

### Commands

| command | stdout on success | notes |
|---|---|---|
| `set <key> <value>` | `OK` | inserts or replaces the value |
| `get <key>` | the value | key missing: exit 1 |
| `del <key>` | `OK` | key missing: exit 1, and nothing is written to the log |
| `scan [--prefix <p>] [--limit <n>]` | one line per entry: `<key>\t<value>` (a single tab) | see below |
| `compact` | `compacted <before> -> <after> bytes` | see below |
| `stats` | three lines, see below | |

Every stdout line ends with `\n`. Nothing else is printed to stdout.

**scan** lists live keys whose key starts with `<p>` (default: all keys), in ascending order comparing keys as unsigned bytes (so `Z` < `a` < `é`), at most `<n>` entries (default: unlimited). `--prefix` and `--limit` may appear in either order, each at most once; `<n>` must be a positive decimal integer (`1`, `20`; not `0`, `-1`, `x`). No matching keys prints nothing and exits 0.

**stats** prints exactly:

```
keys: <number of live keys>
records: <number of valid records in the log>
log_bytes: <total size in bytes of the valid records in the log>
```

**compact** rewrites the log so that it holds exactly one record per live key (overwritten and deleted entries are dropped). `<before>` is `log_bytes` before compaction, `<after>` is `log_bytes` afterwards. After `compact`, `records` equals `keys`.

### Exit codes and errors

| code | situation |
|---|---|
| 0 | success (and `--help`) |
| 1 | `get`/`del` of a key that does not exist: stderr is exactly `error: key not found: <key>` |
| 2 | usage error: no arguments, missing `--db` or its value, unknown command, wrong number of arguments, unknown or repeated `scan` option, invalid `--limit`, invalid key or value |
| 3 | I/O error, for example `<dir>` exists but is not a directory, or a file cannot be read or written |

All error messages go to stderr and start with `error: `. On an error nothing is printed to stdout.

## Storage guarantees

These are checked from the outside, so follow them exactly. The record format itself is up to you.

- The log is the file **`<dir>/data.log`**. It is the only file the database keeps; after any command finishes, the directory contains no other files (temporary files used by `compact` are renamed or removed before exiting).
- Each successful `set` or `del` appends exactly one record to the end of `data.log` and never modifies bytes that were already there. The record is flushed to disk (`fsync`) before `OK` is printed. Only `compact` rewrites the file, and it does so atomically (write a new file, then rename it over `data.log`), so a crash during compaction leaves either the old or the new log.
- Every record carries a checksum (for example CRC-32) over its contents.
- **Recovery:** when the log is read, records are read from the start; reading stops at the first record that is incomplete (the file ends in the middle of it) or whose checksum does not match. That record and everything after it are ignored, as if the file ended there. This handles a crash in the middle of an append, garbage appended to the file, and a damaged record.
- Read-only commands (`get`, `scan`, `stats`) never modify `data.log`. The next `set`, `del` or `compact` first discards the ignored bytes (truncates the file back to its valid part), so afterwards the file size equals `log_bytes` and new records are readable after a restart.
- A missing `data.log` means an empty database.
