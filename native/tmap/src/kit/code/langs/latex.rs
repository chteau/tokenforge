//! LaTeX: build with latexmk / tectonic / pdflatex and keep only what needs fixing from the log:
//! errors (file:line from `l.NN` or -file-line-error), undefined references and citations,
//! multiply-defined labels, missing files, and the worst overfull/underfull boxes.

use super::super::common::{exe, g, glob, gn, newest, re, read, rel, run, s, tail, Ctx, Diags};
use super::Lang;
use crate::kit::util::die;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub const LANG: Lang = Lang { name: "latex", fmt_ext: &[], check, test, deps, proj, fmt };

/// Overfull boxes narrower than this (pt) are ignored.
const OVERFULL_PT: f64 = 1.0;
/// Underfull hboxes below this badness are ignored (10000 = TeX's "infinitely bad").
const UNDERFULL_BADNESS: u32 = 10000;
/// Boxes listed by location; the rest only counted.
const BOXES_SHOWN: usize = 5;

/// True when `d` holds a LaTeX project: latexmkrc / Tectonic.toml, or a top-level .tex with \documentclass.
pub fn is_project(d: &Path) -> bool {
    ["latexmkrc", ".latexmkrc", "Tectonic.toml"].iter().any(|f| d.join(f).is_file()) || !main_files(d).is_empty()
}

/// Top-level .tex files with an uncommented \documentclass, main.tex first.
pub fn main_files(d: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = glob(d.join("*.tex"))
        .into_iter()
        .filter(|p| read(p).lines().take(400).any(|l| l.split('%').next().is_some_and(|c| c.contains("\\documentclass"))))
        .collect();
    v.sort_by_key(|p| (p.file_stem().is_none_or(|n| n != "main"), p.clone()));
    v
}

// ---------- log parsing ----------

#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    /// As written in the log (`./main.tex`), "" when unknown.
    pub file: String,
    pub line: usize,
    /// "E" or "W".
    pub sev: &'static str,
    pub code: &'static str,
    pub msg: String,
    pub extra: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BoxWarn {
    pub overfull: bool,
    pub file: String,
    pub line: usize,
    pub msg: String,
}

#[derive(Debug, Default)]
pub struct TexLog {
    pub items: Vec<Item>,
    /// Boxes over the thresholds, in log order.
    pub boxes: Vec<BoxWarn>,
    /// From "Output written on x.pdf (N pages, …)".
    pub pages: Option<usize>,
    /// LaTeX asked for another run (labels changed, undefined references on a first pass).
    pub rerun: bool,
    /// Citations are undefined or the .bbl is missing: bibtex/biber has to run.
    pub needs_bib: bool,
    /// biblatex asked for biber (rather than bibtex).
    pub biber: bool,
}

/// TeX wraps log lines at `max_print_line` (79): join a full-width line with the next one.
pub fn unwrap_lines(text: &str) -> Vec<String> {
    let starts_msg = |l: &str| {
        ["! ", "LaTeX ", "Package ", "Class ", "Overfull ", "Underfull ", "l."].iter().any(|p| l.starts_with(p))
    };
    let mut out: Vec<String> = Vec::new();
    let mut joining = false;
    for l in text.lines() {
        let l = l.trim_end_matches('\r');
        match out.last_mut() {
            Some(last) if joining && !starts_msg(l) => last.push_str(l),
            _ => out.push(l.to_string()),
        }
        joining = l.len() == 79 || l.chars().count() == 79;
    }
    out
}

/// Strip `./` and normalise separators for display.
fn clean_file(f: &str) -> String {
    let f = f.trim_matches('"');
    f.strip_prefix("./").unwrap_or(f).replace('\\', "/")
}

/// A `(token` that names a file being opened.
fn is_file_token(t: &str) -> bool {
    if t.is_empty() || t.len() > 400 {
        return false;
    }
    let t = t.trim_matches('"');
    let path_like = t.starts_with('/') || t.starts_with("./") || t.starts_with("../") || t.contains('/') || t.contains('\\');
    let ext = re!(r"\.[A-Za-z][A-Za-z0-9]{0,7}$").is_match(t);
    ext || (path_like && t.len() > 2)
}

