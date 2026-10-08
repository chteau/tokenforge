//! `tmap kit diff`: one call = everything a review needs to start: stat, touched symbols with
//! their callers, affected tests, and the diff itself with whole-function context.

use super::symctx::affected_tests;
use super::util;
use crate::index::{Index, NONE};
use regex::Regex;
use std::collections::{BTreeSet, HashSet};
use std::fmt::Write;
use std::path::Path;

const HELP: &str = "One call = everything a review needs to start: stat, touched symbols with
their callers, affected tests, and the diff itself with whole-function
context (so changed functions never need a separate Read).

usage: tmap kit diff [BASE|--worktree|--pr N] [--max-lines N] [--files a,b]
  --pr N      GitHub PR N: fetches its head (refs/pull/N/head, no checkout,
              no branch created) and diffs it against its base branch
  BASE        compare BASE...HEAD (default: origin/HEAD, main, master)
  --worktree  compare HEAD vs working tree (uncommitted changes)
  --max-lines cap for the whole-function diff (default 700); the -U3 diff
              may use up to 2x that (a review needs the diff; per-file
              follow-ups cost more turns). Beyond: per-file hunk index.
  --files     limit diff body to these paths (comma-separated)
Noise (lockfiles, build output, vendored, generated) is excluded and counted.
";

const NOISE: &[&str] = &[
    ":(exclude)*.lock", ":(exclude)package-lock.json", ":(exclude)pnpm-lock.yaml", ":(exclude)yarn.lock", ":(exclude)Cargo.lock",
    ":(exclude)poetry.lock", ":(exclude)go.sum", ":(exclude)pubspec.lock", ":(exclude)*.min.js", ":(exclude)*.map", ":(exclude)*.g.dart",
    ":(exclude)*.freezed.dart", ":(exclude)*.generated.*", ":(exclude)*.pb.go", ":(exclude)*_pb2.py", ":(exclude)node_modules/*",
    ":(exclude)vendor/*", ":(exclude)dist/*", ":(exclude)build/*", ":(exclude)target/*", ":(exclude)coverage/*", ":(exclude).codegraph/*",
];

const BORING: &[&str] = &[
    "Default", "Drop", "drop", "new", "fmt", "from", "into", "clone", "Clone", "Debug", "Display", "default", "eq", "hash", "deref", "main",
    "init", "test", "setUp", "tearDown", "constructor", "render", "toString",
];

#[derive(Default)]
struct Opts {
    max: usize,
    base: String,
    worktree: bool,
    files: String,
    pr: String,
}

/// Run git in `cwd`: (exit code, stdout).
fn git(cwd: &Path, args: &[&str]) -> (i32, String) {
    let mut v = vec!["git"];
    v.extend_from_slice(args);
    let o = util::run(&v, cwd, 300, &[], None);
    (o.code, o.stdout)
}

fn nlines(s: &str) -> usize {
    s.trim_end_matches('\n').lines().count().max(1)
}

/// Enclosing names from hunk headers + definitions on changed lines of a `-U0` diff (heuristic).
fn touched_symbols(u0: &str) -> Vec<String> {
    let kw = Regex::new(r"(function|def|fn|func|class|struct|interface|enum|trait|impl|type)[ \t]+[A-Za-z_$][A-Za-z0-9_$]*").unwrap();
    let arrow = Regex::new(r"(const|let|var)[ \t]+[A-Za-z_$][A-Za-z0-9_$]*[ \t]*=[ \t]*(async[ \t]*)?\(").unwrap();
    let hunk = Regex::new(r"^@@[^@]*@@ ?").unwrap();
    let lead = Regex::new(r"^[a-z]+[ \t]+").unwrap();
    let mut set = BTreeSet::new();
    for raw in u0.lines() {
        let mut ch = raw.chars();
        let line = if raw.starts_with("@@") {
            hunk.replace(raw, "").into_owned()
        } else if matches!(ch.next(), Some('+' | '-')) && ch.next().is_some_and(|c| c != '+' && c != '-') {
            raw[1..].to_string()
        } else {
            continue;
        };
        if let Some(m) = kw.find(&line) {
            set.insert(lead.replace(m.as_str(), "").into_owned());
        } else if let Some(m) = arrow.find(&line) {
            let s = lead.replace(m.as_str(), "");
            set.insert(s.split(['=', ' ', '\t']).next().unwrap_or("").to_string());
        }
    }
    // Case-insensitive order, like `sort` under a typical UTF-8 locale.
    let mut v: Vec<String> = set.into_iter().filter(|s: &String| !s.is_empty() && !BORING.contains(&s.as_str())).collect();
    v.sort_by_key(|s| (s.to_lowercase(), s.clone()));
    v.truncate(12);
    v
}

