//! `tmap kit debug`: failure + the code it points at + recent changes, at once.

use super::distill::{last_lines, render, run_combined};
use super::symctx::{self, block, last_def, read_lines};
use super::util;
use regex::Regex;
use std::fmt::Write;
use std::path::Path;

const HELP: &str = "Debug mode, first call: failure + the code it points at + recent changes, at once.

  tmap kit debug                     run the project's tests
  tmap kit debug -- node --test test/tax.test.js
  tmap kit debug --trace FILE|-      parse a stack trace / error log instead

Prints (bounded): failing tests with expected/actual (distilled when large),
the enclosing function of the top in-repo stack frames (source frames before
test frames), and the last commits touching those files with a compact diff
of the newest one: the usual \"what changed\" answer for regressions.
";

const QUESTION: &str =
    "List each failing test or error: name, file:line, expected vs actual or error message. Then the first in-project stack frame.";

const NOT_CALLS: &[&str] = &[
    "test", "it", "describe", "expect", "assert", "equal", "strictEqual", "deepEqual", "deepStrictEqual", "notEqual", "ok", "throws", "rejects",
    "match", "toBe", "toEqual", "toThrow", "toMatch", "assertEqual", "assertTrue", "assertRaises", "if", "for", "while", "switch", "return",
    "function", "require", "import", "console", "log", "new", "async", "await", "catch",
];

/// The project's default test command, detected from manifests in `root`.
fn default_cmd(root: &Path) -> Option<Vec<String>> {
    let has = |f: &str| root.join(f).is_file();
    let v: &[&str] = if has("package.json") {
        &["npm", "test", "--silent"]
    } else if has("Cargo.toml") {
        &["cargo", "test", "-q"]
    } else if has("go.mod") {
        &["go", "test", "./..."]
    } else if has("pubspec.yaml") {
        if std::fs::read_to_string(root.join("pubspec.yaml")).unwrap_or_default().contains("flutter") { &["flutter", "test"] } else { &["dart", "test"] }
    } else if has("pyproject.toml") || has("setup.py") || has("pytest.ini") {
        &["python3", "-m", "pytest", "-q"]
    } else {
        return None;
    };
    Some(v.iter().map(|s| s.to_string()).collect())
}

fn is_testish(f: &str) -> bool {
    f.contains("test") || f.contains("spec")
}

/// In-repo `path:line` frames from `text`: existing files, deps skipped, source before tests, at most 3.
fn frames(text: &str, root: &Path) -> Vec<(String, usize)> {
    // Windows frames: `C:\proj\src\a.ts:3:5`, `src\lib.rs:10:5`, `file:///C:/proj/a.mjs:3:9`.
    let re = Regex::new(r"(?:\b[A-Za-z]:)?[A-Za-z0-9_@./\\-]+\.(js|mjs|cjs|ts|tsx|jsx|py|rs|go|dart|java|kt|rb|php|cs|cpp|cc|c|h|lua|luau|sh):[0-9]+").unwrap();
    let root_s = root.to_string_lossy().replace('\\', "/");
    let prefix = format!("{}/", root_s.trim_end_matches('/'));
    let mut seen = std::collections::HashSet::new();
    let mut v: Vec<(bool, String, usize)> = Vec::new();
    for m in re.find_iter(text) {
        let m = m.as_str().replace('\\', "/");
        let mut s = m.as_str();
        if s.starts_with("//") {
            s = s.trim_start_matches('/');
            s = &m[m.len() - s.len() - 1..];
        }
        // `/C:/x` (from a file:/// URL) -> `C:/x`
        if s.len() > 3 && s.as_bytes()[0] == b'/' && s.as_bytes()[2] == b':' && s.as_bytes()[1].is_ascii_alphabetic() {
            s = &s[1..];
        }
        // Windows paths compare case-insensitively (`c:/Proj` vs `C:/proj`).
        let under = s.get(..prefix.len()).filter(|h| if cfg!(windows) { h.eq_ignore_ascii_case(&prefix) } else { *h == prefix });
        let s = if under.is_some() { &s[prefix.len()..] } else { s };
        let s = s.strip_prefix("./").unwrap_or(s);
        if !seen.insert(s.to_string()) {
            continue;
        }
        let Some((f, l)) = s.rsplit_once(':') else { continue };
        let abs = f.starts_with('/') || f.as_bytes().get(1) == Some(&b':');
        if abs || f.starts_with("node_modules/") || f.contains("/node_modules/") || ["vendor/", "target/", "dist/", "build/"].iter().any(|p| f.starts_with(p)) {
            continue;
        }
        if !root.join(f).is_file() {
            continue;
        }
        v.push((is_testish(f), f.to_string(), l.parse().unwrap_or(1)));
    }
    v.sort_by_key(|x| x.0);
    v.into_iter().take(3).map(|(_, f, l)| (f, l)).collect()
}

