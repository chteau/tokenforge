//! Extension point for the stacks that live outside the core tools (python: `kit/langs/*.py`):
//! java (+kotlin), cpp, php, ruby, swift, elixir, zig, scala.
//!
//! # Adding a language
//!
//! 1. Create `src/kit/code/langs/<name>.rs` (port of `kit/langs/<name>.py`) and export one constant:
//!
//!    ```ignore
//!    pub const LANG: Lang = Lang { name: "java", fmt_ext: &[".java", ".kt", ".kts"], check, test, deps, proj, fmt };
//!    ```
//!
//! 2. Add `pub mod <name>;` below, put `&<name>::LANG` in [`LANGS`] and remove the entry from [`PENDING`].
//!    Detection already exists: `common::markers` knows all 15 stacks, and `-l <name>` is accepted.
//!
//! # Hooks (same contract as the python module functions)
//!
//! | python                         | Rust                                                        |
//! |--------------------------------|-------------------------------------------------------------|
//! | `FMT_EXT`                      | `fmt_ext` (lowercase, with the dot)                         |
//! | `check(ctx, D, used)`          | `check(&Ctx, &mut Diags, &mut Vec<String>)`: run the build/linters, `d.add(..)` each diagnostic, push tool labels ("mvn compile") to `used`, `d.notes.push(..)` for skipped tools. The caller prints the header and the diagnostics and computes the exit code. |
//! | `test(ctx) -> rc`              | `test(&Ctx) -> i32`: run the tests, print the summary + failures, return the runner exit code. Honour `ctx.opt.raw` (print the full output and return). |
//! | `deps(ctx)`                    | `deps(&Ctx)`: `ctx.cmd` is ls/where/api/why, `ctx.pkg`/`ctx.sym` the operands, `ctx.cap` the line cap. Print, or `die("kit", msg, 2)` on error. |
//! | `proj(ctx)`                    | `proj(&Ctx)`: print the stack facts (first line "java (maven): …", details indented by two spaces). |
//! | `fmt(ctx, files, check)`       | `fmt(&Ctx, &[PathBuf], bool) -> (Vec<String>, Vec<String>)`: format `files` (absolute) in place, or with `check` only list them. Returns (files that would change — absolute or root-relative, only meaningful with `check`; notes such as "ktlint not found: .kt skipped"). |
//!
//! `ctx` fields (`common::Ctx`): `root`, `opt` (`fast`, `lint`, `changed`, `errors_only`, `raw`), `flt` (test filter),
//! `extra` (runner args after `--`), `nmax` (max failures shown), `cap` (output cap), `cmd`, `pkg` (deps package,
//! or test `-p`), `sym`.
//!
//! # Helpers in `super::common` (python `_kit.py` name -> Rust)
//!
//! - `run(cmd, cwd, timeout)` -> `run(&[..], &Path, secs) -> Output { code, stdout, stderr, secs }` (124 timeout, 127 missing)
//! - `tool(name, root)` -> `exe(name, Some(root)) -> Option<String>`; `die(tool, msg)` -> `die("kit", msg, 2)`
//! - `HOME` -> `crate::kit::util::home()`; `glob.glob(p, recursive=True)` -> `glob(p)`; `open(f).read()` -> `read(f)`
//! - `tail_lines(t, n)` -> `tail(t, n)`; `rel(p, root)` -> `rel(p, root)`; `os.path.relpath` -> `relpath` / `relcwd`
//! - `Diags(root)` -> `Diags::new(root)`, `.add(file, line, col, sev, code, msg, extra)`, `.count("E")`, `.print(cap, errors_only)`
//! - `parse_gnu(D, text, root, notes)` -> same; `generic_failures(t, cap)` -> same (default cap 60)
//! - `summary(st, p, f, s, secs, note)` / `show_fail(name, body, where)` -> same (`Option`s for the optional args)
//! - `cap_print(lines, cap)` -> same; `changed_files(root)` -> same
//! - `outline(files, rx, base, sym, block)` / `doc_and_block(L, i, loc, open, close, body_rx, max_lines)` -> same
//!   (python defaults: "{", "}", None, 60); `rx` is applied like python `re.match` (anchored at the line start)
//! - `junit(paths, st, secs, nmax, frame_rx)` -> `junit(&[glob patterns], st, Some(secs), nmax, None) -> Option<usize>`
//! - `newest(paths, since)` -> `newest(&[patterns], SystemTime)`
//! - regexes: `re!(r"...")` compiles once per call site; `pmatch(&rx, s)` = python `re.match`; `g(&caps, i)` / `gn(&caps, i)`
//! - XML (pom, surefire, …): `xml_elems(text, tag)`, `xml_child(&el, tag)`, `xml_text(inner)`, `xml_unescape`
//! - TOML: the `toml` crate (`toml::from_str::<toml::Value>`); JSON: `serde_json`.
//!
//! Jar listings use the `zip` crate (see `java::jar_api`).

use super::common::{Ctx, Diags};
use std::path::PathBuf;

pub mod cpp;
pub mod elixir;
pub mod java;
pub mod php;
pub mod ruby;
pub mod scala;
pub mod swift;
pub mod zig;

/// One externally defined language. All hooks are required; mirror the python module.
pub struct Lang {
    pub name: &'static str,
    pub fmt_ext: &'static [&'static str],
    pub check: fn(&Ctx, &mut Diags, &mut Vec<String>),
    pub test: fn(&Ctx) -> i32,
    pub deps: fn(&Ctx),
    pub proj: fn(&Ctx),
    pub fmt: FmtFn,
}

/// `fmt(ctx, files, check) -> (would_change, notes)`.
pub type FmtFn = fn(&Ctx, &[PathBuf], bool) -> (Vec<String>, Vec<String>);

/// Ported languages.
pub const LANGS: &[&Lang] = &[&java::LANG, &cpp::LANG, &php::LANG, &ruby::LANG, &swift::LANG, &elixir::LANG, &zig::LANG, &scala::LANG];

/// Languages detected but not ported yet, with the extensions their formatter handles (none left).
pub const PENDING: &[(&str, &[&str])] = &[];

pub fn get(stack: &str) -> Option<&'static Lang> {
    LANGS.iter().copied().find(|l| l.name == stack)
}

/// Line printed when a detected stack has no Rust port yet.
pub fn not_ported(stack: &str) -> String {
    format!("{stack}: not ported to tmap kit yet")
}

/// Language owning a file extension (lowercase, with dot): ported first, then pending.
pub fn for_ext(ext: &str) -> Option<&'static str> {
    LANGS
        .iter()
        .find(|l| l.fmt_ext.contains(&ext))
        .map(|l| l.name)
        .or_else(|| PENDING.iter().find(|(_, e)| e.contains(&ext)).map(|(n, _)| *n))
}