/// "caller path:line, ..." for call sites of `name`, at most 6, then "+N more".
fn callers_of(idx: &Index, name: &str) -> String {
    let mut seen = HashSet::new();
    let mut shown = Vec::new();
    for f in &idx.files {
        for c in f.calls.iter().filter(|c| c.name.trim_start_matches('.').trim_end_matches('!') == name) {
            if !seen.insert((f.path.as_str(), c.from, c.line)) {
                continue;
            }
            if shown.len() < 6 {
                let who = if c.from == NONE { "(top level)" } else { f.syms[c.from as usize].name.as_str() };
                shown.push(format!("{who} {}:{}", f.path, c.line));
            }
        }
    }
    if shown.is_empty() {
        return "(no callers indexed)".into();
    }
    let more = seen.len() - shown.len();
    shown.join(", ") + &if more > 0 { format!(", +{more} more") } else { String::new() }
}

/// Top-level package dirs of the changed files ("a/b/" for deeper paths, else "a/").
fn tops(kept: &[&str]) -> Vec<String> {
    let mut v: Vec<String> = kept
        .iter()
        .map(|p| {
            let parts: Vec<&str> = p.split('/').collect();
            if parts.len() > 2 { format!("{}/{}/", parts[0], parts[1]) } else { format!("{}/", parts[0]) }
        })
        .collect();
    v.sort();
    v.dedup();
    v
}

fn hunk_index(u0: &str) -> Vec<String> {
    let mut f = "";
    let mut out = Vec::new();
    for l in u0.lines() {
        if let Some(p) = l.strip_prefix("+++ b/") {
            f = p;
        } else if l.starts_with("@@") {
            out.push(format!("{f}: {}", l.strip_prefix("@@ ").unwrap_or(l)));
        }
    }
    out.truncate(200);
    out
}

