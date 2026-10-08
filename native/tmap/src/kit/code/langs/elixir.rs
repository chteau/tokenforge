//! Elixir: mix compile / credo, ExUnit, Hex deps in deps/ (port of `kit/langs/elixir.py`).

use super::super::common::{cap_print, die, exe, fail_lines, g, glob, gn, outline, pmatch, re, read, run, s, summary_line, tail, ws, Ctx, Diags};
use super::Lang;
use regex::Regex;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const LANG: Lang = Lang { name: "elixir", fmt_ext: &[".ex", ".exs", ".heex"], check, test, deps, proj, fmt };

/// CRLF -> LF (python text mode does this for files and subprocess output).
fn nl(t: &str) -> String {
    t.replace("\r\n", "\n")
}

fn mix() -> String {
    exe("mix", None).unwrap_or_else(|| die("kit", "mix not found", 2))
}

/// Source location `file:line[:col]` (groups: file, line, col). Python LOC, extended to accept
/// Windows drive letters and backslashes.
macro_rules! loc {
    () => {
        r"((?:lib|test|config|apps|priv)[/\\][\w/\\.-]+\.exs?|(?:[A-Za-z]:)?[\w/\\.-]+\.exs?):(\d+)(?::(\d+))?"
    };
}

fn loc_rx() -> &'static Regex {
    re!(loc!())
}

/// `mix compile` warnings/errors (Elixir >= 1.15 `└─ file:line:col` and older `  file:line` forms) and `** (XError)`.
fn parse_compile(d: &mut Diags, text: &str, root: &Path) {
    let a = re!(concat!(r"(?m)^\s*(warning|error):\s*(.+?)\n(?:.*\n){0,12}?\s*(?:└─\s*)?", loc!()));
    for m in a.captures_iter(text) {
        d.add(&s(&root.join(g(&m, 3))), gn(&m, 4), gn(&m, 5), g(&m, 1), "", g(&m, 2), None);
    }
    for m in re!(concat!(r"\*\* \((\w+Error)\) ", loc!(), r": (.*)")).captures_iter(text) {
        d.add(&s(&root.join(g(&m, 2))), gn(&m, 3), gn(&m, 4), "E", g(&m, 1), g(&m, 5), None);
    }
    for m in re!(concat!(r"error: (.*?)\n(?:.*\n){0,8}?\s*└─ ", loc!())).captures_iter(text) {
        d.add(&s(&root.join(g(&m, 2))), gn(&m, 3), gn(&m, 4), "E", "", g(&m, 1), None);
    }
}

/// `mix credo --format=flycheck`: `file:line[:col]: X: message`.
fn parse_credo(d: &mut Diags, out: &str, root: &Path) {
    for m in re!(r"(?m)^(.+?\.exs?):(\d+):(?:(\d+):)? (\w): (.*)$").captures_iter(out) {
        d.add(&s(&root.join(g(&m, 1))), gn(&m, 2), gn(&m, 3), "W", &format!("credo:{}", g(&m, 4)), g(&m, 5), None);
    }
}

fn check(ctx: &Ctx, d: &mut Diags, used: &mut Vec<String>) {
    let root = &ctx.root;
    used.push("mix compile".into());
    let o = run(&[mix().as_str(), "compile", "--force", "--all-warnings"], root, 1800);
    let (out, err) = (nl(&o.stdout), nl(&o.stderr));
    parse_compile(d, &format!("{out}\n{err}"), root);
    if o.code != 0 && d.count("E") == 0 {
        d.add("", 0, 0, "E", "mix", &tail(&format!("{out}{err}"), 8), None);
    }
    if read(root.join("mix.exs")).contains(":credo") && !ctx.opt.fast {
        used.push("credo".into());
        let o = run(&[mix().as_str(), "credo", "--format=flycheck", "--all"], root, 900);
        parse_credo(d, &nl(&o.stdout), root);
    }
}

fn compile_failed(text: &str) -> bool {
    text.contains("== Compilation error") || (re!(r"\*\* \(\w+Error\)").is_match(text) && !text.contains(" tests, "))
}

/// ExUnit failure blocks `  N) test name (Mod)\n body` up to the next block, "Finished in", or the end
/// (python `^\s+\d+\) (test .+?)\n(.*?)(?=^\s+\d+\) test |\nFinished in|\Z)`, re.S|re.M).
fn exunit_blocks(text: &str) -> Vec<(&str, &str)> {
    let hdr = re!(r"(?m)^\s+\d+\) (test [^\n]+)\n");
    let next = re!(r"(?m)^\s+\d+\) test |\nFinished in");
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(h) = hdr.captures_at(text, at) {
        let (name, start) = (h.get(1).map_or("", |m| m.as_str()), h.get(0).map_or(text.len(), |m| m.end()));
        let end = next.find_at(text, start).map_or(text.len(), |m| m.start());
        out.push((name, &text[start..end]));
        at = end.max(start);
    }
    out
}

