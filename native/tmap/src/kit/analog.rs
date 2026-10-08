//! `tmap kit analog`: locate AND read the nearest analog in one call (write mode).

use super::distill::cut;
use super::symctx::{self, block, last_def, read_lines, search};
use crate::index::Index;
use regex::Regex;
use std::path::{Component, Path, PathBuf};

const HELP: &str = "Locate AND read the nearest analog in one call (write mode).
  tmap kit analog LITERAL [LITERAL...]   e.g. tmap kit analog \"'/invoices/:id'\" invoiceTotal
For each literal: matching lines (source first, tests last, capped). Then for
up to 4 matched files: small files (<= TFORGE_SMALL lines, default 120) in full,
larger ones as a symbol outline plus the enclosing function of each match.
Excludes build/vendor/generated noise. Output capped (TFORGE_CAP, default 260 lines).
";

const SKIP: &[&str] = &["node_modules", "dist", "build", "target", "vendor", "coverage", ".git", ".codegraph", ".claude"];

fn skip_file(n: &str) -> bool {
    n.ends_with(".min.js") || n.ends_with(".lock")
}

fn is_test(p: &str) -> bool {
    Regex::new(r"(^|/)(test|tests|__tests__|spec)/|[._](test|spec)\.").unwrap().is_match(p)
}

/// Lexically normalise `p` (drop `.`, fold `dir/..`), '/'-separated.
fn clean(p: &Path) -> String {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir if matches!(out.components().next_back(), Some(Component::Normal(_))) => {
                out.pop();
            }
            c => out.push(c),
        }
    }
    out.to_string_lossy().replace('\\', "/")
}

/// One hop (JS/TS): identifiers on a matched line -> the relative modules they are imported from.
fn import_hop(hf: &str, txt: &str) -> Vec<String> {
    let ext = hf.rsplit('.').next().unwrap_or("");
    if !matches!(ext, "js" | "ts" | "jsx" | "tsx" | "mjs") {
        return vec![];
    }
    let src = read_lines(Path::new(hf));
    let mut ids: Vec<&str> = Regex::new(r"[A-Za-z_$][A-Za-z0-9_$]{3,}").unwrap().find_iter(txt).map(|m| m.as_str()).collect();
    ids.sort_unstable();
    ids.dedup();
    let from = Regex::new(r#".*from +['"]([^'"]+)['"]"#).unwrap();
    let dir = Path::new(hf).parent().unwrap_or(Path::new(""));
    let mut out = Vec::new();
    for id in ids {
        let re = Regex::new(&format!(r#"import[^;]*\b{}\b[^;]*from +['"]\.{{1,2}}/"#, regex::escape(id))).unwrap();
        let Some(imp) = src.iter().find(|l| re.is_match(l)).and_then(|l| from.captures(l)).map(|c| c[1].to_string()) else { continue };
        let cands = [imp.clone(), format!("{imp}.js"), format!("{imp}.ts"), format!("{imp}/index.js"), format!("{imp}/index.ts")];
        if let Some(c) = cands.iter().map(|c| dir.join(c)).find(|p| p.is_file()) {
            out.push(clean(&c));
        }
    }
    out
}

fn env_num(k: &str, d: usize) -> usize {
    std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d)
}

fn render(lits: &[String], small: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut files: Vec<String> = Vec::new();
    for lit in lits {
        let mut hits = search(Path::new("."), SKIP, &skip_file, &|l| l.contains(lit.as_str()), usize::MAX);
        hits.sort_by_key(|h| is_test(&h.path));
        hits.truncate(12);
        out.push(format!("## matches for: {lit}"));
        if hits.is_empty() {
            out.push("(none)".into());
            continue;
        }
        for h in &hits {
            out.push(cut(&format!("{}:{}:{}", h.path, h.line, h.text), 180));
            files.push(h.path.clone());
        }
        for h in hits.iter().take(4) {
            files.extend(import_hop(&h.path, &h.text));
        }
    }
    out.push(String::new());
    let mut seen = std::collections::HashSet::new();
    files.retain(|f| seen.insert(f.clone()));
    let def = Regex::new(r"^\s*(export\s+)?(async\s+)?(function|def|fn|func|class|pub fn|public|private|protected)\s").unwrap();
    let mut idx: Option<(PathBuf, Option<Index>)> = None;
    for f in files.iter().take(5) {
        if !Path::new(f).is_file() {
            continue;
        }
        let lines = read_lines(Path::new(f));
        let n = std::fs::read(f).map_or(0, |b| b.iter().filter(|&&c| c == b'\n').count());
        if n <= small {
            out.push(format!("## {f} ({n} lines, full)"));
            out.extend(lines.iter().enumerate().map(|(i, l)| format!("{}\t{l}", i + 1)));
            continue;
        }
        out.push(format!("## {f} ({n} lines: outline + enclosing functions of matches)"));
        let (root, ix) = idx.get_or_insert_with(|| {
            let r = symctx::index_root();
            let i = symctx::load_index(&r);
            (r, i)
        });
        out.extend(symctx::outline_text(root, ix.as_ref(), &symctx::root_rel(root, f), f, 40).lines().map(str::to_string));
        for lit in lits {
            for ln in lines.iter().enumerate().filter(|(_, l)| l.contains(lit.as_str())).take(2).map(|(i, _)| i + 1) {
                let d = match last_def(&lines, ln, &def) {
                    0 => ln,
                    d => d,
                };
                out.push(format!("-- {f}:{d}"));
                out.extend(block(&lines, d, None, 80, false));
            }
        }
    }
    out
}

pub fn main(args: Vec<String>) -> i32 {
    if args.is_empty() {
        print!("{HELP}");
        return 1;
    }
    if matches!(args[0].as_str(), "-h" | "--help") {
        print!("{HELP}");
        return 0;
    }
    let out = render(&args, env_num("TFORGE_SMALL", 120));
    for l in out.iter().take(env_num("TFORGE_CAP", 260)) {
        println!("{l}");
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_paths_sort_last() {
        assert!(is_test("test/a.js") && is_test("src/a.spec.ts") && is_test("x/__tests__/b.js") && is_test("a_test.go"));
        assert!(!is_test("src/contest.js"));
    }

    #[test]
    fn clean_folds_dots() {
        assert_eq!(clean(Path::new("src/./util.js")), "src/util.js");
        assert_eq!(clean(Path::new("src/a/../lib/x.ts")), "src/lib/x.ts");
        assert_eq!(clean(Path::new("../x.js")), "../x.js");
    }

    #[test]
    fn one_hop_resolves_relative_imports() {
        let d = std::env::temp_dir().join(format!("tforge-analog-{}", std::process::id()));
        std::fs::create_dir_all(d.join("lib")).unwrap();
        std::fs::write(d.join("lib/money.ts"), "export const fmtMoney = 1;\n").unwrap();
        std::fs::write(d.join("a.ts"), "import { fmtMoney } from './lib/money';\nconst x = fmtMoney(2);\n").unwrap();
        let hf = d.join("a.ts").to_string_lossy().into_owned();
        let got = import_hop(&hf, "const x = fmtMoney(2);");
        assert_eq!(got, vec![clean(&d.join("lib/money.ts"))]);
        assert!(import_hop("a.py", "fmtMoney").is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }
}
