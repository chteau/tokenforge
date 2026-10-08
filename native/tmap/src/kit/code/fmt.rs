//! `tmap kit fmt`: format only the files you changed (vs HEAD, plus untracked), per language.

use super::common::*;
use super::langs;
use crate::kit::util;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};

const HELP: &str = "Format only the files you changed (vs HEAD, plus untracked), with each language's formatter.

  tmap kit fmt [--check] [-a] [FILE...]
  --check  report files that would change, write nothing (exit 1 if any)
  -a       whole project instead of changed files
  FILE...  just these files

rs rustfmt (edition from Cargo.toml) | go gofmt | ts/js/json/css/md/yaml prettier or biome (project-local)
cs dotnet format whitespace | lua/luau stylua | dart dart format | py ruff format or black
java google-java-format | kotlin ktlint | c/c++ clang-format (only with a .clang-format) | php pint or
php-cs-fixer | ruby rubocop -a | swift swift-format/swiftformat | elixir mix format | zig zig fmt | scala scalafmt.
Prints only the files whose content changed.";

fn hash(f: &Path) -> Option<u64> {
    let b = std::fs::read(f).ok()?;
    let mut h = DefaultHasher::new();
    b.hash(&mut h);
    Some(h.finish())
}

fn ext(f: &Path) -> String {
    f.extension().map(|e| format!(".{}", e.to_string_lossy().to_lowercase())).unwrap_or_default()
}

/// Formatter group for a file: rs go web cs luau dart py, or a `langs` stack.
pub fn group(f: &Path) -> Option<&'static str> {
    let e = ext(f);
    Some(match e.as_str() {
        ".rs" => "rs",
        ".go" => "go",
        ".ts" | ".tsx" | ".js" | ".jsx" | ".mjs" | ".cjs" | ".json" | ".css" | ".scss" | ".md" | ".yaml" | ".yml" | ".html" | ".vue"
        | ".svelte" => "web",
        ".cs" => "cs",
        ".lua" | ".luau" => "luau",
        ".dart" => "dart",
        ".py" | ".pyi" => "py",
        _ => return langs::for_ext(&e),
    })
}

/// Rust edition from the nearest Cargo.toml above `f` (default 2021).
fn edition(f: &Path) -> String {
    for d in f.ancestors().skip(1) {
        let c = d.join("Cargo.toml");
        if c.exists() {
            if let Some(m) = re!(r#"edition\s*=\s*"(\d+)""#).captures(&read(&c)) {
                return g(&m, 1).to_string();
            }
        }
    }
    "2021".into()
}

fn args(base: Vec<String>, files: &[PathBuf]) -> Vec<String> {
    let mut v = base;
    v.extend(files.iter().map(|f| s(f)));
    v
}

