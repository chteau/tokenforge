# New tool: `tally`

Build **`tally`**, a command-line tool that tracks shared expenses inside groups of friends (like a small offline Splitwise): groups, members, expenses split equally, by percentage or by exact amounts, payments between members, several currencies with fixed exchange rates, balances, and settle-up suggestions. The repository is empty apart from a README; create the project from scratch.

## Constraints

- **F# on .NET 8** (the `dotnet` 8 SDK). Only the SDK, `FSharp.Core` and the .NET base class library (e.g. `System.Text.Json`). No other NuGet packages: the machine is offline, so restores must work from the local package cache (the SDK ships the `FSharp.Core` package; set `<NuGetAudit>false</NuGetAudit>` if the offline vulnerability audit warns).
- The app project is **`src/Tally/Tally.fsproj`** (`net8.0`, `OutputType` `Exe`, **`AssemblyName` `tally`**). It must build with `dotnet build src/Tally/Tally.fsproj` and run with `dotnet run --project src/Tally -- <args>` or `dotnet <output dir>/tally.dll <args>`.
- The build must produce **no compiler warnings**.
- Split the code into several modules/files (e.g. money and rounding, the domain rules, JSON storage, command-line handling) rather than one big `Program.fs`. Keep the splitting/settlement logic free of file and console I/O. Represent money exactly (integer cents or `decimal`), never with `float`.
- No test framework packages are available offline (no xUnit, NUnit, Expecto). Write your own tests as a **console project `tests/Tally.Tests/Tally.Tests.fsproj`** that references the app project, runs your checks with a tiny hand-written assertion helper, prints a summary and **exits non-zero if any check fails**. `dotnet run --project tests/Tally.Tests` must pass.
- Update the README with a short build/test/usage section.

## Command line

```
tally [--data FILE] <command> [args...]
tally --help
```

- Data file: `--data FILE` (must be the first two arguments if given), otherwise the `TALLY_DATA` environment variable, otherwise `tally.json` in the current directory. A missing file means no groups yet; it is created by the first successful command that changes data.
- `tally --help` (or `-h`) as the only argument prints a usage text starting with `usage: tally` to stdout and exits 0.

| command | stdout on success |
|---|---|
| `group add <group> <CUR>` | `created group <group> (<CUR>)` |
| `group list` | one line per group, sorted by name (ordinal): `<group> <CUR> members=<n> entries=<n>` |
| `member add <group> <name>` | `added member <name> to <group>` |
| `rate set <group> <CUR> <rate>` | `rate <CUR>-><BASE> <rate>` (the rate exactly as typed) |
| `expense <group> <payer> <amount> <description> [options]` | `added expense #<id>: <base amount> <BASE>` |
| `pay <group> <from> <to> <amount> [--currency CUR]` | `added payment #<id>: <base amount> <BASE>` |
| `list <group>` | one line per entry, by id (see below) |
| `show <group> <id>` | the entry's list line, then its shares (see below) |
| `rm <group> <id>` | `removed #<id>` |
| `balances <group>` | one line per member, in the order they were added |
| `settle <group>` | suggested transfers, one per line, or `all settled` |

Every stdout line ends with `\n`; nothing else goes to stdout.

**Names and values.** Group and member names match `[A-Za-z][A-Za-z0-9_-]{0,31}`, member names are unique within a group (case-sensitive) and a group's members are kept in the order they were added. Currencies are three uppercase ASCII letters. Each group has a base currency (`<BASE>`). An amount is a positive decimal with at most two decimals (`12`, `12.5`, `12.50`; not `0`, `-3`, `1.234`, `1e3`, `.5`) and at most `1000000.00`. A rate is a positive decimal with at most six decimals; `rate set` stores or replaces the rate meaning "1 `<CUR>` = `<rate>` `<BASE>`". Setting a rate for the base currency itself is an error. Descriptions are any non-empty text.

**Money output** always has exactly two decimals (`3.40`, `1250.00`).

### Expenses

Options for `expense` (after the positional arguments, any order, each at most once):

