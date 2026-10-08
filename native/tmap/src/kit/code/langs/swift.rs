//! Swift: SwiftPM (swift build / swift test), XCTest and swift-testing output, SwiftLint, swift-format
//! (port of `kit/langs/swift.py`).

use super::super::common::{
    cap_print, die, doc_and_block, exe, fail_lines, g, glob, outline, parse_gnu, re, read, rel, run, s, summary_line, tail, Ctx, Diags,
};
use super::Lang;
use regex::Regex;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

pub const LANG: Lang = Lang { name: "swift", fmt_ext: &[".swift"], check, test, deps, proj, fmt };

/// CRLF -> LF (python text mode does this for files and subprocess output).
fn nl(t: &str) -> String {
    t.replace("\r\n", "\n")
}

fn sw() -> String {
    exe("swift", None).unwrap_or_else(|| die("kit", "swift not found", 2))
}

fn check(ctx: &Ctx, d: &mut Diags, used: &mut Vec<String>) {
    used.push("swift build".into());
    let o = run(&[sw().as_str(), "build", "--build-tests"], &ctx.root, 3600);
    let (out, err) = (nl(&o.stdout), nl(&o.stderr));
    parse_gnu(d, &format!("{out}\n{err}"), &ctx.root, false);
    if o.code != 0 && d.count("E") == 0 {
        d.add("", 0, 0, "E", "swift", &tail(if err.is_empty() { &out } else { &err }, 8), None);
    }
    if let Some(lint) = exe("swiftlint", None).filter(|_| !ctx.opt.fast) {
        used.push("swiftlint".into());
        let o = run(&[lint.as_str(), "lint", "--quiet"], &ctx.root, 900);
        parse_gnu(d, &nl(&o.stdout), &ctx.root, false);
    }
}

/// True when `swift test` failed before running any test (compile error).
fn build_failed(text: &str) -> bool {
    re!(r"error: (fatalError|compile|emit-module)|: error: ").is_match(text) && !text.contains("Test Suite") && !text.contains("Test run")
}

/// Summary + failures for XCTest and swift-testing output.
fn test_report(text: &str, rc: i32, secs: f64, nmax: usize, root: &Path) -> Vec<String> {
    // XCTest
    let xp = re!(r"Test Case '.*?' passed").find_iter(text).count() as i64;
    let xf = re!(r"Test Case '-?\[?([\w. ]+?)\]?' failed").captures_iter(text).count();
    // swift-testing
    let num = |c: Option<regex::Captures>, i| c.map(|c| g(&c, i).parse::<i64>().unwrap_or(0));
    let tp = num(re!(r"Test run with (\d+) tests? (?:in \d+ suites? )?passed").captures(text), 1);
    let tf = num(re!(r"Test run with (\d+) tests? (?:in \d+ suites? )?failed.*?(\d+) issues?").captures(text), 1);
    let sf: BTreeSet<&str> =
        re!(r"✘ Test (\S+?)\(\) (?:recorded an issue at|failed)").captures_iter(text).map(|c| c.get(1).map_or("", |m| m.as_str())).collect();
    let p = xp + tp.unwrap_or(0) + tf.map_or(0, |n| n - sf.len() as i64);
    let skipped = re!(r"Test Case '.*?' skipped|◇ Test .*? skipped").find_iter(text).count();
    let mut out = vec![summary_line("swift test", p, xf + sf.len(), skipped, Some(secs), "")];
    // Darwin: "-[Mod.Class testX] : msg"   Linux: "Mod.Class.testX : msg"
    let mut issues: Vec<(String, String, String, String)> = re!(r"(?m)^(.+?\.swift):(\d+):(?:\d+:)? error: (?:-\[)?([\w.]+(?: [\w]+)?)\]? : (.*)$")
        .captures_iter(text)
        .map(|c| (g(&c, 1).into(), g(&c, 2).into(), g(&c, 3).into(), g(&c, 4).into()))
        .collect();
    issues.extend(
        re!(r"(?m)✘ Test (\S+?)\(\) recorded an issue at (\S+?\.swift):(\d+):\d+: (.*)$")
            .captures_iter(text)
            .map(|c| (g(&c, 2).into(), g(&c, 3).into(), g(&c, 1).into(), g(&c, 4).into())),
    );
    for (f, l, name, msg) in issues.iter().take(nmax) {
        let name = if name.is_empty() { "?" } else { name };
        out.extend(fail_lines(name, msg, Some(&format!("{}:{l}", rel(f, root)))));
    }
    if rc != 0 && issues.is_empty() {
        out.push(tail(text, 20));
    }
    out
}

