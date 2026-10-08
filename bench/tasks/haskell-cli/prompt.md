# New tool: `cells`

Build **`cells`**, a command-line spreadsheet evaluator written in Haskell. It reads a grid of cells (numbers, text and formulas such as `=A1+B2*2` or `=SUM(A1:A9)`), evaluates every formula in dependency order, and prints the evaluated grid, a single cell, or a list of error cells. The repository is empty apart from a README; create the project from scratch.

## Constraints

- **GHC 9.14**, using only the packages that ship with GHC (`base`, `containers`, `text`, `bytestring`, `parsec`, `mtl`, ...). No Cabal or Stack package downloads; nothing fetched or installed.
- Provide a **`Makefile`** at the repository root with two targets, run from the repository root:
  - `make build` compiles the program to **`build/cells`** (for example `ghc --make -isrc -outputdir build/obj -o build/cells app/Main.hs`).
  - `make test` builds and runs your test executable; it exits 0 only if all tests pass.
- Layout: library modules under `src/`, the entry point in `app/Main.hs`, tests under `test/`. Split the code into several modules (for example: cell references, grid parsing, formula parser, evaluator, output formatting), each with an explicit export list. Keep parsing and evaluation pure: only `app/Main.hs` does IO.
- Compile with **`-Wall`** (set it in the Makefile); the build must be free of warnings.
- Write your own tests (a small hand-written assertion harness is fine; no hspec/QuickCheck). Update the README with build and usage notes.

## Command line

```
cells eval <file>           print the evaluated grid
cells get <file> <cell>     print the value of one cell, e.g. cells get sheet.csv B3
cells errors <file>         list the cells whose value is an error
cells --help                (or -h) usage text starting with "usage: cells" on stdout, exit 0
```

`<file>` may be `-` to read standard input. Input is UTF-8 and output is UTF-8 regardless of the locale.

| exit | situation |
|---|---|
| 0 | success; `errors` found no error cells |
| 1 | `get`: the cell's value is an error (the error code is still printed); `errors`: at least one error cell |
| 2 | usage error: no or unknown command, wrong number of arguments, `<cell>` is not a valid reference (checked before the file is read), or `<cell>` lies outside the grid |
| 3 | the file cannot be read: stderr is `error: cannot read <file>` |

Error messages go to stderr and start with `error: `; on exit 2 or 3 nothing is printed to stdout.

## Input format

- Each line is a row (the first line is row 1); a trailing `\r` is removed and a final newline does not start a new row. An empty line is a row with a single empty cell. An empty file has no rows.
- A row is split into cells at commas, except commas inside double quotes or inside parentheses: `=SUM(A1,B1)` and `"a,b"` are single cells. (Track a quote flag that every `"` toggles, and a parenthesis depth counted outside quotes that never goes below zero.)
- The **grid** has as many rows as the file and as many columns as its longest row; missing cells at the end of shorter rows are empty. Columns are named `A`..`Z`, `AA`, `AB`, ... and a reference is a column name followed by a row number (`B3`, `aa10`; case-insensitive, no `$`).
- Each cell's text is trimmed of spaces and tabs, then classified:
  - empty text: an **empty** cell;
  - starts with `=`: a **formula** (the rest of the text);
  - a quoted field (starts and ends with `"`, and every other `"` inside is doubled): **text** with the quotes removed and `""` turned into `"`. `"42"` is the text `42`, `""` is the empty text;
  - a number literal: optional `-`, one or more digits, optionally `.` and one or more digits (`7`, `-3.5`, `007`). `+1`, `.5`, `1.` and `1e3` are not numbers;
  - anything else: **text**, taken literally.

## Formulas

Spaces are allowed between tokens. Grammar, lowest precedence first (all binary operators are left-associative):

| level | syntax |
|---|---|
| comparison | `=` `<>` `<` `<=` `>` `>=` |
| concatenation | `&` |
| additive | `+` `-` |
| multiplicative | `*` `/` |
| unary | `-x` |
| primary | number literal (digits, optional `.digits`), string literal `"..."` (a doubled `""` is a quote), cell reference, function call `NAME(arg, ...)`, `( expr )` |

