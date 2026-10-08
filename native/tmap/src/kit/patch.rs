//! `tmap kit patch`: apply edits AND validate in one call (one model turn instead of 2-3).

use super::distill::{last_lines, render, run_combined, shell};
use super::symctx;
use super::util;
use regex::Regex;
use serde_json::Value;
use std::path::Path;

const HELP: &str = r#"Apply edits AND validate in one call (one model turn instead of 2-3).

  tmap kit patch <<'JSON'
  {"edits": [
     {"file": "src/a.js", "find": "exact old text", "replace": "new text"},
     {"file": "src/a.js", "find": "x", "replace": "y", "all": true},
     {"file": "src/new.js", "create": "full content of a NEW file"}
   ],
   "test": "node --test test/a.test.js"}
  JSON

Atomic: every `find` must match exactly once (or `"all": true`) and every
`create` target must not exist; otherwise nothing is written (exit 3) and the
failing edit is reported with the closest matching line. Then runs `test` (if
omitted: tests the tmap index marks as affected by the changed files, else the
project's default test command). Prints diff stat + a compact test result;
big test output is distilled (tmap kit distill). Exit code = test result.
Edits are plain file writes: Claude Code's Edit-tool diff view is bypassed,
so use this when the change is already decided.
"#;

const QUESTION: &str = "Did the tests pass? Give pass/fail counts. For each failure: test name, file:line, expected vs actual, error message.";

/// Python-style repr of a string (as the original script printed hints).
fn py_repr(s: &str) -> String {
    let q = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut out = String::from(q);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == q => {
                out.push('\\');
                out.push(c);
            }
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push(q);
    out
}

/// Closest line to `first` (difflib.get_close_matches, n=1, cutoff 0.5): (1-based line, text).
fn closest(first: &str, text: &str) -> Option<(usize, String)> {
    let lines: Vec<&str> = text.lines().collect();
    let mut best: Option<(f32, &str)> = None;
    for l in &lines {
        let r = similar::TextDiff::from_chars(first, *l).ratio();
        if r >= 0.5 && best.is_none_or(|(br, bl)| r > br || (r == br && *l > bl)) {
            best = Some((r, l));
        }
    }
    let (_, l) = best?;
    Some((lines.iter().position(|x| *x == l)? + 1, l.to_string()))
}

/// Apply all edits in memory; write only if every edit succeeds. Ok: (summary, changed files).
fn apply(spec: &Value, cwd: &Path) -> Result<(String, Vec<String>), Vec<String>> {
    let empty = vec![];
    let edits = spec.get("edits").and_then(Value::as_array).unwrap_or(&empty);
    let mut buf: Vec<(String, String)> = Vec::new();
    let mut created = 0;
    let mut errs = Vec::new();
    let s = |e: &Value, k: &str| e.get(k).and_then(Value::as_str).map(str::to_string);
    for (i, e) in edits.iter().enumerate().map(|(i, e)| (i + 1, e)) {
        let Some(f) = s(e, "file") else {
            errs.push(format!("edit {i}: missing \"file\""));
            continue;
        };
        let pos = buf.iter().position(|(p, _)| *p == f);
        if e.get("create").is_some() {
            let Some(c) = s(e, "create") else {
                errs.push(format!("edit {i}: \"create\" must be a string"));
                continue;
            };
            if cwd.join(&f).exists() || pos.is_some() {
                errs.push(format!("edit {i}: {f} already exists (use find/replace)"));
                continue;
            }
            buf.push((f, c));
            created += 1;
            continue;
        }
        let (Some(find), Some(rep)) = (s(e, "find"), s(e, "replace")) else {
            errs.push(format!("edit {i}: {f}: needs \"find\" and \"replace\" (or \"create\")"));
            continue;
        };
        let pos = match pos {
            Some(p) => p,
            None => match std::fs::read(cwd.join(&f)) {
                Err(_) => {
                    errs.push(format!("edit {i}: no such file {f}"));
                    continue;
                }
                Ok(b) => match String::from_utf8(b) {
                    Ok(t) => {
                        buf.push((f.clone(), t));
                        buf.len() - 1
                    }
                    Err(_) => {
                        errs.push(format!("edit {i}: {f}: not UTF-8 text"));
                        continue;
                    }
                },
            },
        };
        let all = e.get("all").and_then(Value::as_bool).unwrap_or(false);
        let text = &buf[pos].1;
        // CRLF file, LF JSON text: match and write with the file's line endings.
        let (find, rep) = if util::is_crlf(text) && !find.contains('\r') && !rep.contains('\r') {
            (find.replace('\n', "\r\n"), rep.replace('\n', "\r\n"))
        } else {
            (find, rep)
        };
        let n = text.matches(find.as_str()).count();
        if n == 0 || (n > 1 && !all) {
            let msg = if n == 0 { "not found".to_string() } else { format!("matches {n} times (add context or set all)") };
            let first = find.trim().lines().next().unwrap_or("");
            let hint = closest(first, text).map_or(String::new(), |(ln, l)| format!("; closest line {ln}: {}", py_repr(&l.trim().chars().take(120).collect::<String>())));
            errs.push(format!("edit {i}: {f}: find text {msg}{hint}"));
            continue;
        }
        buf[pos].1 = if all { text.replace(&find, &rep) } else { text.replacen(&find, &rep, 1) };
    }
    if !errs.is_empty() {
        return Err(errs);
    }
    for (f, t) in &buf {
        let p = cwd.join(f);
        if let Some(d) = p.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        if let Err(e) = std::fs::write(&p, t) {
            return Err(vec![format!("{f}: {e}")]);
        }
    }
    let mut msg = format!("applied {} edit(s) to {} file(s)", edits.len(), buf.len());
    if created > 0 {
        msg += &format!(", created {created}");
    }
    Ok((msg, buf.into_iter().map(|(f, _)| f).collect()))
}

/// Affected test files (from the tmap index), as paths relative to `cwd`.
fn affected(cwd: &Path, changed: &[String]) -> Vec<String> {
    let root = symctx::index_root();
    let Some(idx) = symctx::load_index(&root) else { return vec![] };
    let rel: Vec<String> = changed.iter().map(|c| symctx::root_rel(&root, c)).collect();
    let here = util::canon(cwd);
    symctx::affected_tests(&idx, &rel)
        .into_iter()
        .take(15)
        .map(|t| {
            let p = root.join(&t);
            p.strip_prefix(&here).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_else(|_| util::slash(&p))
        })
        .collect()
}

/// Narrowest test command for `cwd`: node --test / pytest on affected tests, else the stack default.
fn test_cmd(cwd: &Path, tests: &[String]) -> Option<String> {
    let has = |f: &str| cwd.join(f).is_file();
    let tests = tests.join(" ");
    Some(if has("package.json") {
        let pj = std::fs::read_to_string(cwd.join("package.json")).unwrap_or_default();
        if !tests.is_empty() && Regex::new(r#""test": *"node --test"#).unwrap().is_match(&pj) { format!("node --test {tests}") } else { "npm test --silent".into() }
    } else if has("Cargo.toml") {
        "cargo test -q".into()
    } else if has("go.mod") {
        "go test ./...".into()
    } else if has("pubspec.yaml") {
        if std::fs::read_to_string(cwd.join("pubspec.yaml")).unwrap_or_default().contains("flutter") { "flutter test".into() } else { "dart test".into() }
    } else if has("pyproject.toml") || has("setup.py") || has("pytest.ini") {
        let py = if cfg!(windows) { "python" } else { "python3" };
        format!("{py} -m pytest -q {tests}").trim_end().to_string()
    } else {
        return None;
    })
}

fn compact(res: &str, passed: bool) -> Vec<&str> {
    let v: Vec<&str> = if passed {
        let keep = Regex::new(r"(?i)^\[|pass|fail|tests? |ok\b|passed|failed|error").unwrap();
        let drop = Regex::new(r"^✔|^ok [0-9]").unwrap();
        res.lines().filter(|l| keep.is_match(l) && !drop.is_match(l)).collect()
    } else {
        let drop = Regex::new(r"^ℹ (suites|cancelled|skipped|todo|duration)|^✔|node:internal").unwrap();
        res.lines().filter(|l| !drop.is_match(l)).collect()
    };
    let n = if passed { 6 } else { 40 };
    v[v.len().saturating_sub(n)..].to_vec()
}

pub fn main(args: Vec<String>) -> i32 {
    if args.iter().any(|a| a == "-h" || a == "--help") {
        print!("{HELP}");
        return 0;
    }
    let cwd = util::cwd();
    let spec: Value = match serde_json::from_str(&util::read_stdin()) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("patch: invalid JSON on stdin: {e}");
            return 3;
        }
    };
    let changed = match apply(&spec, &cwd) {
        Ok((msg, changed)) => {
            println!("{msg}");
            changed
        }
        Err(errs) => {
            println!("NOT APPLIED (no file changed):\n{}", errs.join("\n"));
            return 3;
        }
    };
    if util::git_root(&cwd).is_some() && !changed.is_empty() {
        let mut a = vec!["diff", "--stat", "--"];
        a.extend(changed.iter().map(String::as_str));
        for l in last_lines(&util::git(&cwd, &a), 6) {
            println!("{l}");
        }
    }
    let mut cmd = spec.get("test").and_then(Value::as_str).unwrap_or("").to_string();
    if cmd.is_empty() {
        match test_cmd(&cwd, &affected(&cwd, &changed)) {
            Some(c) => cmd = c,
            None => {
                println!("no test command found; pass \"test\" in the JSON");
                return 0;
            }
        }
    }
    println!("$ {cmd}");
    let (rc, out) = run_combined(&shell(&cmd), &cwd);
    let res = render(&out, Some(rc), QUESTION, 12, 4000);
    for l in compact(&res, rc == 0) {
        println!("{l}");
    }
    rc
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("tforge-patch-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn applies_atomically() {
        let d = tmp("ok");
        std::fs::write(d.join("a.txt"), "one two two\n").unwrap();
        let spec = json!({"edits": [
            {"file": "a.txt", "find": "one", "replace": "1"},
            {"file": "a.txt", "find": "two", "replace": "2", "all": true},
            {"file": "sub/new.txt", "create": "hi\n"}
        ]});
        let (msg, changed) = apply(&spec, &d).unwrap();
        assert_eq!(msg, "applied 3 edit(s) to 2 file(s), created 1");
        assert_eq!(changed, vec!["a.txt", "sub/new.txt"]);
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap(), "1 2 2\n");
        assert_eq!(std::fs::read_to_string(d.join("sub/new.txt")).unwrap(), "hi\n");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn reports_and_writes_nothing_on_error() {
        let d = tmp("err");
        std::fs::write(d.join("a.txt"), "let total = 1;\nx x\n").unwrap();
        let spec = json!({"edits": [
            {"file": "a.txt", "find": "let", "replace": "const"},
            {"file": "a.txt", "find": "x", "replace": "y"},
            {"file": "a.txt", "find": "let totl = 1;", "replace": "z"},
            {"file": "nope.txt", "find": "a", "replace": "b"},
            {"file": "a.txt", "create": "c"}
        ]});
        let errs = apply(&spec, &d).unwrap_err();
        assert_eq!(
            errs,
            vec![
                "edit 2: a.txt: find text matches 2 times (add context or set all); closest line 2: 'x x'",
                "edit 3: a.txt: find text not found; closest line 1: 'const total = 1;'",
                "edit 4: no such file nope.txt",
                "edit 5: a.txt already exists (use find/replace)",
            ]
        );
        assert_eq!(std::fs::read_to_string(d.join("a.txt")).unwrap(), "let total = 1;\nx x\n");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn repr_and_compact() {
        assert_eq!(py_repr("it's"), "\"it's\"");
        assert_eq!(py_repr("a\tb'\""), "'a\\tb\\'\"'");
        let res = "[exit=0]\nrunning 3 tests\n✔ a passes\ntest result: ok. 3 passed\n";
        assert_eq!(compact(res, true), vec!["[exit=0]", "test result: ok. 3 passed"]);
        assert_eq!(compact("ℹ duration 3\nboom\n", false), vec!["boom"]);
    }

    #[test]
    fn narrowest_test_command() {
        let d = tmp("cmd");
        assert!(test_cmd(&d, &[]).is_none());
        std::fs::write(d.join("package.json"), r#"{"scripts": {"test": "node --test"}}"#).unwrap();
        assert_eq!(test_cmd(&d, &["test/a.test.js".into()]).unwrap(), "node --test test/a.test.js");
        assert_eq!(test_cmd(&d, &[]).unwrap(), "npm test --silent");
        let _ = std::fs::remove_dir_all(&d);
    }
}
