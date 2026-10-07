//! Builds and caches the code map: one entry per source file with its definitions and call sites.
//! Only files whose mtime or size changed are re-parsed.

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;
use tree_sitter_tags::{TagsConfiguration, TagsContext};

/// Bump whenever extraction changes, so stale cached entries are re-parsed.
const FORMAT: u32 = 4;
const MAX_FILE_BYTES: u64 = 1_000_000;
/// Dependency, build and cache folders: never project source, even without a .gitignore.
const SKIP_DIRS: &[&str] = &[
    "node_modules", "dist", "build", "out", "target", ".next", ".nuxt", ".svelte-kit", "coverage", ".venv", "venv",
    "__pycache__", ".tox", ".mypy_cache", ".pytest_cache", ".turbo", ".cache", ".git", ".forge", ".dart_tool",
];
pub const NONE: u32 = u32::MAX;

#[derive(Serialize, Deserialize, Clone)]
pub struct Sym {
    pub name: String,
    pub kind: String,
    /// 1-based, inclusive.
    pub start: u32,
    pub end: u32,
    /// Index of the innermost enclosing definition in the same file, or NONE.
    pub parent: u32,
    pub sig: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Call {
    /// Index of the innermost definition containing the call, or NONE (top level).
    pub from: u32,
    pub name: String,
    pub line: u32,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct FileEntry {
    pub path: String,
    pub mtime: u64,
    pub size: u64,
    pub lines: u32,
    pub syms: Vec<Sym>,
    pub calls: Vec<Call>,
}

#[derive(Serialize, Deserialize, Default)]
pub struct Index {
    pub format: u32,
    pub root: String,
    pub files: Vec<FileEntry>,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Lang {
    Rust,
    TypeScript,
    Tsx,
    JavaScript,
    Python,
    Go,
}

fn lang_of(path: &Path) -> Option<Lang> {
    Some(match path.extension()?.to_str()? {
        "rs" => Lang::Rust,
        "ts" | "mts" | "cts" => Lang::TypeScript,
        "tsx" => Lang::Tsx,
        "js" | "jsx" | "mjs" | "cjs" => Lang::JavaScript,
        "py" | "pyi" => Lang::Python,
        "go" => Lang::Go,
        _ => return None,
    })
}

fn config(lang: Lang) -> &'static TagsConfiguration {
    static CONFIGS: OnceLock<HashMap<Lang, TagsConfiguration>> = OnceLock::new();
    let all = CONFIGS.get_or_init(|| {
        let js = tree_sitter_javascript::TAGS_QUERY;
        let ts = format!("{}\n{}", tree_sitter_typescript::TAGS_QUERY, js);
        let mk = |l: tree_sitter::Language, q: &str| TagsConfiguration::new(l, q, "").expect("valid tags query");
        HashMap::from([
            (Lang::Rust, mk(tree_sitter_rust::LANGUAGE.into(), include_str!("../queries/rust.scm"))),
            (Lang::TypeScript, mk(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(), &ts)),
            (Lang::Tsx, mk(tree_sitter_typescript::LANGUAGE_TSX.into(), &ts)),
            (Lang::JavaScript, mk(tree_sitter_javascript::LANGUAGE.into(), js)),
            (Lang::Python, mk(tree_sitter_python::LANGUAGE.into(), tree_sitter_python::TAGS_QUERY)),
            (Lang::Go, mk(tree_sitter_go::LANGUAGE.into(), tree_sitter_go::TAGS_QUERY)),
        ])
    });
    &all[&lang]
}

/// Byte offset -> 1-based line number.
struct Lines(Vec<usize>);

impl Lines {
    fn new(src: &[u8]) -> Self {
        let mut v = vec![0];
        v.extend(src.iter().enumerate().filter(|(_, b)| **b == b'\n').map(|(i, _)| i + 1));
        Lines(v)
    }
    fn line(&self, byte: usize) -> u32 {
        (self.0.partition_point(|&s| s <= byte)) as u32
    }
    fn count(&self, src: &[u8]) -> u32 {
        let n = self.0.len() as u32;
        if src.last() == Some(&b'\n') { n - 1 } else { n }
    }
}

/// Declaration head: from the item start up to its body, whitespace collapsed.
/// Stops at the body brace (or Python's header colon), or at a line end outside parentheses.
fn signature(lang: Lang, src: &[u8], start: usize, end: usize) -> String {
    let text = String::from_utf8_lossy(&src[start..end.min(start + 800)]);
    let mut out = String::new();
    let mut depth = 0i32;
    for ch in text.chars() {
        match ch {
            '(' | '[' => depth += 1,
            ')' | ']' => depth -= 1,
            '{' if depth <= 0 && lang != Lang::Python => break,
            ':' if depth <= 0 && lang == Lang::Python => break,
            ';' if depth <= 0 => break,
            '\n' if depth <= 0 && !out.trim().is_empty() && !out.trim_end().ends_with([',', '(', '=', '|', '&']) => break,
            _ => {}
        }
        out.push(ch);
    }
    let mut s = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() > 160 {
        s = s.chars().take(157).collect::<String>() + "...";
    }
    s
}

fn parse_file(ctx: &mut TagsContext, lang: Lang, src: &[u8]) -> (Vec<Sym>, Vec<Call>) {
    // Minified or generated one-liners carry no navigable structure; skip before parsing them.
    if src.len() > 20_000 && src.len() / (src.iter().filter(|b| **b == b'\n').count() + 1) > 300 {
        return (vec![], vec![]);
    }
    let cfg = config(lang);
    let Ok((tags, _)) = ctx.generate_tags(cfg, src, None) else { return (vec![], vec![]) };
    let lines = Lines::new(src);
    let mut defs: Vec<(usize, usize, Sym)> = Vec::new();
    let mut refs: Vec<(usize, String, u32)> = Vec::new();
    for tag in tags.flatten() {
        let ty = cfg.syntax_type_name(tag.syntax_type_id);
        let name = String::from_utf8_lossy(&src[tag.name_range.clone()]).into_owned();
        if name.trim().is_empty() {
            continue;
        }
        if tag.is_definition {
            let (s, e) = (tag.range.start, tag.range.end);
            defs.push((
                s,
                e,
                Sym {
                    name: name.split_whitespace().collect::<Vec<_>>().join(" "),
                    kind: ty.to_string(),
                    start: lines.line(s),
                    end: lines.line(e.saturating_sub(1).max(s)),
                    parent: NONE,
                    sig: signature(lang, src, s, e),
                },
            ));
        } else if ty == "call" {
            // `x.foo()` is a method call: recorded as `.foo` so it never resolves to a free function `foo`.
            let method = tag.name_range.start > 0 && src[tag.name_range.start - 1] == b'.';
            let name = if method { format!(".{name}") } else { name };
            refs.push((tag.name_range.start, name, lines.line(tag.name_range.start)));
        } else if ty == "macro" {
            // Recorded as `name!` so a macro call never resolves to a function of the same name.
            refs.push((tag.name_range.start, format!("{name}!"), lines.line(tag.name_range.start)));
        }
    }
    // Outer definitions first so a stack can track nesting.
    defs.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
    defs.dedup_by(|b, a| a.0 == b.0 && a.1 == b.1 && a.2.name == b.2.name);
    let mut stack: Vec<usize> = Vec::new();
    for i in 0..defs.len() {
        while let Some(&top) = stack.last() {
            if defs[top].1 >= defs[i].1 && defs[top].0 <= defs[i].0 {
                break;
            }
            stack.pop();
        }
        defs[i].2.parent = stack.last().map_or(NONE, |&p| p as u32);
        stack.push(i);
    }
    let innermost = |pos: usize| -> u32 {
        let mut best = NONE;
        let mut best_len = usize::MAX;
        for (i, (s, e, _)) in defs.iter().enumerate() {
            if *s <= pos && pos < *e && e - s < best_len {
                best = i as u32;
                best_len = e - s;
            }
        }
        best
    };
    let calls = refs.into_iter().map(|(pos, name, line)| Call { from: innermost(pos), name, line }).collect();
    (defs.into_iter().map(|d| d.2).collect(), calls)
}

pub fn cache_path(root: &Path) -> PathBuf {
    let base = std::env::var_os("TMAP_CACHE_DIR").map(PathBuf::from).unwrap_or_else(|| {
        std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".cache"))
            .join("tokenforge")
            .join("tmap")
    });
    // FNV-1a of the root path: stable across runs, no extra dependency.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in root.to_string_lossy().bytes() {
        h = (h ^ b as u64).wrapping_mul(0x100000001b3);
    }
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    base.join(format!("{name}-{h:016x}.bin"))
}