/// Feed one log line through the open-file stack: `(file` pushes, `)` pops.
fn scan_parens(line: &str, stack: &mut Vec<Option<String>>) {
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'(' => {
                let rest = &line[i + 1..];
                let end = rest.find(|c: char| c.is_whitespace() || c == '(' || c == ')').unwrap_or(rest.len());
                let tok = &rest[..end];
                stack.push(is_file_token(tok).then(|| clean_file(tok)));
                i += 1 + end;
            }
            b')' => {
                stack.pop();
                i += 1;
            }
            _ => i += 1,
        }
    }
}

fn current(stack: &[Option<String>]) -> String {
    stack.iter().rev().find_map(|x| x.clone()).unwrap_or_default()
}

/// Parse a pdflatex / xelatex / lualatex log (classic `! msg … l.NN` or -file-line-error style).
pub fn parse_log(text: &str) -> TexLog {
    let lines = unwrap_lines(text);
    let mut log = TexLog::default();
    let mut stack: Vec<Option<String>> = Vec::new();
    // Lines whose parentheses are not file opens (error context and help, box contents).
    let mut quiet_until = 0usize;
    let fle = re!(r"^(.*?\.(?:tex|sty|cls|bib|bbl|ltx|dtx|def|cfg|clo|aux|toc|fd|inc|tikz|pgf)):(\d+): (.*)$");
    let lnum = re!(r"^l\.(\d+) ?(.*)$");
    let quoted = r"[`'‘]([^'’]*)['’]";
    let ref_rx = super::super::common::compile(&format!(r"(Reference|Citation) {quoted} on page \S+ undefined(?: on input line (\d+))?"));
    let multi_rx = super::super::common::compile(&format!(r"Label {quoted} multiply defined"));
    let file_w_rx = super::super::common::compile(&format!(r"File {quoted} not found(?: on input line (\d+))?"));
    let missing_e = super::super::common::compile(&format!(r"File {quoted} not found"));
    let box_rx = re!(
        r"^(Overfull|Underfull) \\([hv])box \((?:([\d.]+)pt too (?:wide|high)|badness (\d+))\) (?:(?:in paragraph|in alignment) at lines (\d+)--(\d+)|detected at line (\d+)|has occurred while \\output is active)?"
    );
    let warn_rx = re!(r"^(?:LaTeX|Package ([\w.-]+)|Class ([\w.-]+)) Warning: (.*)$");
    let mut i = 0;
    while i < lines.len() {
        let l = lines[i].as_str();
        let here = i;
        i += 1;
        // ---- errors ----
        let fle_m = fle.captures(l);
        if l.starts_with("! ") || fle_m.is_some() {
            let (mut file, mut line, msg) = match &fle_m {
                Some(m) => (clean_file(g(m, 1)), gn(m, 2), g(m, 3).to_string()),
                None => (current(&stack), 0, l[2..].to_string()),
            };
            // the `l.NN source` line that locates it (may follow an Emergency stop)
            let mut extra = None;
            let mut j = here + 1;
            while j < lines.len() && j < here + 30 {
                let n = lines[j].as_str();
                if let Some(m) = lnum.captures(n) {
                    if line == 0 {
                        line = gn(&m, 1);
                    }
                    let src = g(&m, 2).trim();
                    if !src.is_empty() {
                        extra = Some(format!("at: {}", super::super::common::trunc(src, 120)));
                    }
                    break;
                }
                if (n.starts_with("! ") && !n.starts_with("! Emergency stop")) || fle.is_match(n) {
                    break;
                }
                j += 1;
            }
            // context, the source line and the help text that follows (up to a blank line) are not file opens
            let mut k = j + 1;
            while k < lines.len() && k < j + 15 && !lines[k].trim().is_empty() {
                k += 1;
            }
            quiet_until = quiet_until.max(k);
            let msg = msg.trim().to_string();
            let fatal_tail = msg.starts_with("==>") || msg.contains("==> Fatal error occurred");
            let emergency = msg.starts_with("Emergency stop") || msg.starts_with("Job aborted");
            if fatal_tail || (emergency && log.items.iter().any(|x| x.sev == "E")) {
                continue;
            }
            if file.is_empty() && line == 0 {
                file = current(&stack);
            }
            let code = if missing_e.is_match(&msg) { "missing-file" } else { "error" };
            log.items.push(Item { file, line, sev: "E", code, msg, extra });
            continue;
        }
        // ---- warnings ----
        if let Some(m) = warn_rx.captures(l) {
            let pkg = if !g(&m, 1).is_empty() { g(&m, 1) } else { g(&m, 2) };
            let mut msg = g(&m, 3).to_string();
            // continuation lines: `(natbib)    text` or indented
            while i < lines.len() {
                let n = lines[i].as_str();
                let cont = (!pkg.is_empty() && n.starts_with(&format!("({pkg})"))) || (n.starts_with("               ") && !n.trim().is_empty());
                if !cont {
                    break;
                }
                let t = n.strip_prefix(&format!("({pkg})")).unwrap_or(n);
                msg.push(' ');
                msg.push_str(t.trim());
                i += 1;
            }
            // a `(natbib)` prefix can also end up mid-line when TeX wrapped the line before it at 79
            let msg = if pkg.is_empty() { msg } else { msg.replace(&format!("({pkg})"), " ") };
            let msg = super::super::common::ws(&msg);
            if let Some(r) = ref_rx.captures(&msg) {
                let cite = g(&r, 1) == "Citation";
                if cite {
                    log.needs_bib = true;
                }
                log.items.push(Item {
                    file: current(&stack),
                    line: gn(&r, 3),
                    sev: "W",
                    code: if cite { "undefined-cite" } else { "undefined-ref" },
                    msg: format!("{} `{}' undefined", if cite { "citation" } else { "reference" }, g(&r, 2)),
                    extra: None,
                });
            } else if let Some(r) = multi_rx.captures(&msg) {
                log.items.push(Item {
                    file: String::new(),
                    line: 0,
                    sev: "W",
                    code: "multiply-defined",
                    msg: format!("label `{}' multiply defined", g(&r, 1)),
                    extra: None,
                });
            } else if let Some(r) = file_w_rx.captures(&msg) {
                log.items.push(Item {
                    file: current(&stack),
                    line: gn(&r, 2),
                    sev: "W",
                    code: "missing-file",
                    msg: format!("file `{}' not found", g(&r, 1)),
                    extra: None,
                });
            } else if msg.contains("Rerun to get") || msg.contains("may have changed") {
                log.rerun = true;
            } else if msg.contains("There were undefined citations") {
                log.needs_bib = true;
            } else if msg.contains("There were undefined references") {
                log.rerun = true;
            } else if msg.contains("run Biber") || msg.contains("rerun Biber") {
                log.needs_bib = true;
                log.biber = true;
            } else if pkg == "biblatex" && msg.contains("rerun LaTeX") {
                log.rerun = true;
            }
            continue;
        }
        // ---- boxes ----
        if let Some(m) = box_rx.captures(l) {
            let over = g(&m, 1) == "Overfull";
            let pt: f64 = g(&m, 3).parse().unwrap_or(0.0);
            let bad: u32 = g(&m, 4).parse().unwrap_or(0);
            let keep = if over { pt > OVERFULL_PT } else { g(&m, 2) == "h" && bad >= UNDERFULL_BADNESS };
            if keep {
                let line = [5, 7].iter().map(|k| gn(&m, *k)).find(|n| *n > 0).unwrap_or(0);
                let what = if over { format!("{pt}pt too {}", if g(&m, 2) == "h" { "wide" } else { "high" }) } else { format!("badness {bad}") };
                log.boxes.push(BoxWarn { overfull: over, file: current(&stack), line, msg: format!("\\{}box ({what})", g(&m, 2)) });
            }
            // the box contents (`[]\OT1/cmr/m/n/10 text (…`) run to the next blank line
            let mut k = i;
            while k < lines.len() && k < i + 40 && !lines[k].trim().is_empty() {
                k += 1;
            }
            quiet_until = quiet_until.max(k);
            continue;
        }
        // ---- output / missing aux files ----
        if let Some(m) = re!(r"Output written on .*?\((\d+) pages?").captures(l) {
            log.pages = Some(gn(&m, 1));
            continue;
        }
        if l.starts_with("No pages of output") {
            log.pages = Some(0);
            continue;
        }
        if let Some(m) = re!(r"^No file (.+?)\.$").captures(l) {
            let f = g(&m, 1);
            let ext = f.rsplit('.').next().unwrap_or("").to_lowercase();
            if ext == "bbl" {
                log.needs_bib = true;
                log.items.push(Item {
                    file: String::new(),
                    line: 0,
                    sev: "W",
                    code: "missing-file",
                    msg: format!("no {f}: run bibtex/biber"),
                    extra: None,
                });
            } else if matches!(ext.as_str(), "ind" | "gls" | "nls") {
                log.items.push(Item { file: String::new(), line: 0, sev: "W", code: "missing-file", msg: format!("no {f}"), extra: None });
            }
            // .aux, .toc, .lof, .out, … are normal on a first pass
            continue;
        }
        if here >= quiet_until {
            scan_parens(l, &mut stack);
        }
    }
    log
}

