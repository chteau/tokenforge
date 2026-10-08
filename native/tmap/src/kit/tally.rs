//! `tmap kit tally`: count / summarize text lines by regex key, field, file, or numeric stats.

use super::util::{die, read_stdin};
use regex::{Regex, RegexBuilder};
use std::collections::HashMap;
use std::path::Path;

const HELP: &str = "Count / summarize text without writing a script. Input: FILES/DIRS or stdin.

  tmap kit tally [opts] [PATH...]
  -e REGEX     key = capture group 1 (or whole match) of REGEX; lines without a match skipped
  -k N         key = whitespace field N (1-based; -1 = last)   -d DELIM  field delimiter
  -s           numeric stats of the key (n, sum, min, p50, p95, max, mean) instead of counts
  -g GLOB      with dirs: only files matching GLOB (default all text files), recursive
  -f           key = file name (count matching lines per file; combine with -e)
  -n TOP       show top N (default 25)    -i  ignore case
Default (no -e/-k): count identical lines. REGEX uses Rust syntax (no lookarounds / backreferences).

  tmap kit tally -e 'status=(\\d+)' app.log         tmap kit tally -k 1 access.log
  tmap kit tally -s -e 'took (\\d+)ms' logs/ -g '*.log'
  tmap kit tally -f -e 'TODO' src -g '*.ts'
";

const SKIP: &[&str] = &[".git", "node_modules", "target", "build", "dist", ".dart_tool", "__pycache__", ".venv", "venv"];

/// Compile a Python-style regex with the regex crate; unsupported constructs get a clear message.
pub fn compile(pat: &str, ci: bool, multi_line: bool) -> Result<Regex, String> {
    let p = pat.replace(r"\Z", r"\z");
    RegexBuilder::new(&p).case_insensitive(ci).multi_line(multi_line).build().map_err(|e| {
        let msg = e.to_string();
        let last = msg.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim().trim_start_matches("error: ");
        let py = ["(?=", "(?!", "(?<=", "(?<!"].iter().any(|s| pat.contains(s)) || Regex::new(r"\\[1-9]|\(\?P=").unwrap().is_match(pat);
        let hint = if py { " (lookarounds and backreferences are not supported: Rust regex syntax)" } else { "" };
        format!("bad regex: {last}{hint}")
    })
}

/// Python `float(s)`: surrounding whitespace, underscores between digits, inf/nan.
pub fn py_float_parse(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.contains('_') {
        let b = t.as_bytes();
        let ok = b.iter().enumerate().all(|(i, &c)| c != b'_' || (i > 0 && i + 1 < b.len() && b[i - 1].is_ascii_digit() && b[i + 1].is_ascii_digit()));
        return if ok { t.replace('_', "").parse().ok() } else { None };
    }
    let l = t.trim_start_matches(['+', '-']).to_ascii_lowercase();
    if l.starts_with("inf") && l != "inf" && l != "infinity" {
        return None;
    }
    t.parse().ok()
}

/// Python `format(x, f".{prec}g")`.
pub fn py_g(x: f64, prec: usize) -> String {
    if x.is_nan() {
        return "nan".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "inf".into() } else { "-inf".into() };
    }
    let p = prec.max(1);
    let e = format!("{:.*e}", p - 1, x);
    let (m, exp) = e.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    let strip = |s: String| if s.contains('.') { s.trim_end_matches('0').trim_end_matches('.').to_string() } else { s };
    if exp < -4 || exp >= p as i32 {
        format!("{}e{}{:02}", strip(m.to_string()), if exp < 0 { '-' } else { '+' }, exp.abs())
    } else {
        strip(format!("{:.*}", (p as i32 - 1 - exp).max(0) as usize, x))
    }
}

/// fnmatch-style glob (`*`, `?`, `[seq]`, `[!seq]`) as an anchored regex.
pub fn glob_re(g: &str) -> Regex {
    let mut r = String::from("^");
    let cs: Vec<char> = g.chars().collect();
    let mut i = 0;
    while i < cs.len() {
        match cs[i] {
            '*' => r.push_str(".*"),
            '?' => r.push('.'),
            '[' => match cs[i + 1..].iter().position(|&c| c == ']').map(|j| j + i + 1) {
                Some(j) if j > i + 1 => {
                    let body: String = cs[i + 1..j].iter().collect();
                    let body = body.replace('\\', r"\\");
                    r.push('[');
                    r.push_str(&body.strip_prefix('!').map(|b| format!("^{b}")).unwrap_or(body));
                    r.push(']');
                    i = j;
                }
                _ => r.push_str(r"\["),
            },
            c => r.push_str(&regex::escape(&c.to_string())),
        }
        i += 1;
    }
    r.push('$');
    RegexBuilder::new(&r).case_insensitive(cfg!(windows)).dot_matches_new_line(true).build().unwrap_or_else(|_| Regex::new("^$").unwrap())
}

