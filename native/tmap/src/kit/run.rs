//! `tmap kit run`: any command with its output squeezed: ANSI, progress bars and blank runs removed,
//! repeated lines collapsed, long output capped (head + tail), the full log kept in a file.

use super::util::{cache_home, cwd, die, run};
use regex::Regex;

const HELP: &str = "Run a command; print compact output.
  tmap kit run [--fuzzy] [-n LINES] [-e REGEX] CMD..
Strips colours and progress bars, collapses identical consecutive lines (\"line  (x N)\"; --fuzzy also
merges lines differing only in numbers, for logs), caps at LINES (default
TFORGE_RUN_MAX or 80: head, then tail), shows \"[exit N]\" when non-zero. -e keeps only matching lines.
When lines were cut, the full output is saved and its path printed (grep it instead of rerunning).";

fn max_lines() -> usize {
    std::env::var("TFORGE_RUN_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(80)
}

/// Clean lines: last `\r` segment, no ANSI, no progress/spinner lines, no blank runs.
pub fn clean(text: &str) -> Vec<String> {
    let ansi = Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07").unwrap();
    let bar = Regex::new(r"[█▓▒░⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|\[[=#>.\- ]{8,}\]|^\s*\d+(\.\d+)?%\s*$").unwrap();
    let mut out: Vec<String> = Vec::new();
    for raw in text.lines() {
        let seg = raw.rsplit('\r').find(|s| !s.is_empty()).unwrap_or("");
        let l = ansi.replace_all(seg, "");
        let l = l.trim_end();
        if bar.is_match(l) || (l.is_empty() && out.last().is_none_or(|p| p.is_empty())) {
            continue;
        }
        out.push(l.to_string());
    }
    while out.last().is_some_and(|l| l.is_empty()) {
        out.pop();
    }
    out
}

/// Consecutive equal lines (fuzzy: equal after masking numbers, for logs) become one with a count.
pub fn collapse(lines: Vec<String>, fuzzy: bool) -> Vec<String> {
    let num = Regex::new(r"\d+|0x[0-9a-fA-F]+").unwrap();
    let mut out: Vec<(String, String, usize)> = Vec::new();
    for l in lines {
        let key = if fuzzy { num.replace_all(&l, "#").into_owned() } else { l.clone() };
        match out.last_mut() {
            Some((k, _, n)) if *k == key && !l.is_empty() => *n += 1,
            _ => out.push((key, l, 1)),
        }
    }
    out.into_iter().map(|(_, l, n)| if n > 1 { format!("{l}  (x{n})") } else { l }).collect()
}

pub fn cap(lines: Vec<String>, max: usize, failed: bool, log: &str) -> Vec<String> {
    let n = lines.len();
    if n <= max {
        return lines;
    }
    let h = if failed { max / 5 } else { max / 3 };
    let t = max - h;
    let mut out = lines[..h].to_vec();
    out.push(format!("... [{} of {n} lines omitted; full output: {log}] ...", n - max));
    out.extend_from_slice(&lines[n - t..]);
    out
}

pub fn main(mut a: Vec<String>) -> i32 {
    if a.is_empty() || a[0] == "--help" || a[0] == "-h" {
        println!("{HELP}");
        return 0;
    }
    // only leading options are ours; later ones belong to the command
    let (mut max, mut filter, mut fuzzy) = (max_lines(), None, false);
    while a.len() > 1 && a[0] == "--fuzzy" {
        fuzzy = true;
        a.remove(0);
    }
    while a.len() > 1 && (a[0] == "-n" || a[0] == "-e") {
        let v = a.remove(1);
        if a.remove(0) == "-n" {
            max = v.parse().unwrap_or_else(|_| die("run", "-n needs a number", 2));
        } else {
            filter = Some(Regex::new(&v).unwrap_or_else(|e| die("run", &format!("bad regex: {e}"), 2)));
        }
    }
    if a.is_empty() {
        die("run", "no command", 2);
    }
    super::util::count_runs();
    let argv: Vec<&str> = a.iter().map(String::as_str).collect();
    let o = run(&argv, &cwd(), 1800, &[], None);
    let all = o.stdout + &o.stderr;
    let mut lines = clean(&all);
    if let Some(re) = &filter {
        lines.retain(|l| re.is_match(l));
    }
    let lines = collapse(lines, fuzzy);
    let mut log = String::new();
    if lines.len() > max {
        let dir = cache_home().join("tokenforge").join("run");
        let _ = std::fs::create_dir_all(&dir);
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
        let p = dir.join(format!("{t}.log"));
        if std::fs::write(&p, &all).is_ok() {
            log = p.to_string_lossy().into_owned();
        }
    }
    for l in cap(lines, max, o.code != 0, &log) {
        println!("{l}");
    }
    if o.code != 0 {
        println!("[exit {}]", o.code);
    }
    o.code
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn squeezes() {
        let c = clean("a\x1b[31mb\x1b[0m\n\n\n\rx\nProgress [=========>   ]\nend\n");
        assert_eq!(c, ["ab", "", "x", "end"]);
        let d = collapse(vec!["got 1".into(), "got 22".into(), "x".into()], true);
        assert_eq!(d, ["got 1  (x2)", "x"]);
    }

    #[test]
    fn caps_with_log() {
        let l: Vec<String> = (0..100).map(|i| format!("l{}", "x".repeat(i))).collect();
        let c = cap(l, 10, true, "/p");
        assert_eq!(c.len(), 11);
        assert!(c[2].contains("omitted") && c[2].contains("/p"));
    }
}