fn test(ctx: &Ctx) -> i32 {
    let mut cmd = vec![sw(), "test".into()];
    if let Some(f) = &ctx.flt {
        cmd.extend(["--filter".into(), f.clone()]);
    }
    cmd.extend(ctx.extra.iter().cloned());
    let o = run(&cmd, &ctx.root, 3600);
    let text = nl(&format!("{}\n{}", o.stdout, o.stderr));
    if ctx.opt.raw {
        println!("{text}");
        return o.code;
    }
    if build_failed(&text) {
        let mut d = Diags::new(&ctx.root);
        parse_gnu(&mut d, &text, &ctx.root, false);
        println!("swift: build failed, {} errors", d.count("E"));
        d.print(30, false);
        return o.code;
    }
    for l in test_report(&text, o.code, o.secs, ctx.nmax, &ctx.root) {
        println!("{l}");
    }
    o.code
}

/// Package.resolved pins (v1 `object.pins`, v2/v3 `pins`) by lowercase identity.
fn pins_text(t: &str) -> BTreeMap<String, Value> {
    let j: Value = serde_json::from_str(t).unwrap_or(Value::Null);
    let items = j["pins"].as_array().filter(|a| !a.is_empty()).or_else(|| j["object"]["pins"].as_array());
    items
        .into_iter()
        .flatten()
        .map(|x| {
            let id = x["identity"].as_str().filter(|s| !s.is_empty()).or_else(|| x["package"].as_str()).unwrap_or("");
            (id.to_lowercase(), x.clone())
        })
        .collect()
}

fn pins(root: &Path) -> BTreeMap<String, Value> {
    pins_text(&read(root.join("Package.resolved")))
}

fn ls_lines(pn: &BTreeMap<String, Value>) -> Vec<String> {
    let mut out: Vec<String> = pn
        .iter()
        .map(|(n, x)| {
            let st = &x["state"];
            let ver = st["version"].as_str().filter(|v| !v.is_empty()).map(str::to_string).unwrap_or_else(|| {
                let r = st["revision"].as_str().unwrap_or("");
                r.chars().take(10).collect()
            });
            let loc = x["location"].as_str().filter(|v| !v.is_empty()).or_else(|| x["repositoryURL"].as_str()).unwrap_or("");
            format!("{n} {ver}  {loc}")
        })
        .collect();
    if pn.is_empty() {
        out.push("no Package.resolved (swift package resolve)".into());
    }
    out
}

