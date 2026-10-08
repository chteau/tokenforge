# tally

A small, plain-text expense ledger for the command line. No database, no
dependencies: your money lives in a text file you can read, grep, diff and
edit by hand.

```console
$ tally init
initialised empty ledger in /home/me/.tally
$ tally add 2026-01-03 12.50 groceries --payee "Corner Shop" --tag food
added entry 1
$ tally add 2026-01-31 2500 salary --income --payee "ACME Ltd"
added entry 2
$ tally list
ID  DATE        CATEGORY     AMOUNT  PAYEE        TAGS  NOTE
 1  2026-01-03  groceries   -$12.50  Corner Shop  food
 2  2026-01-31  salary     $2500.00  ACME Ltd
---------------------------------------------------------
    total                  $2487.50
```

## Building

```console
$ cargo build --release
$ cargo test
```

Only the Rust standard library is used.

## Data directory

All files live in one directory, chosen as follows:

1. `--dir DIR`
2. the `TALLY_DIR` environment variable
3. `$HOME/.tally`

| File            | Purpose                                              |
|-----------------|------------------------------------------------------|
| `ledger.txt`    | the entries (see *File format*)                      |
| `config.ini`    | optional configuration                               |
| `summary.cache` | cached per-category / per-month totals; safe to delete |

## Commands

Global options, accepted anywhere on the command line:
`--dir DIR` and `--format table|json|csv`.

| Command | Description |
|---------|-------------|
| `init` | Create an empty ledger. |
| `add DATE AMOUNT CATEGORY [--payee P] [--note N] [--tag T]... [--income]` | Record an expense (or income). |
| `list [--filter EXPR] [--month YYYY-MM \| --from D --to D] [--sort KEY] [--desc] [--limit N]` | List entries. Sort keys: `date` (default), `amount`, `category`, `payee`, `id`. |
| `edit ID [--date D] [--amount A] [--category C] [--payee P] [--note N] [--tag T]... [--clear-tags] [--income \| --expense]` | Change fields of an entry. `--tag` replaces all tags. |
| `remove ID` | Delete an entry. Ids are never reused. |
| `rename-category OLD NEW` | Move every entry from one category to another. |
| `categories` | Count, expenses and income per category. |
| `report monthly [--year YYYY]` | Totals per month with a grand total. |
| `report categories [--filter EXPR] [--month M \| --from D --to D]` | Spending breakdown by category, largest first, with each category's share of spending. |
| `import FILE [--category C] [--dry-run]` | Import a bank CSV export. |
| `config` | Show every configuration key, its value and where it came from. |

### Values

* Dates are `YYYY-MM-DD` (years 1970–2100).
* Amounts are positive decimals with at most two decimal places: `12`,
  `12.5`, `1,250.00`. Money is stored as integer cents.
* Categories are lower-cased and may contain letters, digits, `-` and `_`
  (at most 32 characters).
* Tags may be written as `food` or `#food`; they are lower-cased,
  de-duplicated and may contain letters, digits and `-` (at most 16
  characters).
* Payees are at most 64 characters, notes at most 200.

### Filter expressions

```text
category=groceries and amount>=20
payee~market or tag=food
not (month=2026-02) and kind=expense
```

Fields: `id`, `date`, `month`, `kind` (`expense`/`income`), `amount`,
`category`, `payee`, `note`, `tag`. Operators: `=`, `!=`, `<`, `<=`, `>`,
`>=` and `~` (contains). Text comparisons ignore case. Combine with `and`,
`or`, `not` and parentheses; `and` binds tighter than `or`. Quote values
containing spaces: `payee="corner shop"`.

### Output formats

Every command that prints a table supports `--format`:

* `table` — aligned columns with a totals row where it makes sense;
* `json` — an array of objects, amounts as numbers (`-12.50`);
* `csv` — a header row of keys, then one line per row.

### Exit codes

`0` success, `1` invalid data or I/O error, `2` usage error, `3` the
referenced entry or category does not exist.

## Configuration

`config.ini` in the data directory:

```ini
[general]
currency_symbol = €        ; shown in tables only

[output]
format = table             ; default output format
note_width = 30            ; truncate notes in tables

[import]
default_category = uncategorized
skip_duplicates = true     ; skip rows matching an existing entry

[cache]
enabled = true
```

Any key can be overridden from the environment as
`TALLY_<SECTION>_<KEY>`, for example `TALLY_OUTPUT_FORMAT=json`.
Unknown keys are an error.

## Importing bank exports

`tally import` reads the CSV format most banks offer:

```text
Date,Description,Amount,Balance
03/01/2026,"CORNER SHOP, HIGH ST",-12.50,987.50
```

Dates are day-first; negative amounts become expenses and positive amounts
income. Rows with the same date, amount and payee as an existing entry are
skipped, so importing overlapping exports is safe. The whole import fails
(and nothing is written) if any row is invalid.

## File format

`ledger.txt` is one entry per line:

```text
# tally ledger v1
next_id=3
1|2026-01-03|expense|12.50|groceries|Corner Shop||food
2|2026-01-31|income|2500.00|salary|ACME Ltd||
```

Fields: id, date, kind, amount, category, payee, note, comma-separated tags.
Inside a field `\` is written `\\`, `|` is `\|` and line breaks are `\n`.
Blank lines and lines starting with `#` are ignored. Every write goes to a
temporary file that is then renamed over the ledger, so a crash never leaves
a half-written file.