/// Called names on the 13 lines from `l` of a test file: the code under test (at most 2).
fn called_names(lines: &[String], l: usize) -> Vec<String> {
    let re = Regex::new(r"[A-Za-z_$][A-Za-z0-9_$]*\(").unwrap();
    let mut out: Vec<String> = Vec::new();
    for line in lines.iter().skip(l.saturating_sub(1)).take(13) {
        for m in re.find_iter(line) {
            let n = m.as_str().trim_end_matches('(');
            if !NOT_CALLS.contains(&n) && !out.iter().any(|o| o == n) {
                out.push(n.to_string());
            }
        }
    }
    out.truncate(2);
    out
}

fn summary_filter(distilled: &str) -> Vec<String> {
    let drop = Regex::new(r"node:internal|node:async_hooks|^ℹ (suites|cancelled|skipped|todo|duration)|^\s*(generatedMessage|operator|diff):").unwrap();
    distilled.lines().filter(|l| !l.starts_with("===== ") && !drop.is_match(l)).take(45).map(str::to_string).collect()
}

fn context(text: &str, root: &Path, out: &mut String) {
    for l in summary_filter(&render(&format!("===== failure =====\n{text}"), None, QUESTION, 12, 5000)) {
        let _ = writeln!(out, "{l}");
    }
    let fr = frames(text, root);
    if fr.is_empty() {
        out.push_str("\n(no in-repo stack frame found; locate with tmap find / tmap kit ctx)\n");
        return;
    }
    out.push_str("\n## code at the top frames\n");
    let def = Regex::new(r"^\s*(export\s+)?(default\s+)?(async\s+)?(function|def|fn|func|class|pub fn|pub\(crate\) fn|public|private|protected|static)\s|^\s*(test|it|describe)\(").unwrap();
    for (f, l) in &fr {
        let lines = read_lines(&root.join(f));
        let d = match last_def(&lines, *l, &def) {
            0 => l.saturating_sub(10).max(1),
            d => d,
        };
        let _ = writeln!(out, "-- {f}:{l} (enclosing from line {d})");
        for b in block(&lines, d, Some(*l), 60, true) {
            let _ = writeln!(out, "{b}");
        }
    }
    // Functions called from test frames: the code under test (assertion failures have no source frame).
    let imports = Regex::new(r"^\s*(import |export .* from |const .*= *require\(|from [A-Za-z_.]+ import |use |#include )").unwrap();
    let loc_re = Regex::new(r"^== \.?/?([^:]*):").unwrap();
    let mut extra: Vec<String> = Vec::new();
    let mut idx = None;
    for (f, l) in fr.iter().filter(|(f, _)| is_testish(f)) {
        for nm in called_names(&read_lines(&root.join(f)), *l) {
            let _ = writeln!(out, "\n## code under test: {nm}");
            let ix = idx.get_or_insert_with(|| symctx::load_index(root));
            let body = symctx::symbol_text(root, ix.as_ref(), &nm, None, 30).unwrap_or_default();
            out.push_str(&body);
            let loc = body.lines().find_map(|b| loc_re.captures(b).map(|c| c[1].to_string()));
            if let Some(loc) = loc.filter(|p| root.join(p).is_file() && !extra.contains(p)) {
                let _ = writeln!(out, "-- imports of {loc}:");
                for (i, s) in read_lines(&root.join(&loc)).iter().enumerate().filter(|(_, s)| imports.is_match(s)).take(10) {
                    let _ = writeln!(out, "{}:{s}", i + 1);
                }
                extra.push(loc);
            }
        }
    }
    let mut files = extra;
    for (f, _) in &fr {
        if !files.contains(f) {
            files.push(f.clone());
        }
    }
    if util::run(&["git", "rev-parse", "--git-dir"], root, 10, &[], None).code != 0 {
        return;
    }
    let git = |pre: &[&str]| {
        let mut a: Vec<&str> = pre.to_vec();
        a.push("--");
        a.extend(files.iter().map(String::as_str));
        util::git(root, &a)
    };
    let _ = writeln!(out, "\n## recent commits touching: {} ", files.join(" "));
    out.push_str(&git(&["log", "-n", "4", "--format=%h %ad %s", "--date=short"]));
    let newest = git(&["log", "-n", "1", "--format=%h"]).trim().to_string();
    if !newest.is_empty() && !util::git(root, &["rev-parse", "-q", "--verify", &format!("{newest}^")]).is_empty() {
        let _ = writeln!(out, "-- diff of {newest} on those files (-U1, capped):");
        for l in git(&["show", "-U1", "--format=", &newest]).lines().take(40) {
            let _ = writeln!(out, "{l}");
        }
    }
    if !git(&["status", "--porcelain"]).trim().is_empty() {
        out.push_str("-- uncommitted changes:\n");
        for l in git(&["diff", "-U1"]).lines().take(30) {
            let _ = writeln!(out, "{l}");
        }
    }
}

