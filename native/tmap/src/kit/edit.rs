//! `tmap kit edit`: atomic multi-file edits from `@@ file` headers and `<<< old === new >>>` blocks.

use super::util::{cwd, die, git, git_root, read_stdin, run, tool};
use similar::{capture_diff_slices, group_diff_ops, Algorithm, DiffTag, TextDiff};
use std::collections::HashMap;
use std::path::Path;

const HELP: &str = "Multi-file edits in one call, no JSON escaping. Atomic: all or nothing.

  tmap kit edit [-n] [-d] [-t 'test cmd' [--keep]] <<'EOF'
  @@ src/a.py                 literal replace; old must match exactly once
  <<<
  old text
  ===
  new text
  >>>
  @@ src/a.py all             replace every occurrence (at least one)
  @@ src/a.py re              old is a regex (multi-line mode), new may use \\1; at least one match
  @@ src/a.py:40              insert body after line 40 (0 = top of file)
  @@ src/a.py:40-52           replace lines 40-52 with body (empty body deletes them)
  @@ src/a.py append          append body at end of file
  @@ src/new.py new           create file with body (must not exist)
  <<<
  body
  >>>
  EOF

One @@ header may hold several <<< blocks. Blocks apply in order; line numbers
refer to the file as it is when that block runs (edit bottom-up to keep them stable).
-n dry run   -d print unified diff   -t run a test command afterwards (exit code = its result);
if it fails, the edited files are restored and new files removed (--keep leaves the edits in place)
Prints \"+added -removed\" per file. On failure nothing is written and the
closest matching line is reported.
";

