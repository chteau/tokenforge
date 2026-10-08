//! Zig: zig build / zig build test, build.zig.zon dependencies, zig fmt. Port of `kit/langs/zig.py`.

use super::super::common::{
    cap_print, doc_and_block, exe, fail_lines, g, glob, outline, parse_gnu, pmatch, re, rel, run, s, summary_line, tail, Ctx, Diags, OrdMap,
};
use super::java::{base, lf, rd, slash};
use super::Lang;
use crate::kit::util::{self, die};
use regex::Regex;
use std::path::{Path, PathBuf};

pub const LANG: Lang = Lang { name: "zig", fmt_ext: &[".zig", ".zon"], check, test, deps, proj, fmt };

fn zig() -> String {
    exe("zig", None).unwrap_or_else(|| die("kit", "zig not found", 2))
}

fn check(ctx: &Ctx, d: &mut Diags, used: &mut Vec<String>) {
    used.push("zig build".into());
    let o = run(&[zig().as_str(), "build", "--summary", "none"], &ctx.root, 3600);
    let err = lf(&o.stderr);
    parse_gnu(d, &err, &ctx.root, false);
    if o.code != 0 && d.count("E") == 0 {
        d.add("", 0, 0, "E", "zig", &tail(&err, 8), None);
    }
}

fn sum(rx: &Regex, t: &str) -> usize {
    rx.captures_iter(t).map(|c| g(&c, 1).parse::<usize>().unwrap_or(0)).sum()
}

/// `zig build test` output (LF) -> summary + failures, user frames only. None = it is a build failure.
fn report(text: &str, root: &Path, rc: i32, secs: f64, nmax: usize) -> Option<Vec<String>> {
    if re!(r"(?m)^.+?\.zig:\d+:\d+: error:").is_match(text) && !text.contains("passed") {
        return None;
    }
    let mut p = sum(re!(r"(\d+)/\d+ (?:tests )?passed"), text);
    if p == 0 {
        p = sum(re!(r"(\d+) passed"), text);
    }
    let f = sum(re!(r"(\d+) failed"), text);
    let mut out = vec![summary_line("zig test", p, f, sum(re!(r"(\d+) skipped"), text), Some(secs), "")];
    // python: error: '([^']+)' failed: (.*?)(?=\nerror: '|\n\S+ test|\Z)  (no lookahead in `regex`)
    let head = re!(r"error: '([^']+)' failed: ");
    let stop = re!(r"\nerror: '|\n\S+ test");
    let frame = re!(r"^(.+?\.zig):(\d+):\d+: 0x");
    let std_dir = re!(r"/(lib/)?(zig/)?std/");
    let caret = re!(r"^\s*\^\s*$");
    let loc_rx = re!(r"^\S+\.zig:\d+$");
    let (mut pos, mut n) = (0, 0);
    while let Some(h) = head.captures_at(text, pos) {
        let start = h.get(0).map_or(0, |m| m.end());
        let end = stop.find_at(text, start).map_or(text.len(), |m| m.start());
        pos = end.max(start);
        if n >= nmax {
            break;
        }
        n += 1;
        // message, then only user-code frames (std frames and their source/caret lines dropped)
        let (mut body, mut skip) = (Vec::new(), false);
        for l in text[start..end].lines() {
            let fr = pmatch(frame, l);
            if let Some(fr) = &fr {
                skip = std_dir.is_match(&slash(g(fr, 1)));
            }
            if skip || caret.is_match(l) || l.starts_with("error: the following") {
                continue;
            }
            body.push(match &fr {
                Some(fr) => format!("{}:{}", rel(g(fr, 1), root), g(fr, 2)),
                None => l.to_string(),
            });
        }
        let loc = body.iter().find(|b| loc_rx.is_match(b)).cloned();
        let rest: Vec<&str> = body.iter().filter(|b| Some(*b) != loc.as_ref()).map(String::as_str).collect();
        out.extend(fail_lines(g(&h, 1), &rest.join("\n"), loc.as_deref()));
    }
    if rc != 0 && f == 0 {
        out.push(tail(text, 20));
    }
    Some(out)
}

