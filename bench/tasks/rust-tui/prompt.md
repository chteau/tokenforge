# Build `kanban`: a terminal kanban board

This repository is empty. Build a small terminal kanban board in Rust (edition 2021) using `ratatui` and `crossterm` for the interactive UI. Other crates from crates.io are fine (for example `serde` / `serde_json`). The crate must build a binary named `kanban` (so `cargo build --release` produces `target/release/kanban`), and `cargo fmt --check` and `cargo clippy --all-targets -- -D warnings` must pass. Please add tests for the board logic.

Besides the interactive mode, the program has a **headless script mode** that replays key presses from a file without touching the terminal. It is used for automated testing, so follow the rules below exactly.

## The board

The board always has exactly three columns, in this order: `Todo`, `Doing`, `Done`. Each column holds an ordered list of cards. A card has a numeric `id` (unique, never reused) and a `title`. New ids come from a counter `next_id` that starts at 1 and is incremented every time a card is added.

The UI state is: the **focused column** (0, 1 or 2; initially 0), the **selected card** in the focused column (an index, or none when that column is empty; initially the first card if the column has any), the **mode** (`normal`, `add` or `edit`), the **input** buffer used in add/edit mode, and a one-line **message** (or none).

## Command line

```
kanban [--data FILE] [--script KEYS_FILE [--dump | --render WxH]]
kanban --help
```

- `--data FILE`: the board file. Default: `kanban.json` in the current directory. If the file does not exist, the board starts empty (`next_id` 1) and the file is created when the board is saved.
- Without `--script`, the interactive UI starts (alternate screen, raw mode), drawing the same layout as `--render` below at the terminal's size, and reacts to real key presses with the same key bindings.
- `--script KEYS_FILE`: headless mode. Replays the keys in KEYS_FILE (format below) against the board, never touching the terminal (no raw mode, no alternate screen, no escape sequences). It must work with stdin/stdout not being a terminal.
- `--dump` (only with `--script`): after replaying, print the final state as JSON (shape below) to stdout.
- `--render WxH` (only with `--script`): after replaying, print the final screen as plain text, W columns by H rows (layout below).
- `--help` / `-h`: print a short usage text to stdout and exit 0.

**Saving.** The board (not the UI state) is written to the data file when the program ends normally: when `q` is pressed in normal mode, or when a script ends (whether or not it contained `q`). In script mode it is saved even if nothing changed. Saving must be crash-safe: a crash in the middle of a save must never leave a truncated or half-written data file (write a temporary file in the same directory, then rename it over the data file).

### Errors and exit codes

All error messages go to stderr and start with `error: `. Nothing is printed to stdout and the data file is not written when an error occurs.

| Situation | Exit code |
|---|---|
| Unknown option, missing option value, `--dump`/`--render` without `--script`, both `--dump` and `--render` | 2 |
| `--render` value not of the form `<W>x<H>` with positive integers, or W < 30, or H < 5 | 2 |
| Script file cannot be read | 1 |
| Unknown key name in the script (message includes the key name and the 1-based line number, e.g. `error: unknown key 'Foo' on line 3`) | 2 |
| Data file exists but is not valid JSON or does not have the shape below (message includes the file path) | 1 |

The data file is validated before the script is replayed.

## Data file format

```json
{
  "next_id": 4,
  "columns": [
    {"name": "Todo",  "cards": [{"id": 1, "title": "Buy milk"}, {"id": 3, "title": "Call mom"}]},
    {"name": "Doing", "cards": [{"id": 2, "title": "Write report"}]},
    {"name": "Done",  "cards": []}
  ]
}
```

Exactly three columns, named `Todo`, `Doing`, `Done` in that order; anything else is an invalid file. Whitespace and key order in the file do not matter.

## Script file format

One key per line. The line terminator (`\n` or `\r\n`) is stripped; empty lines are ignored. Key names are case-sensitive:

- a single character, e.g. `j`, `J`, `a`, `q`, `>` : that character key
- `Enter`, `Esc`, `Tab`, `Backspace`, `Up`, `Down`, `Left`, `Right`, `Space`
- `text:<anything>` : types the text after `text:` verbatim (spaces included), as if each character were pressed. Useful for card titles: `text:Buy milk`.

Anything else is an unknown key (error above). The whole file is checked before anything is replayed, so an unknown key is an error even if it comes after `q`. Once `q` quits (normal mode only), the remaining keys are ignored.

## Key bindings

### Normal mode