#[derive(Debug, Clone, PartialEq)]
pub enum Mode {
    Lit,
    All,
    Re,
    Insert(usize),
    Range(usize, usize),
    Append,
    New,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Op {
    pub file: String,
    pub mode: Mode,
    pub old: Option<String>,
    pub new: String,
    pub hl: usize,
}

/// Parse the block script. `exists` decides whether `f:N` names a file literally.
pub fn parse(input: &str, exists: impl Fn(&str) -> bool) -> Result<Vec<Op>, String> {
    let lines: Vec<&str> = input.split('\n').collect();
    let spec_re = regex::Regex::new(r"^(.+?):(\d+)(?:-(\d+))?$").unwrap();
    let (mut ops, mut cur): (Vec<Op>, Option<(String, Mode, usize)>) = (vec![], None);
    let mut i = 0;
    while i < lines.len() {
        let ln = lines[i];
        if let Some(h) = ln.strip_prefix("@@ ") {
            let spec: Vec<&str> = h.split_whitespace().collect();
            let Some(&target) = spec.first() else { return Err(format!("line {}: empty @@ header", i + 1)) };
            let word = spec.get(1).copied().unwrap_or("");
            let mut mode = match word {
                "" => Mode::Lit,
                "all" => Mode::All,
                "re" => Mode::Re,
                "append" => Mode::Append,
                "new" => Mode::New,
                _ => Mode::Insert(usize::MAX),
            };
            let mut file = target.to_string();
            if let Some(c) = spec_re.captures(target).filter(|_| !exists(target)) {
                let num = |s: &str| s.parse::<usize>().map_err(|_| format!("line {}: bad line number {s}", i + 1));
                file = c[1].to_string();
                let a = num(&c[2])?;
                mode = match c.get(3) {
                    Some(b) => Mode::Range(a, num(b.as_str())?),
                    None => Mode::Insert(a),
                };
            } else if mode == Mode::Insert(usize::MAX) {
                return Err(format!("line {}: unknown mode '{word}'", i + 1));
            }
            cur = Some((file, mode, i + 1));
            i += 1;
            continue;
        }
        if ln == "<<<" {
            let Some((file, mode, hl)) = &cur else { return Err(format!("line {}: <<< before any @@ header", i + 1)) };
            let repl = matches!(mode, Mode::Lit | Mode::All | Mode::Re);
            let (mut j, mut body, mut old): (usize, Vec<&str>, Option<Vec<&str>>) = (i + 1, vec![], None);
            while j < lines.len() && lines[j] != ">>>" {
                if lines[j] == "===" && old.is_none() && repl {
                    old = Some(std::mem::take(&mut body));
                } else {
                    body.push(lines[j]);
                }
                j += 1;
            }
            if j >= lines.len() {
                return Err(format!("line {}: unterminated <<< block", i + 1));
            }
            if repl && old.is_none() {
                return Err(format!("line {}: replace block needs === between old and new", i + 1));
            }
            ops.push(Op { file: file.clone(), mode: mode.clone(), old: old.map(|o| o.join("\n")), new: body.join("\n"), hl: *hl });
            i = j + 1;
            continue;
        }
        if !ln.trim().is_empty() && !ln.starts_with('#') {
            let head: String = ln.chars().take(60).collect();
            return Err(format!("line {}: unexpected text outside a block: {}", i + 1, super::jx::py_repr(&head)));
        }
        i += 1;
    }
    if ops.is_empty() {
        return Err("no edits given".into());
    }
    Ok(ops)
}

/// "closest line N: '...'" for the first non-blank line of `old` (difflib cutoff 0.5).
fn closest(s: &str, old: &str) -> String {
    let first = old.split('\n').map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let cand: Vec<&str> = s.split('\n').map(str::trim).collect();
    let mut best: Option<(f32, &str)> = None;
    for c in &cand {
        let r = TextDiff::from_chars(first, c).ratio();
        if r >= 0.5 && best.is_none_or(|(br, bs)| r > br || (r == br && *c > bs)) {
            best = Some((r, c));
        }
    }
    match best {
        None => "no similar line".into(),
        Some((_, b)) => {
            let n = cand.iter().position(|c| *c == b).unwrap() + 1;
            format!("closest line {n}: {}", super::jx::py_repr(&b.chars().take(120).collect::<String>()))
        }
    }
}

/// Python `re.sub` replacement template -> regex crate template.
fn py_repl(t: &str) -> String {
    let mut o = String::new();
    let cs: Vec<char> = t.chars().collect();
    let mut i = 0;
    while i < cs.len() {
        match cs[i] {
            '$' => o.push_str("$$"),
            '\\' if i + 1 < cs.len() => {
                i += 1;
                match cs[i] {
                    d if d.is_ascii_digit() => {
                        let mut n = d.to_string();
                        if cs.get(i + 1).is_some_and(|c| c.is_ascii_digit()) {
                            i += 1;
                            n.push(cs[i]);
                        }
                        o.push_str(&format!("${{{n}}}"));
                    }
                    'g' if cs.get(i + 1) == Some(&'<') => match cs[i + 2..].iter().position(|&c| c == '>') {
                        Some(k) => {
                            let name: String = cs[i + 2..i + 2 + k].iter().collect();
                            o.push_str(&format!("${{{name}}}"));
                            i += 2 + k;
                        }
                        None => o.push_str("\\g"),
                    },
                    'n' => o.push('\n'),
                    't' => o.push('\t'),
                    'r' => o.push('\r'),
                    'f' => o.push('\u{c}'),
                    'v' => o.push('\u{b}'),
                    'a' => o.push('\u{7}'),
                    'b' => o.push('\u{8}'),
                    '\\' => o.push('\\'),
                    c => {
                        o.push('\\');
                        o.push(c)
                    }
                }
            }
            c => o.push(c),
        }
        i += 1;
    }
    o
}

/// Apply one op to `s`.
pub fn apply_op(s: &str, op: &Op) -> Result<String, String> {
    // CRLF file, LF edit text: edit the LF view and convert back, so old text matches and new
    // lines get the file's line endings.
    if super::util::is_crlf(s) && !op.old.as_deref().unwrap_or("").contains('\r') && !op.new.contains('\r') {
        return apply_lf(&s.replace("\r\n", "\n"), op).map(|r| r.replace('\n', "\r\n"));
    }
    apply_lf(s, op)
}

fn apply_lf(s: &str, op: &Op) -> Result<String, String> {
    let where_ = format!("{} (@@ line {})", op.file, op.hl);
    let old = op.old.as_deref().unwrap_or("");
    let new = op.new.as_str();
    Ok(match op.mode {
        Mode::Lit => {
            let c = s.matches(old).count();
            if c != 1 {
                let hint = if c == 0 { closest(s, old) } else { String::new() };
                return Err(format!("{where_}: old text matched {c}x, need exactly 1 (use 'all'). {hint}"));
            }
            s.replacen(old, new, 1)
        }
        Mode::All => {
            if !s.contains(old) {
                return Err(format!("{where_}: old text not found. {}", closest(s, old)));
            }
            s.replace(old, new)
        }
        Mode::Re => {
            let rx = super::tally::compile(old, false, true).map_err(|e| format!("{where_}: {e}"))?;
            if rx.find_iter(s).count() == 0 {
                return Err(format!("{where_}: regex matched nothing"));
            }
            rx.replace_all(s, py_repl(new).as_str()).into_owned()
        }
        Mode::Insert(a) | Mode::Range(a, _) => {
            let mut l: Vec<&str> = s.split('\n').collect();
            if let Mode::Range(_, b) = op.mode {
                if !(1 <= a && a <= b && b <= l.len()) {
                    return Err(format!("{where_}: bad range {a}-{b} (file has {} lines)", l.len()));
                }
                let body: Vec<&str> = if new.is_empty() { vec![] } else { new.split('\n').collect() };
                l.splice(a - 1..b, body);
            } else {
                if a > l.len() {
                    return Err(format!("{where_}: line {a} > {} lines", l.len()));
                }
                l.splice(a..a, new.split('\n'));
            }
            l.join("\n")
        }
        Mode::Append => {
            let sep = if s.ends_with('\n') || s.is_empty() { "" } else { "\n" };
            let end = if new.ends_with('\n') { "" } else { "\n" };
            format!("{s}{sep}{new}{end}")
        }
        Mode::New => format!("{new}{}", if new.ends_with('\n') { "" } else { "\n" }),
    })
}

/// Edited file: name, original content (None = new file), new content.
pub type Change = (String, Option<String>, String);

/// Apply all ops in memory; any failure aborts before anything is written.
pub fn apply_all(ops: &[Op]) -> Result<Vec<Change>, String> {
    let mut order: Vec<Change> = vec![];
    let mut idx: HashMap<String, usize> = HashMap::new();
    for op in ops {
        let i = match idx.get(&op.file) {
            Some(&i) => i,
            None => {
                let orig = if op.mode == Mode::New {
                    if Path::new(&op.file).exists() {
                        return Err(format!("{}: exists (mode new)", op.file));
                    }
                    None
                } else {
                    match std::fs::read(&op.file) {
                        Ok(b) => Some(String::from_utf8(b).map_err(|_| format!("{}: not valid UTF-8", op.file))?),
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(format!("{}: not found", op.file)),
                        Err(e) => return Err(format!("{}: {e}", op.file)),
                    }
                };
                let cur = orig.clone().unwrap_or_default();
                order.push((op.file.clone(), orig, cur));
                idx.insert(op.file.clone(), order.len() - 1);
                order.len() - 1
            }
        };
        order[i].2 = apply_op(&order[i].2, op)?;
    }
    Ok(order)
}

fn range(start: usize, len: usize) -> String {
    match len {
        1 => format!("{}", start + 1),
        0 => format!("{start},0"),
        _ => format!("{},{len}", start + 1),
    }
}

/// difflib-style unified diff (n=1, no line terminators).
pub fn udiff(f: &str, o: &str, s: &str) -> Vec<String> {
    fn cr(l: &str) -> &str {
        l.strip_suffix('\r').unwrap_or(l)
    }
    let a: Vec<&str> = o.split('\n').map(cr).collect();
    let b: Vec<&str> = s.split('\n').map(cr).collect();
    let groups = group_diff_ops(capture_diff_slices(Algorithm::Myers, &a, &b), 1);
    if groups.is_empty() {
        return vec![];
    }
    let mut out = vec![format!("--- a/{f}"), format!("+++ b/{f}")];
    for g in groups {
        let (first, last) = (g[0].as_tag_tuple(), g[g.len() - 1].as_tag_tuple());
        let (o0, o1, n0, n1) = (first.1.start, last.1.end, first.2.start, last.2.end);
        out.push(format!("@@ -{} +{} @@", range(o0, o1 - o0), range(n0, n1 - n0)));
        for op in g {
            let (tag, or, nr) = op.as_tag_tuple();
            match tag {
                DiffTag::Equal => out.extend(a[or].iter().map(|l| format!(" {l}"))),
                _ => {
                    out.extend(a[or].iter().map(|l| format!("-{l}")));
                    out.extend(b[nr].iter().map(|l| format!("+{l}")));
                }
            }
        }
    }
    out
}

/// Write `s` to `p` through a temp file in the same dir, keeping the old file's permissions.
fn write_atomic(p: &Path, s: &str, keep_perms: bool) -> std::io::Result<()> {
    if let Some(dir) = p.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = format!("{}.edit-tmp", p.display());
    std::fs::write(&tmp, s)?;
    if keep_perms {
        if let Ok(m) = std::fs::metadata(p) {
            let _ = std::fs::set_permissions(&tmp, m.permissions());
        }
    }
    // rename replaces an existing target on Windows too (MoveFileEx with REPLACE_EXISTING),
    // unless another process holds it open: replace_file then writes in place.
    super::util::replace_file(Path::new(&tmp), p, s.as_bytes())
}

/// Undo written changes: restore original contents, remove files that were created.
pub fn restore(changes: &[Change]) -> Vec<String> {
    let mut errs = vec![];
    for (f, orig, s) in changes {
        let r = match orig {
            Some(o) if o != s => write_atomic(Path::new(f), o, true),
            Some(_) => Ok(()),
            None => std::fs::remove_file(f).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) }),
        };
        if let Err(e) = r {
            errs.push(format!("{f}: {e}"));
        }
    }
    errs
}

