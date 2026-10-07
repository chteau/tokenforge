//! Read-side commands. Output is one fact per line, root-relative paths, 1-based inclusive line ranges.

use crate::index::{FileEntry, Index, Sym, NONE};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write;

/// Split an identifier into lowercase words: `parseHTTPHeader2` -> parse, http, header, 2.
pub fn words(name: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let chars: Vec<char> = name.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if !c.is_alphanumeric() {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            continue;
        }
        let prev = i.checked_sub(1).map(|j| chars[j]);
        let next = chars.get(i + 1).copied();
        let boundary = match prev {
            Some(p) if p.is_alphanumeric() => {
                (c.is_uppercase() && (p.is_lowercase() || p.is_ascii_digit()))
                    || (c.is_uppercase() && p.is_uppercase() && next.is_some_and(|n| n.is_lowercase()))
                    || (c.is_ascii_digit() != p.is_ascii_digit())
            }
            _ => false,
        };
        if boundary && !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
        cur.extend(c.to_lowercase());
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn kind_bonus(kind: &str) -> i32 {
    match kind {
        "struct" | "class" | "trait" | "interface" | "enum" | "type" | "union" => 6,
        "function" | "method" | "macro" => 3,
        "impl" => -8,
        _ => 0,
    }
}

/// Name matches score high; path and signature only count as whole words or word prefixes,
/// so "graph" does not match "orthographic".
fn term_score(term: &str, name_l: &str, name_words: &[String], path_words: &[String], sig_words: &[String]) -> i32 {
    let prefix = |ws: &[String]| term.len() >= 3 && ws.iter().any(|w| w.starts_with(term));
    if name_l == term {
        100
    } else if name_words.iter().any(|w| w == term) {
        50
    } else if prefix(name_words) {
        30
    } else if path_words.iter().any(|w| w == term) {
        14
    } else if prefix(path_words) {
        8
    } else if sig_words.iter().any(|w| w == term) {
        6
    } else {
        0
    }
}

/// Vendored, generated and test code ranks below the project's own code.
fn path_penalty(path: &str) -> i32 {
    let p = path.to_lowercase();
    let mut pen = 0;
    if ["vendor/", "third_party/", "third-party/", "external/", "generated/", "gen/"].iter().any(|d| p.starts_with(d) || p.contains(&format!("/{d}"))) {
        pen += 25;
    }
    if is_test_file(&p) {
        pen += 10;
    }
    pen
}

fn is_test_file(p: &str) -> bool {
    let name = p.rsplit('/').next().unwrap_or(p);
    name == "tests.rs" || name.ends_with("_test.go") || name.ends_with("_test.py") || name.starts_with("test_")
        || name.contains(".test.") || name.contains(".spec.") || p.contains("/tests/") || p.starts_with("tests/") || p.contains("__tests__/")
}

pub struct FindOpts<'a> {
    pub limit: usize,
    pub kind: Option<&'a str>,
    pub within: Option<&'a str>,
}

pub fn find(idx: &Index, query: &[String], o: &FindOpts) -> String {
    let terms: Vec<String> = query.iter().flat_map(|q| words(q)).collect::<Vec<_>>();
    let terms: Vec<String> = {
        let mut seen = HashSet::new();
        terms.into_iter().filter(|t| seen.insert(t.clone())).collect()
    };
    if terms.is_empty() {
        return "tmap: find needs at least one keyword\n".into();
    }
    // (score, matched terms, file, sym)
    let mut hits: Vec<(i32, usize, &FileEntry, &Sym)> = Vec::new();
    for f in &idx.files {
        if o.within.is_some_and(|w| !f.path.starts_with(w)) {
            continue;
        }
        let path_words = words(&f.path);
        let penalty = path_penalty(&f.path);
        for s in &f.syms {
            if o.kind.is_some_and(|k| s.kind != k) {
                continue;
            }
            let name_l = s.name.to_lowercase();
            let nw = words(&s.name);
            let sw = words(&s.sig);
            let mut score = 0;
            let mut matched = 0;
            for t in &terms {
                let ts = term_score(t, &name_l, &nw, &path_words, &sw);
                if ts > 0 {
                    matched += 1;
                    score += ts;
                }
            }
            if matched == 0 {
                continue;
            }
            score += kind_bonus(&s.kind) - if s.parent == NONE { 0 } else { 2 } - penalty;
            hits.push((score, matched, f, s));
        }
    }
    let full = hits.iter().any(|h| h.1 == terms.len());
    if full {
        hits.retain(|h| h.1 == terms.len());
    }
    hits.sort_by(|a, b| b.1.cmp(&a.1).then(b.0.cmp(&a.0)).then(a.2.path.len().cmp(&b.2.path.len())).then(a.3.start.cmp(&b.3.start)));
    let mut out = String::new();
    if hits.is_empty() {
        let _ = writeln!(out, "tmap: no symbol matches {}", terms.join(" "));
        return out;
    }
    if !full {
        let _ = writeln!(out, "(no symbol matches all of: {}; best partial matches)", terms.join(" "));
    }
    for (_, _, f, s) in hits.iter().take(o.limit) {
        line(&mut out, f, s);
    }
    if hits.len() > o.limit {
        let _ = writeln!(out, "(+{} more; narrow with more words, --kind or --in)", hits.len() - o.limit);
    }
    out
}

