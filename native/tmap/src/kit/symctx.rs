//! `tmap kit ctx`: cheapest-sufficient view of a symbol or a file, in one call.
//! Also hosts the helpers the other context tools share (index access, text search, block slicing).

use crate::index::{FileEntry, Index, NONE};
use crate::query;
use regex::Regex;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

const HELP: &str = "Cheapest-sufficient view of a symbol or a file, in one call.

  tmap kit ctx SYMBOL [--file PATH]   source of SYMBOL + callers/callees
  tmap kit ctx --outline PATH         symbol map of a file (no bodies)
  tmap kit ctx --refs SYMBOL          where SYMBOL is used (file:line, capped)

Uses the tmap index (built or refreshed on the fly); languages it does not parse
fall back to a regex search plus a brace/indent-aware slice.
Output is capped (TFORGE_CAP, default 120 lines).
";

pub const SKIP_DIRS: &[&str] = &["node_modules", "dist", "build", "target", "vendor", "coverage", ".git", ".codegraph"];

/// Repository root for the index: nearest ancestor of the cwd holding `.git`, else the cwd.
pub fn index_root() -> PathBuf {
    let start = super::util::cwd();
    let start = super::util::canon(&start);
    start.ancestors().find(|d| d.join(".git").exists()).map(Path::to_path_buf).unwrap_or(start)
}

pub fn load_index(root: &Path) -> Option<Index> {
    crate::index::refresh(root, false).ok().map(|(i, _)| i)
}

/// `p` (relative to the cwd or absolute) as a path relative to `root`, '/'-separated.
pub fn root_rel(root: &Path, p: &str) -> String {
    let abs = super::util::cwd().join(p);
    let abs = super::util::canon(&abs);
    match abs.strip_prefix(root) {
        Ok(r) => r.to_string_lossy().replace('\\', "/"),
        Err(_) => p.trim_start_matches("./").replace('\\', "/"),
    }
}

pub fn is_test_path(p: &str) -> bool {
    let p = p.to_lowercase();
    let name = p.rsplit('/').next().unwrap_or(&p);
    name == "tests.rs" || name.ends_with("_test.go") || name.ends_with("_test.py") || name.starts_with("test_")
        || name.contains(".test.") || name.contains(".spec.") || p.contains("/tests/") || p.starts_with("tests/") || p.contains("__tests__/")
}

const COMMON: &[&str] = &[
    "new", "default", "fmt", "from", "into", "clone", "drop", "eq", "hash", "deref", "main", "init", "run", "get", "set", "len", "test", "render",
    "toString", "constructor",
];

fn base_name(call: &str) -> &str {
    call.trim_start_matches('.').trim_end_matches('!')
}

/// Test files affected by `changed` (root-relative paths): changed tests, changed files with an inline
/// `tests` module, and test files calling a symbol defined in a changed file.
pub fn affected_tests(idx: &Index, changed: &[String]) -> Vec<String> {
    let changed: HashSet<&str> = changed.iter().map(|s| s.as_str()).collect();
    let mut names: HashSet<&str> = HashSet::new();
    for f in idx.files.iter().filter(|f| changed.contains(f.path.as_str()) && !is_test_path(&f.path)) {
        names.extend(f.syms.iter().filter(|s| s.kind != "impl" && s.name.len() >= 3 && !COMMON.contains(&s.name.as_str())).map(|s| s.name.as_str()));
    }
    idx.files
        .iter()
        .filter(|f| {
            let is_test = is_test_path(&f.path);
            let inline = f.syms.iter().any(|s| s.name == "tests" && s.kind == "module");
            (changed.contains(f.path.as_str()) && (is_test || inline)) || (is_test && f.calls.iter().any(|c| names.contains(base_name(&c.name))))
        })
        .map(|f| f.path.clone())
        .collect()
}

pub struct Hit {
    pub path: String,
    pub line: usize,
    pub text: String,
}