/// `\label{name}` locations in the project's .tex files, as `file:line`.
fn label_sites(root: &Path, name: &str) -> Vec<String> {
    let needle = format!("\\label{{{name}}}");
    let mut out = Vec::new();
    for f in crate::kit::code::common::walk_files(root, "*.tex", crate::kit::code::common::SKIP_DIRS, false) {
        for (n, l) in read(&f).lines().enumerate() {
            if l.split('%').next().is_some_and(|c| c.contains(&needle)) {
                out.push(format!("{}:{}", rel(&s(&f), root), n + 1));
            }
        }
    }
    out
}

/// Path of a file named in the log, relative to `base` (where the engine ran) unless absolute.
/// Tectonic logs `\input{sections/body}` as `(sections/body`: add the `.tex` back.
fn log_path(base: &Path, f: &str) -> String {
    if f.is_empty() {
        return String::new();
    }
    let p = base.join(f);
    if p.extension().is_none() && !p.exists() && p.with_extension("tex").is_file() {
        return s(&p.with_extension("tex"));
    }
    s(&p)
}

/// Add a parsed log to `d`; returns the page count when a PDF was written.
pub fn report(d: &mut Diags, log: &TexLog, base: &Path, root: &Path) {
    for it in &log.items {
        let mut extra = it.extra.clone();
        if it.code == "multiply-defined" {
            let name = it.msg.split(['`', '\'']).nth(1).unwrap_or("");
            let sites = label_sites(root, name);
            if !sites.is_empty() {
                extra = Some(format!("defined at {}", sites.join(", ")));
            }
        }
        d.add(&log_path(base, &it.file), it.line, 0, it.sev, it.code, &it.msg, extra);
    }
    if !log.boxes.is_empty() {
        d.notes.push(format!(
            "{} overfull/underfull boxes (overfull > {OVERFULL_PT}pt, underfull badness {UNDERFULL_BADNESS}){}",
            log.boxes.len(),
            if log.boxes.len() > BOXES_SHOWN { format!(", first {BOXES_SHOWN} below") } else { String::new() }
        ));
        for b in log.boxes.iter().take(BOXES_SHOWN) {
            let code = if b.overfull { "overfull" } else { "underfull" };
            d.add(&log_path(base, &b.file), b.line, 0, "I", code, &b.msg, None);
        }
    }
}

