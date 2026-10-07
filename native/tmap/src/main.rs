mod index;
mod query;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

const HELP: &str = "tmap: code map for coding agents. Find code by keyword instead of reading files.

Usage: tmap <command> [args] [-C DIR]

  find <words...>    ranked definitions: path:start-end  signature
      -n N             max results (default 15)
      --kind K         only this kind (function, method, struct, class, trait, ...)
      --in PATH        only under this path prefix
  tree [PATH]        map of folders, files and their top-level symbols; a file gives its outline
      -d N             folder depth before collapsing (default 3)
  sym <name>         definition, members, calls, call-site count (--src adds the source)
  slice <name>       path:start-end of each definition (for tforge plan reads)
  callers <name>     call sites: path:line  in <enclosing definition>
  callees <name>     what a definition calls, with where each callee is defined
  json               whole map as JSON: files (path, lines, symbols, top names) and file-to-file call edges
  index [--force]    build or refresh the index and print stats
  stats              index size and location

The index refreshes itself on every command: only changed files are re-parsed.
Languages: Rust, TypeScript/TSX, JavaScript, Python, Go.";

struct Args {
    cmd: String,
    pos: Vec<String>,
    dir: Option<PathBuf>,
    n: usize,
    depth: usize,
    kind: Option<String>,
    within: Option<String>,
    src: bool,
    force: bool,
}

fn parse_args() -> Result<Args, String> {
    let mut it = std::env::args().skip(1);
    let mut a = Args { cmd: String::new(), pos: vec![], dir: None, n: 15, depth: 3, kind: None, within: None, src: false, force: false };
    while let Some(x) = it.next() {
        let mut val = |name: &str| it.next().ok_or(format!("{name} needs a value"));
        match x.as_str() {
            "-C" => a.dir = Some(PathBuf::from(val("-C")?)),
            "-n" => a.n = val("-n")?.parse().map_err(|_| "-n needs a number")?,
            "-d" => a.depth = val("-d")?.parse().map_err(|_| "-d needs a number")?,
            "--kind" => a.kind = Some(val("--kind")?),
            "--in" => a.within = Some(val("--in")?.trim_start_matches("./").trim_end_matches('/').to_string()),
            "--src" => a.src = true,
            "--force" => a.force = true,
            "-h" | "--help" => a.cmd = "help".into(),
            "-V" | "--version" => a.cmd = "version".into(),
            _ if x.starts_with('-') && x.len() > 1 => return Err(format!("unknown option {x}")),
            _ if a.cmd.is_empty() => a.cmd = x,
            _ => a.pos.push(x),
        }
    }
    Ok(a)
}

/// Nearest ancestor containing .git, else the directory itself.
fn find_root(start: &Path) -> PathBuf {
    let start = start.canonicalize().unwrap_or_else(|_| start.to_path_buf());
    let mut cur = start.as_path();
    loop {
        if cur.join(".git").exists() {
            return cur.to_path_buf();
        }
        match cur.parent() {
            Some(p) => cur = p,
            None => return start,
        }
    }
}

/// A user-supplied path (relative to cwd or absolute) as a root-relative prefix.
fn rel_to_root(root: &Path, p: &str) -> String {
    let abs = std::env::current_dir().map(|c| c.join(p)).unwrap_or_else(|_| PathBuf::from(p));
    let abs = abs.canonicalize().unwrap_or(abs);
    match abs.strip_prefix(root) {
        Ok(r) => r.to_string_lossy().replace('\\', "/"),
        Err(_) => p.trim_start_matches("./").trim_end_matches('/').to_string(),
    }
}

fn run() -> Result<String, String> {
    let a = parse_args()?;
    match a.cmd.as_str() {
        "" | "help" => return Ok(format!("{HELP}\n")),
        "version" => return Ok(format!("tmap {}\n", env!("CARGO_PKG_VERSION"))),
        _ => {}
    }
    let base = a.dir.clone().unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let root = find_root(&base);
    let t0 = Instant::now();
    let (idx, stats) = index::refresh(&root, a.force).map_err(|e| format!("index: {e}"))?;
    let need = |what: &str| a.pos.first().cloned().ok_or(format!("{} needs {what}", a.cmd));
    Ok(match a.cmd.as_str() {
        "find" | "f" => {
            if a.pos.is_empty() {
                return Err("find needs keywords".into());
            }
            let within = a.within.as_deref().map(|w| rel_to_root(&root, w));
            query::find(&idx, &a.pos, &query::FindOpts { limit: a.n, kind: a.kind.as_deref(), within: within.as_deref() })
        }
        "tree" | "t" => {
            let p = a.pos.first().map(|p| rel_to_root(&root, p)).unwrap_or_default();
            query::tree(&idx, &p, a.depth.max(1))
        }
        "sym" | "s" => query::sym(&idx, &root, &need("a name")?, a.src),
        "slice" => query::slice(&idx, &need("a name")?),
        "callers" => query::callers(&idx, &need("a name")?, a.n.max(40)),
        "callees" => query::callees(&idx, &need("a name")?),
        "json" => query::json(&idx),
        "index" | "stats" => {
            let syms: usize = idx.files.iter().map(|f| f.syms.len()).sum();
            let calls: usize = idx.files.iter().map(|f| f.calls.len()).sum();
            format!(
                "{}: {} files, {} symbols, {} call sites; parsed {} changed file(s), dropped {} in {} ms\ncache: {}\n",
                root.display(),
                idx.files.len(),
                syms,
                calls,
                stats.parsed,
                stats.removed,
                t0.elapsed().as_millis(),
                index::cache_path(&root).display()
            )
        }
        other => return Err(format!("unknown command {other} (tmap --help)")),
    })
}

fn main() -> ExitCode {
    match run() {
        Ok(out) => {
            let _ = std::io::stdout().lock().write_all(out.as_bytes());
            if out.starts_with("tmap: no ") || out.starts_with("tmap: nothing") { ExitCode::from(1) } else { ExitCode::SUCCESS }
        }
        Err(e) => {
            eprintln!("tmap: {e}");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests;