/// Summary lines (+ diffs) and, unless dry, the writes.
pub fn commit(changes: &[Change], dry: bool, diff: bool) -> Result<Vec<String>, String> {
    let mut out = vec![];
    for (f, orig, s) in changes {
        let o = orig.as_deref().unwrap_or("");
        if s == o {
            out.push(format!("{f}: unchanged"));
            continue;
        }
        let d = udiff(f, o, s);
        let add = d.iter().filter(|l| l.starts_with('+') && !l.starts_with("+++")).count();
        let rem = d.iter().filter(|l| l.starts_with('-') && !l.starts_with("---")).count();
        out.push(format!("{f}: +{add} -{rem}{}", if orig.is_none() { " (new)" } else { "" }));
        if diff {
            out.extend(d);
        }
        if !dry {
            write_atomic(Path::new(f), s, orig.is_some()).map_err(|e| format!("{f}: {e}"))?;
        }
    }
    Ok(out)
}

const QUESTION: &str = "Did the tests pass? Give pass/fail counts. For each failure: test name, file:line, expected vs actual, error message.";

/// Big output: small-model answer, else error lines + tail (the distill fallback).
fn distill(text: &str, rc: i32) -> String {
    let tag = format!("exit={rc}");
    if text.len() < 4000 {
        return format!("[{tag}]\n{text}");
    }
    let (kb, nl) = (text.len() / 1024, text.matches('\n').count());
    let max = std::env::var("TFORGE_DISTILL_MAX_BYTES").ok().and_then(|v| v.parse().ok()).unwrap_or(480000usize);
    let errs = |pat: &str| {
        let rx = regex::RegexBuilder::new(pat).case_insensitive(true).build().unwrap();
        text.lines().enumerate().filter(|(_, l)| rx.is_match(l)).map(|(i, l)| format!("{}:{l}", i + 1)).collect::<Vec<_>>()
    };
    let input = if text.len() > max {
        let cut = |s: &str, from_end: bool| {
            let n = max / 3;
            let mut i = if from_end { s.len().saturating_sub(n) } else { n.min(s.len()) };
            while !s.is_char_boundary(i) {
                i += 1;
            }
            if from_end { s[i..].to_string() } else { s[..i].to_string() }
        };
        let e = errs("error|fail|exception|panic|traceback|assert|fatal|warn").join("\n");
        format!(
            "{}\n... [middle omitted; error-like lines from it follow] ...\n{}\n... [tail] ...\n{}",
            cut(text, false),
            cut(&e, false),
            cut(text, true)
        )
    } else {
        text.to_string()
    };
    match super::distill::distill_text(QUESTION, &input) {
        Ok(ans) if !ans.trim().is_empty() => {
            let model = std::env::var("TFORGE_DISTILL_MODEL").unwrap_or_else(|_| "haiku".into());
            let body: Vec<&str> = ans.lines().take(17).collect();
            format!("[distilled by {model} from {kb} KB / {nl} lines; {tag}]\n{}", body.join("\n"))
        }
        _ => {
            let c200 = |l: &str| l.chars().take(200).collect::<String>();
            let mut o = vec![format!("[distill unavailable; heuristic excerpt of {kb} KB / {nl} lines; {tag}]")];
            o.extend(errs("error|fail|exception|panic|traceback|assert|fatal").iter().take(20).map(|l| c200(l)));
            o.push("... last lines:".into());
            let ls: Vec<&str> = text.lines().collect();
            o.extend(ls[ls.len().saturating_sub(10)..].iter().map(|l| c200(l)));
            o.join("\n")
        }
    }
}

