//! `tmap kit test`: run tests; print a summary line plus only the failures (location + assertion), capped.

use super::check::{both, parse_cargo, parse_dotnet, python};
use super::common::*;
use super::langs;
use regex::Regex;
use serde_json::Value;
use std::path::{Path, PathBuf};

const HELP: &str = "Run tests; print a summary line plus ONLY the failures (location + assertion), capped.

  tmap kit test [FILTER] [-l STACK] [-p PKG] [-n MAXFAIL] [-C DIR] [--raw] [-- extra runner args]

  FILTER   test name filter (rust: substring, go: -run regex, js: -t, dotnet: --filter, py: -k, dart: --name)
  -p PKG   rust: -p crate | go: package pattern (default ./...) | dotnet: project path | js/py/dart: test file/path
  -n N     show at most N failures (default 10)        --raw  print the runner's full output instead
  --failed rerun only what failed last time (rust, py)

Runners: rust cargo test | go go test -json | ts vitest/jest (json) or bun test / node --test
  java/kotlin maven surefire or gradle test (JUnit XML) | cpp ctest / meson test / make check
  php phpunit or pest (JUnit XML) | ruby rspec (json) or minitest | swift swift test (XCTest + swift-testing)
  elixir mix test | zig zig build test | scala sbt test (JUnit XML)
  cs dotnet test (trx) | dart dart/flutter test -r json | py pytest | luau lune (.lune/test*) or a
  \"test\" script in rokit/aftman setups. Build errors are shown as diagnostics, not as test output.
Exit code = runner's exit code.";

const T: &str = "test";

pub fn main(args: Vec<String>) -> i32 {
    crate::kit::util::count_runs();
    let mut ctx = Ctx { nmax: 10, cap: 80, ..Default::default() };
    let (mut want, mut chdir) = (None, None);
    let mut it = args.into_iter();
    fn val(it: &mut impl Iterator<Item = String>, o: &str) -> String {
        it.next().unwrap_or_else(|| die(T, &format!("{o} needs a value"), 2))
    }
    while let Some(x) = it.next() {
        match x.as_str() {
            "-h" | "--help" => {
                println!("{HELP}");
                return 0;
            }
            "--" => {
                ctx.extra = it.by_ref().collect();
                break;
            }
            "-l" => want = Some(val(&mut it, "-l")),
            "-p" => ctx.pkg = Some(val(&mut it, "-p")),
            "-n" => ctx.nmax = val(&mut it, "-n").parse().unwrap_or_else(|_| die(T, "-n needs a number", 2)),
            "-C" => chdir = Some(val(&mut it, "-C")),
            "--raw" => ctx.opt.raw = true,
            "--failed" => ctx.failed = true,
            o if o.starts_with('-') => die(T, &format!("unknown option {o}"), 2),
            _ => ctx.flt = Some(x),
        }
    }
    if let Some(d) = chdir {
        if let Err(e) = std::env::set_current_dir(&d) {
            die(T, &format!("-C {d}: {e}"), 2);
        }
    }
    let (root, stacks) = find_root(Path::new("."), want.as_deref());
    let Some(root) = root else { die(T, "no project manifest found here or above", 2) };
    ctx.root = root;
    if ctx.failed {
        if stacks.iter().any(|s| *s != "rust" && *s != "py") {
            die(T, "--failed supports rust and py projects", 2);
        }
        if stacks.contains(&"py") {
            ctx.extra.push("--lf".into());
        }
    }
    let tmp = std::env::temp_dir().join(format!(
        "kit-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
    ));
    let _ = std::fs::create_dir_all(&tmp);
    let mut worst = 0;
    for st in stacks {
        let rc = match st {
            "rust" => rust(&ctx),
            "go" => go(&ctx),
            "ts" => ts(&ctx, &tmp),
            "cs" => cs(&ctx, &tmp),
            "dart" => dart(&ctx),
            "py" => py(&ctx),
            "luau" => luau(&ctx),
            other => match langs::get(other) {
                Some(l) => (l.test)(&ctx),
                None => {
                    println!("{}", langs::not_ported(other));
                    2
                }
            },
        };
        worst = worst.max(rc);
    }
    let _ = std::fs::remove_dir_all(&tmp);
    worst
}

fn need(name: &str, msg: &str) -> String {
    exe(name, None).unwrap_or_else(|| die(T, msg, 2))
}

fn emit(lines: Vec<String>) {
    for l in lines {
        println!("{l}");
    }
}

/// Print the raw runner output when --raw was given.
fn raw_or(ctx: &Ctx, text: &str) -> bool {
    if ctx.opt.raw {
        println!("{text}");
    }
    ctx.opt.raw
}

/// (name, body) pairs of a text split on a heading regex whose group 1 is the name.
fn split_blocks<'a>(text: &'a str, rx: &regex::Regex) -> Vec<(&'a str, &'a str)> {
    let caps: Vec<_> = rx.captures_iter(text).collect();
    caps.iter()
        .enumerate()
        .map(|(i, c)| {
            let end = caps.get(i + 1).map_or(text.len(), |n| n.get(0).unwrap().start());
            (g(c, 1), &text[c.get(0).unwrap().end()..end])
        })
        .collect()
}

// ---------- rust ----------

