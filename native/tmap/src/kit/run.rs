//! `tmap kit run`: any command with its output squeezed: ANSI, progress bars and blank runs removed,
//! repeated lines collapsed, long output capped (head + tail), the full log kept in a file.

use super::util::{cache_home, cwd, die, run};
use regex::Regex;

const HELP: &str = "Run a command; print compact output.
  tmap kit run [--fuzzy] [--group] [-n LINES] [-e REGEX] CMD..
Strips colours and progress bars, collapses identical consecutive lines (\"line  (x N)\"; --fuzzy also
merges lines differing only in numbers, for logs), caps at LINES (default
TFORGE_RUN_MAX or 80: head, then tail), shows \"[exit N]\" when non-zero. -e keeps only matching lines.
--group reads grep/rg --null output: each file's path once above its lines, lines over 500 chars cut.
When lines were cut, the full output is saved and its path printed (grep it instead of rerunning).";

const LONG_LINE: usize = 500;

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

/// grep/rg `--null` output (`path\0line`, `--` between context groups): each path once above its lines, or
/// `path:line` when it has one; `--` only within a file. Lines without a NUL pass through.
pub fn group(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur: Option<(&str, Vec<&str>)> = None;
    let (mut block, mut sep) = (false, false);
    for l in text.lines() {
        if l == "--" {
            sep = true;
            continue;
        }
        match l.split_once('\0') {
            Some((p, rest)) if cur.as_ref().is_some_and(|(c, _)| *c == p) => {
                let lines = &mut cur.as_mut().unwrap().1;
                if sep {
                    lines.push("--");
                }
                lines.push(rest.trim_end());
            }
            Some((p, rest)) => {
                flush(&mut out, cur.replace((p, vec![rest.trim_end()])), &mut block);
            }
            None => {
                flush(&mut out, cur.take(), &mut block);
                if block || (sep && !out.is_empty()) {
                    out.push(if block { String::new() } else { "--".into() });
                }
                block = false;
                out.push(l.trim_end().to_string());
            }
        }
        sep = false;
    }
    flush(&mut out, cur, &mut block);
    out
}

/// A file's lines: under a heading when several (blank lines around the block), else `path:line`.
fn flush(out: &mut Vec<String>, cur: Option<(&str, Vec<&str>)>, block: &mut bool) {
    let Some((path, lines)) = cur else { return };
    let multi = lines.len() > 1;
    if (multi || *block) && !out.is_empty() {
        out.push(String::new());
    }
    if multi {
        out.push(path.to_string());
        out.extend(lines.into_iter().map(String::from));
    } else {
        out.push(format!("{path}:{}", lines[0]));
    }
    *block = multi;
}

/// Lines over `max` chars end in `…[+N chars]`; true when any was cut.
pub fn cut(lines: &mut [String], max: usize) -> bool {
    let mut any = false;
    for l in lines.iter_mut() {
        if let Some((i, _)) = l.char_indices().nth(max) {
            let n = l[i..].chars().count();
            l.truncate(i);
            l.push_str(&format!("…[+{n} chars]"));
            any = true;
        }
    }
    any
}

/// The full output saved under the cache; its path, or "" when it could not be written.
pub fn save_log(text: &str) -> String {
    let dir = cache_home().join("tokenforge").join("run");
    let _ = std::fs::create_dir_all(&dir);
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let p = dir.join(format!("{t}.log"));
    if std::fs::write(&p, text).is_ok() { p.to_string_lossy().into_owned() } else { String::new() }
}

/// Head and tail of a long output. When the command failed, error lines from the omitted middle are kept too (up
/// to MID_ERRORS): the error that broke a build is often not the last thing it prints.
pub fn cap(lines: Vec<String>, max: usize, failed: bool, log: &str) -> Vec<String> {
    const MID_ERRORS: usize = 20;
    let n = lines.len();
    if n <= max {
        return lines;
    }
    let h = if failed { max / 5 } else { max / 3 };
    let t = max - h;
    let mut out = lines[..h].to_vec();
    out.push(format!("... [{} of {n} lines omitted; full output: {log}] ...", n - max));
    if failed {
        static ERR: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
        let re = ERR.get_or_init(|| Regex::new(r"(?i)\b(error|fatal|panic|exception|traceback|failed|failure)\b").unwrap());
        let mid: Vec<&String> = lines[h..n - t].iter().filter(|l| re.is_match(l)).collect();
        if !mid.is_empty() {
            let more = mid.len().saturating_sub(MID_ERRORS);
            out.push(format!("... [error lines among them{}:]", if more > 0 { format!(", first {MID_ERRORS} of {}", mid.len()) } else { String::new() }));
            out.extend(mid.into_iter().take(MID_ERRORS).cloned());
            out.push("... [end of omitted error lines]".into());
        }
    }
    out.extend_from_slice(&lines[n - t..]);
    out
}