#[derive(Default)]
pub struct Opts {
    pub e: Option<Regex>,
    pub k: Option<i64>,
    pub d: Option<String>,
    pub s: bool,
    pub f: bool,
}

#[derive(Default)]
pub struct Tally {
    pub keys: Vec<(String, usize)>,
    idx: HashMap<String, usize>,
    pub nums: Vec<f64>,
    pub lines: usize,
}

impl Tally {
    /// Feed one source (universal newlines, like Python text mode).
    pub fn feed(&mut self, o: &Opts, name: &str, text: &str) {
        super::util::note_raw(text.len());
        let text = text.replace("\r\n", "\n").replace('\r', "\n");
        for ln in text.split_inclusive('\n') {
            self.lines += 1;
            let ln = ln.strip_suffix('\n').unwrap_or(ln);
            let key = if let Some(rx) = &o.e {
                let Some(c) = rx.captures(ln) else { continue };
                if c.len() > 1 { c.get(1).map_or("", |m| m.as_str()) } else { c.get(0).unwrap().as_str() }
            } else if let Some(k) = o.k {
                let parts: Vec<&str> = match o.d.as_deref() {
                    Some(d) if !d.is_empty() => ln.split(d).collect(),
                    _ => ln.split_whitespace().collect(),
                };
                let i = if k > 0 { k - 1 } else if k < 0 { parts.len() as i64 + k } else { 0 };
                match usize::try_from(i).ok().and_then(|i| parts.get(i)) {
                    Some(p) => *p,
                    None => continue,
                }
            } else {
                ln
            };
            let key = if o.f { name } else { key };
            if o.s {
                if let Some(x) = py_float_parse(key) {
                    self.nums.push(x);
                }
            } else {
                match self.idx.get(key) {
                    Some(&i) => self.keys[i].1 += 1,
                    None => {
                        self.idx.insert(key.to_string(), self.keys.len());
                        self.keys.push((key.to_string(), 1));
                    }
                }
            }
        }
    }

    /// Report lines and exit code.
    pub fn report(mut self, s: bool, top: usize) -> (Vec<String>, i32) {
        if s {
            if self.nums.is_empty() {
                return (vec![format!("no numbers ({} lines read)", self.lines)], 1);
            }
            let n = &mut self.nums;
            n.sort_by(|a, b| a.total_cmp(b));
            let q = |p: f64| n[(n.len() - 1).min((p * n.len() as f64) as usize)];
            let sum: f64 = n.iter().sum();
            // Neumaier-compensated sum for the mean, close to Python's fsum-based fmean.
            let (mut t, mut c) = (0.0f64, 0.0f64);
            for &x in n.iter() {
                let y = t + x;
                c += if t.abs() >= x.abs() { (t - y) + x } else { (x - y) + t };
                t = y;
            }
            let mean = (t + c) / n.len() as f64;
            let line = format!(
                "n={} sum={} min={} p50={} p95={} max={} mean={}",
                n.len(),
                py_g(sum, 6),
                py_g(n[0], 6),
                py_g(q(0.5), 6),
                py_g(q(0.95), 6),
                py_g(n[n.len() - 1], 6),
                py_g(mean, 4)
            );
            return (vec![line], 0);
        }
        let tot: usize = self.keys.iter().map(|k| k.1).sum();
        let mut out = vec![format!("{tot} hits, {} distinct ({} lines read)", self.keys.len(), self.lines)];
        self.keys.sort_by_key(|k| std::cmp::Reverse(k.1)); // stable: ties keep first-seen order
        for (k, v) in self.keys.iter().take(top) {
            out.push(format!("{v:>7}  {}", k.chars().take(160).collect::<String>()));
        }
        if self.keys.len() > top {
            out.push(format!("   … {} more keys", self.keys.len() - top));
        }
        (out, 0)
    }
}

fn walk_dir(dir: &Path, glob: Option<&Regex>, out: &mut Vec<std::path::PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut ents: Vec<_> = rd.flatten().collect();
    ents.sort_by_key(|e| e.file_name());
    let mut dirs = vec![];
    for e in ents {
        let p = e.path();
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let name = e.file_name().to_string_lossy().into_owned();
        if is_dir {
            if !SKIP.contains(&name.as_str()) {
                dirs.push(p);
            }
        } else if glob.is_none_or(|g| g.is_match(&name)) {
            out.push(p);
        }
    }
    for d in dirs {
        walk_dir(&d, glob, out);
    }
}