pub fn main(args: Vec<String>) -> i32 {
    let (mut trace, mut cmd) = (None::<String>, Vec::new());
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--trace" => trace = Some(it.next().unwrap_or_else(|| "-".into())),
            "--" => {
                cmd = it.collect();
                break;
            }
            "-h" | "--help" => {
                print!("{HELP}");
                return 0;
            }
            _ => {}
        }
    }
    let here = util::cwd();
    let root = util::git_root(&here).unwrap_or_else(|| here.clone());
    let root = util::canon(&root);
    let mut out = String::new();
    let text = if let Some(t) = trace {
        let text = if t == "-" { util::read_stdin() } else { String::from_utf8_lossy(&std::fs::read(here.join(&t)).unwrap_or_default()).into_owned() };
        let _ = writeln!(out, "## trace ({} lines)", text.matches('\n').count());
        text
    } else {
        if cmd.is_empty() {
            match default_cmd(&root) {
                Some(c) => cmd = c,
                None => {
                    println!("no test command detected; pass one after --, or use --trace");
                    return 1;
                }
            }
        }
        let (rc, text) = run_combined(&cmd, &root);
        let _ = writeln!(out, "## $ {}  (exit {rc})", cmd.join(" "));
        if rc == 0 {
            out.push_str("tests pass\n");
            for l in last_lines(&text, 3) {
                let _ = writeln!(out, "{l}");
            }
            print!("{out}");
            return 0;
        }
        text
    };
    context(&text, &root, &mut out);
    print!("{out}");
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_prefer_source_and_skip_deps() {
        let root = std::env::temp_dir().join(format!("tforge-debug-{}", std::process::id()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("test")).unwrap();
        std::fs::write(root.join("src/tax.js"), "x\n").unwrap();
        std::fs::write(root.join("test/tax.test.js"), "x\n").unwrap();
        let r = root.to_string_lossy();
        let log = format!(
            "at Object.<anonymous> ({r}/test/tax.test.js:5:3)\n at node_modules/x/y.js:1\n at ./src/tax.js:12\n at src/tax.js:12\n at src/missing.js:3\n at /usr/lib/z.js:9\n"
        );
        assert_eq!(frames(&log, &root), vec![("src/tax.js".to_string(), 12), ("test/tax.test.js".to_string(), 5)]);
        // Windows-style frames: backslashes, drive letters, file:/// URLs.
        let rb = r.replace('/', "\\");
        let win = format!(
            "at Object.<anonymous> ({rb}\\test\\tax.test.js:5:3)\n at C:\\other\\z.js:1:1\n at file:///D:/x/src/tax.js:2:1\n at src\\tax.js:12:5\n"
        );
        assert_eq!(frames(&win, &root), vec![("src/tax.js".to_string(), 12), ("test/tax.test.js".to_string(), 5)]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn called_names_skip_assertions() {
        let lines: Vec<String> = ["test('adds', () => {", "  assert.equal(addTax(2), 3);", "  expect(fmt(x)).toBe(1)", "});"].iter().map(|s| s.to_string()).collect();
        assert_eq!(called_names(&lines, 1), vec!["addTax", "fmt"]);
    }

    #[test]
    fn summary_drops_noise() {
        let s = "===== f =====\nfail 1\nℹ duration 3\n    at node:internal/x\n  operator: 'x'\nkept\n";
        assert_eq!(summary_filter(s), vec!["fail 1", "kept"]);
    }

    #[test]
    fn default_cmd_from_manifest() {
        let d = std::env::temp_dir().join(format!("tforge-debug-cmd-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        assert!(default_cmd(&d).is_none());
        std::fs::write(d.join("go.mod"), "module x\n").unwrap();
        assert_eq!(default_cmd(&d).unwrap(), vec!["go", "test", "./..."]);
        let _ = std::fs::remove_dir_all(&d);
    }
}
