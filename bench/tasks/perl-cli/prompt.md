# New tool: `cfgmerge`

Build **`cfgmerge`**, a command-line tool that lints INI and `.env` configuration files, merges several of them in layers (later layers win), expands `${...}` references, validates the result against a schema, and explains where every value came from. The repository is empty apart from a README; create the project from scratch.

## Constraints

- **Perl 5** (`/usr/bin/perl`, 5.38) with **core modules only** — nothing from CPAN, nothing installed. `use strict; use warnings;` (or `use v5.36;`) in every file; `perl -wc` must report no warnings.
- The program is **`bin/cfgmerge`** (executable, `#!/usr/bin/perl`), run from the repository root as `perl bin/cfgmerge ...` or `bin/cfgmerge ...`. Put the logic in modules under **`lib/`** (e.g. `lib/CfgMerge/Parser.pm`, `.../Interpolate.pm`, `.../Schema.pm`, `.../Output.pm`); the script only wires them together and must find `lib/` on its own (e.g. `FindBin`).
- Write tests with `Test::More` in **`t/*.t`**; `prove -l t` must pass.
- Update the README with a short usage section.

## Command line

```
cfgmerge lint FILE...
cfgmerge merge [--schema S [--strict]] [--set KEY=VALUE]... [--format ini|env] FILE...
cfgmerge get [--set KEY=VALUE]... KEY FILE...
cfgmerge explain [--schema S [--strict]] [--set KEY=VALUE]... FILE...
cfgmerge diff FILE_A FILE_B
cfgmerge --help
```

Options may appear anywhere after the command; `--` ends option processing. `--set` may repeat; the others at most once. `--help` (or `-h`) as the only argument prints text starting with `usage: cfgmerge` to stdout, exit 0.

**Format by file name**: a base name of `.env`, starting with `.env.`, or ending in `.env` is an env file; ending in `.ini`, `.cfg` or `.conf` is an INI file; anything else is a usage error `error: cannot tell the format of <FILE>`. The schema file is always INI. Files are UTF-8; a leading BOM and `\r` before `\n` are ignored.

## Keys

A **name** matches `[A-Za-z_][A-Za-z0-9_]*`; a **key** is one or more names joined by `.` (`db.replica.host`). Keys are case-insensitive and stored lowercase. INI key `k` in section `[s]` is the key `s.k` (outside any section it is just `k`). An env name maps to a key by lowercasing it and turning every `__` into `.` (`DB__HOST` → `db.host`). The result must be a valid key, otherwise `invalid key`.

## File syntax

INI, line by line (leading/trailing whitespace ignored):
- empty lines and lines starting with `;` or `#` are comments;
- `[section]`: the section is a key (spaces inside the brackets are trimmed); after `]` only whitespace or a comment (`;`/`#`) may follow; sections may repeat;
- `key = value`: key is a key (may contain dots, e.g. `pool.size`), spaces around `=` are optional.

Env: same comments; `KEY=VALUE` with an optional `export ` prefix and optional spaces around `=`; no section headers.

**Values** (both formats): the text after `=`, trimmed. If it starts with `"`: a double-quoted string with escapes `\\ \" \n \t \$` (any other backslash is kept literally); `${...}` references are expanded. If it starts with `'`: a literal single-quoted string, no escapes, no expansion. After the closing quote only whitespace and optionally a comment (`;` or `#`) may follow. Otherwise the value is unquoted: it ends at the first `;` or `#` that is preceded by whitespace (an inline comment), is trimmed, and `${...}` references are expanded. Keys defined more than once in one file: the last definition wins.

**Lint diagnostics** (exact message texts):

| problem | message |
|---|---|
| bad `[...]` line | `error: invalid section header` |
| line without `=` | `error: missing '='` |
| invalid key / env name | `error: invalid key '<as written>'` |
| no closing quote | `error: unterminated quote` |
| text after the closing quote | `error: trailing characters after closing quote` |
| bad `${`, e.g. `${a b}` or `${x` | `error: invalid reference` |
| `[...]` in an env file | `error: section headers are not allowed in env files` |
| key defined twice in one file | `warning: duplicate key '<key>' (previous definition on line <n>)` |

