# New tool: `asm`

Build **`asm`**, the toolchain for a small 32-bit stack machine, written in OCaml: an assembler that turns a text assembly language into a binary program file, a disassembler that turns the binary back into text, and a virtual machine that runs it. The repository is empty apart from a README; create the project from scratch.

## Constraints

- **OCaml 5** and **dune 3**, standard library only (no opam packages: no alcotest, ounit, ppx, cmdliner, nothing fetched or installed).
- From the repository root, `dune build` must succeed (default dev profile, no warnings disabled) and produce the executable **`_build/default/bin/asm.exe`** (an `executable` stanza named `asm` in `bin/dune`).
- Put the logic in a dune `library` with several modules, each with a clear job (for example: instruction set, binary format, assembler, disassembler, VM), and give at least two of them an `.mli` interface. `bin/` only parses the command line and prints. All byte-level encoding and decoding of the binary format lives in **one** module. No `Obj.magic`.
- Add automated tests in a dune `test` stanza so that `dune test` runs and passes them. A small hand-written assertion harness is fine.
- Update the README with a short build and usage section.

## Command line

```
asm assemble <source.s> -o <out.bin>
asm disasm <program.bin>
asm run <program.bin> [--steps <n>]
asm --help
```

- `asm --help` (or `-h`) as the only argument prints a usage text starting with `usage: asm` to stdout and exits 0.
- `assemble` prints nothing on success. On any error the output file is not created (an existing file is left untouched).
- `--steps <n>` sets the step limit (a positive decimal integer; default 1000000).
- Any other argument shape (missing/extra arguments, unknown command, bad `--steps` value) is a usage error.

## Assembly language

- One statement per line. `;` starts a comment that runs to the end of the line. Blank lines are ignored. Tokens are separated by spaces or tabs; there are no commas.
- A line may start with one or more **labels**, each a token `name:` (identifier immediately followed by `:`), optionally followed by an instruction. An identifier matches `[A-Za-z_][A-Za-z0-9_]*`; labels are case-sensitive. A label stands for the byte offset of the next instruction in the code (or the end of the code if none follows).
- **Instructions**: a mnemonic (case-insensitive) and at most one operand. **Integer** operands are decimal with an optional leading `-` (`42`, `-7`) or hexadecimal with a lowercase `0x` prefix (`0xff`, `0x7FFFFFFF`, never negative); the value must fit in a signed 32-bit integer.
- **`.data <name> <v1> [<v2> ...]`** (directive name case-insensitive) reserves consecutive memory words initialised to the given integers. Data words get addresses 0, 1, 2, … in source order across all `.data` lines, and `<name>` stands for the address of its first word. Data names and labels share one namespace. Memory has 256 words; data beyond that is an error.

| mnemonic | opcode | operand | effect (`a` = second from top, `b` = top) |
|---|---|---|---|
| `halt` | 0x00 | – | stop, exit 0 |
| `push X` | 0x01 | integer or data name | push X (a data name pushes its address) |
| `pop` | 0x02 | – | discard top |
| `dup` | 0x03 | – | push a copy of top |
| `swap` | 0x04 | – | exchange the top two |
| `over` | 0x05 | – | push a copy of `a` |
| `add` `sub` `mul` | 0x10 0x11 0x12 | – | pop b, pop a, push a+b / a−b / a×b (wrapping 32-bit) |
| `div` `mod` | 0x13 0x14 | – | pop b, pop a, push quotient truncated toward zero / remainder with the sign of `a`; −2147483648 div −1 = −2147483648, mod −1 = 0 |
| `neg` | 0x15 | – | negate top (wrapping) |
| `cmp` | 0x16 | – | pop b, pop a, push −1 if a<b, 0 if a=b, 1 if a>b |
| `jmp L` `jz L` `jnz L` | 0x20 0x21 0x22 | label | jump; `jz`/`jnz` pop a value and jump if it is zero / non-zero |
| `call L` | 0x23 | label | push the offset of the next instruction on the call stack, jump |
| `ret` | 0x24 | – | pop the call stack and jump there |
| `load X` `store X` | 0x30 0x31 | integer or data name | push memory[X] / pop into memory[X] |
| `print` | 0x40 | – | pop and print it in decimal followed by `\n` |

## Binary format