fn load(path: &Path) -> Option<Index> {
    let bytes = fs::read(path).ok()?;
    let idx: Index = bincode::deserialize(&bytes).ok()?;
    (idx.format == FORMAT).then_some(idx)
}

pub struct Stats {
    pub parsed: usize,
    pub removed: usize,
}

/// Load the cached index for `root` and bring it up to date with the working tree.
pub fn refresh(root: &Path, force: bool) -> std::io::Result<(Index, Stats)> {
    let cache = cache_path(root);
    let mut old: HashMap<String, FileEntry> = if force {
        HashMap::new()
    } else {
        load(&cache).map(|i| i.files.into_iter().map(|f| (f.path.clone(), f)).collect()).unwrap_or_default()
    };
    let mut current: Vec<(String, PathBuf, Lang, u64, u64)> = Vec::new();
    let walker = ignore::WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .parents(true)
        .filter_entry(|e| !(e.file_type().is_some_and(|t| t.is_dir()) && SKIP_DIRS.contains(&e.file_name().to_str().unwrap_or(""))))
        .build();
    for entry in walker.flatten() {
        let p = entry.path();
        let Some(lang) = lang_of(p) else { continue };
        if p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.contains(".min.") || n.ends_with(".bundle.js")) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let rel = p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/");
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos() as u64);
        current.push((rel, p.to_path_buf(), lang, mtime, meta.len()));
    }
    let total_old = old.len();
    let mut keep: Vec<FileEntry> = Vec::new();
    let mut todo = Vec::new();
    for (rel, abs, lang, mtime, size) in current {
        match old.remove(&rel) {
            Some(f) if f.mtime == mtime && f.size == size => keep.push(f),
            _ => todo.push((rel, abs, lang, mtime, size)),
        }
    }
    let removed = old.len();
    let parsed: Vec<FileEntry> = todo
        .par_iter()
        .map_init(TagsContext::new, |ctx, (rel, abs, lang, mtime, size)| {
            let src = fs::read(abs).unwrap_or_default();
            let (syms, calls) = parse_file(ctx, *lang, &src);
            FileEntry { path: rel.clone(), mtime: *mtime, size: *size, lines: Lines::new(&src).count(&src), syms, calls }
        })
        .collect();
    let stats = Stats { parsed: parsed.len(), removed };
    keep.extend(parsed);
    keep.sort_by(|a, b| a.path.cmp(&b.path));
    let idx = Index { format: FORMAT, root: root.to_string_lossy().into_owned(), files: keep };
    if stats.parsed > 0 || stats.removed > 0 || total_old == 0 {
        if let Some(dir) = cache.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = cache.with_extension(format!("tmp{}", std::process::id()));
        fs::write(&tmp, bincode::serialize(&idx).expect("serializable index"))?;
        fs::rename(&tmp, &cache)?;
    }
    Ok((idx, stats))
}