/// Summary + failures from `mix test` output; `flt` (a name filter) narrows the failures shown.
fn exunit_report(text: &str, secs: f64, nmax: usize, flt: Option<&str>) -> Vec<String> {
    let m = re!(r"(\d+) (?:tests?|doctests?(?:, \d+ tests?)?), (\d+) failures?(?:, (\d+) (?:skipped|excluded))?").captures(text);
    let mut out = vec![match &m {
        Some(m) => {
            let tot: usize = re!(r"(\d+) (?:doc)?tests?").captures_iter(g(m, 0)).map(|c| gn(&c, 1)).sum();
            summary_line("exunit", tot as i64 - gn(m, 2) as i64, g(m, 2), gn(m, 3), Some(secs), "")
        }
        None => summary_line("exunit", "?", "?", 0, Some(secs), ""),
    }];
    let blocks = exunit_blocks(text);
    let filtered: Vec<(&str, &str)> =
        blocks.iter().copied().filter(|(n, _)| flt.is_none_or(|f| n.to_lowercase().contains(&f.to_lowercase()))).collect();
    let shown = if filtered.is_empty() { blocks } else { filtered };
    for (name, body) in shown.into_iter().take(nmax) {
        let loc = loc_rx().captures(body);
        let lines: Vec<&str> = body.split("stacktrace:").next().unwrap_or("").lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        let skip_first = loc.as_ref().is_some_and(|c| lines.first().is_some_and(|f| f.contains(g(c, 0))));
        let shown_lines = if skip_first { &lines[1..] } else { &lines[..] };
        let place = loc.as_ref().map(|c| format!("{}:{}", g(c, 1), g(c, 2)));
        out.extend(fail_lines(name, &shown_lines.join("\n"), place.as_deref()));
    }
    out
}

fn test(ctx: &Ctx) -> i32 {
    // a file[:line] filter is passed to mix; a name filter narrows the reported failures
    let mut args = vec![mix(), "test".into()];
    if let Some(f) = ctx.flt.as_ref().filter(|f| re!(r"\.exs?(:\d+)?$").is_match(f)) {
        args.push(f.clone());
    }
    args.extend(ctx.extra.iter().cloned());
    let o = run(&args, &ctx.root, 3600);
    let text = nl(&format!("{}\n{}", o.stdout, o.stderr));
    if ctx.opt.raw {
        println!("{text}");
        return o.code;
    }
    if compile_failed(&text) {
        let mut d = Diags::new(&ctx.root);
        parse_compile(&mut d, &text, &ctx.root);
        println!("mix: compile failed, {} errors", d.count("E"));
        d.print(30, false);
        if d.items.is_empty() {
            println!("{}", tail(&text, 20));
        }
        return o.code;
    }
    for l in exunit_report(&text, o.secs, ctx.nmax, ctx.flt.as_deref()) {
        println!("{l}");
    }
    o.code
}