All multi-byte integers are little-endian. A file is a 16-byte header, then the code, then the data:

| bytes | content |
|---|---|
| 0–3 | magic `SVMB` (ASCII) |
| 4 | version, `1` |
| 5–7 | reserved, written as zero, ignored when reading |
| 8–11 | code size in bytes (unsigned 32-bit) |
| 12–15 | number of data words (unsigned 32-bit) |

Each instruction is its opcode byte, followed for instructions with an operand by the operand as a signed 32-bit integer (for jumps and `call`: the target byte offset within the code, read as unsigned). Data words are signed 32-bit integers. Loading checks, in this order: fewer than 16 bytes → `truncated file`; wrong magic → `bad magic`; version ≠ 1 → `unsupported version <v>`; file shorter than the sizes say → `truncated file`; longer → `trailing data`; more than 256 data words → `data section too large`; then the code is decoded from offset 0: unknown opcode → `unknown opcode 0x<hh> at offset <o>` (two lowercase hex digits), an operand that runs past the end of the code → `truncated instruction at offset <o>`. These go to stderr as `error: <message>` with exit 4.

## Disassembler

`disasm` prints canonical assembly that reassembles to a byte-identical file:

- If there is data: first the line `.data data <w0> <w1> ...` (all words, decimal).
- Then each instruction on its own line: four spaces, the lowercase mnemonic, and for operand instructions a space and the operand. `push`/`load`/`store` operands are signed decimal; jump/call operands are `L<offset>`.
- Every offset that is the target of a jump or call gets the line `L<offset>:` right before its instruction (or as the last line if it is the end of the code). Offsets are plain decimal (`L0`, `L17`).
- A target that is neither an instruction start nor the end of the code: `error: invalid jump target <t> at offset <o>`, exit 4.

## Virtual machine

Execution starts at offset 0 with empty stacks and memory initialised from the data section (rest zero). It ends with exit 0 at `halt`, or when execution reaches the end of the code. The value stack holds at most 1024 values and the call stack at most 256 return offsets. A valid jump target is an instruction start or the end of the code. Every executed instruction (including `halt`) is one step; if `<n>` steps have been executed and another instruction would run, execution stops with the step-limit trap. Output printed before a trap stays on stdout. A trap prints one line to stderr and exits with its code (`<o>` is the offset of the faulting instruction; `<t>` unsigned):

| exit | stderr |
|---|---|
| 10 | `trap: stack underflow at offset <o>` (too few values, or `ret` with an empty call stack) |
| 11 | `trap: division by zero at offset <o>` (`div` or `mod`) |
| 12 | `trap: bad jump to <t> at offset <o>` (checked when a jump is taken) |
| 13 | `trap: bad address <x> at offset <o>` (`load`/`store` outside 0–255) |
| 14 | `trap: step limit exceeded` |
| 15 | `trap: stack overflow at offset <o>` (value or call stack full) |

## Assembler errors

On an error `assemble` prints exactly one line `error: line <n>: <message>` to stderr and exits 1. If the file has several errors, report the one with the smallest line number; within a line, the leftmost problem. Messages (names and tokens as written; mnemonics lowercased in the operand-count messages):

- `invalid label '<name>'` — label or `.data` name that is not an identifier
- `duplicate label '<name>'` — reported at the second definition
- `unknown instruction '<token>'`, `unknown directive '<token>'` (any other token starting with `.`)
- `'<mnemonic>' expects 1 operand`, `'<mnemonic>' expects no operand`, `'.data' expects a name and at least one value`
- `invalid operand '<token>'` — not an integer (nor an identifier where a name is allowed; jump operands must be identifiers)
- `integer out of range '<token>'`
- `undefined label '<name>'` (jump/call to a name that is not a label), `undefined data '<name>'` (`push`/`load`/`store` of a name that is not a data name)
- `data section too large` — at the `.data` line that exceeds 256 words

## Other errors and exit codes

| code | situation |
|---|---|
| 0 | success (and `--help`) |
| 1 | assembler error |
| 2 | usage error: stderr starts with `error: ` |
| 3 | input cannot be read or output cannot be written: `error: cannot read <path>` / `error: cannot write <path>` |
| 4 | invalid binary file (see above) |
| 10–15 | VM traps |

All errors go to stderr; on an error or trap nothing is printed to stdout except `print` output produced before a trap.