fn line(out: &mut String, f: &FileEntry, s: &Sym) {
    let parent = (s.parent != NONE).then(|| &f.syms[s.parent as usize]);
    let sig = if s.sig.is_empty() { format!("{} {}", s.kind, s.name) } else { s.sig.clone() };
    let _ = write!(out, "{}:{}-{}  {}", f.path, s.start, s.end, sig);
    if let Some(p) = parent {
        let _ = write!(out, "  (in {})", p.name);
    }
    out.push('\n');
}

fn defs_named<'a>(idx: &'a Index, name: &str) -> Vec<(&'a FileEntry, usize)> {
    let pick = |exact: bool| {
        idx.files
            .iter()
            .flat_map(|f| f.syms.iter().enumerate().map(move |(i, s)| (f, i, s)))
            .filter(|(_, _, s)| if exact { s.name == name } else { s.name.eq_ignore_ascii_case(name) })
            .filter(|(_, _, s)| s.kind != "impl")
            .map(|(f, i, _)| (f, i))
            .collect::<Vec<_>>()
    };
    let exact = pick(true);
    if exact.is_empty() { pick(false) } else { exact }
}

pub fn slice(idx: &Index, name: &str) -> String {
    let defs = defs_named(idx, name);
    if defs.is_empty() {
        return format!("tmap: no definition named {name}\n");
    }
    defs.iter().map(|(f, i)| format!("{}:{}-{}\n", f.path, f.syms[*i].start, f.syms[*i].end)).collect()
}

pub fn sym(idx: &Index, root: &std::path::Path, name: &str, with_src: bool) -> String {
    let defs = defs_named(idx, name);
    if defs.is_empty() {
        return format!("tmap: no definition named {name} (try: tmap find {name})\n");
    }
    let callers = idx.files.iter().flat_map(|f| &f.calls).filter(|c| c.name == defs_name(&defs)).count();
    let mut out = String::new();
    for (f, i) in &defs {
        let s = &f.syms[*i];
        line(&mut out, f, s);
        let callees: HashSet<&str> = f.calls.iter().filter(|c| c.from == *i as u32).map(|c| c.name.as_str()).collect();
        let children: Vec<&str> = f.syms.iter().filter(|c| c.parent == *i as u32).map(|c| c.name.as_str()).collect();
        if !children.is_empty() {
            let _ = writeln!(out, "  members: {}", trunc_list(&children, 20));
        }
        if !callees.is_empty() {
            let mut v: Vec<&str> = callees.into_iter().collect();
            v.sort_unstable();
            let _ = writeln!(out, "  calls: {}", trunc_list(&v, 20));
        }
        if with_src {
            let text = std::fs::read_to_string(root.join(&f.path)).unwrap_or_default();
            let lines: Vec<&str> = text.lines().collect();
            let (a, b) = (s.start as usize - 1, (s.end as usize).min(lines.len()));
            let cap = 150;
            for l in &lines[a..b.min(a + cap)] {
                let _ = writeln!(out, "  {l}");
            }
            if b > a + cap {
                let _ = writeln!(out, "  [... {} more lines: Read {}:{}-{}]", b - a - cap, f.path, a + cap + 1, b);
            }
        }
    }
    let _ = writeln!(out, "  call sites named {}: {callers}", defs_name(&defs));
    out
}