Every key pressed in normal mode first clears the message; then:

| Key | Action |
|---|---|
| `j` or `Down` | select the next card in the focused column; from the last card, wrap to the first. Nothing if the column is empty. |
| `k` or `Up` | select the previous card; from the first card, wrap to the last. |
| `l` or `Right` | focus the next column; nothing in `Done` (no wrap). |
| `h` or `Left` | focus the previous column; nothing in `Todo` (no wrap). |
| `Tab` | focus the next column, wrapping from `Done` to `Todo`. |
| `a` | enter `add` mode with an empty input. |
| `e` | enter `edit` mode with the input set to the selected card's title. Nothing if no card is selected. |
| `d` | delete the selected card; message `Deleted "<title>"`. The selection stays at the same index, or moves to the new last card if it was the last; none if the column is now empty. |
| `L` | move the selected card to the end of the next column; the focus follows the card (it stays selected). Nothing in `Done`. |
| `H` | move the selected card to the end of the previous column; focus follows. Nothing in `Todo`. |
| `J` | swap the selected card with the one below it; selection follows the card. Nothing if it is the last. |
| `K` | swap the selected card with the one above it; selection follows. Nothing if it is the first. |
| `q` | quit (save). |
| anything else | nothing (`text:` lines are ignored in normal mode). |

Whenever the focused column changes because of `h`, `l`, `Left`, `Right` or `Tab`, the selection becomes the first card of the newly focused column (none if it is empty).

### Add / edit mode

| Key | Action |
|---|---|
| a character key (including `q`, `j`, ...), `Space`, `text:...` | append the character(s) to the input |
| `Backspace` | remove the last character of the input (nothing if empty) |
| `Esc` | cancel: back to normal mode, input cleared, board unchanged |
| `Enter` | commit (below), then back to normal mode with the input cleared |
| `Tab`, arrows | nothing |

On `Enter` the input is trimmed of leading and trailing whitespace. If the result is empty, nothing changes and the message becomes `Title cannot be empty`. Otherwise:

- add mode: a card `{id: next_id, title}` is appended to the end of the focused column and becomes the selected card; `next_id` is incremented; message `Added "<title>"`.
- edit mode: the selected card's title is replaced; message `Updated "<title>"`.

## `--dump` output

A single JSON object (whitespace and key order do not matter):

```json
{
  "next_id": 4,
  "columns": [ ...same as the data file... ],
  "focus": 0,
  "selected": 1,
  "mode": "normal",
  "input": "",
  "message": "Added \"Call mom\""
}
```

`selected` is an index into the focused column's cards, or `null`. `mode` is `"normal"`, `"add"` or `"edit"`. `message` is a string or `null`.

## `--render WxH` output

Exactly H lines, each at most W characters, with trailing spaces removed from every line. Characters are counted as Unicode scalar values.

Column regions: let `cw = W / 3` (integer division). Column `i` (0, 1, 2) starts at character offset `i * cw`; columns 0 and 1 are `cw` wide, column 2 is `W - 2 * cw` wide. Text placed in a region of width `w` is cut to at most `w - 1` characters, so neighbouring columns are always separated by at least one space.

- Line 1: `KANBAN - <n> total`, where n is the number of cards on the board.
- Line 2: the column headers, each at the start of its region: `<Name> (<count>)`, e.g. `Todo (2)`; the focused column's header is wrapped in brackets: `[Todo (2)]`.
- Line 3: W `-` characters.
- Lines 4 to H-1 (that is, `H - 4` card rows): the cards of each column, one per line, top to bottom in column order. Each is `> <title>` for the selected card of the focused column and `  <title>` (two spaces) for every other card. An empty column shows `  (empty)` on its first card row. If a column has more cards than card rows, it shows the cards from the first one, except for the focused column when its selected card would not be visible: then it shows the last `H - 4` cards ending with the selected one.
- Line H (the last line): in normal mode, the message if there is one, otherwise `a:add e:edit d:delete H/L:move q:quit`. In add mode `New card: <input>_`, in edit mode `Edit card: <input>_`. Cut to W characters.

Example: board with `Buy milk` and `Call mom` in Todo (Buy milk selected) and `Write report` in Doing, `--render 60x7`:

```
KANBAN - 3 total
[Todo (2)]          Doing (1)           Done (0)
------------------------------------------------------------
> Buy milk            Write report        (empty)
  Call mom

a:add e:edit d:delete H/L:move q:quit
```

(The 6th line is empty: trailing spaces are removed.)