/// Summary and failures from `cargo test` output.
pub fn rust_report(out: &str, err: &str, rc: i32, secs: f64, nmax: usize) -> Vec<String> {
    let text = format!("{out}\n{err}");
    let (mut p, mut f, mut ig) = (0, 0, 0);
    for m in re!(r"test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored").captures_iter(&text) {
        p += gn(&m, 1);
        f += gn(&m, 2);
        ig += gn(&m, 3);
    }
    let mut o = vec![summary_line("rust", p, f, ig, Some(secs), "")];
    for (shown, (name, body)) in split_blocks(out, re!(r"(?m)^---- (.+?) stdout ----$")).into_iter().enumerate() {
        if shown >= nmax {
            o.push("… more failures (-n)".into());
            break;
        }
        let body = body.split("\nfailures:").next().unwrap_or("").split("\n---- ").next().unwrap_or("");
        let loc = re!(r"panicked at ((?:[A-Za-z]:)?[^\n:]+:\d+:\d+)").captures(body).map(|m| g(&m, 1).to_string());
        let keep: Vec<&str> = body.lines().filter(|l| !l.starts_with("note: run with") && !l.starts_with("stack backtrace")).collect();
        o.extend(fail_lines(name, &keep.join("\n"), loc.as_deref()));
    }
    if rc != 0 && f == 0 {
        o.push(tail(&text, 20));
    }
    o
}

/// Where the failing test names of the last rust run are kept (per project root).
fn failed_file(root: &Path) -> PathBuf {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    root.hash(&mut h);
    let dir = crate::kit::util::cache_home().join("tokenforge").join("failed");
    let _ = std::fs::create_dir_all(&dir);
    dir.join(format!("{:x}.txt", h.finish()))
}

fn rust(ctx: &Ctx) -> i32 {
    let cargo = need("cargo", "cargo not found");
    let sel: Vec<String> = match &ctx.pkg {
        Some(p) => vec!["-p".into(), p.clone()],
        None => vec!["--workspace".into()],
    };
    let mut cmd = vec![cargo.clone(), "test".into(), "--no-run".into(), "--message-format=json".into()];
    cmd.extend(sel.iter().cloned());
    let o = run(&cmd, &ctx.root, 900);
    let mut d = Diags::new(&ctx.root);
    parse_cargo(&mut d, &o.stdout, &ctx.root, true, false);
    if o.code != 0 {
        println!("rust: build failed, {} errors", d.count("E"));
        d.print(30, false);
        if d.items.is_empty() {
            println!("{}", tail(&o.stderr, 15));
        }
        return o.code;
    }
    let mut cmd = vec![cargo, "test".into(), "--no-fail-fast".into()];
    cmd.extend(sel);
    cmd.extend(ctx.flt.clone());
    let store = failed_file(&ctx.root);
    if ctx.failed {
        let names = std::fs::read_to_string(&store).unwrap_or_default();
        if names.trim().is_empty() {
            println!("rust: no failures recorded from the last run");
            return 0;
        }
        cmd.push("--".into());
        cmd.extend(names.lines().map(String::from));
    }
    cmd.extend(ctx.extra.iter().cloned());
    let o = run(&cmd, &ctx.root, 900);
    let failed: Vec<&str> = re!(r"(?m)^---- (.+?) stdout ----$").captures_iter(&o.stdout).map(|c| c.get(1).unwrap().as_str()).collect();
    let _ = std::fs::write(&store, failed.join("\n"));
    if raw_or(ctx, &format!("{}\n{}", o.stdout, o.stderr)) {
        return o.code;
    }
    emit(rust_report(&o.stdout, &o.stderr, o.code, o.secs, ctx.nmax));
    o.code
}

// ---------- go ----------