fn test(ctx: &Ctx) -> i32 {
    let mut cmd = vec![zig(), "build".into(), "test".into(), "--summary".into(), "all".into()];
    if let Some(f) = &ctx.flt {
        cmd.push(format!("-Dtest-filter={f}"));
    }
    cmd.extend(ctx.extra.iter().cloned());
    let o = run(&cmd, &ctx.root, 3600);
    let text = lf(&format!("{}\n{}", o.stdout, o.stderr));
    if ctx.opt.raw {
        println!("{text}");
        return o.code;
    }
    match report(&text, &ctx.root, o.code, o.secs, ctx.nmax) {
        Some(lines) => {
            for l in lines {
                println!("{l}");
            }
        }
        None => {
            let mut d = Diags::new(&ctx.root);
            parse_gnu(&mut d, &text, &ctx.root, false);
            println!("zig: build failed, {} errors", d.count("E"));
            d.print(30, false);
        }
    }
    o.code
}

// ---------- dependencies ----------

/// build.zig.zon `.dependencies`: name -> (hash, url or path).
fn zon(root: &Path) -> OrdMap<String, (Option<String>, String)> {
    let mut out = OrdMap::default();
    let p = root.join("build.zig.zon");
    if !p.exists() {
        return out;
    }
    let t = rd(&p);
    let sec = re!(r"(?s)\.dependencies\s*=\s*\.\{(.*?)\n\s{4}\},").captures(&t).map(|c| g(&c, 1).to_string()).unwrap_or_default();
    for c in re!(r#"(?s)\.([@"\w-]+)\s*=\s*\.\{(.*?)\}"#).captures_iter(&sec) {
        let body = g(&c, 2);
        let h = re!(r#"\.hash\s*=\s*"([^"]+)""#).captures(body).map(|m| g(&m, 1).to_string());
        let u = re!(r#"\.(url|path)\s*=\s*"([^"]+)""#).captures(body).map(|m| g(&m, 2).to_string()).unwrap_or_default();
        out.insert(g(&c, 1).trim_matches(['@', '"']).to_string(), (h, u));
    }
    out
}

/// `lib_dir` from `zig env` (JSON on older zig, ZON on newer); string escapes undone (Windows `C:\\zig\\lib`).
fn lib_dir(env: &str) -> Option<String> {
    re!(r#""?lib_dir"?\s*[:=]\s*"([^"]+)""#).captures(env).map(|c| g(&c, 1).replace("\\\\", "\\"))
}

/// Zig's global package cache: `$ZIG_GLOBAL_CACHE_DIR`, else `~/.cache/zig` (`%LOCALAPPDATA%\zig` on Windows).
fn global_cache() -> PathBuf {
    if let Some(d) = std::env::var_os("ZIG_GLOBAL_CACHE_DIR") {
        return PathBuf::from(d);
    }
    if cfg!(windows) {
        if let Some(la) = std::env::var_os("LOCALAPPDATA") {
            return Path::new(&la).join("zig");
        }
    }
    util::home().join(".cache").join("zig")
}

fn deps(ctx: &Ctx) {
    let root = &ctx.root;
    let cmd = ctx.cmd.as_deref().unwrap_or("ls");
    let pkg = ctx.pkg.as_deref().unwrap_or("");
    let z = zon(root);
    if cmd == "ls" {
        for (n, (_, u)) in &z.items {
            println!("{n}  {u}");
        }
        if z.items.is_empty() {
            println!("no dependencies in build.zig.zon");
        }
        return;
    }
    if cmd == "why" {
        println!("zig has no reverse-dependency query; see build.zig.zon");
        return;
    }
    let d: Option<PathBuf> = if pkg == "std" {
        lib_dir(&run(&[zig().as_str(), "env"], root, 20).stdout).map(|l| Path::new(&l).join("std"))
    } else {
        let (h, u) = z.get(&pkg.to_string()).cloned().unwrap_or((None, String::new()));
        if h.is_none() && u.is_empty() {
            die("kit", &format!("{pkg} not in build.zig.zon"), 2);
        }
        let mut cands: Vec<PathBuf> = h.iter().map(|h| global_cache().join("p").join(h)).collect();
        if !u.is_empty() && !u.starts_with("http") {
            cands.push(root.join(&u));
        }
        cands.into_iter().find(|c| c.is_dir())
    };
    let Some(d) = d else { die("kit", &format!("{pkg}: not fetched (zig build --fetch)"), 2) };
    if cmd == "where" {
        println!("{pkg}  {}", s(&d));
        return;
    }
    let mut files = glob(d.join("**").join("*.zig"));
    files.sort();
    files.truncate(800);
    println!("{pkg}  {}", s(&d));
    let Some(sym) = ctx.sym.as_deref() else {
        let rx = re!(r"^\s*pub\s+(inline\s+|extern\s+|export\s+)?(fn|const|var)\s+\w+");
        let lines: Vec<String> = outline(&files, rx, &d, None, None).into_iter().filter(|l| !l.split(':').next().unwrap_or("").contains("test")).collect();
        cap_print(&lines, ctx.cap);
        return;
    };
    let decl = Regex::new(&format!(r"^\s*pub\s+(inline\s+|extern\s+|export\s+)?(fn|const|var)\s+{}\b", regex::escape(sym))).expect("decl regex");
    let body = re!(r"^\s*pub\s|^\s*\w+:\s");
    let blk = |l: &[String], i: usize, loc: &str| doc_and_block(l, i, loc, "{", "}", Some(body), 60);
    let mut lines = outline(&files, &decl, &d, Some(sym), Some(&blk));
    if lines.is_empty() {
        lines.push(format!("no pub decl named {sym}"));
    }
    cap_print(&lines, ctx.cap);
}

// ---------- project facts ----------

fn proj(ctx: &Ctx) {
    let d = &ctx.root;
    let zt = rd(d.join("build.zig.zon"));
    let cap = |rx: &Regex, t: &str| rx.captures(t).map(|c| g(&c, 1).to_string());
    let n = cap(re!(r#"\.name\s*=\s*\.?"?([\w-]+)"#), &zt).unwrap_or_else(|| base(d));
    let v = cap(re!(r#"\.version\s*=\s*"([^"]+)""#), &zt).unwrap_or_default();
    let mz = cap(re!(r#"\.minimum_zig_version\s*=\s*"([^"]+)""#), &zt);
    let zv = match exe("zig", None) {
        Some(z) => run(&[z.as_str(), "version"], d, 10).stdout.trim().to_string(),
        None => "not installed".into(),
    };
    println!("zig: {n} {v}  zig {zv}{}", mz.map(|m| format!("  (min {m})")).unwrap_or_default());
    let bt = rd(d.join("build.zig"));
    let arts: Vec<String> = re!(r#"add(Executable|StaticLibrary|SharedLibrary|Library|Test|Module)\(\s*\.\{\s*\.name\s*=\s*"([^"]+)""#)
        .captures_iter(&bt)
        .map(|c| format!("{}({})", g(&c, 2), g(&c, 1).to_lowercase()))
        .collect();
    if !arts.is_empty() {
        println!("  artifacts: {}", arts.join(", "));
    }
    println!("  deps {}; .zig files: {}", zon(d).items.len(), glob(d.join("src").join("**").join("*.zig")).len());
}

fn fmt(ctx: &Ctx, files: &[PathBuf], check: bool) -> (Vec<String>, Vec<String>) {
    let Some(z) = exe("zig", None) else { return (Vec::new(), vec!["zig not found: .zig skipped".into()]) };
    let mut c = vec![z, "fmt".into()];
    if check {
        c.push("--check".into());
    }
    c.extend(files.iter().map(|f| s(f)));
    let o = run(&c, &ctx.root, 900);
    (if check { o.stdout.split_whitespace().map(str::to_string).collect() } else { Vec::new() }, Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUN: &str = "test\n\
└─ run test 1/2 passed, 1 failed\n\
error: 'main.test.fails' failed: expected 1, found 2\n\
/usr/lib/zig/std/testing.zig:93:17: 0x1038f5c in expectEqual__anon_1234 (test)\n\
                return error.TestExpectedEqual;\n\
                ^\n\
/home/u/p/src/main.zig:10:5: 0x1039105 in test.fails (test)\n\
    try std.testing.expectEqual(1, 2);\n\
    ^\n\
error: while executing test 'main.test.other', the following command exited with code 1\n\
Build Summary: 3/5 steps succeeded; 1 failed; 1/2 tests passed; 1 failed\n";

    #[test]
    fn test_failures_user_frames() {
        let v = report(RUN, Path::new("/home/u/p"), 1, 0.4, 10).unwrap();
        assert_eq!(v[0], "zig test: 2 passed, 3 failed [0.4s]"); // python sums every "N passed" / "N failed"
        assert!(v[1].starts_with("FAIL main.test.fails  (") && v[1].ends_with("src/main.zig:10)"), "{v:?}");
        assert_eq!(v[2], "    expected 1, found 2");
        assert_eq!(v[3], "    try std.testing.expectEqual(1, 2);", "{v:#?}"); // `\` continuation ate the indent
        assert!(!v.iter().any(|l| l.contains("testing.zig") || l.contains("TestExpectedEqual")));
    }

    #[test]
    fn windows_frames_and_build_failure() {
        let w = lf("error: 'x.test.a' failed: boom\r\nC:\\zig\\lib\\std\\debug.zig:5:3: 0x1 in panic (test)\r\n    @panic(msg);\r\nC:\\p\\src\\x.zig:4:9: 0x2 in test.a (test)\r\n    foo();\r\n        ^\r\n0/1 tests passed; 1 failed\r\n");
        let v = report(&w, Path::new("C:\\p"), 1, 0.1, 10).unwrap();
        assert!(v[1].starts_with("FAIL x.test.a  (") && v[1].ends_with("x.zig:4)"), "{v:?}");
        assert!(!v.iter().any(|l| l.contains("@panic")));
        let b = "src/main.zig:3:5: error: use of undeclared identifier 'nope'\n    nope();\n    ^~~~\nC:\\p\\src\\w.zig:1:1: error: expected 'fn'\n";
        assert!(report(b, Path::new("/p"), 1, 0.1, 10).is_none());
        let mut d = Diags::new(Path::new("/p"));
        parse_gnu(&mut d, b, Path::new("/p"), false);
        assert_eq!(d.count("E"), 2);
        assert!(d.items.iter().any(|x| x.file.replace('\\', "/").ends_with("C:/p/src/w.zig") && x.line == 1), "{:?}", d.items);
    }

    #[test]
    fn zon_and_env() {
        let d = std::env::temp_dir().join(format!("kit-zig-zon-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(
            d.join("build.zig.zon"),
            ".{\r\n    .name = .app,\r\n    .version = \"0.1.0\",\r\n    .dependencies = .{\r\n        .zap = .{\r\n            .url = \"https://x/zap.tar.gz\",\r\n            .hash = \"zap-0.1-abc\",\r\n        },\r\n        .@\"local-lib\" = .{\r\n            .path = \"libs/local\",\r\n        },\r\n    },\r\n}\r\n",
        )
        .unwrap();
        let z = zon(&d);
        assert_eq!(z.items.len(), 2);
        assert_eq!(z.items[0], ("zap".into(), (Some("zap-0.1-abc".into()), "https://x/zap.tar.gz".into())));
        assert_eq!(z.items[1], ("local-lib".into(), (None, "libs/local".into())));
        let _ = std::fs::remove_dir_all(&d);
        assert_eq!(lib_dir("{\n \"zig_exe\": \"/usr/bin/zig\",\n \"lib_dir\": \"/usr/lib/zig\"\n}").as_deref(), Some("/usr/lib/zig"));
        assert_eq!(lib_dir(".{\n    .lib_dir = \"C:\\\\zig\\\\lib\",\n}").as_deref(), Some("C:\\zig\\lib"));
    }
}
