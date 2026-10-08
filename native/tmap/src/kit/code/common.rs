//! Shared helpers for the language-aware tools (port of token-surgeon `kit/_kit.py`):
//! stack detection, globbing, subprocesses, diagnostics, test summaries, API outlines, JUnit XML.

use crate::kit::util::{self, Output};
use regex::{Captures, Regex};
use std::collections::{HashMap, HashSet};
use std::fmt::Display;
use std::hash::Hash;
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

pub use crate::kit::util::die;

/// Compile a regex once (static per call site): `re!(r"^\d+")`.
macro_rules! re {
    ($p:expr) => {{
        static R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        R.get_or_init(|| $crate::kit::code::common::compile($p))
    }};
}
pub(crate) use re;

/// Compile a regex literal (panics on a bad pattern); used by `re!`.
pub fn compile(p: &str) -> Regex {
    Regex::new(p).unwrap_or_else(|e| panic!("bad regex {p}: {e}"))
}

pub const STACKS: [&str; 16] =
    ["rust", "go", "ts", "cs", "luau", "dart", "py", "java", "cpp", "php", "ruby", "swift", "elixir", "zig", "scala", "latex"];
pub const SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "bin", "obj", "dist", "build", ".dart_tool", "__pycache__", ".venv", "venv", "Packages",
    "DevPackages", "ServerPackages", "vendor", ".gradle", ".build", "_build", "deps", "zig-out", ".zig-cache",
    "cmake-build-debug", "cmake-build-release",
];

/// Options shared by the tools; the language hooks read the ones they care about.
#[derive(Clone, Debug, Default)]
pub struct Opts {
    pub fast: bool,
    pub lint: bool,
    pub changed: bool,
    pub errors_only: bool,
    pub raw: bool,
}

/// What a tool knows about the current invocation (python: `ctx` SimpleNamespace).
#[derive(Clone, Debug, Default)]
pub struct Ctx {
    /// Project root (dir holding the manifest).
    pub root: PathBuf,
    pub opt: Opts,
    /// test: name filter.
    pub flt: Option<String>,
    /// test: runner args after `--`.
    pub extra: Vec<String>,
    /// test: max failures shown.
    pub nmax: usize,
    /// deps/check: output line cap.
    pub cap: usize,
    /// deps: ls | where | api | why.
    pub cmd: Option<String>,
    /// deps: package; test: `-p` value.
    pub pkg: Option<String>,
    /// deps: symbol.
    pub sym: Option<String>,
}

// ---------- small string / regex helpers ----------

pub fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// First `n` chars (python `s[:n]`).
pub fn trunc(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

/// Collapse whitespace runs (python `" ".join(s.split())`).
pub fn ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// File contents, lossy; "" when unreadable.
pub fn read(p: impl AsRef<Path>) -> String {
    std::fs::read(p).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default()
}

/// Python `re.match`: a match anchored at the start of `s`.
pub fn pmatch<'a>(r: &Regex, s: &'a str) -> Option<Captures<'a>> {
    r.captures(s).filter(|c| c.get(0).is_some_and(|m| m.start() == 0))
}

/// Group `i` or "".
pub fn g<'a>(c: &Captures<'a>, i: usize) -> &'a str {
    c.get(i).map_or("", |m| m.as_str())
}

/// Group `i` as a number, 0 when absent.
pub fn gn(c: &Captures, i: usize) -> usize {
    g(c, i).parse().unwrap_or(0)
}

/// Version sort key: numeric parts, non-numeric parts count as 0 (python `[int(x) if x.isdigit() else 0 ...]`).
pub fn ver_key(v: &str, seps: &[char]) -> Vec<u64> {
    v.split(|c| seps.contains(&c)).map(|x| if !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit()) { x.parse().unwrap_or(0) } else { 0 }).collect()
}

/// Python-style repr of a JSON value (`['a', 'b']`, `{'k': 'v'}`, True, None).
pub fn pyrepr(v: &serde_json::Value) -> String {
    use serde_json::Value as V;
    match v {
        V::String(s) => format!("'{s}'"),
        V::Bool(b) => (if *b { "True" } else { "False" }).into(),
        V::Null => "None".into(),
        V::Number(n) => n.to_string(),
        V::Array(a) => format!("[{}]", a.iter().map(pyrepr).collect::<Vec<_>>().join(", ")),
        V::Object(o) => format!("{{{}}}", o.iter().map(|(k, v)| format!("'{k}': {}", pyrepr(v))).collect::<Vec<_>>().join(", ")),
    }
}

/// String value as-is, anything else as python repr (python f-string of a JSON value).
pub fn pystr(v: &serde_json::Value) -> String {
    v.as_str().map(str::to_string).unwrap_or_else(|| pyrepr(v))
}

/// Insertion-ordered map (python dict semantics: updating keeps the original position).
pub struct OrdMap<K, V> {
    pub items: Vec<(K, V)>,
    idx: HashMap<K, usize>,
}

impl<K: Eq + Hash + Clone, V> Default for OrdMap<K, V> {
    fn default() -> Self {
        OrdMap { items: Vec::new(), idx: HashMap::new() }
    }
}

impl<K: Eq + Hash + Clone, V> OrdMap<K, V> {
    pub fn insert(&mut self, k: K, v: V) {
        match self.idx.get(&k) {
            Some(&i) => self.items[i].1 = v,
            None => {
                self.idx.insert(k.clone(), self.items.len());
                self.items.push((k, v));
            }
        }
    }
    pub fn get(&self, k: &K) -> Option<&V> {
        self.idx.get(k).map(|&i| &self.items[i].1)
    }
    pub fn entry(&mut self, k: K, default: impl FnOnce() -> V) -> &mut V {
        if !self.idx.contains_key(&k) {
            self.insert(k.clone(), default());
        }
        let i = self.idx[&k];
        &mut self.items[i].1
    }
}