/// Lines matching `m` under `dir` (gitignore-aware, dependency/build dirs skipped, binaries skipped),
/// at most `per_file` per file, files in path order. Paths are relative to `dir`.
pub fn search(dir: &Path, skip_dirs: &[&str], skip_file: &dyn Fn(&str) -> bool, m: &dyn Fn(&str) -> bool, per_file: usize) -> Vec<Hit> {
    let skip: Vec<String> = skip_dirs.iter().map(|s| s.to_string()).collect();
    let walker = ignore::WalkBuilder::new(dir)
        .hidden(false)
        .require_git(false)
        .sort_by_file_name(|a, b| a.cmp(b))
        .filter_entry(move |e| !(e.file_type().is_some_and(|t| t.is_dir()) && skip.iter().any(|s| e.file_name() == s.as_str())))
        .build();
    let mut out = Vec::new();
    for e in walker.flatten() {
        if !e.file_type().is_some_and(|t| t.is_file()) || skip_file(&e.file_name().to_string_lossy()) {
            continue;
        }
        let Ok(bytes) = std::fs::read(e.path()) else { continue };
        if bytes.len() > 8_000_000 || bytes[..bytes.len().min(8000)].contains(&0) {
            continue;
        }
        let rel = e.path().strip_prefix(dir).unwrap_or(e.path()).to_string_lossy().replace('\\', "/");
        let text = String::from_utf8_lossy(&bytes);
        let mut n = 0;
        for (i, l) in text.lines().enumerate() {
            if m(l) {
                out.push(Hit { path: rel.clone(), line: i + 1, text: l.to_string() });
                n += 1;
                if n >= per_file {
                    break;
                }
            }
        }
    }
    out
}

pub fn read_lines(path: &Path) -> Vec<String> {
    String::from_utf8_lossy(&std::fs::read(path).unwrap_or_default()).lines().map(str::to_string).collect()
}

/// Last line number <= `ln` matching `re` (0 if none).
pub fn last_def(lines: &[String], ln: usize, re: &Regex) -> usize {
    (1..=ln.min(lines.len())).rev().find(|&i| re.is_match(&lines[i - 1])).unwrap_or(0)
}

/// Numbered lines from `s` until braces balance (at or after `hit`) or `max` lines past `s`.
/// `mark` prefixes the `hit` line with '>' and others with ' '.
pub fn block(lines: &[String], s: usize, hit: Option<usize>, max: usize, mark: bool) -> Vec<String> {
    let (mut o, mut c) = (0, 0);
    let mut out = Vec::new();
    for nr in s.max(1)..=lines.len() {
        let l = &lines[nr - 1];
        let m = if !mark { "" } else if Some(nr) == hit { ">" } else { " " };
        out.push(format!("{m}{nr}\t{l}"));
        o += l.matches('{').count();
        c += l.matches('}').count();
        if (o > 0 && o <= c && hit.is_none_or(|h| nr >= h)) || nr - s > max {
            break;
        }
    }
    out
}

fn indent_pos(l: &str) -> usize {
    l.find(|c| c != ' ' && c != '\t').map_or(0, |i| i + 1)
}

/// Slice from line `s` until braces balance (C-like) or indentation returns (Python/Lua-like).
fn slice_indent(lines: &[String], s: usize, cap: usize) -> Vec<String> {
    let opener = Regex::new(r"^[ \t]*[{(]").unwrap();
    let ind = lines.get(s.wrapping_sub(1)).map_or(0, |l| indent_pos(l));
    let (mut depth, mut opened, mut out) = (0i64, false, Vec::new());
    for nr in s.max(1)..=lines.len() {
        let l = &lines[nr - 1];
        if !opened && nr > s && !opener.is_match(l) && indent_pos(l) > 0 && indent_pos(l) <= ind {
            break;
        }
        out.push(format!("{nr}\t{l}"));
        let (o, c) = (l.matches('{').count() as i64, l.matches('}').count() as i64);
        depth += o - c;
        opened |= o > 0;
        if opened && depth <= 0 {
            break;
        }
        if out.len() >= cap {
            out.push("... (capped)".into());
            break;
        }
    }
    out
}

fn cap_lines(mut v: Vec<String>, cap: usize) -> String {
    if v.len() > cap {
        v.truncate(cap);
    }
    v.iter().map(|l| format!("{l}\n")).collect()
}