- `--currency CUR`: currency of `<amount>` (default the base currency). A non-base currency needs a rate set for that group, otherwise `error: no rate for currency: <CUR>`.
- `--split equal|exact|percent` (default `equal`).
- `--among a,b,c` (only with `equal`): the participants, in that order. Default: all current members in member order.
- `--shares a=V,b=V,...` (required for `exact` and `percent`, not allowed with `equal`): participants in that order. For `exact`, each `V` is an amount in the expense currency and they must sum to exactly `<amount>`; for `percent`, each `V` is a positive number with at most two decimals and they must sum to exactly `100`.

Payer and every participant must be members of the group; a participant listed twice is an error. The payer need not be a participant.

**Conversion.** The base amount `T` = `<amount>` × rate, rounded to cents with **banker's rounding** (round half to even: `5.125` → `5.12`, `5.175` → `5.18`). Entries store their base amounts at the time they are added; later rate changes do not affect them.

**Splitting** (always done on `T` in base cents, so shares always sum to `T`): each participant gets a weight (`equal`: 1; `exact`: their amount; `percent`: their percentage). Participant `i` first gets `floor(T × wᵢ / W)` cents (`W` = sum of weights). The cents still missing are handed out one each to the participants with the largest remainder `(T × wᵢ) mod W`; ties go to the participant listed earlier. Example: `10.00` equally among three gives `3.34, 3.33, 3.33`.

### Payments

`pay` records that `<from>` paid `<to>` money directly (`<from>` ≠ `<to>`, both members). The amount is converted like an expense.

### Listing

`list` prints, by ascending id:

- expense in the base currency: `#<id> expense <payer> <amount> <BASE> "<description>"`
- expense in another currency: `#<id> expense <payer> <amount> <CUR> = <base amount> <BASE> "<description>"`
- payment: `#<id> payment <from> -> <to> <amount> <CUR>` with ` = <base amount> <BASE>` appended when the currency differs.

`show` prints the list line, then for an expense one line per participant in participant order: two spaces, the name, a space and the share in base currency (`  bob 3.33`). Ids are positive integers that start at 1 and increase per group; ids are never reused, even after `rm`.

### Balances and settling up

A member's balance = base amounts they paid (expenses as payer, payments as `<from>`) − their expense shares − base amounts of payments they received. `balances` prints `<name> <balance> <BASE>`, with a `+` sign for positive balances, `-` for negative, and `0.00` for zero (`alice +20.00 EUR`).

`settle` computes transfers `<debtor> -> <creditor> <amount> <BASE>` that bring every balance to zero:

1. Exact matches first: for each debtor (negative balance) in member order, pick the earliest creditor in member order, not already matched in this step, whose balance equals exactly the debt; emit that transfer.
2. Then repeatedly take the debtor with the largest debt and the creditor with the largest credit (ties: earlier in member order) and transfer the smaller of the two amounts, until all balances are zero.

Print the transfers in the order they were produced; print `all settled` if every balance is zero.

## Errors and exit codes

| code | situation |
|---|---|
| 0 | success (and `--help`) |
| 1 | the request is well-formed but not allowed: unknown group/member/entry, duplicate group or member, invalid name/currency/amount/rate/percentage, missing rate, shares that do not add up, duplicate participant, empty description, `<from>` = `<to>`, rate for the base currency |
| 2 | usage error: no arguments, unknown command, wrong number of arguments, unknown/repeated/value-less option, `--shares` or `--among` not allowed for the split type, `--shares` missing, a `--shares` item without `=`, unknown split type |
| 3 | the data file cannot be read or written, or is not valid JSON |

All error messages go to stderr and start with `error: `; on any error nothing is printed to stdout and the data file is left unchanged. These messages must be exact: `error: unknown group: <g>`, `error: unknown member: <name>`, `error: unknown entry: <id>`, `error: group already exists: <g>`, `error: member already exists: <name>`, `error: no rate for currency: <CUR>`, `error: duplicate participant: <name>`.

## Storage

The data file is UTF-8 JSON (the layout is up to you) holding everything needed to answer later commands. Write it atomically (write a temporary file in the same directory, then rename it over the data file) and never leave the temporary file behind.