// ---------- paths ----------

/// Lexical normalization (python `os.path.normpath`).
pub fn normpath(p: &Path) -> PathBuf {
    let mut out: Vec<Component> = Vec::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => match out.last() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                Some(Component::RootDir) | Some(Component::Prefix(_)) => {}
                _ => out.push(c),
            },
            _ => out.push(c),
        }
    }
    let r: PathBuf = out.iter().collect();
    if r.as_os_str().is_empty() { PathBuf::from(".") } else { r }
}

pub fn abspath(p: &Path) -> PathBuf {
    normpath(&if p.is_absolute() { p.to_path_buf() } else { util::cwd().join(p) })
}

/// Python `os.path.relpath(p, start)`; `p` unchanged when on another drive.
pub fn relpath(p: impl AsRef<Path>, start: &Path) -> String {
    let (a, b) = (abspath(p.as_ref()), abspath(start));
    let (ac, bc): (Vec<_>, Vec<_>) = (a.components().collect(), b.components().collect());
    if ac.first() != bc.first() {
        return s(&a);
    }
    let n = ac.iter().zip(&bc).take_while(|(x, y)| x == y).count();
    let mut r = PathBuf::new();
    for _ in n..bc.len() {
        r.push("..");
    }
    for c in &ac[n..] {
        r.push(c);
    }
    if r.as_os_str().is_empty() { ".".into() } else { s(&r) }
}

/// Relative to the current dir, for display ('/'-separated on Windows too, like git).
pub fn relcwd(p: impl AsRef<Path>) -> String {
    util::slash(Path::new(&relpath(p, &util::cwd())))
}

/// Path for display (python `_kit.rel`): relative to cwd unless that climbs 3+ levels.
pub fn rel(path: &str, root: &Path) -> String {
    if path.is_empty() {
        return String::new();
    }
    let p = if Path::new(path).is_absolute() { PathBuf::from(path) } else { root.join(path) };
    let r = relcwd(&p);
    if r.starts_with("../../..") { util::slash(Path::new(path)) } else { r }
}

/// `root.join(f)` as a string (absolute `f` wins, like `os.path.join`).
pub fn join(root: &Path, f: &str) -> String {
    s(&root.join(f))
}

fn has_magic(s: &str) -> bool {
    s.contains(['*', '?', '['])
}

/// Shell wildcard match of one path component: `*`, `?`, `[abc]`, `[!a-z]`.
pub fn fnmatch(pat: &str, name: &str) -> bool {
    fn m(p: &[char], n: &[char]) -> bool {
        match p.first() {
            None => n.is_empty(),
            Some('*') => (0..=n.len()).any(|i| m(&p[1..], &n[i..])),
            Some('?') => !n.is_empty() && m(&p[1..], &n[1..]),
            Some('[') => {
                let Some(end) = p.iter().skip(2).position(|&c| c == ']').map(|e| e + 2) else {
                    return n.first() == Some(&'[') && m(&p[1..], &n[1..]);
                };
                let Some(&c) = n.first() else { return false };
                let (neg, set) = if p[1] == '!' { (true, &p[2..end]) } else { (false, &p[1..end]) };
                let mut hit = false;
                let mut i = 0;
                while i < set.len() {
                    if i + 2 < set.len() && set[i + 1] == '-' {
                        hit |= set[i] <= c && c <= set[i + 2];
                        i += 3;
                    } else {
                        hit |= set[i] == c;
                        i += 1;
                    }
                }
                hit != neg && m(&p[end + 1..], &n[1..])
            }
            Some(&c) => n.first() == Some(&c) && m(&p[1..], &n[1..]),
        }
    }
    m(&pat.chars().collect::<Vec<_>>(), &name.chars().collect::<Vec<_>>())
}

fn list_dir(d: &Path) -> Vec<(String, PathBuf, bool)> {
    let dir = if d.as_os_str().is_empty() { Path::new(".") } else { d };
    let mut v: Vec<(String, PathBuf, bool)> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| {
                    let name = e.file_name().to_string_lossy().into_owned();
                    let real_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                    (name.clone(), d.join(&name), real_dir)
                })
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

fn glob_rec(base: &Path, parts: &[String], out: &mut Vec<PathBuf>) {
    let Some((first, rest)) = parts.split_first() else {
        if base.symlink_metadata().is_ok() {
            out.push(base.to_path_buf());
        }
        return;
    };
    if first == "**" {
        glob_rec(base, rest, out);
        for (name, p, is_dir) in list_dir(base) {
            if is_dir && !name.starts_with('.') {
                glob_rec(&p, parts, out);
            }
        }
    } else if !has_magic(first) {
        let p = base.join(first);
        if rest.is_empty() || p.is_dir() {
            glob_rec(&p, rest, out);
        }
    } else {
        for (name, p, _) in list_dir(base) {
            if (name.starts_with('.') && !first.starts_with('.')) || !fnmatch(first, &name) {
                continue;
            }
            if rest.is_empty() || p.is_dir() {
                glob_rec(&p, rest, out);
            }
        }
    }
}