fn locked_text(t: &str) -> BTreeMap<String, String> {
    re!(r#"(?m)^\s+"([\w-]+)": \{:hex, :[\w-]+, "([^"]+)""#).captures_iter(t).map(|m| (g(&m, 1).to_string(), g(&m, 2).to_string())).collect()
}

fn locked(root: &Path) -> BTreeMap<String, String> {
    locked_text(&nl(&read(root.join("mix.lock"))))
}

/// `deps ls` lines from mix.exs deps tuples.
fn ls_lines(mx: &str, lk: &BTreeMap<String, String>) -> Vec<String> {
    re!(r"\{:(\w+),\s*([^}]+)\}")
        .captures_iter(mx)
        .filter(|m| {
            let sp = g(m, 2);
            ["only:", "~>", "github:", "path:", "\""].iter().any(|k| sp.contains(k))
        })
        .map(|m| {
            let n = g(&m, 1);
            let spec = ws(g(&m, 2));
            format!("{n} {}  {}", lk.get(n).map(String::as_str).unwrap_or("(git/path)"), spec.chars().take(60).collect::<String>())
        })
        .collect()
}

/// `deps api SYM` block: @spec/@impl/@doc above the def; for defmodule, its defs and specs.
fn ex_block(l: &[String], i: usize, loc: &str) -> Vec<String> {
    // walk up over @spec/@impl lines and one @doc (single-line or heredoc), nothing else
    let mut j = i;
    while j > 0 {
        let p = l[j - 1].trim();
        if p.starts_with("@spec") || p.starts_with("@impl") || (p.starts_with("@doc") && !p.ends_with("\"\"\"")) {
            j -= 1;
            continue;
        }
        if p == "\"\"\"" {
            let mut k = j as isize - 2;
            while k >= 0 && pmatch(re!(r#"^\s*@doc\s+(~[sS])?""""#), &l[k as usize]).is_none() {
                k -= 1;
            }
            if k >= 0 && (j as isize - k) < 40 {
                j = k as usize;
                continue;
            }
        }
        break;
    }
    let mut out = vec![format!("── {loc}")];
    out.extend(l[j..i].iter().filter(|x| !x.trim().is_empty() && x.trim() != "\"\"\"").take(8).map(|x| x.trim_end().to_string()));
    out.push(l[i].trim_end().to_string());
    if l[i].contains("defmodule") {
        let defs = re!(r"^\s*(def|defmacro|@spec)\s");
        out.extend(
            (i + 1..l.len().min(i + 1500)).filter(|&k| pmatch(defs, &l[k]).is_some()).take(60).map(|k| format!("   {}: {}", k + 1, l[k].trim())),
        );
    }
    out
}

fn deps(ctx: &Ctx) {
    let root = &ctx.root;
    let cmd = ctx.cmd.as_deref().unwrap_or("ls");
    let pkg = ctx.pkg.clone().unwrap_or_default();
    let lk = locked(root);
    if cmd == "ls" {
        for l in ls_lines(&nl(&read(root.join("mix.exs"))), &lk) {
            println!("{l}");
        }
        return;
    }
    if cmd == "why" {
        let o = run(&[mix().as_str(), "deps.tree"], root, 300);
        let mut v: Vec<String> = nl(&o.stdout).lines().filter(|l| l.contains(&pkg)).map(str::to_string).collect();
        if v.is_empty() {
            v.push("not found".into());
        }
        cap_print(&v, ctx.cap);
        return;
    }
    let d = root.join("deps").join(&pkg);
    if !d.is_dir() {
        die("kit", &format!("{pkg} not in deps/ (mix deps.get)"), 2);
    }
    let ver = lk.get(&pkg).cloned().unwrap_or_default();
    if cmd == "where" {
        println!("{pkg} {ver}  {}", s(&d));
        return;
    }
    let mut files = glob(d.join("lib").join("**").join("*.ex"));
    files.sort();
    files.truncate(600);
    println!("{pkg} {ver}  {}", s(&d));
    let Some(sym) = ctx.sym.as_deref() else {
        cap_print(&outline(&files, re!(r"^\s*defmodule\s+[\w.]+|^\s*(defmacro|def)\s+[a-z_]\w*[?!]?"), &d, None, None), ctx.cap);
        return;
    };
    let e = regex::escape(sym);
    let decl = Regex::new(&format!(r"^\s*defmodule\s+([\w.]*\.)?{e}\b|^\s*(defmacro|def)\s+{e}\b")).expect("decl regex");
    let mut out = outline(&files, &decl, &d, Some(sym), Some(&ex_block));
    if out.is_empty() {
        out.push(format!("no def named {sym}"));
    }
    cap_print(&out, ctx.cap);
}

const NOTABLE: [&str; 9] = ["phoenix", "ecto", "ecto_sql", "absinthe", "oban", "broadway", "nerves", "credo", "dialyxir"];

/// `proj` header lines from mix.exs (`v` = last line of `elixir --version`).
fn proj_head(t: &str, v: &str) -> Vec<String> {
    let cap = |rx: &Regex| rx.captures(t).map(|c| g(&c, 1).to_string());
    let app = cap(re!(r"app:\s*:(\w+)"));
    let ver = cap(re!(r#"version:\s*"([^"]+)""#));
    let ex = cap(re!(r#"elixir:\s*"([^"]+)""#));
    let mut out = vec![format!(
        "elixir: {} {}  requires {}  {v}",
        app.as_deref().unwrap_or("?"),
        ver.as_deref().unwrap_or(""),
        ex.as_deref().unwrap_or("?")
    )];
    let fw: Vec<&str> = NOTABLE.iter().copied().filter(|x| t.contains(&format!(":{x}"))).collect();
    if !fw.is_empty() {
        out.push(format!("  notable: {}", fw.join(", ")));
    }
    out
}

fn proj(ctx: &Ctx) {
    let d = &ctx.root;
    let t = nl(&read(d.join("mix.exs")));
    let v = match exe("elixir", None) {
        Some(e) => nl(&run(&[e.as_str(), "--version"], d, 20).stdout).trim().lines().last().unwrap_or("").to_string(),
        None => "elixir not installed".into(),
    };
    for l in proj_head(&t, &v) {
        println!("{l}");
    }
    let apps = d.join("apps");
    if apps.is_dir() {
        let mut names: Vec<String> =
            std::fs::read_dir(&apps).into_iter().flatten().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        println!("  umbrella apps: {}", names.join(", "));
    }
    println!(
        "  locked deps {}; .ex files: {}, tests: {}",
        locked(d).len(),
        glob(d.join("lib").join("**").join("*.ex")).len(),
        glob(d.join("test").join("**").join("*_test.exs")).len()
    );
}

fn unformatted(text: &str) -> Vec<String> {
    re!(r"(?m)^\s*\*\s+(\S+)").captures_iter(text).map(|c| g(&c, 1).to_string()).collect()
}

fn fmt(ctx: &Ctx, files: &[PathBuf], check: bool) -> (Vec<String>, Vec<String>) {
    let Some(m) = exe("mix", None) else { return (Vec::new(), vec!["mix not found: .ex skipped".into()]) };
    let mut c = vec![m, "format".into()];
    if check {
        c.push("--check-formatted".into());
    }
    c.extend(files.iter().map(|f| s(f)));
    let o = run(&c, &ctx.root, 900);
    (if check { unformatted(&nl(&format!("{}{}", o.stdout, o.stderr))) } else { Vec::new() }, Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r() -> &'static Path {
        Path::new("/r")
    }

    #[test]
    fn compile_new_and_old_formats() {
        let text = "Compiling 2 files (.ex)\n\
    warning: variable \"x\" is unused (if the variable is not meant to be used, prefix it with an underscore)\n\
    │\n  3 │     x = 1\n    │     ~\n    │\n    └─ lib/demo.ex:3:5: Demo.f/0\n\n\
warning: Demo.g/0 is undefined\n  lib\\demo\\b.ex:12: Demo.h/0\n\n\
    error: undefined variable \"y\"\n    │\n  7 │     y\n    │     ^\n    │\n    └─ c:/proj/lib/demo.ex:7:5: Demo.k/0\n\n\
** (CompileError) lib/demo.ex: cannot compile module Demo (errors have been logged)\n\
** (SyntaxError) lib/bad.ex:4:3: syntax error before: ')'\n";
        let mut d = Diags::new(r());
        parse_compile(&mut d, text, r());
        let find = |l: usize| d.items.iter().find(|x| x.line == l).unwrap_or_else(|| panic!("line {l}"));
        assert_eq!((find(3).sev.as_str(), find(3).col), ("W", 5));
        assert!(find(3).file.ends_with("demo.ex"));
        assert!(find(3).msg.starts_with("variable \"x\" is unused"));
        assert_eq!(find(12).msg, "Demo.g/0 is undefined");
        assert!(find(12).file.ends_with("b.ex"));
        assert_eq!((find(7).sev.as_str(), find(7).msg.as_str()), ("E", "undefined variable \"y\""));
        assert!(find(7).file.ends_with("demo.ex"));
        assert_eq!((find(4).code.as_str(), find(4).col, find(4).msg.as_str()), ("SyntaxError", 3, "syntax error before: ')'"));
        assert!(compile_failed("== Compilation error in file lib/x.ex ==\n"));
        assert!(!compile_failed("** (RuntimeError) boom\n3 tests, 1 failure\n"));
    }

    #[test]
    fn credo_flycheck() {
        let mut d = Diags::new(r());
        parse_credo(
            &mut d,
            "lib/demo.ex:5:7: R: Modules should have a @moduledoc tag.\nlib\\demo\\b.ex:9: W: There should be no calls to IO.inspect/1.\n",
            r(),
        );
        assert_eq!(d.items.len(), 2);
        assert_eq!((d.items[0].line, d.items[0].col, d.items[0].code.as_str()), (5, 7, "credo:R"));
        assert_eq!((d.items[1].line, d.items[1].col, d.items[1].sev.as_str()), (9, 0, "W"));
    }

    #[test]
    fn exunit_failures() {
        let text = "Running ExUnit with seed: 1, max_cases: 16\n\n.\n\n  1) test adds numbers (DemoTest)\n     test/demo_test.exs:5\n     Assertion with == failed\n     code:  assert 1 + 1 == 3\n     left:  2\n     right: 3\n     stacktrace:\n       test/demo_test.exs:6: (test)\n\n\
  2) test raises (DemoTest)\n     test\\demo_test.exs:9\n     ** (RuntimeError) boom\n     stacktrace:\n       lib/demo.ex:3: Demo.boom/0\n\n\
Finished in 0.03 seconds (0.00s async, 0.03s sync)\n1 doctest, 3 tests, 2 failures, 1 skipped\n";
        let out = exunit_report(text, 0.4, 10, None);
        assert_eq!(out[0], "exunit: 2 passed, 2 failed, 1 skipped [0.4s]");
        assert_eq!(out[1], "FAIL test adds numbers (DemoTest)  (test/demo_test.exs:5)");
        assert_eq!(out[2], "    Assertion with == failed");
        assert_eq!(out.iter().filter(|l| l.starts_with("FAIL")).count(), 2);
        assert!(out.contains(&"FAIL test raises (DemoTest)  (test\\demo_test.exs:9)".to_string()));
        let only = exunit_report(text, 0.4, 10, Some("RAISES"));
        assert_eq!(only.iter().filter(|l| l.starts_with("FAIL")).count(), 1);
        assert_eq!(exunit_report("no summary", 0.1, 10, None), vec!["exunit: ? passed, ? failed [0.1s]"]);
        assert_eq!(exunit_report("3 tests, 0 failures\n", 0.1, 10, None), vec!["exunit: 3 passed, 0 failed [0.1s]"]);
    }

    #[test]
    fn lock_ls_proj() {
        let lock = "%{\r\n  \"jason\": {:hex, :jason, \"1.4.1\", \"af1504e\", [:mix], [], \"hexpm\", \"fbb01ec\"},\r\n  \"plug_cowboy\": {:hex, :plug_cowboy, \"2.7.0\", \"x\", [:mix], [], \"hexpm\", \"y\"},\r\n  \"mylib\": {:git, \"https://g/x.git\", \"abc\", []},\r\n}\r\n";
        let lk = locked_text(&nl(lock));
        assert_eq!(lk.len(), 2);
        assert_eq!(lk.get("jason").map(String::as_str), Some("1.4.1"));
        let mx = "defmodule Demo.MixProject do\n  def project do\n    [app: :demo, version: \"0.1.0\", elixir: \"~> 1.15\", deps: deps()]\n  end\n  defp deps do\n    [\n      {:jason, \"~> 1.4\"},\n      {:credo, \"~> 1.7\", only: [:dev, :test], runtime: false},\n      {:mylib, github: \"me/mylib\"},\n      {:other, path: \"../other\"}\n    ]\n  end\nend\n";
        assert_eq!(
            ls_lines(mx, &lk),
            vec![
                "jason 1.4.1  \"~> 1.4\"",
                "credo (git/path)  \"~> 1.7\", only: [:dev, :test], runtime: false",
                "mylib (git/path)  github: \"me/mylib\"",
                "other (git/path)  path: \"../other\""
            ]
        );
        assert_eq!(proj_head(mx, "Elixir 1.17.2 (compiled with Erlang/OTP 27)"), vec![
            "elixir: demo 0.1.0  requires ~> 1.15  Elixir 1.17.2 (compiled with Erlang/OTP 27)",
            "  notable: credo"
        ]);
        assert_eq!(unformatted("** (Mix) mix format failed due to --check-formatted.\nThe following files are not formatted:\n\n  * lib/demo.ex\n  * C:\\p\\lib\\b.ex\n"), vec!["lib/demo.ex", "C:\\p\\lib\\b.ex"]);
    }

    #[test]
    fn def_block() {
        let src: Vec<String> = "defmodule Demo do\n  @moduledoc false\n  @doc \"\"\"\n  Adds.\n  \"\"\"\n  @spec add(integer, integer) :: integer\n  def add(a, b), do: a + b\nend"
            .lines()
            .map(str::to_string)
            .collect();
        assert_eq!(
            ex_block(&src, 6, "lib/demo.ex:7"),
            vec!["── lib/demo.ex:7", "  @doc \"\"\"", "  Adds.", "  @spec add(integer, integer) :: integer", "  def add(a, b), do: a + b"]
        );
        assert_eq!(ex_block(&src, 0, "lib/demo.ex:1"), vec!["── lib/demo.ex:1", "defmodule Demo do", "   6: @spec add(integer, integer) :: integer", "   7: def add(a, b), do: a + b"]);
    }
}