/// Summary, build errors and leaf failures from `go test -json` output.
pub fn go_report(out: &str, err: &str, rc: i32, secs: f64, nmax: usize) -> Vec<String> {
    type Key = (String, Option<String>);
    let mut outs: OrdMap<Key, Vec<String>> = OrdMap::default();
    let mut res: OrdMap<Key, &str> = OrdMap::default();
    let mut build: Vec<String> = Vec::new();
    for ln in out.lines() {
        let e = match serde_json::from_str::<Value>(ln) {
            Ok(v @ Value::Object(_)) => v,
            _ => {
                if re!(r"\.go:\d+").is_match(ln) {
                    build.push(ln.to_string());
                }
                continue;
            }
        };
        let act = e["Action"].as_str().unwrap_or("");
        let pkg = e["Package"].as_str().or(e["ImportPath"].as_str()).unwrap_or("").to_string();
        let test = e["Test"].as_str().filter(|t| !t.is_empty()).map(str::to_string);
        let key = (pkg.clone(), test.clone());
        match act {
            "output" | "build-output" => {
                let o = e["Output"].as_str().unwrap_or("").trim_end().to_string();
                if act == "build-output" || re!(r"^\S+\.go:\d+:\d+: ").is_match(&o) {
                    build.push(o.clone());
                }
                outs.entry(key, Vec::new).push(o);
            }
            "pass" | "fail" | "skip" if test.is_some() => res.insert(key, if act == "pass" { "pass" } else if act == "fail" { "fail" } else { "skip" }),
            "fail" if !res.items.iter().any(|(k, v)| k.0 == pkg && *v == "fail") => res.insert((pkg, None), "pkgfail"),
            _ => {}
        }
    }
    let top: Vec<&str> = res.items.iter().filter(|(k, _)| k.1.as_deref().is_some_and(|t| !t.contains('/'))).map(|(_, v)| *v).collect();
    let n = |s: &str| top.iter().filter(|v| **v == s).count();
    let f = n("fail");
    let mut o = Vec::new();
    if !build.is_empty() && top.is_empty() {
        o.push(format!("go: build failed, no tests ran [{secs:.1}s] (go test also runs vet; `-- -vet=off` skips it)"));
    } else {
        o.push(summary_line("go", n("pass"), f, n("skip"), Some(secs), ""));
    }
    let mut seen = std::collections::HashSet::new();
    for b in build.iter().filter(|l| !l.trim().is_empty() && !l.starts_with('#') && seen.insert(l.as_str())).take(30) {
        o.push(format!("BUILD {}", b.trim()));
    }
    let mut shown = 0;
    for ((pkg, test), v) in &res.items {
        let Some(test) = test else { continue };
        if *v != "fail" || shown >= nmax {
            continue;
        }
        // leaf failures only: skip a parent whose subtest failed
        let sub = format!("{test}/");
        if res.items.iter().any(|(k, r)| k.1.as_deref().is_some_and(|t| t.starts_with(&sub)) && *r == "fail") {
            continue;
        }
        let noise = re!(r"^\s*(=== (RUN|PAUSE|CONT|NAME)|--- (FAIL|PASS|SKIP))");
        let body: Vec<&str> =
            outs.get(&(pkg.clone(), Some(test.clone()))).into_iter().flatten().map(String::as_str).filter(|l| !noise.is_match(l)).collect();
        let loc = body.iter().find_map(|l| re!(r"\w+\.go:\d+").find(l)).map(|m| m.as_str());
        o.extend(fail_lines(&format!("{test}  [{pkg}]"), &body.join("\n"), loc));
        shown += 1;
    }
    let pkgfail = res.items.iter().any(|(_, v)| *v == "pkgfail");
    for ((pkg, _), v) in &res.items {
        if *v == "pkgfail" && build.is_empty() {
            o.push(format!("FAIL package {pkg}"));
            let lines = outs.get(&(pkg.clone(), None)).cloned().unwrap_or_default();
            o.push(format!("    {}", lines[lines.len().saturating_sub(8)..].join("\n    ")));
        }
    }
    if rc != 0 && f == 0 && build.is_empty() && !pkgfail {
        o.push(tail(if err.is_empty() { out } else { err }, 15));
    }
    o
}

fn go(ctx: &Ctx) -> i32 {
    let mut cmd = vec![need("go", "go not found"), "test".into(), "-json".into()];
    if let Some(f) = &ctx.flt {
        cmd.extend(["-run".into(), f.clone()]);
    }
    cmd.extend(ctx.extra.iter().cloned());
    cmd.push(ctx.pkg.clone().unwrap_or_else(|| "./...".into()));
    let o = run(&cmd, &ctx.root, 900);
    if raw_or(ctx, &both(&o)) {
        return o.code;
    }
    emit(go_report(&o.stdout, &o.stderr, o.code, o.secs, ctx.nmax));
    o.code
}

// ---------- ts / js ----------

/// Error lines + first user-code stack frame, paths relative to cwd; drops node internals.
pub fn js_trim(text: &str, cwd: &str) -> String {
    let mut out = Vec::new();
    let mut framed = false;
    let clean = re!(r"\x1b\[[0-9;]*m").replace_all(text, "");
    for l in clean.lines() {
        if re!(r"^\s+at ").is_match(l) {
            if framed || re!(r"node_modules|node:|<anonymous>|async_hooks").is_match(l) {
                continue;
            }
            framed = true;
        }
        let l = l.replace("file://", "").replace(&format!("{cwd}/"), "");
        // Windows: `C:\proj\x.ts` frames, and `/C:/proj/x.ts` left from file:/// URLs.
        let l = if cwd.contains('\\') { l.replace(&format!("{cwd}\\"), "").replace(&format!("/{}/", cwd.replace('\\', "/")), "").replace(&format!("{}/", cwd.replace('\\', "/")), "") } else { l };
        out.push(l);
    }
    out.join("\n")
}