fn deps(ctx: &Ctx) {
    let root = &ctx.root;
    let cmd = ctx.cmd.as_deref().unwrap_or("ls");
    let pkg = ctx.pkg.clone().unwrap_or_default();
    let pn = pins(root);
    if cmd == "ls" {
        for l in ls_lines(&pn) {
            println!("{l}");
        }
        return;
    }
    if cmd == "why" {
        let o = run(&[sw().as_str(), "package", "show-dependencies"], root, 300);
        let out = nl(&o.stdout);
        let all: Vec<String> = out.lines().map(str::to_string).collect();
        let hit: Vec<String> = all.iter().filter(|l| l.to_lowercase().contains(&pkg.to_lowercase())).cloned().collect();
        cap_print(if hit.is_empty() { &all } else { &hit }, ctx.cap);
        return;
    }
    let lower = pkg.to_lowercase();
    let Some(d) = glob(root.join(".build").join("checkouts").join("*"))
        .into_iter()
        .find(|x| x.file_name().is_some_and(|n| n.to_string_lossy().to_lowercase() == lower))
    else {
        die("kit", &format!("{pkg} not in .build/checkouts (swift package resolve)"), 2)
    };
    let ver = pn.get(&lower).and_then(|x| x["state"]["version"].as_str()).unwrap_or("").to_string();
    if cmd == "where" {
        println!("{pkg} {ver}  {}", s(&d));
        return;
    }
    let mut files = glob(d.join("Sources").join("**").join("*.swift"));
    files.truncate(600);
    println!("{pkg} {ver}  {}", s(&d));
    let Some(sym) = ctx.sym.as_deref() else {
        let rx = re!(
            r"^\s*(@\w+\s+)*(public|open)\s+(final\s+|static\s+|class\s+|indirect\s+|nonisolated\s+)*(func|struct|class|enum|protocol|actor|typealias|var|let|init|extension|macro)\b"
        );
        let kinds = re!(r"(struct|class|enum|protocol|actor|typealias|extension|macro)\s");
        let mut v: Vec<String> = outline(&files, rx, &d, None, None).into_iter().filter(|l| kinds.is_match(l) || l.contains("func ")).collect();
        v.truncate(4000);
        cap_print(&v, ctx.cap);
        return;
    };
    let e = regex::escape(sym);
    let decl = Regex::new(&format!(r"^\s*(@\w+\s+)*(public|open)\s+.*\b(func|struct|class|enum|protocol|actor|typealias|extension|var|let)\s+{e}\b"))
        .expect("decl regex");
    let body = re!(r"^\s*(@\w+\s+)*(public|open)\s");
    // protocol requirements carry no access modifier: show them all
    let blk = |l: &[String], i: usize, loc: &str| {
        let b = if re!(r"\bprotocol\s").is_match(&l[i]) { None } else { Some(body) };
        doc_and_block(l, i, loc, "{", "}", b, 60)
    };
    let mut out = outline(&files, &decl, &d, Some(sym), Some(&blk));
    if out.is_empty() {
        out.push(format!("no public declaration named {sym}"));
    }
    cap_print(&out, ctx.cap);
}