fn parent_matches(f: &FileEntry, parent: u32, q: &str) -> bool {
    if parent == NONE {
        return false;
    }
    let p = &f.syms[parent as usize].name;
    p == q || p.ends_with(&format!(" for {q}")) || p.starts_with(&format!("{q}<"))
}

/// Definitions of `name` (`Type::method` / `Type.method` narrow by parent), optionally in one file.
fn defs<'a>(idx: &'a Index, name: &str, file: Option<&str>) -> Vec<(&'a FileEntry, usize)> {
    let (qual, base) = match name.rsplit_once("::").or_else(|| name.rsplit_once('.')) {
        Some((q, b)) if !q.is_empty() && !b.is_empty() => (Some(q), b),
        _ => (None, name),
    };
    let pick = |exact: bool| -> Vec<(&FileEntry, usize)> {
        idx.files
            .iter()
            .filter(|f| file.is_none_or(|p| f.path == p))
            .flat_map(|f| f.syms.iter().enumerate().map(move |(i, s)| (f, i, s)))
            .filter(|(_, _, s)| s.kind != "impl" && if exact { s.name == base } else { s.name.eq_ignore_ascii_case(base) })
            .filter(|(f, _, s)| qual.is_none_or(|q| parent_matches(f, s.parent, q)))
            .map(|(f, i, _)| (f, i))
            .collect()
    };
    let exact = pick(true);
    if exact.is_empty() { pick(false) } else { exact }
}

/// Index view of a symbol: header, numbered source, its calls, then call sites. None if not indexed.
fn index_sym(idx: &Index, root: &Path, name: &str, file: Option<&str>, cap: usize) -> Option<String> {
    let found = defs(idx, name, file);
    if found.is_empty() {
        return None;
    }
    let src_cap = (cap.saturating_sub(12) / found.len().min(5)).max(10);
    let mut out = Vec::new();
    for (f, i) in found.iter().take(5) {
        let s = &f.syms[*i];
        let sig = if s.sig.is_empty() { format!("{} {}", s.kind, s.name) } else { s.sig.clone() };
        let parent = if s.parent == NONE { String::new() } else { format!("  (in {})", f.syms[s.parent as usize].name) };
        out.push(format!("== {}:{}-{}  {sig}{parent}", f.path, s.start, s.end));
        let lines = read_lines(&root.join(&f.path));
        let (a, b) = (s.start as usize, (s.end as usize).min(lines.len()));
        for n in a..=b.min(a + src_cap - 1) {
            out.push(format!("{n}\t{}", lines[n - 1]));
        }
        if b >= a + src_cap {
            out.push(format!("... ({} more lines: {}:{}-{b})", b + 1 - a - src_cap, f.path, a + src_cap));
        }
        let mut calls: Vec<&str> = f.calls.iter().filter(|c| c.from == *i as u32).map(|c| c.name.as_str()).collect();
        calls.sort_unstable();
        calls.dedup();
        if !calls.is_empty() {
            let more = calls.len().saturating_sub(20);
            out.push(format!("-- calls: {}{}", calls[..calls.len().min(20)].join(", "), if more > 0 { format!(", +{more} more") } else { String::new() }));
        }
    }
    let base = base_name(name.rsplit("::").next().unwrap_or(name));
    let base = base.rsplit('.').next().unwrap_or(base);
    let callers = query::callers(idx, base, 8);
    if callers.starts_with("tmap: no call sites") {
        out.push("-- callers: none indexed".into());
    } else {
        out.push("-- callers:".into());
        out.extend(callers.lines().map(|l| format!("  {l}")));
    }
    if out.len() > cap {
        out.truncate(cap);
        out.push("... (capped)".into());
    }
    Some(out.iter().map(|l| format!("{l}\n")).collect())
}

fn def_patterns(sym: &str) -> (Regex, Regex) {
    let s = regex::escape(sym);
    let a = format!(
        r"(function|def|fn|func|class|struct|enum|trait|interface|type|const|let|var|local function)\s+\*?{s}\b|^\s*(async\s+)?{s}\s*\([^)]*\)\s*\{{|^func\s+\([^)]*\)\s+{s}\b"
    );
    let b = format!(r"^\s*([A-Za-z_][A-Za-z0-9_<>,.?*&:]*\s+)+{s}\s*\(");
    (Regex::new(&a).unwrap(), Regex::new(&b).unwrap())
}