/// Python `glob.glob(pat, recursive=True)`: `*` `?` `[..]` per component, `**` = any depth.
/// Hidden entries only match patterns starting with '.'; symlinked dirs are not descended by `**`.
/// Results are sorted per directory.
pub fn glob(pat: impl AsRef<Path>) -> Vec<PathBuf> {
    let mut base = PathBuf::new();
    let mut parts: Vec<String> = Vec::new();
    for c in pat.as_ref().components() {
        match c {
            Component::Normal(x) => parts.push(x.to_string_lossy().into_owned()),
            Component::CurDir => {}
            Component::ParentDir if parts.is_empty() => base.push(".."),
            Component::ParentDir => parts.push("..".into()),
            other => base.push(other.as_os_str()),
        }
    }
    if parts.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    glob_rec(&base, &parts, &mut out);
    let mut seen = HashSet::new();
    out.retain(|p| seen.insert(p.clone()));
    out
}

/// Files below `d` whose name matches `pat`, pruning hidden dirs and dirs named in `skip`.
/// `glob_hidden`: hidden files only match a pattern starting with '.' (glob), else os.walk semantics.
pub fn walk_files(d: &Path, pat: &str, skip: &[&str], glob_hidden: bool) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![d.to_path_buf()];
    while let Some(cur) = stack.pop() {
        for (name, p, is_dir) in list_dir(&cur) {
            if is_dir {
                if !skip.contains(&name.as_str()) && !name.starts_with('.') {
                    stack.push(p);
                }
            } else if fnmatch(pat, &name) && !(glob_hidden && name.starts_with('.') && !pat.starts_with('.')) {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

// ---------- stack detection ----------

/// Stacks whose manifest lives directly in `d`.
pub fn markers(d: &Path) -> Vec<&'static str> {
    let has = |pats: &[&str]| pats.iter().any(|p| !glob(d.join(p)).is_empty());
    let mut out = Vec::new();
    let rules: [(&str, &[&str]); 7] = [
        ("rust", &["Cargo.toml"]),
        ("go", &["go.mod", "go.work"]),
        ("ts", &["package.json", "tsconfig.json", "deno.json"]),
        ("cs", &["*.sln", "*.slnx", "*.csproj", "*.fsproj"]),
        (
            "luau",
            &[
                "default.project.json", "*.project.json", "wally.toml", "selene.toml", ".luaurc", "rokit.toml", "aftman.toml",
                "foreman.toml", "stylua.toml", ".stylua.toml",
            ],
        ),
        ("dart", &["pubspec.yaml"]),
        ("py", &["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"]),
    ];
    for (st, pats) in rules {
        if has(pats) {
            out.push(st);
        }
    }
    if has(&["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"]) {
        out.push("java");
    }
    if has(&["CMakeLists.txt", "meson.build"])
        || (has(&["Makefile", "makefile", "GNUmakefile", "configure.ac"])
            && has(&["*.c", "*.cc", "*.cpp", "*.cxx", "src/*.c", "src/*.cc", "src/*.cpp", "src/*.cxx"]))
    {
        out.push("cpp");
    }
    let rest: [(&str, &[&str]); 6] = [
        ("php", &["composer.json"]),
        ("ruby", &["Gemfile", "*.gemspec"]),
        ("swift", &["Package.swift"]),
        ("elixir", &["mix.exs"]),
        ("zig", &["build.zig", "build.zig.zon"]),
        ("scala", &["build.sbt"]),
    ];
    for (st, pats) in rest {
        if has(pats) {
            out.push(st);
        }
    }
    if super::langs::latex::is_project(d) {
        out.push("latex");
    }
    out
}

/// Nearest dir at or above `start` (bounded by the git root) holding a manifest; `want` restricts to one stack.
pub fn find_root(start: &Path, want: Option<&str>) -> (Option<PathBuf>, Vec<&'static str>) {
    let mut d = abspath(start);
    let top = util::git_root(start).map(|p| normpath(&p)).unwrap_or_else(|| d.clone());
    loop {
        let mut st = markers(&d);
        if let Some(w) = want {
            st.retain(|s| *s == w);
        }
        if !st.is_empty() {
            return (Some(d), st);
        }
        match d.parent() {
            Some(p) if d != top => d = p.to_path_buf(),
            _ => break,
        }
    }
    (None, Vec::new())
}

/// Manifest dirs below `root` up to `depth` levels (monorepos), excluding root itself.
pub fn subprojects(root: &Path, depth: usize) -> Vec<(String, Vec<&'static str>)> {
    fn walk(root: &Path, cur: &Path, lvl: usize, depth: usize, out: &mut Vec<(String, Vec<&'static str>)>) {
        if lvl > 0 {
            let m = markers(cur);
            if !m.is_empty() {
                out.push((relpath(cur, root), m));
            }
        }
        if lvl >= depth {
            return;
        }
        for (name, p, is_dir) in list_dir(cur) {
            if is_dir && !SKIP_DIRS.contains(&name.as_str()) && !name.starts_with('.') {
                walk(root, &p, lvl + 1, depth, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, 0, depth, &mut out);
    out
}

// ---------- subprocesses ----------

/// Resolve an executable (project node_modules/.bin, PATH, toolchain dirs) as a string.
pub fn exe(name: &str, root: Option<&Path>) -> Option<String> {
    util::tool(name, root).map(|p| s(&p))
}

/// Run `cmd` in `cwd` with a timeout (seconds), colour-free env. 124 = timeout, 127 = missing.
pub fn run<S: AsRef<str>>(cmd: &[S], cwd: &Path, timeout: u64) -> Output {
    let v: Vec<&str> = cmd.iter().map(|x| x.as_ref()).collect();
    util::run(&v, cwd, timeout, &[], None)
}

/// Last `n` non-empty lines joined (python `tail_lines`).
pub fn tail(text: &str, n: usize) -> String {
    util::tail_lines(text, n).join("\n")
}

/// Files changed vs HEAD plus untracked ones, absolute, sorted.
pub fn changed_files(root: &Path) -> Vec<PathBuf> {
    let a = util::git(root, &["diff", "--name-only", "--diff-filter=ACMR", "HEAD"]);
    let b = util::git(root, &["ls-files", "-o", "--exclude-standard", "--full-name"]);
    let top = util::git_root(root).unwrap_or_else(|| root.to_path_buf());
    let mut v: Vec<PathBuf> = a.lines().chain(b.lines()).filter(|l| !l.trim().is_empty()).map(|f| top.join(f)).collect();
    v.sort();
    v.dedup();
    v
}

// ---------- diagnostics ----------

#[derive(Clone, Debug, PartialEq)]
pub struct Diag {
    /// Display path (relative to cwd), "" for project-level messages.
    pub file: String,
    pub line: usize,
    pub col: usize,
    /// E, W, I, …
    pub sev: String,
    pub code: String,
    pub msg: String,
    pub extra: Option<String>,
}

/// Collects diagnostics; prints errors first, deduplicated, capped.
pub struct Diags {
    pub root: PathBuf,
    pub items: Vec<Diag>,
    seen: HashSet<(String, usize, usize, String)>,
    /// Printed as "  note: …" under the stack header.
    pub notes: Vec<String>,
    /// Appended to the header counts (latex: ", PDF built (12 pages)").
    pub status: String,
}

pub fn sev_letter(sev: &str) -> String {
    match sev.to_lowercase().as_str() {
        "error" | "fatal" => "E".into(),
        "warning" => "W".into(),
        "info" | "hint" | "note" => "I".into(),
        _ => sev.chars().next().map(|c| c.to_uppercase().to_string()).unwrap_or_else(|| "E".into()),
    }
}

impl Diags {
    pub fn new(root: &Path) -> Self {
        Diags { root: root.to_path_buf(), items: Vec::new(), seen: HashSet::new(), notes: Vec::new(), status: String::new() }
    }

    /// Add one diagnostic. `file` absolute or root-relative ("" = none); `sev` "error"/"warning"/"E"/"W"/…
    #[allow(clippy::too_many_arguments)]
    pub fn add(&mut self, file: &str, line: usize, col: usize, sev: &str, code: &str, msg: &str, extra: Option<String>) {
        let msg = ws(msg);
        if !self.seen.insert((file.to_string(), line, col, msg.clone())) {
            return;
        }
        self.items.push(Diag {
            file: rel(file, &self.root),
            line,
            col,
            sev: sev_letter(sev),
            code: code.to_string(),
            msg,
            extra,
        });
    }

    pub fn count(&self, sev: &str) -> usize {
        self.items.iter().filter(|d| d.sev == sev).count()
    }

    /// Keep only diagnostics in `files`.
    pub fn filter_files(&mut self, files: &[PathBuf]) {
        let real = |p: &Path| p.canonicalize().unwrap_or_else(|_| abspath(p));
        let keep: HashSet<PathBuf> = files.iter().map(|f| real(f)).collect();
        let here = util::cwd();
        self.items.retain(|d| !d.file.is_empty() && keep.contains(&real(&here.join(&d.file))));
    }

    pub fn lines(&self, cap: usize, errors_only: bool) -> Vec<String> {
        let mut items: Vec<&Diag> = self.items.iter().filter(|d| !errors_only || d.sev == "E").collect();
        let rank = |s: &str| match s {
            "E" => 0,
            "W" => 1,
            _ => 2,
        };
        items.sort_by(|a, b| (rank(&a.sev), &a.file, a.line).cmp(&(rank(&b.sev), &b.file, b.line)));
        let mut out = Vec::new();
        for d in items.iter().take(cap) {
            let loc = if d.file.is_empty() { "-".to_string() } else { format!("{}:{}:{}", d.file, d.line, d.col) };
            let code = if d.code.is_empty() { String::new() } else { format!(" {}", d.code) };
            out.push(format!("{loc} {}{code} {}", d.sev, trunc(&d.msg, 300)));
            if let Some(x) = d.extra.as_deref().filter(|x| !x.is_empty()) {
                out.push(format!("    {}", trunc(&ws(x), 200)));
            }
        }
        if items.len() > cap {
            out.push(format!("… {} more (-a for all)", items.len() - cap));
        }
        if items.len() > 8 {
            let mut per: OrdMap<&str, usize> = OrdMap::default();
            for d in &items {
                *per.entry(&d.file, || 0) += 1;
            }
            let mut top: Vec<(&str, usize)> = per.items.into_iter().collect();
            top.sort_by_key(|x| std::cmp::Reverse(x.1));
            let top: Vec<String> =
                top.iter().take(6).map(|(f, n)| format!("{} {n}", if f.is_empty() { "-" } else { f })).collect();
            out.push(format!("by file: {}", top.join(", ")));
        }
        out
    }

    pub fn print(&self, cap: usize, errors_only: bool) {
        for l in self.lines(cap, errors_only) {
            println!("{l}");
        }
    }
}

/// Lines that look like failures or source locations, with one line of context, capped.
pub fn generic_failures(text: &str, cap: usize) -> String {
    let fail = re!(r"(?i)(fail|error|panic|assert|expected|received|not ok|exception|✗|×|\bE\s{2,})");
    let loc = re!(r"[\w./\\-]+\.(rs|go|ts|tsx|js|jsx|mjs|cs|lua|luau|dart|py)[:(]\d+");
    let lines: Vec<&str> = text.lines().collect();
    let mut keep = std::collections::BTreeSet::new();
    for (i, l) in lines.iter().enumerate() {
        if fail.is_match(l) || loc.is_match(l) {
            keep.insert(i);
            keep.insert(i + 1);
        }
    }
    let mut out: Vec<String> = keep.into_iter().filter(|&i| i < lines.len()).map(|i| trunc(lines[i].trim_end(), 240).to_string()).collect();
    if out.len() > cap {
        let n = out.len() - cap;
        out.truncate(cap);
        out.push(format!("… {n} more lines"));
    }
    out.join("\n")
}

// ---------- API outlines (deps api) ----------

/// Block printer for `outline`: (file lines, index, "path:line") -> output lines.
pub type BlockFn<'a> = &'a dyn Fn(&[String], usize, &str) -> Vec<String>;

/// Grep declarations matching `rx` (anchored at line start) in `files`; "path:line  text".
/// With `sym`, only lines containing the word `sym`, printed through `block` when given.
pub fn outline(files: &[PathBuf], rx: &Regex, base: &Path, sym: Option<&str>, block: Option<BlockFn>) -> Vec<String> {
    let word = sym.map(|s| Regex::new(&format!(r"\b{}\b", regex::escape(s))).expect("sym regex"));
    let mut out = Vec::new();
    for f in files {
        let Ok(b) = std::fs::read(f) else { continue };
        let lines: Vec<String> = String::from_utf8_lossy(&b).lines().map(str::to_string).collect();
        for (i, l) in lines.iter().enumerate() {
            let t = l.trim_start();
            if ["//", "/*", "* ", "--"].iter().any(|p| t.starts_with(p)) {
                continue;
            }
            if pmatch(rx, l).is_none() || word.as_ref().is_some_and(|w| !w.is_match(l)) {
                continue;
            }
            let loc = format!("{}:{}", relpath(f, base), i + 1);
            match (sym, block) {
                (Some(_), Some(bl)) => out.extend(bl(&lines, i, &loc)),
                _ => out.push(format!("{loc}  {}", trunc(l.trim(), 200))),
            }
        }
    }
    out
}

/// Doc comments above line `i`, the declaration, and top-level member lines of its body
/// (filtered by `body_rx`) up to the matching `close`. Python defaults: "{", "}", None, 60.
pub fn doc_and_block(l: &[String], i: usize, loc: &str, open: &str, close: &str, body_rx: Option<&Regex>, max_lines: usize) -> Vec<String> {
    let above = re!(r"^\s*(///|//!|/\*\*|\*|\*/|#\[|@|--- ?|\[)");
    let attr = re!(r"^(#\[|@)");
    let marker = re!(r"^(///?|//!|/\*\*|\*/?|---?)\s*");
    let comment = re!(r"^\s*(//|/\*|\*|#\[doc)");
    let mut j = i;
    while j > 0 && above.is_match(&l[j - 1]) {
        j -= 1;
    }
    let (mut doc, mut para_done) = (Vec::new(), false);
    for x in &l[j..i] {
        let st = x.trim();
        if attr.is_match(st) {
            doc.push(x.trim_end().to_string());
            continue;
        }
        if para_done {
            continue;
        }
        if marker.replace(st, "").is_empty() && !doc.is_empty() {
            para_done = true;
            continue;
        }
        if doc.len() < 6 {
            doc.push(x.trim_end().to_string());
        }
    }
    let mut out = vec![format!("── {loc}")];
    out.extend(doc);
    let (mut depth, mut started, mut n) = (0i64, false, 0);
    for x in &l[i..] {
        let member = started && depth == 1 && !x.trim().is_empty() && !comment.is_match(x);
        if !started || (member && body_rx.is_none_or(|r| pmatch(r, x).is_some())) {
            out.push(x.trim_end().to_string());
            n += 1;
        }
        depth += x.matches(open).count() as i64 - x.matches(close).count() as i64;
        if x.contains(open) {
            started = true;
        }
        if started && depth <= 0 {
            if out.last().map(String::as_str) != Some(x.trim_end()) {
                out.push(x.trim_end().to_string());
            }
            break;
        }
        if !started && x.trim_end().ends_with(';') {
            break;
        }
        if n >= max_lines {
            out.push("    …".into());
            break;
        }
    }
    out
}

/// gcc/clang/swiftc/zig/javac style `file:line[:col]: severity: message [flag]`, plus linker errors.
#[allow(dead_code)] // used by langs/*
pub fn parse_gnu(d: &mut Diags, text: &str, root: &Path, notes: bool) {
    let rx = re!(r"^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note|remark):\s*(.*?)(?:\s+\[(-W[\w=+-]+|[\w.:-]+)\])?$");
    for ln in text.lines() {
        let Some(m) = rx.captures(ln.trim()) else { continue };
        let kind = g(&m, 4);
        if matches!(kind, "note" | "remark") && !notes {
            continue;
        }
        let f = g(&m, 1);
        if f.starts_with("In file included") || f.starts_with("/usr/bin/ld") || f.starts_with("ld") {
            continue;
        }
        d.add(&join(root, f), gn(&m, 2), gn(&m, 3), if kind.contains("error") { "E" } else { "W" }, g(&m, 6), g(&m, 5), None);
    }
    for m in re!(r"undefined reference to [`'](.+?)'").captures_iter(text) {
        d.add("", 0, 0, "E", "ld", &format!("undefined reference to {}", g(&m, 1)), None);
    }
}

// ---------- test summaries ----------

/// "st: P passed, F failed[, S skipped][ [1.2s]]note". P/F may be "?".
pub fn summary_line(st: &str, passed: impl Display, failed: impl Display, skipped: usize, secs: Option<f64>, note: &str) -> String {
    let sk = if skipped > 0 { format!(", {skipped} skipped") } else { String::new() };
    let t = secs.map(|s| format!(" [{s:.1}s]")).unwrap_or_default();
    format!("{st}: {passed} passed, {failed} failed{sk}{t}{note}")
}

pub fn summary(st: &str, passed: impl Display, failed: impl Display, skipped: usize, secs: Option<f64>, note: &str) {
    println!("{}", summary_line(st, passed, failed, skipped, secs, note));
}

/// "FAIL name  (where)" then up to 14 indented non-empty body lines.
pub fn fail_lines(name: &str, body: &str, place: Option<&str>) -> Vec<String> {
    let mut out = vec![format!("FAIL {name}{}", place.map(|w| format!("  ({w})")).unwrap_or_default())];
    out.extend(body.lines().filter(|l| !l.trim().is_empty()).take(14).map(|l| format!("    {}", trunc(l.trim_end(), 220))));
    out
}

#[allow(dead_code)] // used by langs/*
pub fn show_fail(name: &str, body: &str, place: Option<&str>) {
    for l in fail_lines(name, body, place) {
        println!("{l}");
    }
}

/// Print at most `cap` lines, then "… N more (-a, or pass a SYMBOL)".
pub fn cap_print(lines: &[String], cap: usize) {
    for l in lines.iter().take(cap) {
        println!("{l}");
    }
    if lines.len() > cap {
        println!("… {} more (-a, or pass a SYMBOL)", lines.len() - cap);
    }
}

// ---------- minimal XML (JUnit, TRX, .NET XML docs) ----------

pub struct XmlEl {
    pub attrs: HashMap<String, String>,
    /// Raw inner markup; None for `<tag/>`.
    pub inner: Option<String>,
}

impl XmlEl {
    pub fn attr(&self, k: &str) -> Option<&str> {
        self.attrs.get(k).map(String::as_str)
    }
}

pub fn xml_unescape(s: &str) -> String {
    let ent = re!(r"&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);");
    ent.replace_all(s, |c: &Captures| match g(c, 1) {
        "lt" => "<".to_string(),
        "gt" => ">".into(),
        "amp" => "&".into(),
        "quot" => "\"".into(),
        "apos" => "'".into(),
        x => {
            let n = if let Some(h) = x.strip_prefix("#x") { u32::from_str_radix(h, 16).ok() } else { x[1..].parse().ok() };
            n.and_then(char::from_u32).map(String::from).unwrap_or_default()
        }
    })
    .into_owned()
}

/// Text content of inner markup: CDATA kept verbatim, tags dropped, entities decoded.
pub fn xml_text(inner: &str) -> String {
    let mut out = String::new();
    let mut rest = inner;
    while let Some(i) = rest.find("<![CDATA[") {
        out.push_str(&xml_unescape(&re!(r"(?s)<[^>]*>").replace_all(&rest[..i], "")));
        let body = &rest[i + 9..];
        let end = body.find("]]>").unwrap_or(body.len());
        out.push_str(&body[..end]);
        rest = body.get(end + 3..).unwrap_or("");
    }
    out.push_str(&xml_unescape(&re!(r"(?s)<[^>]*>").replace_all(rest, "")));
    out
}

/// All `<tag …>` elements (not nested in themselves) in document order; namespace prefixes are not handled.
pub fn xml_elems(text: &str, tag: &str) -> Vec<XmlEl> {
    let el = Regex::new(&format!(
        r#"(?s)<{t}\b((?:[^>"']|"[^"]*"|'[^']*')*?)(/>|>(.*?)</{t}\s*>)"#,
        t = regex::escape(tag)
    ))
    .expect("xml regex");
    let at = re!(r#"([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')"#);
    el.captures_iter(text)
        .map(|c| XmlEl {
            attrs: at.captures_iter(g(&c, 1)).map(|a| (g(&a, 1).to_string(), xml_unescape(&format!("{}{}", g(&a, 2), g(&a, 3))))).collect(),
            inner: c.get(3).map(|m| m.as_str().to_string()),
        })
        .collect()
}

/// First direct-or-nested child element `tag` of `el`.
pub fn xml_child(el: &XmlEl, tag: &str) -> Option<XmlEl> {
    xml_elems(el.inner.as_deref()?, tag).into_iter().next()
}

#[allow(dead_code)] // used by langs/*
const JUNIT_FRAME: &str = r"\(([\w$.-]+\.(?:java|kt|scala|groovy|php|rb|swift|ex|exs|cpp|cc|c|py)):(\d+)\)|([\w/.-]+\.(?:php|rb|ex|exs|swift|cpp|cc|c|py|kt|java|scala)):(\d+)";

/// Summarize JUnit-XML reports matching the glob patterns `pats` (surefire, gradle, phpunit, rspec_junit,
/// ctest, mix junit…): summary line + up to `nmax` failures. Returns the failure count, None without reports.
/// `frame_rx` overrides the source-frame regex (groups 1:2 or 3:4 = file:line).
#[allow(dead_code)] // used by langs/*
pub fn junit(pats: &[String], st: &str, secs: Option<f64>, nmax: usize, frame_rx: Option<&str>) -> Option<usize> {
    let files: Vec<PathBuf> = pats.iter().flat_map(glob).collect();
    if files.is_empty() {
        return None;
    }
    let frame = Regex::new(frame_rx.unwrap_or(JUNIT_FRAME)).expect("frame regex");
    let noise = re!(r"^\s+at (org\.junit|org\.opentest4j|java\.|jdk\.|sun\.|org\.gradle|org\.apache\.maven|kotlin\.|scala\.|sbt\.|munit\.|org\.scalatest|PHPUnit\\)");
    let lib = re!(r"at (org\.junit|org\.opentest4j|org\.assertj|org\.hamcrest|java\.|jdk\.|sun\.|kotlin\.|scala\.|org\.scalatest|munit\.)[^\n]*$");
    let (mut p, mut f, mut sk) = (0, 0, 0);
    let mut fails: Vec<(String, String, Option<String>)> = Vec::new();
    for file in &files {
        let text = read(file);
        for tc in xml_elems(&text, "testcase") {
            let bad = xml_child(&tc, "failure").or_else(|| xml_child(&tc, "error"));
            if xml_child(&tc, "skipped").is_some() {
                sk += 1;
                continue;
            }
            let Some(bad) = bad else {
                p += 1;
                continue;
            };
            f += 1;
            let msg1 = bad.attr("message").unwrap_or("").trim().to_string();
            let txt = format!("{}\n{}", bad.attr("message").unwrap_or(""), bad.inner.as_deref().map(xml_text).unwrap_or_default());
            let cls = tc.attr("classname").unwrap_or("").rsplit('.').next().unwrap_or("").to_string();
            let frames: Vec<(String, String, String)> = frame
                .captures_iter(&txt)
                .map(|m| {
                    let st = m.get(0).map_or(0, |x| x.start());
                    let mut from = st.saturating_sub(160);
                    while !txt.is_char_boundary(from) {
                        from -= 1;
                    }
                    let file = if m.get(1).is_some() { g(&m, 1) } else { g(&m, 3) };
                    let line = if m.get(2).is_some() { g(&m, 2) } else { g(&m, 4) };
                    (file.to_string(), line.to_string(), txt[from..st].to_string())
                })
                .collect();
            let stem = |f: &str| {
                let b = f.rsplit(['/', '\\']).next().unwrap_or(f);
                b.rfind('.').filter(|&i| i > 0).map_or(b, |i| &b[..i]).to_string()
            };
            let pick = frames
                .iter()
                .find(|fr| !cls.is_empty() && stem(&fr.0) == cls)
                .or_else(|| frames.iter().find(|fr| !lib.is_match(&fr.2)));
            let loc = pick.map(|fr| format!("{}:{}", fr.0, fr.1));
            let mut seen = HashSet::new();
            let body: Vec<&str> = txt
                .lines()
                .filter(|l| !l.trim().is_empty() && !noise.is_match(l))
                .filter(|l| !(!msg1.is_empty() && l.trim().ends_with(msg1.as_str()) && l.trim() != msg1))
                .filter(|l| seen.insert(*l))
                .collect();
            let name = [tc.attr("classname"), tc.attr("name")].iter().flatten().filter(|x| !x.is_empty()).copied().collect::<Vec<_>>().join(".");
            if !fails.iter().any(|x| x.0 == name) {
                fails.push((name, body.join("\n"), loc));
            }
        }
    }
    summary(st, p, f, sk, secs, "");
    for x in fails.iter().take(nmax) {
        show_fail(&x.0, &x.1, x.2.as_deref());
    }
    if fails.len() > nmax {
        println!("… {} more failures (-n)", fails.len() - nmax);
    }
    Some(f)
}

/// Files matching the glob patterns modified at or after `since` (minus 1s): skips stale reports.
#[allow(dead_code)] // used by langs/*
pub fn newest(pats: &[String], since: SystemTime) -> Vec<PathBuf> {
    let since = since - std::time::Duration::from_secs(1);
    pats.iter()
        .flat_map(glob)
        .filter(|p| p.metadata().and_then(|m| m.modified()).is_ok_and(|t| t >= since))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("kit-common-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn markers_detect_all_stacks() {
        let d = tmp("markers");
        let cases: &[(&str, &[&str])] = &[
            ("rust", &["Cargo.toml"]),
            ("go", &["go.mod"]),
            ("ts", &["package.json"]),
            ("cs", &["App.csproj"]),
            ("luau", &["default.project.json"]),
            ("dart", &["pubspec.yaml"]),
            ("py", &["pyproject.toml"]),
            ("java", &["pom.xml"]),
            ("cpp", &["Makefile", "src/main.c"]),
            ("php", &["composer.json"]),
            ("ruby", &["x.gemspec"]),
            ("swift", &["Package.swift"]),
            ("elixir", &["mix.exs"]),
            ("zig", &["build.zig"]),
            ("scala", &["build.sbt"]),
            ("latex", &["latexmkrc"]),
        ];
        for (st, files) in cases {
            let sd = d.join(st);
            for f in *files {
                let p = sd.join(f);
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                std::fs::write(p, "").unwrap();
            }
            assert_eq!(markers(&sd), vec![*st], "{st}");
        }
        // Makefile alone is not cpp
        let mk = d.join("mk");
        std::fs::create_dir_all(&mk).unwrap();
        std::fs::write(mk.join("Makefile"), "").unwrap();
        assert!(markers(&mk).is_empty());
        let subs = subprojects(&d, 2);
        assert_eq!(subs.len(), 16);
        let (root, st) = find_root(&d.join("rust"), None);
        assert_eq!(st, vec!["rust"]);
        assert_eq!(root.unwrap(), abspath(&d.join("rust")));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn glob_and_fnmatch() {
        assert!(fnmatch("*.rs", "a.rs") && !fnmatch("*.rs", "a.rsx") && fnmatch("t?st_[a-c]*.py", "test_b1.py"));
        assert!(fnmatch("[!x]y", "ay") && !fnmatch("[!x]y", "xy"));
        let d = tmp("glob");
        for f in ["src/a.rs", "src/x/b.rs", "src/.h/c.rs", "README.md"] {
            let p = d.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "").unwrap();
        }
        let names: Vec<String> = glob(d.join("**").join("*.rs")).iter().map(|p| relpath(p, &d)).collect();
        assert_eq!(names, vec!["src/a.rs".replace('/', std::path::MAIN_SEPARATOR_STR), "src/x/b.rs".replace('/', std::path::MAIN_SEPARATOR_STR)]);
        assert_eq!(glob(d.join("*.md")).len(), 1);
        assert_eq!(walk_files(&d, "*.rs", SKIP_DIRS, true).len(), 2);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn paths() {
        assert_eq!(normpath(Path::new("/a/b/../c/./d")), PathBuf::from("/a/c/d"));
        assert_eq!(relpath("/a/b/c", Path::new("/a/x")), format!("..{0}b{0}c", std::path::MAIN_SEPARATOR));
        assert_eq!(relpath("/a", Path::new("/a")), ".");
    }

    #[test]
    fn diags_sort_dedupe_cap() {
        let mut d = Diags::new(Path::new("/r"));
        d.add("/r/b.rs", 3, 1, "warning", "W1", "warn  one", None);
        d.add("/r/a.rs", 9, 2, "error", "E1", "bad\nthing", Some("help: x".into()));
        d.add("/r/a.rs", 9, 2, "error", "E1", "bad thing", None);
        d.add("", 0, 0, "fatal", "", "boom", None);
        assert_eq!(d.items.len(), 3);
        assert_eq!(d.count("E"), 2);
        let l = d.lines(30, false);
        assert_eq!(l[0], "- E boom");
        assert!(l[1].ends_with("a.rs:9:2 E E1 bad thing"));
        assert_eq!(l[2], "    help: x");
        assert!(l[3].ends_with("b.rs:3:1 W W1 warn one"));
        assert_eq!(d.lines(1, false).last().unwrap(), "… 2 more (-a for all)");
        assert_eq!(d.lines(30, true).len(), 3);
    }

    #[test]
    fn gnu_and_generic() {
        let mut d = Diags::new(Path::new("/r"));
        parse_gnu(&mut d, "src/a.c:3:5: error: unknown type 'x'\nsrc/a.c:4: warning: unused [-Wunused]\na.c:1:1: note: here\nmain.o: undefined reference to `foo'", Path::new("/r"), false);
        assert_eq!(d.items.len(), 3);
        assert_eq!(d.items[1].code, "-Wunused");
        assert_eq!(d.items[2].msg, "undefined reference to foo");
        let g = generic_failures("ok\nall good\nFAIL thing\n  detail\nok\nsrc/x.rs:3 here", 60);
        assert_eq!(g, "FAIL thing\n  detail\nsrc/x.rs:3 here");
    }

    #[test]
    fn doc_block_and_outline() {
        let src: Vec<String> = "/// Adds.\n///\n/// More.\n#[inline]\npub fn add(a: i32) -> i32 {\n    a + 1\n}\npub struct S {\n    pub x: i32,\n    // c\n    y: u8,\n}"
            .lines()
            .map(String::from)
            .collect();
        let b = doc_and_block(&src, 4, "f.rs:5", "{", "}", None, 60);
        assert_eq!(b, vec!["── f.rs:5", "/// Adds.", "#[inline]", "pub fn add(a: i32) -> i32 {", "    a + 1", "}"]);
        let b = doc_and_block(&src, 7, "f.rs:8", "{", "}", None, 60);
        assert_eq!(b, vec!["── f.rs:8", "pub struct S {", "    pub x: i32,", "    y: u8,", "}"]);
        let d = tmp("outline");
        std::fs::write(d.join("f.rs"), src.join("\n")).unwrap();
        let rx = Regex::new(r"^\s*pub\s+(fn|struct)\b").unwrap();
        let o = outline(&[d.join("f.rs")], &rx, &d, None, None);
        assert_eq!(o, vec!["f.rs:5  pub fn add(a: i32) -> i32 {", "f.rs:8  pub struct S {"]);
        let o = outline(&[d.join("f.rs")], &rx, &d, Some("S"), Some(&|l: &[String], i, loc: &str| doc_and_block(l, i, loc, "{", "}", None, 60)));
        assert_eq!(o.len(), 5);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn junit_xml() {
        let d = tmp("junit");
        std::fs::write(
            d.join("TEST-a.xml"),
            r#"<?xml version="1.0"?><testsuite><testcase classname="com.x.CalcTest" name="adds" time="0.1"/>
<testcase classname="com.x.CalcTest" name="subs"><failure message="expected: &lt;1&gt; but was: <2>" type="AssertionError"><![CDATA[org.opentest4j.AssertionFailedError: expected: <1> but was: <2>
	at org.junit.jupiter.api.AssertEquals.fail(AssertEquals.java:1)
	at com.x.CalcTest.subs(CalcTest.java:14)]]></failure></testcase>
<testcase classname="com.x.CalcTest" name="skip"><skipped/></testcase></testsuite>"#,
        )
        .unwrap();
        let els = xml_elems(&read(d.join("TEST-a.xml")), "testcase");
        assert_eq!(els.len(), 3);
        assert_eq!(xml_child(&els[1], "failure").unwrap().attr("message"), Some("expected: <1> but was: <2>"));
        assert_eq!(junit(&[s(&d.join("*.xml"))], "maven", None, 10, None), Some(1));
        assert_eq!(junit(&[s(&d.join("none*.xml"))], "maven", None, 10, None), None);
        assert_eq!(newest(&[s(&d.join("*.xml"))], SystemTime::now() - std::time::Duration::from_secs(60)).len(), 1);
        let _ = std::fs::remove_dir_all(&d);
    }
}