pub fn main(args: Vec<String>) -> i32 {
    let mut a = args.into_iter();
    let (mut o, mut paths, mut top, mut ci, mut pat, mut glob) = (Opts::default(), vec![], 25usize, false, None, None);
    while let Some(x) = a.next() {
        match x.as_str() {
            "-h" | "--help" => {
                println!("{HELP}");
                return 0;
            }
            "-e" | "-k" | "-d" | "-g" | "-n" => {
                let v = a.next().unwrap_or_else(|| die("tally", &format!("{x} needs a value"), 2));
                let num = || v.trim().parse::<i64>().unwrap_or_else(|_| die("tally", &format!("{x}: not an integer: {v}"), 2));
                match x.as_str() {
                    "-e" => pat = Some(v),
                    "-k" => o.k = Some(num()),
                    "-d" => o.d = Some(v),
                    "-g" => glob = Some(glob_re(&v)),
                    _ => top = num().max(0) as usize,
                }
            }
            "-s" => o.s = true,
            "-f" => o.f = true,
            "-i" => ci = true,
            _ => paths.push(x),
        }
    }
    if let Some(p) = pat {
        o.e = Some(compile(&p, ci, false).unwrap_or_else(|e| die("tally", &e, 2)));
    }
    let mut t = Tally::default();
    if paths.is_empty() {
        t.feed(&o, "<stdin>", &read_stdin());
    }
    for p in &paths {
        let pp = Path::new(p);
        if pp.is_dir() {
            let mut files = vec![];
            walk_dir(pp, glob.as_ref(), &mut files);
            for f in files {
                // Binary (non-UTF-8) files in a dir walk are skipped.
                if let Ok(Ok(s)) = std::fs::read(&f).map(String::from_utf8) {
                    t.feed(&o, &f.to_string_lossy(), &s);
                }
            }
        } else {
            match std::fs::read(pp) {
                Ok(b) => t.feed(&o, p, &String::from_utf8_lossy(&b)),
                Err(e) => die("tally", &format!("{p}: {e}"), 2),
            }
        }
    }
    let (out, code) = t.report(o.s, top);
    println!("{}", out.join("\n"));
    code
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(o: &Opts, text: &str, s: bool) -> Vec<String> {
        let mut t = Tally::default();
        t.feed(o, "f", text);
        t.report(s, 2).0
    }

    #[test]
    fn counts_lines_and_ties() {
        let o = Opts::default();
        assert_eq!(run(&o, "b\na\nb\na\nc\n", false), vec!["5 hits, 3 distinct (5 lines read)", "      2  b", "      2  a", "   … 1 more keys"]);
        assert_eq!(run(&o, "", false), vec!["0 hits, 0 distinct (0 lines read)"]);
        assert_eq!(run(&o, "x\r\nx", false)[0], "2 hits, 1 distinct (2 lines read)");
    }

    #[test]
    fn regex_and_fields() {
        let o = Opts { e: Some(compile(r"status=(\d+)", false, false).unwrap()), ..Default::default() };
        assert_eq!(run(&o, "status=200\nnone\nstatus=500 status=1\nstatus=200\n", false)[1], "      2  200");
        let o = Opts { k: Some(-1), ..Default::default() };
        assert_eq!(run(&o, "a  b\nc b\n\n", false)[0], "2 hits, 1 distinct (3 lines read)");
        let o = Opts { k: Some(2), d: Some(",".into()), ..Default::default() };
        assert_eq!(run(&o, "x,,y\nz\n", false), vec!["1 hits, 1 distinct (2 lines read)", "      1  "]);
        let o = Opts { f: true, e: Some(compile("TODO", true, false).unwrap()), ..Default::default() };
        assert_eq!(run(&o, "todo\nno\n", false)[1], "      1  f");
    }

    #[test]
    fn stats_and_format() {
        let o = Opts { s: true, e: Some(compile(r"took (\d+)ms", false, false).unwrap()), ..Default::default() };
        let text: String = (1..=10).map(|i| format!("took {i}ms\n")).collect();
        assert_eq!(run(&o, &text, true), vec!["n=10 sum=55 min=1 p50=6 p95=10 max=10 mean=5.5"]);
        assert_eq!(run(&o, "x\n", true), vec!["no numbers (1 lines read)"]);
        assert_eq!(py_g(1234567.0, 6), "1.23457e+06");
        assert_eq!(py_g(0.00001234, 4), "1.234e-05");
        assert_eq!(py_g(2.0 / 3.0, 4), "0.6667");
        assert_eq!(py_g(100.0, 6), "100");
        assert_eq!(py_float_parse(" 1_000.5 "), Some(1000.5));
        assert_eq!(py_float_parse("1__0"), None);
        assert_eq!(py_float_parse("abc"), None);
    }

    #[test]
    fn regex_errors_and_glob() {
        let e = compile(r"(?<=a)b", false, false).unwrap_err();
        assert!(e.starts_with("bad regex:") && e.contains("lookarounds"), "{e}");
        assert!(compile(r"x\Z", false, false).unwrap().is_match("ax"));
        let g = glob_re("*.l[!x]g");
        assert!(g.is_match("app.log") && !g.is_match("app.lxg") && !g.is_match("a.log.gz"));
    }
}