/// Keep what matters of the test result, like patch-and-test.sh.
pub fn filter_result(res: &str, rc: i32) -> Vec<String> {
    let lines: Vec<&str> = res.trim_end_matches('\n').split('\n').collect();
    let kept: Vec<&str> = if rc == 0 {
        let keep = regex::Regex::new(r"(?i)^\[|pass|fail|tests? |ok\b|passed|failed|error").unwrap();
        let drop = regex::Regex::new(r"^✔|^ok [0-9]").unwrap();
        let v: Vec<&str> = lines.into_iter().filter(|l| keep.is_match(l) && !drop.is_match(l)).collect();
        v[v.len().saturating_sub(6)..].to_vec()
    } else {
        let drop = regex::Regex::new(r"^ℹ (suites|cancelled|skipped|todo|duration)|^✔|node:internal").unwrap();
        let v: Vec<&str> = lines.into_iter().filter(|l| !drop.is_match(l)).collect();
        v[v.len().saturating_sub(40)..].to_vec()
    };
    kept.into_iter().map(String::from).collect()
}

/// Run `cmd` through the shell after the edits; exit = its code.
fn run_test(cmd: &str, files: &[String]) -> i32 {
    let here = cwd();
    if git_root(&here).is_some() {
        let mut a = vec!["diff", "--stat", "--"];
        a.extend(files.iter().map(String::as_str));
        for l in super::util::tail_lines(&git(&here, &a), 6) {
            println!("{l}");
        }
    }
    println!("$ {cmd}");
    // cmd /C: util::run hands the script to cmd.exe verbatim.
    let shell: Vec<&str> = if cfg!(windows) {
        vec!["cmd", "/C", cmd]
    } else if tool("bash", None).is_some() {
        vec!["bash", "-c", cmd]
    } else {
        vec!["sh", "-c", cmd]
    };
    let o = run(&shell, &here, 3600, &[], None);
    super::util::note_raw(o.stdout.len() + o.stderr.len());
    let text = match (o.stdout.trim_end_matches('\n'), o.stderr.as_str()) {
        (out, "") => out.to_string(),
        ("", err) => err.to_string(),
        (out, err) => format!("{out}\n{err}"),
    };
    let res = distill(text.trim_end_matches('\n'), o.code);
    for l in filter_result(&res, o.code) {
        println!("{l}");
    }
    o.code
}