// ---------- build ----------

/// `$out_dir` / `$aux_dir` from a latexmkrc.
fn rc_dirs(rc: &str) -> Vec<String> {
    re!(r#"\$(?:out|aux)_dir\s*=\s*['"]([^'"]+)['"]"#).captures_iter(rc).map(|m| g(&m, 1).to_string()).collect()
}

fn latexmkrc(root: &Path) -> String {
    ["latexmkrc", ".latexmkrc"].iter().map(|f| read(root.join(f))).collect::<Vec<_>>().join("\n")
}

/// The log of `stem`: next to it or in the latexmkrc out/aux dir; else the newest log written by this build.
fn find_logs(root: &Path, stems: &[String], dirs: &[String], since: SystemTime, ok: bool) -> Vec<PathBuf> {
    let fresh = |p: &Path| p.metadata().and_then(|m| m.modified()).is_ok_and(|t| t + std::time::Duration::from_secs(1) >= since);
    let mut out = Vec::new();
    for st in stems {
        let cands = std::iter::once(root.to_path_buf()).chain(dirs.iter().map(|d| root.join(d)));
        // an up-to-date latexmk run leaves the previous (still valid) log; a failed run must not report a stale one
        if let Some(p) = cands.map(|d| d.join(format!("{st}.log"))).find(|p| p.is_file() && (ok || fresh(p))) {
            out.push(p);
        }
    }
    if out.is_empty() {
        let pats: Vec<String> = ["*.log", "*/*.log", "*/*/*.log"].iter().map(|p| s(&root.join(p))).collect();
        let mut v = newest(&pats, since);
        v.retain(|p| !p.to_string_lossy().contains("missfont"));
        v.sort_by_key(|p| std::cmp::Reverse(p.metadata().and_then(|m| m.modified()).ok()));
        out.extend(v.into_iter().take(1));
    }
    out
}

fn stem(p: &Path) -> String {
    p.file_stem().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default()
}

fn name(p: &Path) -> String {
    p.file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default()
}

fn check(ctx: &Ctx, d: &mut Diags, used: &mut Vec<String>) {
    let root = &ctx.root;
    let mains = main_files(root);
    let rc = latexmkrc(root);
    let mut dirs = rc_dirs(&rc);
    let start = SystemTime::now();
    let mut output = String::new();
    let mut code = 0;
    let stems: Vec<String> = mains.iter().map(|p| stem(p)).collect();
    if let Some(lmk) = exe("latexmk", None) {
        used.push("latexmk".into());
        let mut cmd = vec![lmk];
        if !rc.contains("$pdf_mode") {
            cmd.push("-pdf".into());
        }
        cmd.extend(["-interaction=nonstopmode".into(), "-halt-on-error".into(), "-file-line-error".into()]);
        if !rc.contains("@default_files") {
            cmd.extend(mains.iter().map(|p| name(p)));
        }
        let o = run(&cmd, root, 1800);
        code = o.code;
        output = format!("{}{}", o.stdout, o.stderr);
    } else if let Some(tt) = exe("tectonic", None) {
        used.push("tectonic".into());
        if root.join("Tectonic.toml").is_file() {
            dirs.push("build".into());
            let o = run(&[tt.as_str(), "-X", "build", "--keep-logs"], root, 1800);
            code = o.code;
            output = format!("{}{}", o.stdout, o.stderr);
        } else {
            for m in &mains {
                let o = run(&[tt.clone(), "--keep-logs".into(), name(m)], root, 1800);
                code = code.max(o.code);
                output.push_str(&o.stdout);
                output.push_str(&o.stderr);
            }
        }
    } else if let Some(pl) = exe("pdflatex", None) {
        used.push("pdflatex".into());
        for m in &mains {
            let (mut bib_done, mut after_bib) = (false, 0);
            for pass in 0..5 {
                let o = run(&[pl.clone(), "-interaction=nonstopmode".into(), "-file-line-error".into(), name(m)], root, 900);
                code = o.code;
                output = format!("{}{}", o.stdout, o.stderr);
                let log = parse_log(&read(root.join(format!("{}.log", stem(m)))));
                if log.items.iter().any(|x| x.sev == "E") {
                    break;
                }
                if log.needs_bib && !bib_done {
                    bib_done = true;
                    let tool = if log.biber { "biber" } else { "bibtex" };
                    if let Some(b) = exe(tool, None) {
                        used.push(tool.into());
                        run(&[b, stem(m)], root, 300);
                        continue;
                    }
                }
                // after bibtex: two passes to resolve citations, then only while LaTeX asks for a rerun
                if bib_done {
                    after_bib += 1;
                    if after_bib < 2 {
                        continue;
                    }
                }
                if !log.rerun || pass >= 3 {
                    break;
                }
            }
        }
    } else {
        die("kit", "no LaTeX engine found: install latexmk (TeX Live / MiKTeX), tectonic, or pdflatex", 2);
    }
    let logs = find_logs(root, &stems, &dirs, start, code == 0);
    if logs.is_empty() {
        d.add("", 0, 0, "E", "latex", &tail(&output, 8), None);
        d.status = ", no PDF".into();
        return;
    }
    let mut pages: Option<usize> = None;
    for lp in &logs {
        let log = parse_log(&read(lp));
        report(d, &log, root, root); // engines run in root: log paths are relative to it
        if let Some(p) = log.pages {
            pages = Some(pages.unwrap_or(0) + p);
        }
    }
    if code != 0 && d.count("E") == 0 {
        d.add("", 0, 0, "E", "latex", &tail(&output, 6), None);
    }
    d.status = match pages {
        Some(n) if n > 0 && d.count("E") == 0 => format!(", PDF built ({n} page{})", if n == 1 { "" } else { "s" }),
        _ => ", no PDF".into(),
    };
}

fn test(_ctx: &Ctx) -> i32 {
    println!("latex: no test runner (`tkit check` builds the document and reports the log)");
    0
}

fn deps(_ctx: &Ctx) {
    die("kit", "deps: not supported for latex", 2)
}

fn proj(ctx: &Ctx) {
    let root = &ctx.root;
    let mains: Vec<String> = main_files(root).iter().map(|p| name(p)).collect();
    let tex = crate::kit::code::common::walk_files(root, "*.tex", crate::kit::code::common::SKIP_DIRS, false).len();
    let bib = crate::kit::code::common::walk_files(root, "*.bib", crate::kit::code::common::SKIP_DIRS, false).len();
    let engine = ["latexmk", "tectonic", "pdflatex"].into_iter().find(|e| exe(e, None).is_some()).unwrap_or("none on PATH");
    println!(
        "latex: {}  {tex} .tex, {bib} .bib  engine {engine}",
        if mains.is_empty() { "(main file from latexmkrc)".to_string() } else { mains.join(", ") }
    );
}

fn fmt(_ctx: &Ctx, _files: &[PathBuf], _check: bool) -> (Vec<String>, Vec<String>) {
    (Vec::new(), Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        read(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/latex").join(name))
    }

    #[test]
    fn unwraps_79_column_lines() {
        let a = "x".repeat(79);
        let v = unwrap_lines(&format!("{a}\nrest\nshort\n{a}\n! Error.\n"));
        assert_eq!(v, vec![format!("{a}rest"), "short".into(), a.clone(), "! Error.".into()]);
    }

    #[test]
    fn file_stack() {
        let mut st = Vec::new();
        scan_parens("(./main.tex LaTeX2e <2023-11-01> (/usr/share/texlive/texmf-dist/tex/latex/base/article.cls", &mut st);
        assert_eq!(current(&st), "/usr/share/texlive/texmf-dist/tex/latex/base/article.cls");
        scan_parens("Document Class: article 2023/05/17 v1.4n Standard LaTeX document class", &mut st);
        scan_parens("(/usr/share/texlive/texmf-dist/tex/latex/base/size10.clo))", &mut st);
        assert_eq!(current(&st), "main.tex");
        scan_parens("(see the transcript file for additional information) (./sec/intro.tex", &mut st);
        assert_eq!(current(&st), "sec/intro.tex");
        scan_parens(")", &mut st);
        assert_eq!(current(&st), "main.tex");
    }

    #[test]
    fn error_log() {
        let log = parse_log(&fixture("error.log"));
        let e: Vec<&Item> = log.items.iter().filter(|x| x.sev == "E").collect();
        assert_eq!(e.len(), 2, "{:#?}", log.items);
        assert_eq!((e[0].file.as_str(), e[0].line, e[0].code), ("sections/method.tex", 14, "error"));
        assert_eq!(e[0].msg, "Undefined control sequence.");
        assert_eq!(e[0].extra.as_deref(), Some("at: We use the \\foo"));
        assert_eq!((e[1].file.as_str(), e[1].line, e[1].code), ("main.tex", 31, "missing-file"));
        assert!(e[1].msg.contains("figures/plot.pdf"));
        assert_eq!(log.pages, Some(0));
    }

    #[test]
    fn file_line_error_log() {
        let log = parse_log(
            "(./main.tex\n./main.tex:5: Undefined control sequence.\nl.5 \\badmacro\n              \n\n! Emergency stop.\n<*> main.tex\n\n)\nNo pages of output.\n",
        );
        assert_eq!(log.items.len(), 1, "{:#?}", log.items);
        assert_eq!((log.items[0].file.as_str(), log.items[0].line), ("main.tex", 5));
    }

    #[test]
    fn citation_log() {
        let log = parse_log(&fixture("citations.log"));
        let w = |code: &str| log.items.iter().filter(|x| x.code == code).cloned().collect::<Vec<_>>();
        let cites = w("undefined-cite");
        assert_eq!(cites.len(), 2, "{:#?}", log.items);
        assert_eq!((cites[0].file.as_str(), cites[0].line), ("main.tex", 22));
        assert_eq!(cites[0].msg, "citation `knuth1984' undefined");
        // natbib's warning is continued on a `(natbib)` line
        assert_eq!((cites[1].file.as_str(), cites[1].line), ("sections/related.tex", 7));
        assert_eq!(cites[1].msg, "citation `lamport94' undefined");
        let refs = w("undefined-ref");
        assert_eq!((refs.len(), refs[0].line, refs[0].msg.as_str()), (1, 40, "reference `fig:arch' undefined"));
        assert_eq!(w("multiply-defined")[0].msg, "label `sec:intro' multiply defined");
        assert!(w("missing-file").iter().any(|x| x.msg.contains("main.bbl")));
        assert!(log.needs_bib && log.rerun);
        assert_eq!(log.pages, Some(4));
        assert!(log.items.iter().all(|x| x.sev == "W"));
    }

    #[test]
    fn box_log() {
        let log = parse_log(&fixture("boxes.log"));
        assert!(log.items.is_empty(), "{:#?}", log.items);
        // 0.8pt overfull and badness-1803 underfull are under the thresholds
        assert_eq!(log.boxes.len(), 7, "{:#?}", log.boxes);
        assert_eq!(log.boxes[0], BoxWarn { overfull: true, file: "main.tex".into(), line: 12, msg: "\\hbox (23.4pt too wide)".into() });
        assert_eq!((log.boxes[1].file.as_str(), log.boxes[1].line), ("sections/results.tex", 8));
        assert_eq!((log.boxes[1].overfull, log.boxes[1].msg.as_str()), (false, "\\hbox (badness 10000)"));
        // parentheses inside the box dump did not unbalance the file stack
        assert_eq!((log.boxes[2].file.as_str(), log.boxes[2].line), ("sections/results.tex", 30));
        assert_eq!((log.boxes[6].file.as_str(), log.boxes[6].line), ("main.tex", 61));
        assert_eq!(log.pages, Some(12));
    }

    #[test]
    fn report_into_diags() {
        let d0 = std::env::temp_dir().join(format!("kit-latex-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d0);
        std::fs::create_dir_all(&d0).unwrap();
        std::fs::write(d0.join("main.tex"), "\\documentclass{article}\n\\begin{document}\n\\section{A}\\label{sec:intro}\n\\section{B}\\label{sec:intro}\n\\end{document}\n").unwrap();
        assert!(is_project(&d0));
        assert_eq!(main_files(&d0), vec![d0.join("main.tex")]);
        let mut d = Diags::new(&d0);
        report(&mut d, &parse_log(&fixture("citations.log")), &d0, &d0);
        let md = d.items.iter().find(|x| x.code == "multiply-defined").unwrap();
        let x = md.extra.as_deref().unwrap();
        assert!(x.starts_with("defined at ") && x.contains("main.tex:3, ") && x.ends_with("main.tex:4"), "{x}");
        let mut d = Diags::new(&d0);
        report(&mut d, &parse_log(&fixture("boxes.log")), &d0, &d0);
        assert_eq!(d.items.len(), BOXES_SHOWN);
        assert!(d.notes[0].starts_with("7 overfull/underfull boxes"));
        assert_eq!(d.count("W") + d.count("E"), 0);
        // tectonic logs `\input{sections/body}` without the extension
        std::fs::create_dir_all(d0.join("sections")).unwrap();
        std::fs::write(d0.join("sections/body.tex"), "x").unwrap();
        let mut d = Diags::new(&d0);
        report(&mut d, &parse_log("(main.tex (sections/body\n! Undefined control sequence.\nl.5 Second \\undefinedmacro\n\n) )\n"), &d0, &d0);
        assert!(d.items[0].file.ends_with("sections/body.tex") && d.items[0].line == 5, "{:?}", d.items);
        let _ = std::fs::remove_dir_all(&d0);
    }

    #[test]
    fn latexmkrc_dirs() {
        assert_eq!(rc_dirs("$out_dir = 'build';\n$aux_dir=\"aux\";\n$pdf_mode = 1;"), vec!["build", "aux"]);
    }
}