A **range** `A1:B3` (any two corners, in either order) may appear only as a direct argument of a function call. Function names are case-insensitive: `SUM`, `AVG`, `MIN`, `MAX`, `COUNT` (one or more arguments) and `IF(cond, then, else)` (exactly three).

Values are numbers (double precision), text, or empty (an empty cell). Rules:

- `+ - * /` and unary `-` convert operands to numbers: empty is 0, text is `#VALUE!`. Division by zero is `#DIV/0!`. A result that is not a finite number is `#NUM!`.
- `&` converts both sides to text (numbers use the output format below, empty is `""`) and joins them.
- Comparisons give `1` (true) or `0` (false). Two numbers compare numerically, two texts compare case-sensitively by code point. Empty counts as `0` next to a number, as `""` next to a text, and equals empty. A number compared with a text is `#VALUE!`.
- `SUM`, `AVG`, `MIN`, `MAX` take the numbers from their arguments: inside a range, numeric cells are used and empty and text cells are skipped; any other argument is converted to a number (empty is 0, text is `#VALUE!`). `SUM` of nothing is 0, `MIN`/`MAX` of nothing are 0, `AVG` of nothing is `#DIV/0!`. `COUNT` counts the numeric values among its arguments (ranges and other arguments alike); text and empty values are simply not counted, never `#VALUE!`.
- `IF` converts `cond` to a number; non-zero picks `then`, zero picks `else`. Only the picked branch is evaluated. A range given to `IF` is `#VALUE!`.
- A formula whose final value is empty (for example `=C9` with `C9` empty) has the value `0`.

### Errors

| code | meaning |
|---|---|
| `#PARSE!` | the formula is not valid syntax, including a wrong number of arguments for a known function, or a range outside a function argument |
| `#NAME?` | valid syntax, but calls an unknown function |
| `#CYCLE!` | the cell is part of a reference cycle (see below) |
| `#REF!` | a reference, or any corner of a range, lies outside the grid (`A0` is outside too) |
| `#DIV/0!` `#VALUE!` `#NUM!` | as described above |

- **Propagation:** an error in an operand or argument makes the result that error. Operands are evaluated left to right (both operands of a binary operator are evaluated before their types are checked), arguments in order, range cells row by row; the first error found wins. Referencing a cell whose value is an error yields that error.
- **Cycles:** every reference in a valid formula (in any `IF` branch, every cell of an in-grid range) is a dependency. Every cell that belongs to a dependency cycle, including a cell that refers to itself, has the value `#CYCLE!`; cells that merely use such a cell get `#CYCLE!` through propagation. `#PARSE!` and `#NAME?` cells have no dependencies.

## Output

- **Numbers** are printed with 6 decimal places (as `printf "%.6f"`), then trailing zeros and a trailing `.` are removed; `-0` prints as `0`. So `3`, `-2.5`, `0.333333`, `100000000000000000000`.
- `eval` prints every row of the grid, each with exactly as many comma-separated cells as the grid has columns, each line ending in `\n`. Empty cells print as nothing, errors as their code, numbers as above. A text is printed as is, unless it is empty, contains `,` `"` `(` or `)`, starts or ends with a space or tab, starts with `=` or `#`, or is a number literal; then it is printed as a quoted field (`"` doubled). Apart from error codes, reading the output back gives the same values.
- `get` prints the cell's value on one line: number as above, text unquoted, an error as its code, an empty cell as an empty line.
- `errors` prints one line `<cell> <code>` (for example `B2 #DIV/0!`, column letters upper-case) per error cell, row by row, left to right.

## Example

```
$ cat budget.csv
item,qty,price,total
apple,3,0.5,=B2*C2
pear,2,1.25,=B3*C3
,,sum,=SUM(D2:D3)
,,avg,=AVG(D2:D3)&" each"
$ cells eval budget.csv
item,qty,price,total
apple,3,0.5,1.5
pear,2,1.25,2.5
,,sum,4
,,avg,2 each
```