fn min_js(n: &str) -> bool {
    n.ends_with(".min.js")
}

/// Regex fallback for symbols the index does not know (unsupported languages).
fn grep_sym(root: &Path, sym: &str, file: Option<&str>, cap: usize) -> Option<String> {
    let (a, b) = def_patterns(sym);
    let dir = file.map_or(root.to_path_buf(), |f| root.join(f));
    let find = |re: &Regex| -> Vec<Hit> {
        if dir.is_file() {
            let lines = read_lines(&dir);
            let p = file.unwrap_or_default().to_string();
            lines.iter().enumerate().filter(|(_, l)| re.is_match(l)).map(|(i, l)| Hit { path: p.clone(), line: i + 1, text: l.clone() }).collect()
        } else {
            let base = dir.strip_prefix(root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
            search(&dir, SKIP_DIRS, &min_js, &|l| re.is_match(l), usize::MAX)
                .into_iter()
                .map(|h| Hit { path: if base.is_empty() { h.path } else { format!("{base}/{}", h.path) }, ..h })
                .collect()
        }
    };
    let mut hits: Vec<Hit> = find(&a).into_iter().take(5).collect();
    if hits.is_empty() {
        let kw = Regex::new(r":\s*(return|new|await|throw|else)\s").unwrap();
        hits = find(&b).into_iter().filter(|h| !kw.is_match(&format!("{}:{}:{}", h.path, h.line, h.text))).take(5).collect();
    }
    if hits.is_empty() {
        return None;
    }
    let mut out = String::new();
    for h in hits {
        out.push_str(&format!("== {}:{}\n", h.path, h.line));
        for l in slice_indent(&read_lines(&root.join(&h.path)), h.line, cap) {
            out.push_str(&l);
            out.push('\n');
        }
    }
    Some(out)
}

/// Source of `sym` (index first, regex fallback); None when no definition is found.
pub fn symbol_text(root: &Path, idx: Option<&Index>, sym: &str, file: Option<&str>, cap: usize) -> Option<String> {
    idx.and_then(|i| index_sym(i, root, sym, file, cap)).or_else(|| grep_sym(root, sym, file, cap))
}

/// Outline of `rel` (root-relative): index outline, else a regex definition list.
pub fn outline_text(root: &Path, idx: Option<&Index>, rel: &str, shown: &str, cap: usize) -> String {
    if let Some(f) = idx.and_then(|i| i.files.iter().find(|f| f.path == rel)) {
        return cap_lines(query::outline(f).lines().map(str::to_string).collect(), cap);
    }
    let lines = read_lines(&root.join(rel));
    let def = Regex::new(r"^\s*(export\s+)?(default\s+)?(async\s+)?(pub(\([a-z]+\))?\s+)?(function|def|fn|func|class|struct|enum|trait|impl|interface|type|const|let|var|module|local function)\s").unwrap();
    let local = Regex::new(r"^\s+(const|let|var|local)\s").unwrap();
    let deep = Regex::new(r"^\s{5,}").unwrap();
    let mut out = vec![format!("{shown} ({} lines) -- definitions:", lines.len())];
    out.extend(
        lines
            .iter()
            .enumerate()
            .filter(|(_, l)| def.is_match(l) && !local.is_match(l) && !deep.is_match(l))
            .map(|(i, l)| super::distill::cut(&format!("{}:{l}", i + 1), 140))
            .take(cap),
    );
    out.iter().map(|l| format!("{l}\n")).collect()
}

fn word_re(sym: &str) -> Regex {
    Regex::new(&format!(r"(?:^|\W){}(?:\W|$)", regex::escape(sym))).unwrap()
}

fn refs_text(root: &Path, idx: Option<&Index>, sym: &str, cap: usize) -> String {
    if let Some(i) = idx {
        let c = query::callers(i, sym, 30);
        if !c.starts_with("tmap: no call sites") {
            return cap_lines(c.lines().map(str::to_string).collect(), cap);
        }
    }
    let re = word_re(sym);
    let all = search(root, SKIP_DIRS, &min_js, &|l| re.is_match(l), usize::MAX);
    let mut out = vec![format!("{} references to {sym}:", all.len())];
    let mut per: (String, usize) = (String::new(), 0);
    for h in &all {
        if per.0 != h.path {
            per = (h.path.clone(), 0);
        }
        per.1 += 1;
        if per.1 <= 3 {
            out.push(super::distill::cut(&format!("{}:{}:{}", h.path, h.line, h.text), 160));
        }
    }
    cap_lines(out, cap + 1)
}

pub fn cap_env(default: usize) -> usize {
    std::env::var("TFORGE_CAP").ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

pub fn main(args: Vec<String>) -> i32 {
    let (mut mode, mut sym, mut file) = ("sym", String::new(), String::new());
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--outline" => {
                mode = "outline";
                file = it.next().unwrap_or_default();
            }
            "--refs" => {
                mode = "refs";
                sym = it.next().unwrap_or_default();
            }
            "--file" | "-f" => file = it.next().unwrap_or_default(),
            "-h" | "--help" => {
                print!("{HELP}");
                return 0;
            }
            _ => sym = a,
        }
    }
    let cap = cap_env(120);
    let root = index_root();
    match mode {
        "outline" => {
            if !Path::new(&file).is_file() {
                println!("no such file: {file}");
                return 1;
            }
            let idx = load_index(&root);
            print!("{}", outline_text(&root, idx.as_ref(), &root_rel(&root, &file), &file, cap));
            0
        }
        "refs" => {
            if sym.is_empty() {
                println!("usage: --refs SYMBOL");
                return 1;
            }
            let idx = load_index(&root);
            print!("{}", refs_text(&root, idx.as_ref(), &sym, cap));
            0
        }
        _ => {
            if sym.is_empty() {
                print!("{HELP}");
                return 1;
            }
            let rel = (!file.is_empty()).then(|| root_rel(&root, &file));
            let idx = load_index(&root);
            match symbol_text(&root, idx.as_ref(), &sym, rel.as_deref(), cap) {
                Some(t) => {
                    print!("{t}");
                    0
                }
                None => {
                    println!("no definition found for {sym} (try --refs)");
                    1
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Vec<String> {
        s.lines().map(str::to_string).collect()
    }

    #[test]
    fn slice_stops_at_balanced_braces_or_dedent() {
        let c = v("fn a() {\n  x;\n}\nfn b() {}\n");
        assert_eq!(slice_indent(&c, 1, 50), vec!["1\tfn a() {", "2\t  x;", "3\t}"]);
        let py = v("def f():\n    return 1\n\ndef g():\n    pass\n");
        assert_eq!(slice_indent(&py, 1, 50), vec!["1\tdef f():", "2\t    return 1", "3\t"]);
        assert_eq!(slice_indent(&py, 1, 1), vec!["1\tdef f():", "... (capped)"]);
    }

    #[test]
    fn block_marks_hit_and_waits_for_it() {
        let c = v("fn a() {}\nfn b() {\n  y\n}\n");
        assert_eq!(block(&c, 1, Some(3), 60, true), vec![" 1\tfn a() {}", " 2\tfn b() {", ">3\t  y", " 4\t}"]);
        assert_eq!(block(&c, 1, None, 60, false), vec!["1\tfn a() {}"]);
        let re = Regex::new(r"^\s*fn\s").unwrap();
        assert_eq!(last_def(&c, 3, &re), 2);
        assert_eq!(last_def(&c, 0, &re), 0);
    }

    #[test]
    fn def_patterns_match_common_forms() {
        let (a, b) = def_patterns("total");
        for l in ["function total(x) {", "def total(self):", "  pub fn total() {", "const total = () =>", "func (s *S) total() int"] {
            assert!(a.is_match(l), "{l}");
        }
        assert!(!a.is_match("let totals = 1"));
        assert!(b.is_match("  public static int total(int a) {"));
        assert!(word_re("foo").is_match("x(foo)") && !word_re("foo").is_match("foobar"));
    }

    #[test]
    fn test_paths() {
        assert!(is_test_path("src/a.test.ts") && is_test_path("tests/x.rs") && is_test_path("pkg/a_test.go"));
        assert!(!is_test_path("src/attest.rs"));
    }
}