pub fn main(a: Vec<String>) -> i32 {
    if a.iter().any(|x| x == "-h" || x == "--help") {
        println!("{HELP}");
        return 0;
    }
    let check = a.iter().any(|x| x == "--check");
    let allf = a.iter().any(|x| x == "-a");
    let mut files: Vec<PathBuf> = a.iter().filter(|x| !x.starts_with('-')).map(|f| abspath(Path::new(f))).collect();
    let (root, _) = find_root(Path::new("."), None);
    let top = util::git_root(Path::new(".")).or_else(|| root.clone()).unwrap_or_else(util::cwd);
    let base = root.clone().unwrap_or_else(|| top.clone());
    if files.is_empty() {
        files = if allf { walk_files(&base, "*", SKIP_DIRS, false) } else { changed_files(&top) };
    }
    files.retain(|f| f.is_file());
    if files.is_empty() {
        println!("fmt: no changed files");
        return 0;
    }
    let mut groups: OrdMap<&str, Vec<PathBuf>> = OrdMap::default();
    for f in &files {
        if let Some(k) = group(f) {
            groups.entry(k, Vec::new).push(f.clone());
        }
    }
    let before: Vec<Option<u64>> = files.iter().map(|f| hash(f)).collect();
    let (mut notes, mut would): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
    let ctx = Ctx { root: base.clone(), ..Default::default() };
    for (k, fs) in &groups.items {
        match *k {
            "rs" => {
                let Some(rf) = exe("rustfmt", None) else {
                    notes.push("rustfmt missing".into());
                    continue;
                };
                let mut eds: Vec<String> = fs.iter().map(|f| edition(f)).collect();
                eds.sort();
                eds.dedup();
                for ed in eds {
                    let sub: Vec<PathBuf> = fs.iter().filter(|f| edition(f) == ed).cloned().collect();
                    let mut c = vec![rf.clone(), "--edition".into(), ed];
                    if check {
                        c.extend(["--check".into(), "-l".into()]);
                    }
                    let o = run(&args(c, &sub), &base, 900);
                    if check {
                        would.extend(o.stdout.lines().filter(|l| !l.trim().is_empty()).map(str::to_string));
                    }
                }
            }
            "go" => {
                let Some(gf) = exe("gofmt", None) else {
                    notes.push("gofmt missing".into());
                    continue;
                };
                let mut c = vec![gf, "-l".into()];
                if !check {
                    c.push("-w".into());
                }
                let o = run(&args(c, fs), &base, 900);
                if check {
                    would.extend(o.stdout.split_whitespace().map(str::to_string));
                }
            }
            "web" => {
                let (pr, bi) = (exe("prettier", Some(&base)), exe("biome", Some(&base)));
                if base.join("biome.json").exists() || base.join("biome.jsonc").exists() {
                    let Some(bi) = bi else {
                        notes.push("biome config but biome not installed".into());
                        continue;
                    };
                    let mut c = vec![bi, "format".into()];
                    if !check {
                        c.push("--write".into());
                    }
                    let o = run(&args(c, fs), &base, 900);
                    if check {
                        let text = format!("{}{}", o.stdout, o.stderr);
                        let hit = |f: &PathBuf| {
                            let r = relpath(f, &base);
                            text.contains(&r) || text.contains(&r.replace('\\', "/"))
                        };
                        would.extend(fs.iter().filter(|f| hit(f)).map(|f| s(f)));
                    }
                } else if let Some(pr) = pr {
                    let mode = if check { "--list-different" } else { "--write" };
                    let c = vec![pr, mode.into(), "--log-level".into(), "warn".into(), "--ignore-unknown".into()];
                    let o = run(&args(c, fs), &base, 900);
                    if check {
                        would.extend(o.stdout.split_whitespace().map(str::to_string));
                    }
                } else {
                    notes.push("no project-local prettier/biome: web files skipped".into());
                }
            }
            "cs" => {
                let Some(dn) = exe("dotnet", None) else {
                    notes.push("dotnet missing".into());
                    continue;
                };
                let has_proj = std::fs::read_dir(&base)
                    .map(|r| r.flatten().any(|e| [".sln", ".slnx", ".csproj"].iter().any(|x| e.file_name().to_string_lossy().ends_with(x))))
                    .unwrap_or(false);
                let mut c = vec![dn, "format".into(), "whitespace".into()];
                if !has_proj {
                    c.push("--folder".into());
                }
                c.push("--include".into());
                let mut c = args(c, fs);
                if check {
                    c.push("--verify-no-changes".into());
                }
                let o = run(&c, &base, 900);
                if check && o.code != 0 {
                    would.extend(fs.iter().map(|f| s(f)));
                }
            }
            "luau" => {
                let Some(st) = exe("stylua", None) else {
                    notes.push("stylua missing: .lua/.luau skipped".into());
                    continue;
                };
                let mut c = vec![st];
                if check {
                    c.push("--check".into());
                }
                let o = run(&args(c, fs), &base, 900);
                if check {
                    let mut v: Vec<String> = re!(r"Diff in (\S+?):").captures_iter(&o.stdout).map(|m| g(&m, 1).to_string()).collect();
                    v.sort();
                    v.dedup();
                    would.extend(v);
                }
            }
            "dart" => {
                let Some(dt) = exe("dart", None) else {
                    notes.push("dart missing".into());
                    continue;
                };
                let mut c = vec![dt, "format".into()];
                if check {
                    c.extend(["--output=none".into(), "--set-exit-if-changed".into()]);
                }
                let o = run(&args(c, fs), &base, 900);
                if check {
                    would.extend(re!(r"Changed (\S+)").captures_iter(&o.stdout).map(|m| g(&m, 1).to_string()));
                }
            }
            "py" => {
                let c = if let Some(rf) = exe("ruff", None) {
                    vec![rf, "format".into()]
                } else if let Some(bl) = exe("black", None) {
                    vec![bl, "-q".into()]
                } else {
                    notes.push("no ruff/black: .py skipped".into());
                    continue;
                };
                let mut c = c;
                if check {
                    c.push("--check".into());
                }
                let o = run(&args(c, fs), &base, 900);
                if check {
                    let text = format!("{}{}", o.stdout, o.stderr);
                    would.extend(re!(r"Would reformat:? (\S+)").captures_iter(&text).map(|m| g(&m, 1).to_string()));
                }
            }
            other => match langs::get(other) {
                Some(l) => {
                    let (w, n) = (l.fmt)(&ctx, fs, check);
                    would.extend(w);
                    notes.extend(n);
                }
                None => notes.push(format!("{other} formatter not ported to tmap kit yet: {} file(s) skipped", fs.len())),
            },
        }
    }
    for n in &notes {
        println!("note: {n}");
    }
    if check {
        let mut w: Vec<String> = would
            .iter()
            .filter(|x| !x.trim().is_empty())
            .map(|x| relcwd(if Path::new(x).is_absolute() { PathBuf::from(x) } else { base.join(x) }))
            .collect();
        w.sort();
        w.dedup();
        if w.is_empty() {
            let tail = if notes.is_empty() { format!(" ({} files)", files.len()) } else { " in the files that have a formatter (see notes)".into() };
            println!("fmt: no changes needed{tail}");
        } else {
            println!("{}", w.join("\n"));
        }
        return i32::from(!w.is_empty());
    }
    let ch: Vec<String> = files.iter().zip(&before).filter(|(f, b)| hash(f) != **b).map(|(f, _)| relcwd(f)).collect();
    if ch.is_empty() {
        let tail = if notes.is_empty() { format!(" ({} files already formatted)", files.len()) } else { " (some files skipped, see notes)".into() };
        println!("fmt: nothing changed{tail}");
    } else {
        println!("formatted: {}", ch.join(", "));
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_and_pending() {
        assert_eq!(group(Path::new("a/b.RS")), Some("rs"));
        assert_eq!(group(Path::new("x.tsx")), Some("web"));
        assert_eq!(group(Path::new("x.pyi")), Some("py"));
        assert_eq!(group(Path::new("x.kt")), Some("java"));
        assert_eq!(group(Path::new("x.hpp")), Some("cpp"));
        assert_eq!(group(Path::new("x.txt")), None);
    }
}