/// Summary and failures from a vitest/jest `--json` report.
pub fn jest_report(kind: &str, r: &Value, secs: f64, nmax: usize) -> Vec<String> {
    let n = |k: &str| r[k].as_u64().unwrap_or(0);
    let mut o = vec![summary_line(kind, n("numPassedTests"), n("numFailedTests"), (n("numPendingTests") + n("numTodoTests")) as usize, Some(secs), "")];
    let cwd = s(&crate::kit::util::cwd());
    let mut shown = 0;
    for fr in r["testResults"].as_array().into_iter().flatten() {
        let fname = relcwd(fr["name"].as_str().unwrap_or(""));
        let asserts = fr["assertionResults"].as_array().map(Vec::as_slice).unwrap_or(&[]);
        if fr["status"] == "failed" && !asserts.iter().any(|t| t["status"] == "failed") {
            o.extend(fail_lines(&format!("suite {fname}"), fr["message"].as_str().unwrap_or(""), None));
        }
        for t in asserts {
            if t["status"] != "failed" || shown >= nmax {
                continue;
            }
            let msgs: Vec<&str> = t["failureMessages"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
            let body = js_trim(&msgs.join("\n"), &cwd);
            let loc = body.lines().find_map(|l| re!(r"\(?((?:\b[A-Za-z]:)?(?:/|\\|\w)[^():\s]*\.(?:t|j)sx?:\d+:\d+)").captures(l).map(|m| g(&m, 1).to_string()));
            let loc = loc.map(|l| if Path::new(&l).is_absolute() || l.starts_with('/') { relcwd(&l) } else { l });
            let name = t["fullName"].as_str().filter(|x| !x.is_empty()).or(t["title"].as_str()).unwrap_or("");
            o.extend(fail_lines(name, &body, loc.as_deref()));
            shown += 1;
        }
    }
    o
}

/// Summary (and failure lines when rc != 0) from bun / node --test / npm test text output.
pub fn js_text_report(kind: &str, text: &str, rc: i32, secs: f64) -> Vec<String> {
    let text = re!(r"\x1b\[[0-9;]*m").replace_all(text, "").into_owned();
    let mut o = Vec::new();
    match kind {
        "bun" => {
            let m = re!(r"(?s)(\d+) pass.*?\n\s*(\d+) fail").captures(&text);
            let (p, f) = m.as_ref().map_or(("?", "?"), |m| (g(m, 1), g(m, 2)));
            o.push(summary_line("bun", p, f, 0, Some(secs), ""));
        }
        "node" => {
            let m = re!(r"# pass (\d+)\n# fail (\d+)").captures(&text).or_else(|| re!(r"ℹ pass (\d+)\nℹ fail (\d+)").captures(&text));
            let (p, f) = m.as_ref().map_or(("?", "?"), |m| (g(m, 1), g(m, 2)));
            o.push(summary_line("node --test", p, f, 0, Some(secs), ""));
        }
        _ => o.push(format!("npm test: exit {rc} [{secs:.1}s]")),
    }
    if rc != 0 {
        let t = if kind == "node" || kind == "bun" { js_trim(&text, &s(&crate::kit::util::cwd())) } else { text };
        o.push(generic_failures(&t, 60));
    }
    o
}

/// Arguments for `node --test`: none without a test script, the script's own when it is a plain `node … --test …`
/// (bare, node takes every file under test/ for a test, helpers and fixtures too). None for any other script: npm runs it.
fn node_test_args(script: &str) -> Option<Vec<String>> {
    if script.trim().is_empty() {
        return Some(Vec::new());
    }
    let m = re!(r"^\s*node\s+([^&|;<>$`()\\]*)$").captures(script)?;
    let w: Vec<String> = re!(r#""([^"]*)"|'([^']*)'|(\S+)"#)
        .captures_iter(&m[1])
        .filter_map(|c| c.iter().skip(1).flatten().next().map(|a| a.as_str().to_string()))
        .collect();
    w.iter().any(|a| a == "--test").then(|| w.into_iter().filter(|a| a != "--test").collect())
}

fn ts(ctx: &Ctx, tmp: &Path) -> i32 {
    let root = &ctx.root;
    let pj: Value = serde_json::from_str(&read(root.join("package.json"))).unwrap_or(Value::Null);
    let script = pj["scripts"]["test"].as_str().unwrap_or("");
    // the test script decides; installed deps only break ties when it names no runner
    let named = ["vitest", "jest", "bun test", "node --test"].into_iter().find(|r| script.contains(r));
    let has_dep = |n: &str| named.is_none() && (pj["dependencies"].get(n).is_some() || pj["devDependencies"].get(n).is_some());
    let rep = tmp.join("r.json");
    let flt = |flag: &str| ctx.flt.as_ref().map(|f| vec![flag.to_string(), f.clone()]).unwrap_or_default();
    let target: Vec<String> = ctx.pkg.iter().cloned().collect();
    let local = |name: &str| match exe(name, Some(root)) {
        Some(t) => vec![t],
        None => vec![exe("npx", None).unwrap_or_else(|| "npx".into()), name.into()],
    };
    let (mut cmd, kind): (Vec<String>, &str);
    if named == Some("vitest") || (named.is_none() && has_dep("vitest")) {
        cmd = local("vitest");
        cmd.extend(["run".into(), "--reporter=json".into(), format!("--outputFile={}", s(&rep))]);
        cmd.extend(flt("-t"));
        kind = "vitest";
    } else if named == Some("jest") || (named.is_none() && has_dep("jest")) {
        cmd = local("jest");
        cmd.extend(["--json".into(), format!("--outputFile={}", s(&rep))]);
        cmd.extend(flt("-t"));
        kind = "jest";
    } else if named == Some("bun test") || (named.is_none() && (root.join("bun.lockb").exists() || root.join("bun.lock").exists())) {
        cmd = vec![need("bun", "bun not found"), "test".into()];
        cmd.extend(flt("-t"));
        kind = "bun";
    } else if let Some(args) = node_test_args(script) {
        cmd = vec![need("node", "node not found"), "--test".into()];
        cmd.extend(flt("--test-name-pattern"));
        if target.is_empty() {
            cmd.extend(args);
        }
        kind = "node";
    } else {
        cmd = vec![need("npm", "npm not found"), "test".into(), "--silent".into(), "--".into()];
        kind = "npm";
    }
    if kind != "npm" {
        cmd.extend(target);
    }
    cmd.extend(ctx.extra.iter().cloned());
    let o = run(&cmd, root, 900);
    if raw_or(ctx, &both(&o)) {
        return o.code;
    }
    if kind == "vitest" || kind == "jest" {
        if let Ok(r) = serde_json::from_str::<Value>(&read(&rep)) {
            emit(jest_report(kind, &r, o.secs, ctx.nmax));
            return o.code;
        }
    }
    emit(js_text_report(kind, &format!("{}\n{}", o.stdout, o.stderr), o.code, o.secs));
    o.code
}

// ---------- c# ----------

/// Summary and failures from .trx files (contents).
pub fn trx_report(trx: &[String], secs: f64, nmax: usize) -> Vec<String> {
    let (mut p, mut f, mut sk) = (0, 0, 0);
    let mut fails = Vec::new();
    for t in trx {
        if let Some(c) = xml_elems(t, "ResultSummary").first().and_then(|rs| xml_child(rs, "Counters")) {
            let n = |k: &str| c.attr(k).and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
            p += n("passed");
            f += n("failed");
            sk += n("notExecuted");
        }
        for r in xml_elems(t, "UnitTestResult") {
            if r.attr("outcome") != Some("Failed") || fails.len() >= nmax {
                continue;
            }
            let info = xml_child(&r, "ErrorInfo");
            let text = |tag: &str| info.as_ref().and_then(|i| xml_child(i, tag)).and_then(|e| e.inner.map(|x| xml_text(&x))).unwrap_or_default();
            let (msg, st) = (text("Message"), text("StackTrace"));
            let loc = re!(r" in (.+?):line (\d+)").captures(&st).map(|m| relcwd(format!("{}:{}", g(&m, 1), g(&m, 2))));
            fails.push((r.attr("testName").unwrap_or("").to_string(), msg, loc));
        }
    }
    let mut o = vec![summary_line("dotnet", p, f, sk, Some(secs), "")];
    for (n, m, l) in &fails {
        o.extend(fail_lines(n, m, l.as_deref()));
    }
    o
}

fn cs(ctx: &Ctx, tmp: &Path) -> i32 {
    let mut cmd = vec![need("dotnet", "dotnet not found"), "test".into()];
    cmd.extend(ctx.pkg.clone());
    cmd.extend(["--nologo", "-v", "q", "--logger", "trx", "--results-directory"].map(String::from));
    cmd.push(s(tmp));
    if let Some(f) = &ctx.flt {
        cmd.push("--filter".into());
        cmd.push(if f.contains(['=', '~', '!']) { f.clone() } else { format!("FullyQualifiedName~{f}") });
    }
    cmd.extend(ctx.extra.iter().cloned());
    let o = run(&cmd, &ctx.root, 900);
    if raw_or(ctx, &both(&o)) {
        return o.code;
    }
    let trx: Vec<PathBuf> = glob(tmp.join("*.trx"));
    if trx.is_empty() {
        let mut d = Diags::new(&ctx.root);
        parse_dotnet(&mut d, &both(&o), true);
        if d.items.is_empty() {
            println!("dotnet test: exit {}", o.code);
        } else {
            println!("dotnet: build failed, {} errors", d.count("E"));
        }
        d.print(30, false);
        if d.items.is_empty() {
            println!("{}", tail(&both(&o), 20));
        }
        return o.code;
    }
    emit(trx_report(&trx.iter().map(read).collect::<Vec<_>>(), o.secs, ctx.nmax));
    o.code
}

// ---------- dart ----------

/// Summary and failures from `dart|flutter test -r json` events.
pub fn dart_report(st: &str, out: &str, err: &str, rc: i32, secs: f64, nmax: usize) -> Vec<String> {
    let mut names: std::collections::HashMap<i64, (String, String, Option<i64>)> = Default::default();
    let mut errs: std::collections::HashMap<i64, Vec<String>> = Default::default();
    let mut res: OrdMap<i64, String> = OrdMap::default();
    let lib = re!(r"^(package:(test|matcher|test_api|flutter_test)|dart:)");
    for ln in out.lines() {
        let Ok(e) = serde_json::from_str::<Value>(ln) else { continue };
        match e["type"].as_str().unwrap_or("") {
            "testStart" => {
                let t = &e["test"];
                names.insert(t["id"].as_i64().unwrap_or(-1), (t["name"].as_str().unwrap_or("").into(), t["url"].as_str().unwrap_or("").into(), t["line"].as_i64()));
            }
            "error" => {
                let stack: Vec<&str> = e["stackTrace"].as_str().unwrap_or("").lines().filter(|l| !lib.is_match(l)).collect();
                let msg = format!("{}\n{}", e["error"].as_str().unwrap_or(""), trunc(&stack.join("\n"), 600));
                errs.entry(e["testID"].as_i64().unwrap_or(-1)).or_default().push(msg);
            }
            "testDone" if e["hidden"] != true => {
                let r = if e["skipped"] == true { "skip".to_string() } else { e["result"].as_str().unwrap_or("").to_string() };
                res.insert(e["testID"].as_i64().unwrap_or(-1), r);
            }
            _ => {}
        }
    }
    let cnt = |f: &dyn Fn(&str) -> bool| res.items.iter().filter(|(_, v)| f(v)).count();
    let bad = |v: &str| v == "failure" || v == "error";
    let f = cnt(&bad);
    let mut o = vec![summary_line(st, cnt(&|v| v == "success"), f, cnt(&|v| v == "skip"), Some(secs), "")];
    let mut shown = 0;
    for (tid, v) in &res.items {
        if bad(v) && shown < nmax {
            let (n, url, line) = names.get(tid).cloned().unwrap_or((tid.to_string(), String::new(), None));
            let loc = line.filter(|l| *l != 0).map(|l| format!("{}:{l}", crate::kit::util::file_url_path(&url).map(relcwd).unwrap_or(url.clone())));
            o.extend(fail_lines(&n, &errs.get(tid).map(|v| v.join("\n")).unwrap_or_default(), loc.as_deref()));
            shown += 1;
        }
    }
    if rc != 0 && f == 0 {
        o.push(generic_failures(&format!("{out}{err}"), 60));
    }
    o
}

fn dart(ctx: &Ctx) -> i32 {
    let pub_ = read(ctx.root.join("pubspec.yaml"));
    let flutter = re!(r"(?m)^\s+flutter:\s*\n\s+sdk: flutter").is_match(&pub_);
    let exe_ = (if flutter { exe("flutter", None) } else { None }).or_else(|| exe("dart", None)).unwrap_or_else(|| die(T, "dart/flutter not found", 2));
    let mut cmd = vec![exe_.clone(), "test".into(), "-r".into(), "json".into()];
    if let Some(f) = &ctx.flt {
        cmd.extend(["--name".into(), f.clone()]);
    }
    cmd.extend(ctx.pkg.clone());
    cmd.extend(ctx.extra.iter().cloned());
    let o = run(&cmd, &ctx.root, 900);
    if raw_or(ctx, &both(&o)) {
        return o.code;
    }
    let st = Path::new(&exe_).file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or(exe_.clone());
    emit(dart_report(&st, &o.stdout, &o.stderr, o.code, o.secs, ctx.nmax));
    o.code
}

// ---------- python ----------

/// Summary and failures from `pytest -q --tb=short -rfE` output.
pub fn pytest_report(out: &str, rc: i32, secs: f64, nmax: usize) -> Vec<String> {
    let m = re!(r"=+ (.*) in [\d.]+s").captures(out).or_else(|| re!(r"(?m)^(\d+ (passed|failed).*?) in").captures(out));
    let line = m.map(|m| g(&m, 1).to_string()).unwrap_or_else(|| format!("exit {rc}"));
    let n = |k: &str| Regex::new(&format!(r"(\d+) {k}")).ok().and_then(|r| r.captures(&line)).map_or(0, |c| gn(&c, 1));
    let mut o = vec![summary_line("pytest", n("passed"), n("failed") + n("error"), n("skipped"), Some(secs), "")];
    let locrx = re!(r"^(?:[A-Za-z]:)?[\w/.\\-]+\.py:\d+");
    for (name, body) in split_blocks(out, re!(r"(?m)^_{3,} (.+?) _{3,}$")).into_iter().take(nmax) {
        let body = body.split("\n=").next().unwrap_or("");
        let keep: Vec<&str> = body.lines().filter(|l| l.starts_with("E ") || l.starts_with('>') || locrx.is_match(l)).collect();
        let loc = keep.iter().find_map(|l| locrx.find(l)).map(|m| m.as_str());
        o.extend(fail_lines(name, &keep.join("\n"), loc));
    }
    o
}
/// unittest fallback summary from its stderr.
pub fn unittest_report(err: &str, rc: i32, secs: f64) -> Vec<String> {
    let num = |rx: &Regex| rx.captures(err).map_or(0, |c| gn(&c, 1));
    let n = num(re!(r"Ran (\d+) tests?"));
    let nf = num(re!(r"failures=(\d+)")) + num(re!(r"errors=(\d+)"));
    let mut o = vec![summary_line("unittest", n.saturating_sub(nf), nf, 0, Some(secs), "")];
    if rc != 0 {
        o.push(generic_failures(err, 60));
    }
    o
}

fn py(ctx: &Ctx) -> i32 {
    let root = &ctx.root;
    let venv = [".venv/bin/python", "venv/bin/python", ".venv/Scripts/python.exe", "venv/Scripts/python.exe"]
        .iter()
        .map(|p| root.join(p))
        .find(|p| p.exists());
    let pyexe = venv.map(|p| s(&p)).unwrap_or_else(python);
    let mut cmd: Vec<String> = [pyexe.as_str(), "-m", "pytest", "-q", "--tb=short", "-rfE", "--no-header"].map(String::from).to_vec();
    if let Some(f) = &ctx.flt {
        cmd.extend(["-k".into(), f.clone()]);
    }
    cmd.extend(ctx.pkg.clone());
    cmd.extend(ctx.extra.iter().cloned());
    let mut o = run(&cmd, root, 900);
    if raw_or(ctx, &both(&o)) {
        return o.code;
    }
    if o.stderr.contains("No module named pytest") {
        if let Some(uvx) = exe("uvx", None) {
            let mut c = vec![uvx, "pytest".into()];
            c.extend(cmd[3..].iter().cloned());
            o = run(&c, root, 900);
        }
    }
    if o.stderr.contains("No module named pytest") {
        let mut c = vec![pyexe, "-m".into(), "unittest".into()];
        if let Some(f) = &ctx.flt {
            c.extend(["-k".into(), f.clone()]);
        }
        let o = run(&c, root, 900);
        if o.stderr.contains("Ran 0 tests") {
            println!("py: pytest not installed and unittest found 0 tests (pip install pytest)");
            return 1;
        }
        emit(unittest_report(&o.stderr, o.code, o.secs));
        return o.code;
    }
    emit(pytest_report(&o.stdout, o.code, o.secs, ctx.nmax));
    o.code
}

// ---------- luau ----------

fn luau(ctx: &Ctx) -> i32 {
    let root = &ctx.root;
    let lune = exe("lune", None);
    let mut tests: Vec<PathBuf> = glob(root.join(".lune").join("test*.luau"));
    tests.extend(glob(root.join("lune").join("test*.luau")));
    tests.sort();
    let cmd = match (lune, tests.first()) {
        (Some(l), Some(t)) => {
            let r = relpath(t, root).replace('\\', "/");
            let script = r.strip_suffix(".luau").unwrap_or(&r);
            let script = script.strip_prefix(".lune/").unwrap_or(script).to_string();
            let mut c = vec![l, "run".into(), script];
            c.extend(ctx.flt.clone());
            c.extend(ctx.extra.iter().cloned());
            c
        }
        _ if exe("run-in-roblox", None).is_some() && !glob(root.join("*.project.json")).is_empty() => {
            die(T, "run-in-roblox found but no runner script; run your TestEZ/Jest-Lua place manually (or pass -- args)", 2)
        }
        _ => die(T, "no Luau test runner found (expected lune + .lune/test*.luau)", 2),
    };
    let o = run(&cmd, root, 900);
    if raw_or(ctx, &both(&o)) {
        return o.code;
    }
    let text = format!("{}\n{}", o.stdout, o.stderr);
    let m = re!(r"(?si)(\d+) passed.*?(\d+) failed").captures(&text);
    let (p, f) = match &m {
        Some(m) => (g(m, 1), g(m, 2)),
        None => ("?", if o.code == 0 { "0" } else { "?" }),
    };
    summary("luau", p, f, 0, Some(o.secs), "");
    if o.code != 0 {
        println!("{}", generic_failures(&text, 60));
    }
    o.code
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_test_script_args() {
        let v = |a: &[&str]| Some(a.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(node_test_args(""), v(&[]));
        assert_eq!(node_test_args("node --test"), v(&[]));
        assert_eq!(node_test_args("node --test test/*.test.mjs"), v(&["test/*.test.mjs"]));
        assert_eq!(node_test_args(r#"node --import tsx --test "test/**/*.test.ts""#), v(&["--import", "tsx", "test/**/*.test.ts"]));
        for other in ["tsc && node --test dist/", "NODE_ENV=test node --test", "node test/run.js", "c8 node --test"] {
            assert_eq!(node_test_args(other), None, "{other}");
        }
    }

    #[test]
    fn cargo_test_summary() {
        let out = "running 3 tests\ntest a ... ok\ntest b ... FAILED\n\nfailures:\n\n---- tests::b stdout ----\n\nthread 'tests::b' panicked at src/lib.rs:10:5:\nassertion `left == right` failed\n  left: 1\n right: 2\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n\n\nfailures:\n    tests::b\n\ntest result: FAILED. 2 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\n";
        let o = rust_report(out, "", 101, 1.24, 10);
        assert_eq!(o[0], "rust: 2 passed, 1 failed, 1 skipped [1.2s]");
        assert_eq!(o[1], "FAIL tests::b  (src/lib.rs:10:5)");
        assert!(o.iter().any(|l| l.contains("left: 1")) && !o.iter().any(|l| l.contains("RUST_BACKTRACE")));
        assert_eq!(o.len(), 6);
    }

    #[test]
    fn go_test_json() {
        let out = r#"{"Action":"run","Package":"ex/a","Test":"TestA"}
{"Action":"output","Package":"ex/a","Test":"TestA","Output":"=== RUN   TestA\n"}
{"Action":"output","Package":"ex/a","Test":"TestA","Output":"    a_test.go:9: got 1 want 2\n"}
{"Action":"fail","Package":"ex/a","Test":"TestA","Elapsed":0}
{"Action":"output","Package":"ex/a","Test":"TestB/sub","Output":"    b_test.go:4: nope\n"}
{"Action":"fail","Package":"ex/a","Test":"TestB/sub"}
{"Action":"fail","Package":"ex/a","Test":"TestB"}
{"Action":"pass","Package":"ex/a","Test":"TestC"}
{"Action":"skip","Package":"ex/a","Test":"TestD"}
{"Action":"fail","Package":"ex/a"}"#;
        let o = go_report(out, "", 1, 0.5, 10);
        assert_eq!(o[0], "go: 1 passed, 2 failed, 1 skipped [0.5s]");
        assert_eq!(o[1], "FAIL TestA  [ex/a]  (a_test.go:9)");
        assert_eq!(o[2], "        a_test.go:9: got 1 want 2");
        assert_eq!(o[3], "FAIL TestB/sub  [ex/a]  (b_test.go:4)");
        assert_eq!(o.len(), 5);
        let build = "# ex/a\na.go:3:2: undefined: x\n{\"Action\":\"fail\",\"Package\":\"ex/a\"}\n";
        let o = go_report(build, "", 1, 0.1, 10);
        assert!(o[0].starts_with("go: build failed"));
        assert_eq!(o[1], "BUILD a.go:3:2: undefined: x");
    }

    #[test]
    fn jest_json() {
        let r: Value = serde_json::from_str(r#"{"numPassedTests":3,"numFailedTests":1,"numPendingTests":1,"numTodoTests":0,"testResults":[
          {"name":"/nowhere/a.test.ts","status":"failed","assertionResults":[{"status":"passed","title":"ok"},
           {"status":"failed","fullName":"math adds","title":"adds","failureMessages":["Error: expect(received).toBe(expected)\n\nExpected: 2\nReceived: 3\n    at /nowhere/a.test.ts:5:13\n    at node_modules/x.js:1:1"]}]},
          {"name":"/nowhere/b.test.ts","status":"failed","message":"SyntaxError: bad","assertionResults":[]}]}"#).unwrap();
        let o = jest_report("jest", &r, 2.0, 10);
        assert_eq!(o[0], "jest: 3 passed, 1 failed, 1 skipped [2.0s]");
        assert!(o[1].starts_with("FAIL math adds  (") && o[1].ends_with("a.test.ts:5:13)"));
        assert!(!o.iter().any(|l| l.contains("node_modules")));
        assert!(o.iter().any(|l| l.starts_with("FAIL suite ") && l.ends_with("b.test.ts")));
        let o = js_text_report("node", "# tests 3\n# pass 2\n# fail 1\nnot ok 1 - x\n", 1, 1.0);
        assert_eq!(o[0], "node --test: 2 passed, 1 failed [1.0s]");
        assert!(o[1].contains("not ok 1 - x"));
        let o = js_text_report("bun", " 4 pass\n 0 fail\n", 0, 1.0);
        assert_eq!(o, vec!["bun: 4 passed, 0 failed [1.0s]"]);
    }

    #[test]
    fn pytest_and_unittest() {
        let out = "..F.s                                                     [100%]\n=================================== FAILURES ===================================\n________________________________ test_add ________________________________\ntests/test_m.py:5: in test_add\n    assert add(1, 1) == 3\nE   assert 2 == 3\n=========================== short test summary info ============================\nFAILED tests/test_m.py::test_add - assert 2 == 3\n1 failed, 3 passed, 1 skipped in 0.12s\n";
        let o = pytest_report(out, 1, 0.2, 10);
        assert_eq!(o[0], "pytest: 3 passed, 1 failed, 1 skipped [0.2s]");
        assert_eq!(o[1], "FAIL test_add  (tests/test_m.py:5)");
        assert_eq!(o[3], "    E   assert 2 == 3");
        let o = pytest_report("==== 2 passed, 1 error in 0.50s ====\n", 1, 0.5, 10);
        assert_eq!(o[0], "pytest: 2 passed, 1 failed [0.5s]");
        let o = unittest_report("F.\nFAIL: test_x\nRan 2 tests in 0.001s\n\nFAILED (failures=1)\n", 1, 0.1);
        assert_eq!(o[0], "unittest: 1 passed, 1 failed [0.1s]");
    }

    #[test]
    fn trx_and_dart() {
        let trx = r#"<?xml version="1.0"?><TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><Results>
<UnitTestResult testName="T.Adds" outcome="Passed"/>
<UnitTestResult testName="T.Subs" outcome="Failed"><Output><ErrorInfo><Message>Assert.Equal() Failure&#xD;
Expected: 1</Message><StackTrace>   at T.Subs() in /nowhere/T.cs:line 12</StackTrace></ErrorInfo></Output></UnitTestResult>
</Results><ResultSummary outcome="Failed"><Counters total="2" executed="2" passed="1" failed="1" notExecuted="0"/></ResultSummary></TestRun>"#;
        let o = trx_report(&[trx.to_string()], 3.0, 10);
        assert_eq!(o[0], "dotnet: 1 passed, 1 failed [3.0s]");
        assert!(o[1].starts_with("FAIL T.Subs  (") && o[1].ends_with("T.cs:12)"));
        assert_eq!(o[2].trim(), "Assert.Equal() Failure");
        let out = r#"{"type":"testStart","test":{"id":3,"name":"adds","url":"file:///nowhere/test/a_test.dart","line":7}}
{"type":"error","testID":3,"error":"Expected: <2>\n  Actual: <3>","stackTrace":"package:matcher/x.dart 1:1\nfile:///nowhere/test/a_test.dart 8:5"}
{"type":"testDone","testID":3,"result":"failure","hidden":false,"skipped":false}
{"type":"testStart","test":{"id":4,"name":"ok","url":null,"line":null}}
{"type":"testDone","testID":4,"result":"success","hidden":false,"skipped":false}
{"type":"testDone","testID":1,"result":"success","hidden":true}"#;
        let o = dart_report("flutter", out, "", 1, 1.0, 10);
        assert_eq!(o[0], "flutter: 1 passed, 1 failed [1.0s]");
        assert!(o[1].starts_with("FAIL adds  (") && o[1].ends_with("a_test.dart:7)"));
        assert!(!o.iter().any(|l| l.contains("package:matcher")));
    }

    #[test]
    fn js_trim_windows_paths() {
        let t = "Error: boom\n    at f (C:\\proj\\src\\a.ts:3:5)\n    at g (file:///C:/proj/src/b.mjs:4:1)\n";
        assert_eq!(js_trim(t, "C:\\proj"), "Error: boom\n    at f (src\\a.ts:3:5)");
        assert_eq!(js_trim("    at x (file:///C:/proj/src/b.mjs:4:1)", "C:\\proj"), "    at x (src/b.mjs:4:1)");
    }
}