pub fn main(mut a: Vec<String>) -> i32 {
    if a.is_empty() || a[0] == "--help" || a[0] == "-h" {
        println!("{HELP}");
        return 0;
    }
    // only leading options are ours; later ones belong to the command
    let (mut max, mut filter, mut fuzzy, mut grouped) = (max_lines(), None, false, false);
    while a.len() > 1 {
        match a[0].as_str() {
            "--fuzzy" => fuzzy = true,
            "--group" => grouped = true,
            "-n" => {
                let v = a.remove(1);
                max = v.parse().unwrap_or_else(|_| die("run", "-n needs a number", 2));
            }
            "-e" => {
                let v = a.remove(1);
                filter = Some(Regex::new(&v).unwrap_or_else(|e| die("run", &format!("bad regex: {e}"), 2)));
            }
            _ => break,
        }
        a.remove(0);
    }
    if a.is_empty() {
        die("run", "no command", 2);
    }
    super::util::count_runs();
    let argv: Vec<&str> = a.iter().map(String::as_str).collect();
    let o = run(&argv, &cwd(), 1800, &[], None);
    let all = o.stdout.clone() + &o.stderr;
    let mut lines = if grouped { [group(&o.stdout), clean(&o.stderr)].concat() } else { clean(&all) };
    if let Some(re) = &filter {
        lines.retain(|l| re.is_match(l));
    }
    let long = grouped && cut(&mut lines, LONG_LINE);
    let lines = collapse(lines, fuzzy);
    let omits = lines.len() > max;
    let log = if omits || long { save_log(&if grouped { all.replace('\0', ":") } else { all }) } else { String::new() };
    for l in cap(lines, max, o.code != 0, &log) {
        println!("{l}");
    }
    if long && !omits && !log.is_empty() {
        println!("[long lines cut; full output: {log}]");
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
    fn cap_keeps_errors_from_the_omitted_middle_of_a_failed_run() {
        let mut lines: Vec<String> = (0..3000).map(|i| format!("ok {i}")).collect();
        lines[1500] = "src/a.rs:3: error: mismatched types".into();
        lines.extend((0..100).map(|i| format!("cleanup {i}")));
        let out = cap(lines.clone(), 50, true, "LOG");
        assert!(out.iter().any(|l| l == "src/a.rs:3: error: mismatched types"), "{out:?}");
        assert!(out.len() <= 50 + 4, "{}", out.len());
        // a successful run is capped as before, and many errors are themselves capped
        assert!(!cap(lines.clone(), 50, false, "LOG").iter().any(|l| l.contains("mismatched")));
        let noisy: Vec<String> = (0..3000).map(|i| format!("error {i}")).collect();
        let out = cap(noisy, 50, true, "LOG");
        assert!(out.len() <= 50 + 23 && out.iter().any(|l| l.contains("first 20 of")), "{}", out.len());
    }

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

    #[test]
    fn groups_by_file() {
        let g = group("a.rs\x002:x\na.rs\x003-y  \n--\na.rs\x009:z\nb.rs\x001:w\n--\nc.rs\x004:v\nc.rs\x005:u\ngrep: d: Is a directory\n");
        assert_eq!(g, ["a.rs", "2:x", "3-y", "--", "9:z", "", "b.rs:1:w", "", "c.rs", "4:v", "5:u", "", "grep: d: Is a directory"]);
        assert_eq!(group("one\n--\ntwo\n"), ["one", "--", "two"]);
        let mut l = vec!["é".repeat(LONG_LINE + 7), "short".into()];
        assert!(cut(&mut l, LONG_LINE));
        assert_eq!(l, [format!("{}…[+7 chars]", "é".repeat(LONG_LINE)), "short".into()]);
    }
}