`lint` prints one line per problem to stdout, `<FILE>:<LINE>: <message>`, files in argument order, lines in order, then a summary `<N> error(s), <M> warning(s)`. Exit 1 if there was any error, else 0. Every other command, when a layer has errors, prints only the error lines (same format) to stderr and exits 1.

## Merging and references

Layers are the FILEs in order, then the `--set` values in order (unquoted values; KEY is a key in INI notation). A later layer overrides a key of an earlier one. After merging, references in the final values are expanded:

- `${key}` — the final value of that key (normalised like keys: case-insensitive, `__` = `.`, so `${DB__HOST}` = `${db.host}`), itself fully expanded;
- `${env:NAME}` — the process environment variable `NAME`;
- `${key:-text}` / `${env:NAME:-text}` — `text` (literal, may be empty, no `}`) when the key/variable is undefined;
- `$$` — a literal `$`; a `$` not followed by `{` or `$` is literal.

Errors (exit 1): `error: undefined reference '${<as written>}' in key '<key>'` and `error: reference cycle: a -> b -> a`. Keys are expanded in ascending byte order; references in a value are followed left to right, depth-first; a cycle is reported as the chain starting at the first key that repeats, e.g. if `a` → `b` → `c` → `b`, the message is `reference cycle: b -> c -> b`. Report only the first error.

## Schema

The schema is an INI file with one section per key, e.g. `[db.port]`, holding properties:

- `type` (required): `string`, `int` (`-?[0-9]+`), `number` (`-?[0-9]+(\.[0-9]+)?`), `bool` (`true false yes no on off 1 0`, case-insensitive), `enum`;
- `required` (`true`/`false`, default false); `default` (a literal value used when the key is missing);
- `min`/`max` (numbers): value bounds for `int`/`number`, length bounds (in characters) for `string`;
- `values` (only and required for `enum`): comma-separated allowed values, trimmed.

Anything else (unknown property or type, `min` on an enum, top-level properties outside a section...) is `error: invalid schema: <key>: <reason>`, exit 2. With a schema, after expansion: missing keys with a `default` get it, then each schema key is checked (first failure only, in this order), and with `--strict` each non-schema key is an error. Messages go to stderr, sorted by key, as `error: <key>: <message>`, then exit 1:

`required key is missing` · `expected <type>, got "<value>"` · `"<value>" is not one of: <values joined by ", ">` · `<value> is less than minimum <min>` · `<value> is greater than maximum <max>` · `length <n> is less than minimum <min>` · `length <n> is greater than maximum <max>` · `not in schema`

(`<min>`/`<max>` are printed as written in the schema.)

## Output

**merge** prints the final config. `--format ini` (default): top-level keys first, then one block per section (the key minus its last name) as `[section]`, with a blank line before each section header unless it is the first line; sections and keys in ascending byte order; lines `name = value`. `--format env`: `NAME=value` lines sorted by NAME, where NAME is the key uppercased with `.` → `__`. In both, a value is written bare unless it is empty or contains whitespace at either end, or any of `" ' \ # ; $`, a tab or a newline; then it is written double-quoted with `\\ \" \n \t \$` escapes. Re-reading the output gives the same values.

**get** prints the final value of KEY followed by `\n`; unknown key: `error: key not found: <key>`, exit 1.

**explain** prints, per final key in ascending order, `<key> = "<value>"  [<source>]`, then for every earlier layer that also set it, newest first, `  overrides "<value as written, unexpanded>"  [<source>]`. Values are shown double-quoted with the escapes above (without `\$`). A source is `<FILE>:<LINE>` (FILE as given), `--set`, or `default` (from the schema).

**diff** expands each file on its own and prints, by ascending key: `- <key> = "<value>"` (only in A), `+ <key> = "<value>"` (only in B), `~ <key>: "<a>" -> "<b>"` (changed). Exit 0 when identical (no output), 1 when different.

## Exit codes

0 success · 1 lint errors, layer errors, reference errors, schema violations, `get` of a missing key, `diff` differences · 2 usage error (unknown command or option, missing arguments or option values, repeated option, `--strict` without `--schema`, `--format` other than `ini`/`env`, invalid `--set`, unknown file format, invalid schema) · 3 a file cannot be read (`error: cannot read <FILE>: <reason>`). All error messages go to stderr; on exit 2 or 3 nothing goes to stdout.