/// `proj` lines from Package.swift (`v` = first line of `swift --version`).
fn proj_lines(t: &str, v: &str, ndeps: usize, nsrc: usize, ntest: usize) -> Vec<String> {
    let tv = re!(r"swift-tools-version:\s*([\d.]+)").captures(t).map(|c| g(&c, 1).to_string());
    let name = re!(r#"name:\s*"([^"]+)""#).captures(t).map(|c| g(&c, 1).to_string());
    let mut out = vec![format!("swift: {}  tools {}  {v}", name.as_deref().unwrap_or("?"), tv.as_deref().unwrap_or("?"))];
    let plat: Vec<String> = re!(r#"\.(macOS|iOS|tvOS|watchOS|visionOS|macCatalyst)\(\.?v?([\w."]+)\)"#)
        .captures_iter(t)
        .map(|c| format!("{} {}", g(&c, 1), g(&c, 2)))
        .collect();
    if !plat.is_empty() {
        out.push(format!("  platforms: {}", plat.join(", ")));
    }
    let tg: Vec<String> = re!(r#"\.(executableTarget|target|testTarget|macro|plugin)\(\s*name:\s*"([^"]+)""#)
        .captures_iter(t)
        .map(|c| format!("{}({})", g(&c, 2), g(&c, 1).replace("Target", "")))
        .collect();
    if !tg.is_empty() {
        out.push(format!("  targets: {}", tg.join(", ")));
    }
    out.push(format!("  deps {ndeps}; .swift files: {nsrc}, tests: {ntest}"));
    out
}

fn proj(ctx: &Ctx) {
    let d = &ctx.root;
    let t = nl(&read(d.join("Package.swift")));
    let v = match exe("swift", None) {
        Some(sx) => {
            let o = run(&[sx.as_str(), "--version"], d, 20);
            let txt = nl(if o.stdout.trim().is_empty() { &o.stderr } else { &o.stdout });
            txt.lines().next().unwrap_or("").to_string()
        }
        None => "swift not installed".into(),
    };
    let n = |dir: &str| glob(d.join(dir).join("**").join("*.swift")).len();
    for l in proj_lines(&t, &v, pins(d).len(), n("Sources"), n("Tests")) {
        println!("{l}");
    }
}

/// Files named in swift-format / swiftformat lint lines (`path:line:col: warning: …`), drive letters kept.
fn lint_files(err: &str) -> Vec<String> {
    let rx = re!(r"^(.+?\.swift):\d+");
    let set: BTreeSet<String> =
        err.lines().filter(|l| l.contains(".swift:")).filter_map(|l| rx.captures(l).map(|c| g(&c, 1).to_string())).collect();
    set.into_iter().collect()
}

fn fmt(ctx: &Ctx, files: &[PathBuf], check: bool) -> (Vec<String>, Vec<String>) {
    let fs = files.iter().map(|f| s(f));
    if let Some(sf) = exe("swift-format", None) {
        let mut c = vec![sf, (if check { "lint" } else { "format" }).to_string()];
        if !check {
            c.push("-i".into());
        }
        c.extend(fs);
        let o = run(&c, &ctx.root, 900);
        return (if check { lint_files(&nl(&o.stderr)) } else { Vec::new() }, Vec::new());
    }
    if let Some(sfm) = exe("swiftformat", None) {
        let mut c = vec![sfm];
        if check {
            c.push("--lint".into());
        }
        c.extend(fs);
        let o = run(&c, &ctx.root, 900);
        return (if check { lint_files(&nl(&o.stderr)) } else { Vec::new() }, Vec::new());
    }
    (Vec::new(), vec!["no swift-format / swiftformat: .swift skipped".into()])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r() -> &'static Path {
        Path::new("/r")
    }

    #[test]
    fn build_errors() {
        let text = "Building for debugging...\n/r/Sources/App/main.swift:3:9: error: cannot find 'foo' in scope\n    foo()\n        ^~~\n\
C:\\r\\Sources\\App\\util.swift:7:5: warning: variable 'x' was never used; consider replacing with '_' or removing it\n\
error: fatalError\n";
        assert!(build_failed(text));
        let mut d = Diags::new(r());
        parse_gnu(&mut d, text, r(), false);
        assert_eq!(d.count("E"), 1);
        assert_eq!((d.items[0].line, d.items[0].col), (3, 9));
        assert_eq!(d.items[0].msg, "cannot find 'foo' in scope");
        assert!(d.items[1].file.ends_with("util.swift"));
        assert_eq!((d.items[1].sev.as_str(), d.items[1].line, d.items[1].col), ("W", 7, 5));
    }

    #[test]
    fn xctest_linux() {
        let text = "Test Suite 'All tests' started at 2026-01-01\n\
Test Case 'MathTests.testAdd' started\nTest Case 'MathTests.testAdd' passed (0.001 seconds)\n\
Test Case 'MathTests.testSub' started\n/r/Tests/MathTests/MathTests.swift:12: error: MathTests.testSub : XCTAssertEqual failed: (\"1\") is not equal to (\"2\")\n\
Test Case 'MathTests.testSub' failed (0.002 seconds)\n\
Test Case 'MathTests.testSkip' skipped (0.000 seconds)\n";
        let out = test_report(text, 1, 1.0, 10, r());
        assert_eq!(out[0], "swift test: 1 passed, 1 failed, 1 skipped [1.0s]");
        assert!(out[1].starts_with("FAIL MathTests.testSub  (") && out[1].ends_with("MathTests.swift:12)"));
        assert_eq!(out[2], "    XCTAssertEqual failed: (\"1\") is not equal to (\"2\")");
    }

    #[test]
    fn xctest_darwin_and_windows() {
        let text = "Test Case '-[MathTests.MathTests testAdd]' passed (0.001 seconds).\n\
/Users/me/p/Tests/MathTests/MathTests.swift:9: error: -[MathTests.MathTests testSub] : XCTAssertTrue failed\n\
Test Case '-[MathTests.MathTests testSub]' failed (0.002 seconds).\n\
C:\\p\\Tests\\MathTests\\MathTests.swift:21: error: MathTests.MathTests.testMul : XCTAssertEqual failed\n\
Test Case 'MathTests.testMul' failed (0.002 seconds)\n";
        let out = test_report(text, 1, 0.5, 10, r());
        assert_eq!(out[0], "swift test: 1 passed, 2 failed [0.5s]");
        assert!(out[1].starts_with("FAIL MathTests.MathTests testSub  ("));
        assert!(out[3].starts_with("FAIL MathTests.MathTests.testMul  (") && out[3].ends_with("MathTests.swift:21)"));
    }

    #[test]
    fn swift_testing() {
        let text = "◇ Test run started.\n◇ Test add() started.\n✔ Test add() passed after 0.001 seconds.\n\
✘ Test sub() recorded an issue at MathTests.swift:10:5: Expectation failed: (a → 1) == 2\n\
✘ Test sub() failed after 0.002 seconds with 1 issue.\n\
◇ Test later() skipped.\n\
✘ Test run with 3 tests failed after 0.003 seconds with 1 issue.\n";
        let out = test_report(text, 1, 0.2, 10, r());
        assert_eq!(out[0], "swift test: 2 passed, 1 failed, 1 skipped [0.2s]");
        assert!(out[1].starts_with("FAIL sub  (") && out[1].ends_with("MathTests.swift:10)"));
        assert_eq!(out[2], "    Expectation failed: (a → 1) == 2");
        let ok = "✔ Test run with 4 tests in 2 suites passed after 0.004 seconds.\n";
        assert_eq!(test_report(ok, 0, 0.1, 10, r()), vec!["swift test: 4 passed, 0 failed [0.1s]"]);
        assert!(!build_failed(ok));
    }

    #[test]
    fn swiftlint_output() {
        let mut d = Diags::new(r());
        parse_gnu(
            &mut d,
            "/r/Sources/A.swift:4:1: warning: Line Length Violation: Line should be 120 characters or less (line_length)\n\
C:\\r\\Sources\\B.swift:2:7: error: Force Cast Violation: Force casts should be avoided (force_cast)\n",
            r(),
            false,
        );
        assert_eq!(d.count("E"), 1);
        assert_eq!(d.count("W"), 1);
        assert!(d.items.iter().any(|x| x.file.ends_with("B.swift") && x.line == 2 && x.col == 7));
    }

    #[test]
    fn resolved_and_proj() {
        let v2 = r#"{"pins":[{"identity":"swift-argument-parser","kind":"remoteSourceControl","location":"https://github.com/apple/swift-argument-parser.git","state":{"revision":"abcdef0123456789","version":"1.3.0"}},
{"identity":"Yams","location":"https://github.com/jpsim/Yams","state":{"branch":"main","revision":"0123456789abcdef"}}],"version":2}"#;
        let pn = pins_text(v2);
        assert_eq!(
            ls_lines(&pn),
            vec![
                "swift-argument-parser 1.3.0  https://github.com/apple/swift-argument-parser.git",
                "yams 0123456789  https://github.com/jpsim/Yams"
            ]
        );
        let v1 = r#"{"object":{"pins":[{"package":"Nimble","repositoryURL":"https://github.com/Quick/Nimble","state":{"version":"9.0.0"}}]},"version":1}"#;
        assert_eq!(ls_lines(&pins_text(v1)), vec!["nimble 9.0.0  https://github.com/Quick/Nimble"]);
        assert_eq!(ls_lines(&pins_text("")), vec!["no Package.resolved (swift package resolve)"]);
        let pkg = "// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(\n  name: \"Demo\",\n  platforms: [.macOS(.v13), .iOS(\"16.0\")],\n  targets: [\n    .executableTarget(\n      name: \"App\"),\n    .testTarget(name: \"AppTests\", dependencies: [\"App\"]),\n  ]\n)\n";
        assert_eq!(
            proj_lines(pkg, "Swift version 6.0", 2, 3, 1),
            vec![
                "swift: Demo  tools 5.9  Swift version 6.0",
                "  platforms: macOS 13, iOS \"16.0\"",
                "  targets: App(executable), AppTests(test)",
                "  deps 2; .swift files: 3, tests: 1"
            ]
        );
    }

    #[test]
    fn format_lint_files() {
        let err = "/r/Sources/A.swift:3:1: warning: [Indentation] replace leading whitespace\nC:\\r\\Sources\\B.swift:1:1: warning: [Spacing] x\n/r/Sources/A.swift:9:1: warning: y\n";
        assert_eq!(lint_files(err), vec!["/r/Sources/A.swift", "C:\\r\\Sources\\B.swift"]);
    }
}