fn defs_name(defs: &[(&FileEntry, usize)]) -> String {
    defs[0].0.syms[defs[0].1].name.clone()
}

fn trunc_list(v: &[&str], max: usize) -> String {
    if v.len() <= max {
        v.join(", ")
    } else {
        format!("{}, +{} more", v[..max].join(", "), v.len() - max)
    }
}

pub fn callers(idx: &Index, name: &str, limit: usize) -> String {
    let mut out = String::new();
    let mut n = 0;
    let mut seen = HashSet::new();
    for f in &idx.files {
        for c in f.calls.iter().filter(|c| c.name == name) {
            n += 1;
            let caller = (c.from != NONE).then(|| &f.syms[c.from as usize]);
            if !seen.insert((f.path.as_str(), c.from, c.line)) || seen.len() > limit {
                continue;
            }
            let _ = writeln!(out, "{}:{}  in {}", f.path, c.line, caller.map_or("(top level)".to_string(), |s| format!("{} {}", s.kind, s.name)));
        }
    }
    if n == 0 {
        return format!("tmap: no call sites named {name}\n");
    }
    if seen.len() > limit {
        let _ = writeln!(out, "(+{} more call sites)", seen.len() - limit);
    }
    out
}

pub fn callees(idx: &Index, name: &str) -> String {
    let defs = defs_named(idx, name);
    if defs.is_empty() {
        return format!("tmap: no definition named {name}\n");
    }
    let mut where_defined: HashMap<&str, (&str, u32, u32)> = HashMap::new();
    for f in &idx.files {
        for s in &f.syms {
            if s.kind != "impl" {
                where_defined.entry(s.name.as_str()).or_insert((f.path.as_str(), s.start, s.end));
            }
        }
    }
    let mut out = String::new();
    for (f, i) in defs {
        let s = &f.syms[i];
        let _ = writeln!(out, "{}:{}-{}  {}", f.path, s.start, s.end, s.sig);
        let mut names: Vec<&str> = f.calls.iter().filter(|c| c.from == i as u32).map(|c| c.name.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        let mut external = Vec::new();
        for n in names {
            match where_defined.get(n) {
                Some((p, a, b)) => {
                    let _ = writeln!(out, "  {n} -> {p}:{a}-{b}");
                }
                None => external.push(n),
            }
        }
        if !external.is_empty() {
            let _ = writeln!(out, "  external: {}", trunc_list(&external, 25));
        }
    }
    out
}

/// File outline: every definition, indented by nesting.
pub fn outline(f: &FileEntry) -> String {
    let mut out = format!("{} ({} lines)\n", f.path, f.lines);
    let depth_of = |mut i: usize| {
        let mut d = 0;
        while f.syms[i].parent != NONE {
            i = f.syms[i].parent as usize;
            d += 1;
        }
        d
    };
    for (i, s) in f.syms.iter().enumerate() {
        let sig = if s.sig.is_empty() { format!("{} {}", s.kind, s.name) } else { s.sig.clone() };
        let _ = writeln!(out, "{}{}-{} {}", "  ".repeat(depth_of(i) + 1), s.start, s.end, sig);
    }
    out
}

/// Top-level names of a file; types carry their member count (impl blocks merged into their type).
fn file_summary(f: &FileEntry, max: usize) -> String {
    if is_test_file(&f.path.to_lowercase()) {
        let n = f.syms.iter().filter(|s| matches!(s.kind.as_str(), "function" | "method")).count();
        return if n == 0 { "test file".into() } else { format!("test file ({n} fns)") };
    }
    let mut members: HashMap<&str, usize> = HashMap::new();
    for s in &f.syms {
        if s.parent != NONE {
            let p = &f.syms[s.parent as usize];
            *members.entry(p.name.as_str()).or_default() += 1;
        }
    }
    let mut seen = HashSet::new();
    let mut names = Vec::new();
    for s in f.syms.iter().filter(|s| s.parent == NONE) {
        let base = s.name.trim_start_matches(|c: char| !c.is_alphanumeric() && c != '_');
        let base = base.split(['<', ' ']).next().unwrap_or(base);
        let key = if s.kind == "impl" { base.rsplit(" for ").next().unwrap_or(base) } else { base };
        if !seen.insert(key.to_string()) {
            continue;
        }
        let n = members.get(s.name.as_str()).copied().unwrap_or(0)
            + f.syms.iter().filter(|o| o.kind == "impl" && o.name.split(['<', ' ']).next() == Some(key) && o.name != s.name).map(|o| members.get(o.name.as_str()).copied().unwrap_or(0)).sum::<usize>();
        let label = match s.kind.as_str() {
            "function" | "method" | "macro" => format!("{key}()"),
            _ if n > 0 => format!("{key}{{{n}}}"),
            _ => key.to_string(),
        };
        names.push(label);
    }
    // Cap by count and by length: long names (descriptive test-style) would flood the line.
    let mut line = String::new();
    let mut shown = 0;
    for n in &names {
        if shown == max || line.len() + n.len() > 160 {
            break;
        }
        if !line.is_empty() {
            line.push_str(", ");
        }
        line.push_str(n);
        shown += 1;
    }
    if shown < names.len() {
        line.push_str(&format!(", +{}", names.len() - shown));
    }
    line
}

pub fn tree(idx: &Index, prefix: &str, depth: usize) -> String {
    let prefix = prefix.trim_matches('/');
    if let Some(f) = idx.files.iter().find(|f| f.path == prefix) {
        return outline(f);
    }
    let under: Vec<&FileEntry> = idx
        .files
        .iter()
        .filter(|f| prefix.is_empty() || f.path == prefix || f.path.starts_with(&format!("{prefix}/")))
        .collect();
    if under.is_empty() {
        return format!("tmap: nothing indexed under {prefix}\n");
    }
    // dir -> files directly in it
    let mut dirs: BTreeMap<String, Vec<&FileEntry>> = BTreeMap::new();
    for f in &under {
        let rel = if prefix.is_empty() { f.path.as_str() } else { &f.path[prefix.len() + 1..] };
        let dir = rel.rsplit_once('/').map_or("", |(d, _)| d).to_string();
        dirs.entry(dir).or_default().push(f);
    }
    let syms: usize = under.iter().map(|f| f.syms.len()).sum();
    let mut out = format!("{}/ ({} files, {} symbols)\n", if prefix.is_empty() { "." } else { prefix }, under.len(), syms);
    // Totals for directories cut off at `depth`, shown as one line each.
    let mut collapsed: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for (dir, files) in &dirs {
        if !dir.is_empty() && dir.split('/').count() > depth {
            let top: String = dir.split('/').take(depth).collect::<Vec<_>>().join("/");
            let e = collapsed.entry(top).or_default();
            e.0 += files.len();
            e.1 += files.iter().map(|f| f.syms.len()).sum::<usize>();
        }
    }
    let base = if prefix.is_empty() { String::new() } else { format!("{prefix}/") };
    let mut printed: HashSet<String> = HashSet::new();
    for (dir, files) in &dirs {
        let segs: Vec<&str> = if dir.is_empty() { vec![] } else { dir.split('/').collect() };
        // Print each ancestor directory once, then either collapse or list files.
        for l in 1..=segs.len().min(depth) {
            let anc = segs[..l].join("/");
            if !printed.insert(anc.clone()) {
                continue;
            }
            let pad = "  ".repeat(l);
            match collapsed.get(&anc) {
                Some((nf, ns)) if l == depth => {
                    let own = dirs.get(&anc).map_or(0, |v| v.len());
                    let _ = writeln!(out, "{pad}{}/ ({} files, {} symbols below; tmap tree {base}{anc})", segs[l - 1], nf + own, ns + dirs.get(&anc).map_or(0, |v| v.iter().map(|f| f.syms.len()).sum::<usize>()));
                }
                _ => {
                    let _ = writeln!(out, "{pad}{}/", segs[l - 1]);
                }
            }
        }
        let level = segs.len();
        if level >= depth && collapsed.contains_key(&segs[..depth.min(level)].join("/")) || level > depth {
            continue;
        }
        let indent = "  ".repeat(level + 1);
        for f in files {
            let name = f.path.rsplit('/').next().unwrap_or(&f.path);
            let summary = file_summary(f, 12);
            if summary.is_empty() {
                let _ = writeln!(out, "{indent}{name}");
            } else {
                let _ = writeln!(out, "{indent}{name}: {summary}");
            }
        }
    }
    out
}