fn report(o: &Opts, cwd: &Path) -> (String, i32) {
    let mut out = String::new();
    if git(cwd, &["rev-parse", "--is-inside-work-tree"]).0 != 0 {
        return ("not a git repo\n".into(), 1);
    }
    let mut base = o.base.clone();
    let (range, label): (Vec<String>, String) = if !o.pr.is_empty() {
        let pr = &o.pr;
        if util::tool("gh", None).is_none() {
            return ("--pr needs the gh CLI\n".into(), 1);
        }
        let q = r#""\(.baseRefName)\t\(.headRefName)\t\(.state)\t\(.author.login)\t\(.title)""#;
        let m = util::run(&["gh", "pr", "view", pr, "--json", "baseRefName,headRefName,title,author,state", "-q", q], cwd, 60, &[], None);
        if m.code != 0 {
            return (format!("gh pr view {pr} failed\n"), 1);
        }
        let meta: Vec<&str> = m.stdout.trim_end_matches('\n').split('\t').collect();
        let fld = |i: usize| meta.get(i).copied().unwrap_or("");
        let pbase = fld(0).to_string();
        let _ = writeln!(out, "## PR #{pr}: {} [{}, {} -> {pbase}, by {}]", fld(4), fld(2), fld(1), fld(3));
        if git(cwd, &["fetch", "-q", "origin", &pbase, &format!("pull/{pr}/head")]).0 != 0 {
            return (out + &format!("git fetch of pull/{pr}/head failed\n"), 1);
        }
        let ls = git(cwd, &["ls-remote", "origin", &format!("refs/pull/{pr}/head")]).1;
        let head = ls.split('\t').next().unwrap_or("").trim().to_string();
        if head.is_empty() || git(cwd, &["cat-file", "-e", &format!("{head}^{{commit}}")]).0 != 0 {
            return (out + "PR head commit not available locally\n", 1);
        }
        (vec![format!("origin/{pbase}...{head}")], format!("origin/{pbase}...PR#{pr}"))
    } else if o.worktree {
        (vec!["HEAD".into()], "HEAD..worktree".into())
    } else {
        if base.is_empty() {
            let origin = git(cwd, &["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]).1.trim().to_string();
            for c in [origin.as_str(), "main", "master", "trunk", "develop"] {
                if !c.is_empty() && git(cwd, &["rev-parse", "-q", "--verify", &format!("{c}^{{commit}}")]).0 == 0 {
                    base = c.to_string();
                    break;
                }
            }
        }
        if base.is_empty() {
            return ("no base branch found; pass BASE or --worktree\n".into(), 1);
        }
        if git(cwd, &["rev-parse", "HEAD"]).1 == git(cwd, &["rev-parse", &base]).1 {
            // On the base itself: review uncommitted work, else the last commit.
            if !git(cwd, &["status", "--porcelain", "--untracked-files=no"]).1.trim().is_empty() {
                (vec!["HEAD".into()], "HEAD..worktree".into())
            } else if git(cwd, &["rev-parse", "-q", "--verify", "HEAD~1"]).0 == 0 {
                (vec!["HEAD~1".into(), "HEAD".into()], "HEAD~1..HEAD".into())
            } else {
                return (format!("on {base} with a clean tree and no parent commit: nothing to diff\n"), 0);
            }
        } else {
            (vec![format!("{base}...HEAD")], format!("{base}...HEAD"))
        }
    };
    let paths: Vec<String> = if o.files.is_empty() { vec![".".into()] } else { o.files.split(',').map(str::to_string).collect() };
    let diff = |extra: &[&str]| -> String {
        let mut a: Vec<&str> = vec!["diff"];
        a.extend_from_slice(extra);
        a.extend(range.iter().map(String::as_str));
        a.push("--");
        a.extend(paths.iter().map(String::as_str));
        a.extend_from_slice(NOISE);
        git(cwd, &a).1
    };
    let mut all_args = vec!["diff", "--name-only"];
    all_args.extend(range.iter().map(String::as_str));
    let all = git(cwd, &all_args).1.lines().count();
    let kept_s = diff(&["--name-only"]);
    let kept: Vec<&str> = kept_s.lines().filter(|l| !l.is_empty()).collect();
    let _ = writeln!(out, "## diff {label}  ({} files reviewed, {} excluded as noise/out-of-scope)", kept.len(), all as i64 - kept.len() as i64);
    for l in super::distill::last_lines(&diff(&["--stat=100"]), 25) {
        let _ = writeln!(out, "{l}");
    }
    if kept.is_empty() {
        return (out, 0);
    }
    let u0 = diff(&["-U0"]);
    let syms = touched_symbols(&u0);
    let idx = util::git_root(cwd).map(|r| util::canon(&r)).and_then(|r| super::symctx::load_index(&r));
    if !syms.is_empty() {
        let _ = writeln!(out, "\n## touched symbols (heuristic){}", if idx.is_some() { " <- callers" } else { "" });
        for s in &syms {
            match &idx {
                Some(i) => writeln!(out, "- {s} <- {}", callers_of(i, s)),
                None => writeln!(out, "- {s}"),
            }
            .ok();
        }
    }
    if let Some(i) = &idx {
        // Keep tests near the change (same top-level package/crate dir).
        let tops = tops(&kept);
        let changed: Vec<String> = kept.iter().map(|s| s.to_string()).collect();
        let tests: Vec<String> = affected_tests(i, &changed).into_iter().filter(|t| tops.iter().any(|p| t.starts_with(p.as_str()))).take(8).collect();
        if !tests.is_empty() {
            out.push_str("\n## affected tests\n");
            for t in tests {
                let _ = writeln!(out, "- {t}");
            }
        }
    }
    out.push('\n');
    let body = diff(&["-W"]);
    let n = nlines(&body);
    if n <= o.max {
        let _ = writeln!(out, "## diff (whole-function context, {n} lines)\n{}", body.trim_end_matches('\n'));
        return (out, 0);
    }
    let body = diff(&["-U3"]);
    let n = nlines(&body);
    if n <= o.max * 2 {
        let _ = writeln!(out, "## diff (-U3; function context exceeded {} lines, {n} lines)\n{}", o.max, body.trim_end_matches('\n'));
        return (out, 0);
    }
    let again = if !o.pr.is_empty() { format!("--pr {}", o.pr) } else if o.worktree { "--worktree".into() } else { base };
    let _ = writeln!(out, "## diff too large ({n} lines at -U3). Hunk index; fetch per file with:\n##   tmap kit diff {again} --files <path>");
    for l in hunk_index(&u0) {
        let _ = writeln!(out, "{l}");
    }
    (out, 0)
}

pub fn main(args: Vec<String>) -> i32 {
    super::util::count_runs();
    let mut o = Opts { max: 700, ..Default::default() };
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--worktree" => o.worktree = true,
            "--pr" => o.pr = it.next().unwrap_or_default(),
            "--max-lines" => {
                let v = it.next().unwrap_or_default();
                o.max = v.parse().unwrap_or_else(|_| util::die("diff", &format!("--max-lines: not a number: {v}"), 2));
            }
            "--files" => o.files = it.next().unwrap_or_default(),
            "-h" | "--help" => {
                print!("{HELP}");
                return 0;
            }
            _ => o.base = a,
        }
    }
    let (text, code) = report(&o, &util::cwd());
    print!("{text}");
    code
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symbols_from_hunks_and_changed_lines() {
        let u0 = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@ fn outer(a: u8) {\n-    let y = 1;\n+export function addTax(x) {\n+const handler = async (req) => 1\n+  fn new() {}\n-struct Point {\n";
        assert_eq!(touched_symbols(u0), vec!["addTax", "handler", "outer", "Point"]);
    }

    #[test]
    fn hunk_index_and_tops() {
        let u0 = "+++ b/src/a.rs\n@@ -1 +1 @@ fn f\n+x\n+++ b/b.rs\n@@ -3,0 +4 @@\n";
        assert_eq!(hunk_index(u0), vec!["src/a.rs: -1 +1 @@ fn f", "b.rs: -3,0 +4 @@"]);
        assert_eq!(tops(&["a/b/c.rs", "a/b/d.rs", "x.rs", "src/y.rs"]), vec!["a/b/", "src/", "x.rs/"]);
        assert_eq!(nlines(""), 1);
        assert_eq!(nlines("a\nb\n\n"), 2);
    }

    #[test]
    fn diff_against_main_in_temp_repo() {
        if util::tool("git", None).is_none() {
            return;
        }
        let d = std::env::temp_dir().join(format!("tforge-diff-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("src")).unwrap();
        std::env::set_var("TMAP_CACHE_DIR", d.join(".cache"));
        let g = |a: &[&str]| {
            let mut v = vec!["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
            v.extend_from_slice(a);
            assert_eq!(git(&d, &v).0, 0, "git {a:?}");
        };
        g(&["init", "-q", "-b", "main"]);
        std::fs::write(d.join(".gitignore"), ".cache/\n").unwrap();
        std::fs::write(d.join("src/lib.rs"), "pub fn total(a: u32) -> u32 {\n    a + 1\n}\n\npub fn caller() -> u32 {\n    total(2)\n}\n").unwrap();
        g(&["add", "."]);
        g(&["commit", "-qm", "init"]);
        g(&["checkout", "-qb", "feat"]);
        std::fs::write(d.join("src/lib.rs"), "pub fn total(a: u32) -> u32 {\n    a + 2\n}\n\npub fn caller() -> u32 {\n    total(2)\n}\n").unwrap();
        std::fs::write(d.join("Cargo.lock"), "noise\n").unwrap();
        g(&["add", "."]);
        g(&["commit", "-qm", "change"]);
        let (out, code) = report(&Opts { max: 700, ..Default::default() }, &d);
        assert_eq!(code, 0);
        assert!(out.starts_with("## diff main...HEAD  (1 files reviewed, 1 excluded as noise/out-of-scope)\n"), "{out}");
        assert!(out.contains("## touched symbols (heuristic) <- callers\n- total <- caller src/lib.rs:6\n"), "{out}");
        assert!(out.contains("## diff (whole-function context,") && out.contains("+    a + 2"), "{out}");
        let (small, _) = report(&Opts { max: 1, ..Default::default() }, &d);
        assert!(small.contains("## diff too large") && small.contains("src/lib.rs: -2 +2 @@"), "{small}");
        let _ = std::fs::remove_dir_all(&d);
    }
}