pub fn main(args: Vec<String>) -> i32 {
    let (mut dry, mut diff, mut test, mut keep) = (false, false, None, false);
    let mut a = args.into_iter();
    while let Some(x) = a.next() {
        match x.as_str() {
            "-n" => dry = true,
            "-d" => diff = true,
            "--keep" => keep = true,
            "-t" => test = Some(a.next().unwrap_or_else(|| die("edit", "-t needs a command", 2))),
            "-h" | "--help" => {
                println!("{HELP}");
                return 0;
            }
            _ => die("edit", &format!("unknown option {x}"), 2),
        }
    }
    use std::io::IsTerminal;
    if std::io::stdin().is_terminal() {
        println!("{HELP}");
        return 2;
    }
    let mut input = read_stdin();
    if cfg!(windows) {
        input = input.replace("\r\n", "\n");
    }
    let ops = parse(&input, |f| Path::new(f).exists()).unwrap_or_else(|e| die("edit", &e, 2));
    let changes = apply_all(&ops).unwrap_or_else(|e| die("edit", &e, 2));
    let out = commit(&changes, dry, diff).unwrap_or_else(|e| {
        // A write failed midway: put back what was already written.
        let undo = restore(&changes);
        die("edit", &format!("{e}{}", if undo.is_empty() { "; nothing changed".into() } else { format!("; restore failed: {}", undo.join(", ")) }), 2)
    });
    println!("{}{}", if dry { "DRY RUN, nothing written\n" } else { "" }, out.join("\n"));
    let rc = match test {
        Some(t) if !dry => run_test(&t, &changes.iter().map(|c| c.0.clone()).collect::<Vec<_>>()),
        _ => return 0,
    };
    if rc != 0 && !keep {
        let undo = restore(&changes);
        if undo.is_empty() {
            println!("test failed: edits rolled back (--keep to leave them)");
        } else {
            println!("test failed; rollback incomplete: {}", undo.join(", "));
        }
    }
    rc
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("tmap-edit-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn ops(s: &str) -> Vec<Op> {
        parse(s, |_| false).unwrap()
    }

    #[test]
    fn parse_headers_and_blocks() {
        let o = ops("# c\n@@ a.rs\n<<<\nx\n===\ny\n>>>\n<<<\n===\n>>>\n@@ b.rs:4-6\n<<<\nz\n===\n>>>\n@@ c.rs:0\n<<<\nq\n>>>\n");
        assert_eq!(o.len(), 4);
        assert_eq!((o[0].old.as_deref(), o[0].new.as_str(), o[0].hl), (Some("x"), "y", 2));
        assert_eq!((o[1].old.as_deref(), o[1].new.as_str()), (Some(""), ""));
        assert_eq!((o[2].mode.clone(), o[2].new.as_str()), (Mode::Range(4, 6), "z\n==="));
        assert_eq!(o[3].mode, Mode::Insert(0));
        let w = ops("@@ C:\\p\\a.rs:4-6\n<<<\nz\n>>>\n@@ C:\\p\\b.rs\n<<<\nx\n===\ny\n>>>\n");
        assert_eq!((w[0].file.as_str(), w[0].mode.clone()), ("C:\\p\\a.rs", Mode::Range(4, 6)));
        assert_eq!((w[1].file.as_str(), w[1].mode.clone()), ("C:\\p\\b.rs", Mode::Lit));
        assert_eq!(parse("@@ f:3\n", |f| f == "f:3").unwrap_err(), "no edits given");
        assert!(parse("@@ f bogus\n", |_| false).unwrap_err().contains("unknown mode 'bogus'"));
        assert!(parse("<<<\n>>>\n", |_| false).unwrap_err().contains("before any @@"));
        assert!(parse("@@ f\n<<<\nx\n", |_| false).unwrap_err().contains("unterminated"));
        assert!(parse("@@ f\n<<<\nx\n>>>\n", |_| false).unwrap_err().contains("needs ==="));
        assert_eq!(parse("@@ f\nstray\n", |_| false).unwrap_err(), "line 2: unexpected text outside a block: 'stray'");
    }

    #[test]
    fn literal_matching() {
        let op = |m: Mode, old: &str, new: &str| Op { file: "f".into(), mode: m, old: Some(old.into()), new: new.into(), hl: 1 };
        assert_eq!(apply_op("a b a", &op(Mode::All, "a", "c")).unwrap(), "c b c");
        let e = apply_op("a b a", &op(Mode::Lit, "a", "c")).unwrap_err();
        assert_eq!(e, "f (@@ line 1): old text matched 2x, need exactly 1 (use 'all'). ");
        let e = apply_op("fn main() {\n  let x = 1;\n}", &op(Mode::Lit, "let y = 1;", "")).unwrap_err();
        assert!(e.ends_with("closest line 2: 'let x = 1;'"), "{e}");
        assert!(apply_op("zzz", &op(Mode::All, "qq", "")).unwrap_err().ends_with("no similar line"));
        assert_eq!(apply_op("v=1\nv=22\n", &op(Mode::Re, r"^v=(\d+)$", r"w=\1$")).unwrap(), "w=1$\nw=22$\n");
        assert!(apply_op("x", &op(Mode::Re, "y", "")).unwrap_err().ends_with("regex matched nothing"));
        assert!(apply_op("x", &op(Mode::Re, "(?<=a)x", "")).unwrap_err().contains("lookarounds"));
    }

    #[test]
    fn line_modes() {
        let op = |m: Mode, new: &str| Op { file: "f".into(), mode: m, old: None, new: new.into(), hl: 1 };
        let s = "1\n2\n3\n";
        assert_eq!(apply_op(s, &op(Mode::Insert(0), "0")).unwrap(), "0\n1\n2\n3\n");
        assert_eq!(apply_op(s, &op(Mode::Insert(3), "x")).unwrap(), "1\n2\n3\nx\n");
        assert!(apply_op(s, &op(Mode::Insert(5), "x")).unwrap_err().ends_with("line 5 > 4 lines"));
        assert_eq!(apply_op(s, &op(Mode::Range(2, 3), "")).unwrap(), "1\n");
        assert_eq!(apply_op(s, &op(Mode::Range(1, 1), "a\nb")).unwrap(), "a\nb\n2\n3\n");
        assert!(apply_op(s, &op(Mode::Range(3, 2), "")).unwrap_err().contains("bad range 3-2 (file has 4 lines)"));
        assert_eq!(apply_op("a", &op(Mode::Append, "b")).unwrap(), "a\nb\n");
        assert_eq!(apply_op("", &op(Mode::Append, "b\n")).unwrap(), "b\n");
        assert_eq!(apply_op("", &op(Mode::New, "n")).unwrap(), "n\n");
        // CRLF files keep CRLF; LF edit text still matches.
        let w = "1\r\n2\r\n3\r\n";
        assert_eq!(apply_op(w, &op(Mode::Insert(1), "x\ny")).unwrap(), "1\r\nx\r\ny\r\n2\r\n3\r\n");
        assert_eq!(apply_op(w, &op(Mode::Range(2, 2), "b")).unwrap(), "1\r\nb\r\n3\r\n");
        assert_eq!(apply_op(w, &op(Mode::Append, "4")).unwrap(), "1\r\n2\r\n3\r\n4\r\n");
        let lit = Op { file: "f".into(), mode: Mode::Lit, old: Some("1\n2".into()), new: "a\nb".into(), hl: 1 };
        assert_eq!(apply_op(w, &lit).unwrap(), "a\r\nb\r\n3\r\n");
        assert_eq!(udiff("f", w, "1\r\nb\r\n3\r\n")[4], "-2");
    }

    #[test]
    fn atomic_new_and_rollback() {
        let d = tmp("atomic");
        let a = d.join("a.txt");
        std::fs::write(&a, "one\ntwo\n").unwrap();
        let (af, nf) = (a.to_string_lossy().into_owned(), d.join("sub/n.txt").to_string_lossy().into_owned());
        // second block fails: nothing may be written
        let bad = ops(&format!("@@ {af}\n<<<\none\n===\nONE\n>>>\n@@ {nf} new\n<<<\nx\n>>>\n@@ {af}\n<<<\nmissing\n===\n>>>\n"));
        assert!(apply_all(&bad).unwrap_err().contains("old text matched 0x"));
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "one\ntwo\n");
        assert!(!Path::new(&nf).exists());
        let good = ops(&format!("@@ {af}\n<<<\none\n===\nONE\n>>>\n@@ {nf} new\n<<<\nx\n>>>\n"));
        let ch = apply_all(&good).unwrap();
        let out = commit(&ch, true, true).unwrap();
        assert_eq!(out, vec![format!("{af}: +1 -1"), format!("--- a/{af}"), format!("+++ b/{af}"), "@@ -1,2 +1,2 @@".into(), "-one".into(), "+ONE".into(), " two".into(), format!("{nf}: +1 -0 (new)"), format!("--- a/{nf}"), format!("+++ b/{nf}"), "@@ -1 +1,2 @@".into(), "+x".into(), " ".into()]);
        assert!(!Path::new(&nf).exists());
        commit(&ch, false, false).unwrap();
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "ONE\ntwo\n");
        assert_eq!(std::fs::read_to_string(&nf).unwrap(), "x\n");
        assert!(restore(&ch).is_empty());
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "one\ntwo\n");
        assert!(!Path::new(&nf).exists());
        commit(&ch, false, false).unwrap();
        assert!(apply_all(&good[1..]).unwrap_err().ends_with("exists (mode new)"));
        assert!(apply_all(&ops("@@ /nonexistent/zz\n<<<\na\n===\n>>>\n")).unwrap_err().ends_with("not found"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn repl_and_filter() {
        assert_eq!(py_repl(r"\1-\g<name>$x\n\\"), "${1}-${name}$$x\n\\");
        assert_eq!(filter_result("[exit=0]\nrunning 3 tests\n✔ a\nok 1 - a\ntest result: ok. 3 passed\n", 0), vec!["[exit=0]", "test result: ok. 3 passed"]);
        assert_eq!(filter_result("[exit=1]\nℹ duration 3\nboom", 1), vec!["[exit=1]", "boom"]);
    }
}
