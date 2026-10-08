//! C / C++: CMake (+ctest), Meson, or Make. gcc/clang/MSVC diagnostics. Port of `kit/langs/cpp.py`.

use super::super::common::{
    cap_print, changed_files, doc_and_block, exe, g, glob, gn, outline, parse_gnu, pmatch, re, relcwd, run, s, summary, tail, trunc, ws,
    Ctx, Diags,
};
use super::java::{lf, rd, slash};
use super::Lang;
use crate::kit::util::{self, die};
use regex::Regex;
use std::path::{Path, PathBuf};

pub const LANG: Lang = Lang {
    name: "cpp",
    fmt_ext: &[".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx", ".ipp", ".m", ".mm"],
    check,
    test,
    deps,
    proj,
    fmt,
};

fn jobs() -> String {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).to_string()
}

fn need(name: &str) -> String {
    exe(name, None).unwrap_or_else(|| die("kit", &format!("{name} not found"), 2))
}

/// `make`, or MinGW's `mingw32-make` (Windows).
fn make() -> String {
    exe("make", None).or_else(|| exe("mingw32-make", None)).unwrap_or_else(|| die("kit", "make not found", 2))
}

fn system(root: &Path) -> &'static str {
    if root.join("CMakeLists.txt").exists() {
        "cmake"
    } else if root.join("meson.build").exists() {
        "meson"
    } else {
        "make"
    }
}

fn build_dir(root: &Path, kind: &str) -> Option<PathBuf> {
    for p in ["build", "_build", "builddir", "cmake-build-*", "out/build/*", "build/*"] {
        let mut v = glob(p.split('/').fold(root.to_path_buf(), |a, c| a.join(c)));
        v.sort();
        for d in v {
            if kind == "cmake" && d.join("CMakeCache.txt").exists() {
                return Some(d);
            }
            if kind == "meson" && d.join("meson-private").is_dir() {
                return Some(d);
            }
        }
    }
    None
}

fn configure(root: &Path, kind: &str, notes: &mut Vec<String>) -> PathBuf {
    if let Some(d) = build_dir(root, kind) {
        return d;
    }
    let d = root.join("build");
    if kind == "cmake" {
        let cm = need("cmake");
        let gen: Vec<&str> = if exe("ninja", None).is_some() { vec!["-G", "Ninja"] } else { vec![] };
        let mut c = vec![cm, "-S".into(), s(root), "-B".into(), s(&d), "-DCMAKE_EXPORT_COMPILE_COMMANDS=ON".into()];
        c.extend(gen.iter().map(|x| x.to_string()));
        let o = run(&c, root, 600);
        notes.push(format!("configured {} (cmake{})", relcwd(&d), if gen.is_empty() { "" } else { " + ninja" }));
        if o.code != 0 {
            let e = lf(if o.stderr.is_empty() { &o.stdout } else { &o.stderr });
            die("kit", &format!("cmake configure failed:\n{}", tail(&e, 15)), 2);
        }
    } else {
        let ms = need("meson");
        let o = run(&[ms, "setup".into(), s(&d)], root, 600);
        notes.push(format!("configured {} (meson)", relcwd(&d)));
        if o.code != 0 {
            die("kit", &format!("meson setup failed:\n{}", tail(&lf(&format!("{}{}", o.stdout, o.stderr)), 15)), 2);
        }
    }
    d
}

/// The cache's generator: Visual Studio / Xcode / "Ninja Multi-Config" are multi-config
/// (ctest then needs `-C <config>`).
fn multi_config(cache: &str) -> bool {
    ["CMAKE_GENERATOR:INTERNAL=Visual Studio", "CMAKE_GENERATOR:INTERNAL=Xcode", "CMAKE_GENERATOR:INTERNAL=Ninja Multi-Config"]
        .iter()
        .any(|g| cache.contains(g))
}

/// Native-tool "keep going" args: ninja `-k 0`, make/nmake `-k`; MSBuild and xcodebuild take none.
fn keep_going(cache: &str) -> Vec<&'static str> {
    if cache.contains("CMAKE_GENERATOR:INTERNAL=Ninja") {
        vec!["--", "-k", "0"]
    } else if cache.contains("CMAKE_GENERATOR:INTERNAL=Visual Studio") || cache.contains("CMAKE_GENERATOR:INTERNAL=Xcode") {
        vec![]
    } else {
        vec!["--", "-k"]
    }
}

/// MSVC / clang-cl `file(line[,col]): error C1234: msg [project.vcxproj]` and `x.obj : error LNK2019: msg`.
pub fn parse_msvc(d: &mut Diags, text: &str) {
    let rx = re!(r"^(.+?)\((\d+)(?:,(\d+))?\):\s*(fatal error|error|warning)(?:\s+(\w+))?:\s*(.*)$");
    let lnk = re!(r"^(.+?) : (fatal error|error|warning) (LNK\d+):\s*(.*)$");
    let proj = re!(r"\s+\[[^\[\]]+\.(?:vcxproj|csproj|proj)\]$");
    for ln in text.lines() {
        let ln = ln.trim();
        if let Some(m) = pmatch(rx, ln) {
            let msg = proj.replace(g(&m, 6), "");
            d.add(g(&m, 1), gn(&m, 2), gn(&m, 3), g(&m, 4), g(&m, 5), &msg, None);
        } else if let Some(m) = pmatch(lnk, ln) {
            let msg = proj.replace(g(&m, 4), "");
            d.add("", 0, 0, g(&m, 2), g(&m, 3), &format!("{}: {msg}", g(&m, 1)), None);
        }
    }
}

/// Build everything, keep going past errors. Returns (rc, build dir).
fn build(ctx: &Ctx, d: &mut Diags, used: &mut Vec<String>, notes: &mut Vec<String>) -> (i32, PathBuf) {
    let kind = system(&ctx.root);
    let (o, bd) = if kind == "cmake" {
        let bd = configure(&ctx.root, kind, notes);
        let cache = rd(bd.join("CMakeCache.txt"));
        used.push("cmake --build".into());
        let mut c = vec![need("cmake"), "--build".into(), s(&bd), "-j".into(), jobs()];
        c.extend(keep_going(&cache).iter().map(|x| x.to_string()));
        (run(&c, &ctx.root, 3600), bd)
    } else if kind == "meson" {
        let bd = configure(&ctx.root, kind, notes);
        used.push("ninja (meson)".into());
        (run(&[need("ninja"), "-C".into(), s(&bd), "-k".into(), "0".into()], &ctx.root, 3600), bd)
    } else {
        used.push("make -k".into());
        (run(&[make(), "-k".into(), "-j".into(), jobs()], &ctx.root, 3600), ctx.root.clone())
    };
    let text = lf(&format!("{}\n{}", o.stdout, o.stderr));
    parse_gnu(d, &text, &bd, false);
    parse_msvc(d, &text);
    if o.code != 0 && d.count("E") == 0 {
        let rx = re!(r"(?i)error|failed|\*\*\*");
        let hits: Vec<&str> = text.lines().filter(|l| rx.is_match(l)).collect();
        let t = if hits.is_empty() { text.clone() } else { hits.join("\n") };
        d.add("", 0, 0, "E", kind, &tail(&t, 8), None);
    }
    (o.code, bd)
}

fn check(ctx: &Ctx, d: &mut Diags, used: &mut Vec<String>) {
    let mut notes = Vec::new();
    let (_, bd) = build(ctx, d, used, &mut notes);
    d.notes.extend(notes);
    let cc = bd.join("compile_commands.json");
    if let (true, Some(tidy), true) = (ctx.opt.lint, exe("clang-tidy", None), cc.exists()) {
        let files: Vec<String> = changed_files(&ctx.root)
            .iter()
            .map(|f| s(f))
            .filter(|f| [".c", ".cc", ".cpp", ".cxx"].iter().any(|e| f.ends_with(e)))
            .collect();
        if !files.is_empty() {
            used.push("clang-tidy".into());
            let mut c = vec![tidy, "-p".into(), s(&bd), "--quiet".into()];
            c.extend(files);
            let o = run(&c, &ctx.root, 1800);
            parse_gnu(d, &lf(&o.stdout), &ctx.root, false);
        }
    }
}

fn fail_line() -> &'static Regex {
    re!(r"(Failure|FAILED|Expected|Which is|Value of|Actual|actual:|expected:|REQUIRE|CHECK|ASSERT|assert|Assertion|error:|\w+\.(c|cc|cpp|h|hpp):\d+)")
}

/// ctest `--output-on-failure` text -> summary + failing tests with their assertion lines.
fn ctest_report(text: &str, secs: f64, nmax: usize) -> Vec<String> {
    let mut out = Vec::new();
    let m = re!(r"(\d+)% tests passed, (\d+) tests? failed out of (\d+)").captures(text);
    let (tot, f) = m.as_ref().map_or((0, 0), |m| (gn(m, 3), gn(m, 2)));
    let skipped = re!(r"\*\*\*Not Run|Disabled").find_iter(text).count();
    out.push(super::super::common::summary_line("ctest", tot.saturating_sub(f), f, skipped, Some(secs), ""));
    if f == 0 {
        return out;
    }
    let after = text.rsplit("The following tests FAILED:").next().unwrap_or("");
    let failed: Vec<(String, String)> =
        re!(r"(?m)^\s*\d+ - (\S+) \((\w[^)]*)\)").captures_iter(after).map(|c| (g(&c, 1).to_string(), g(&c, 2).to_string())).collect();
    let stop = re!(r"\n\s*Start\s+\d+:|\n\d+% tests");
    for (name, why) in failed.iter().take(nmax) {
        let start = Regex::new(&format!(r"Start\s+\d+: {}\n", regex::escape(name))).expect("start regex");
        let blk = start.find(text).and_then(|h| {
            let rest = &text[h.end()..];
            stop.find(rest).map(|e| &rest[..e.start()])
        });
        out.push(format!("FAIL {name} ({why})"));
        let body = blk.unwrap_or("").lines().filter(|l| fail_line().is_match(l)).take(14);
        out.extend(body.map(|l| format!("    {}", trunc(l.trim(), 220))));
    }
    out
}

fn test(ctx: &Ctx) -> i32 {
    let mut d = Diags::new(&ctx.root);
    let mut notes = Vec::new();
    let (rc, bd) = build(ctx, &mut d, &mut Vec::new(), &mut notes);
    for n in &notes {
        println!("note: {n}");
    }
    if d.count("E") > 0 {
        println!("cpp: build failed, {} errors", d.count("E"));
        d.print(30, false);
        return if rc != 0 { rc } else { 1 };
    }
    let kind = system(&ctx.root);
    if kind == "cmake" {
        let mut c = vec![need("ctest"), "--test-dir".into(), s(&bd), "--output-on-failure".into(), "-j".into(), jobs()];
        if multi_config(&rd(bd.join("CMakeCache.txt"))) && !ctx.extra.iter().any(|x| x == "-C" || x.starts_with("--build-config")) {
            c.extend(["-C".to_string(), "Debug".to_string()]); // the config `cmake --build` built by default
        }
        if let Some(f) = &ctx.flt {
            c.extend(["-R".to_string(), f.clone()]);
        }
        c.extend(ctx.extra.iter().cloned());
        let o = run(&c, &ctx.root, 3600);
        let text = lf(&format!("{}{}", o.stdout, o.stderr));
        if ctx.opt.raw {
            println!("{text}");
            return o.code;
        }
        if text.contains("No tests were found") {
            println!("ctest: no tests registered (enable_testing() + add_test / gtest_discover_tests)");
            return o.code;
        }
        for l in ctest_report(&text, o.secs, ctx.nmax) {
            println!("{l}");
        }
        return o.code;
    }
    if kind == "meson" {
        let mut c = vec![need("meson"), "test".into(), "-C".into(), s(&bd), "--print-errorlogs".into()];
        c.extend(ctx.flt.iter().cloned());
        let o = run(&c, &ctx.root, 3600);
        let text = lf(&format!("{}{}", o.stdout, o.stderr));
        if ctx.opt.raw {
            println!("{text}");
            return o.code;
        }
        let num = |rx: &Regex| rx.captures(&text).map(|c| g(&c, 1).to_string()).unwrap_or_else(|| "?".into());
        summary("meson test", num(re!(r"(?m)^Ok:\s+(\d+)")), num(re!(r"(?m)^Fail:\s+(\d+)")), 0, Some(o.secs), "");
        if o.code != 0 {
            for l in text.lines().filter(|l| fail_line().is_match(l)).take(40) {
                println!("    {}", trunc(l.trim(), 220));
            }
        }
        return o.code;
    }
    let mk = make();
    let tgt = if run(&[mk.as_str(), "-n", "check"], &ctx.root, 30).code == 0 { "check" } else { "test" };
    let o = run(&[mk.as_str(), tgt], &ctx.root, 3600);
    println!("make {tgt}: exit {} [{:.1}s]", o.code, o.secs);
    if o.code != 0 {
        let text = lf(&format!("{}{}", o.stdout, o.stderr));
        let lines: Vec<&str> = text.lines().filter(|l| fail_line().is_match(l)).map(|l| trunc(l.trim(), 220)).collect();
        println!("{}", trunc(&lines.join("\n"), 4000));
    }
    o.code
}

// ---------- dependencies ----------

/// Path below `root` excluded from CMake scans (build trees, vendored code).
fn vendored(p: &Path) -> bool {
    re!(r"/(build|_deps|third_party|external)/").is_match(&slash(&s(p)))
}

/// (name, source) from vcpkg.json, conanfile.txt/.py, CMake and meson.build.
fn declared(root: &Path) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let vj = root.join("vcpkg.json");
    if vj.exists() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&rd(&vj)) {
            for d in v.get("dependencies").and_then(|x| x.as_array()).into_iter().flatten() {
                let n = d.as_str().or_else(|| d.get("name").and_then(|x| x.as_str())).unwrap_or("None");
                out.push((n.to_string(), "vcpkg".into()));
            }
        }
    }
    let ct = root.join("conanfile.txt");
    if ct.exists() {
        let t = rd(&ct);
        if let Some(c) = re!(r"(?s)\[requires\]\n(.*?)(\n\[|\z)").captures(&t) {
            out.extend(g(&c, 1).lines().map(str::trim).filter(|l| !l.is_empty()).map(|l| (l.to_string(), "conan".to_string())));
        }
    }
    let cp = root.join("conanfile.py");
    if cp.exists() {
        let t = rd(&cp);
        out.extend(re!(r#"requires\(\s*["']([^"']+)"#).captures_iter(&t).map(|c| (g(&c, 1).to_string(), "conan".to_string())));
    }
    let mut cms = glob(root.join("**").join("CMakeLists.txt"));
    cms.extend(glob(root.join("cmake").join("*.cmake")));
    for cm in cms {
        if vendored(&cm) {
            continue;
        }
        let t = rd(&cm);
        let mut add = |rx: &Regex, src: &str| out.extend(rx.captures_iter(&t).map(|c| (g(&c, 1).to_string(), src.to_string())));
        add(re!(r"find_package\s*\(\s*(\w+)"), "find_package");
        add(re!(r"FetchContent_Declare\s*\(\s*(\w+)"), "FetchContent");
        add(re!(r#"CPMAddPackage\s*\(\s*(?:NAME\s+)?["']?(?:gh:[\w-]+/)?([\w-]+)"#), "CPM");
    }
    let mb = root.join("meson.build");
    if mb.exists() {
        let t = rd(&mb);
        out.extend(re!(r"dependency\s*\(\s*'([^']+)'").captures_iter(&t).map(|c| (g(&c, 1).to_string(), "meson".to_string())));
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|x| seen.insert(x.clone()));
    out
}

/// Header directories for pkg: FetchContent/CPM sources, vcpkg, conan, pkg-config, system.
fn include_dirs(root: &Path, pkg: &str) -> Vec<PathBuf> {
    let low = pkg.to_lowercase();
    let mut out: Vec<PathBuf> = Vec::new();
    for d in [build_dir(root, "cmake"), build_dir(root, "meson"), Some(root.join("build"))].into_iter().flatten() {
        out.extend(glob(d.join("_deps").join(format!("{low}-src"))));
        out.extend(glob(d.join("subprojects").join(format!("{low}*"))));
    }
    out.extend(glob(root.join("vcpkg_installed").join("*").join("include").join(&low)));
    out.extend(glob(root.join("vcpkg_installed").join("*").join("include").join(pkg)));
    if let Some(vr) = std::env::var_os("VCPKG_ROOT") {
        // vcpkg classic mode (common on Windows)
        out.extend(glob(Path::new(&vr).join("installed").join("*").join("include").join(&low)));
    }
    for sub in ["subprojects", "third_party", "external"] {
        out.extend(glob(root.join(sub).join(format!("{low}*"))));
    }
    let home = util::home();
    out.extend(glob(home.join(".conan2").join("p").join(format!("{low}*")).join("p").join("include")));
    out.extend(glob(home.join(".cpm").join(&low).join("*")));
    if let Some(pc) = exe("pkg-config", None) {
        let o = run(&[pc.as_str(), "--cflags-only-I", &low], root, 10);
        out.extend(o.stdout.split_whitespace().filter_map(|x| x.strip_prefix("-I")).map(PathBuf::from));
    }
    for sysd in ["/usr/include", "/usr/local/include", "/opt/homebrew/include"] {
        for c in [pkg, low.as_str()] {
            let p = Path::new(sysd).join(c);
            let h = Path::new(sysd).join(format!("{c}.h"));
            if p.is_dir() {
                out.push(p);
            } else if h.exists() {
                out.push(h);
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|p| p.exists() && seen.insert(p.clone()));
    out
}

const DECL: &str = r"^\s*(template\s*<.*>\s*)?(class|struct|enum(\s+class)?|union|namespace|using|typedef)\s+[A-Za-z_]\w*|^\s*(inline\s+|static\s+|constexpr\s+|extern\s+|virtual\s+|explicit\s+|[A-Z_]+_API\s+)*[\w:<>,*&\s]+?\b[A-Za-z_]\w*\s*\([^;{]*\)\s*(const)?\s*(noexcept)?\s*[;{]";

/// Declaration regex for one symbol: types by name, functions with type-ish tokens before the
/// name and a line that ends like code (not prose in a comment).
fn sym_decl(sym: &str) -> Regex {
    let e = regex::escape(sym);
    Regex::new(&format!(
        r"^\s*(template\s*<.*>\s*)?(class|struct|enum(\s+class)?|union|using|typedef)\s+(\w+\s+)?{e}\b|^\s*[\w\s*&:<>,]*[\w*&>]\s+\**{e}\s*\(.*([;{{,(]|\)\s*(const)?\s*(noexcept)?\s*(override)?)\s*$"
    ))
    .expect("decl regex")
}

fn deps(ctx: &Ctx) {
    let cmd = ctx.cmd.as_deref().unwrap_or("ls");
    let pkg = ctx.pkg.as_deref().unwrap_or("");
    if cmd == "ls" {
        let dl = declared(&ctx.root);
        for (n, src) in &dl {
            println!("{n} ({src})");
        }
        if dl.is_empty() {
            println!("no vcpkg.json / conanfile / find_package / FetchContent / meson dependency() found");
        }
        return;
    }
    if cmd == "why" {
        println!("C/C++ has no reverse-dependency query; see `deps ls` for declared sources");
        return;
    }
    let dirs = include_dirs(&ctx.root, pkg);
    if dirs.is_empty() {
        die("kit", &format!("{pkg}: no headers found (FetchContent _deps, vcpkg_installed, conan, pkg-config, /usr/include)"), 2);
    }
    if cmd == "where" {
        println!("{}", dirs.iter().map(|d| s(d)).collect::<Vec<_>>().join("\n"));
        return;
    }
    let skip = re!(r"/(test|tests|detail|internal|impl)/");
    let mut files: Vec<PathBuf> = Vec::new();
    for d in &dirs {
        if d.is_file() {
            files.push(d.clone());
        } else {
            files.extend(glob(d.join("**").join("*")).into_iter().filter(|f| {
                let fs = s(f);
                [".h", ".hpp", ".hh", ".hxx"].iter().any(|e| fs.ends_with(e)) && !skip.is_match(&slash(&fs))
            }));
        }
    }
    files.truncate(400);
    println!("{pkg}  {}", s(&dirs[0]));
    let base = if dirs[0].is_dir() { dirs[0].clone() } else { dirs[0].parent().map(Path::to_path_buf).unwrap_or_default() };
    let Some(sym) = ctx.sym.as_deref() else {
        let rx = Regex::new(DECL).expect("DECL");
        let lines: Vec<String> = outline(&files, &rx, &base, None, None).into_iter().filter(|l| !l.contains("operator")).collect();
        cap_print(&lines, ctx.cap);
        return;
    };
    let blk = |l: &[String], i: usize, loc: &str| doc_and_block(l, i, loc, "{", "}", None, 50);
    let mut lines = outline(&files, &sym_decl(sym), &base, Some(sym), Some(&blk));
    if lines.is_empty() {
        lines.push(format!("no declaration named {sym}"));
    }
    cap_print(&lines, ctx.cap);
}

// ---------- project facts ----------

fn first_line(cmd: &[String], d: &Path) -> String {
    run(cmd, d, 10).stdout.lines().next().unwrap_or("").to_string()
}

fn proj(ctx: &Ctx) {
    let d = &ctx.root;
    let kind = system(d);
    let cc: Vec<String> = ["g++", "clang++"].iter().filter_map(|c| exe(c, None)).map(|c| first_line(&[c, "--version".into()], d)).collect();
    if kind == "cmake" {
        let t = rd(d.join("CMakeLists.txt"));
        let p = re!(r"(?s)project\s*\(\s*(\w+)([^)]*)\)").captures(&t);
        let std = re!(r"CMAKE_CXX_STANDARD\s+(\d+)|cxx_std_(\d+)")
            .captures(&t)
            .and_then(|c| [1, 2].iter().map(|&i| g(&c, i)).find(|x| !x.is_empty()).map(str::to_string))
            .unwrap_or_else(|| "?".into());
        let ver = match exe("cmake", None) {
            Some(cm) => run(&[cm.as_str(), "--version"], d, 10).stdout.split_whitespace().nth(2).unwrap_or("").to_string(),
            None => "not installed".into(),
        };
        let (name, rest) = match &p {
            Some(c) => (g(c, 1), if g(c, 2).trim().is_empty() { String::new() } else { format!(" {}", ws(g(c, 2))) }),
            None => ("?", String::new()),
        };
        println!("cpp (cmake {ver}): {name}{rest}  C++{std}");
        let mut tg = Vec::new();
        for cm in glob(d.join("**").join("CMakeLists.txt")) {
            if vendored(&cm) {
                continue;
            }
            let ct = rd(&cm);
            for c in re!(r"(add_executable|add_library)\s*\(\s*(\w+)").captures_iter(&ct) {
                tg.push(format!("{}({})", g(&c, 2), trunc(g(&c, 1).split('_').nth(1).unwrap_or(""), 3)));
            }
        }
        if !tg.is_empty() {
            println!("  targets ({}): {}", tg.len(), tg.iter().take(20).cloned().collect::<Vec<_>>().join(", "));
        }
        let bd = build_dir(d, "cmake").map(relcwd).unwrap_or_else(|| "none (kit check configures build/)".into());
        let tests = if re!(r"enable_testing|add_test|gtest_discover|catch_discover").is_match(&t) { "ctest" } else { "none registered at top level" };
        println!("  build dir: {bd}; tests: {tests}");
    } else if kind == "meson" {
        let t = rd(d.join("meson.build"));
        let p = re!(r"project\s*\(\s*'([^']+)'").captures(&t).map(|c| g(&c, 1).to_string()).unwrap_or_else(|| "?".into());
        println!("cpp (meson): {p}");
    } else {
        let t = ["Makefile", "makefile", "GNUmakefile"].iter().map(|f| d.join(f)).find(|p| p.exists()).map(rd).unwrap_or_default();
        println!("cpp (make): targets: {}", trunc(&make_targets(&t).join(", "), 200));
    }
    if !cc.is_empty() {
        println!("  compilers: {}", cc.join("; "));
    }
    let dl = declared(d);
    if !dl.is_empty() {
        println!("  deps {}: {}", dl.len(), dl.iter().take(15).map(|x| x.0.as_str()).collect::<Vec<_>>().join(", "));
    }
    let n: usize = [".c", ".cc", ".cpp", ".cxx"].iter().map(|e| glob(d.join("**").join(format!("*{e}"))).len()).sum();
    println!("  source files: {n}");
}

/// Makefile rule names (python `^([a-zA-Z][\w.-]*):(?!=)`), unique, in order.
fn make_targets(t: &str) -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    for c in re!(r"(?m)^([a-zA-Z][\w.-]*):").captures_iter(t) {
        let end = c.get(0).map_or(0, |m| m.end());
        if t[end..].starts_with('=') {
            continue;
        }
        let n = g(&c, 1).to_string();
        if !v.contains(&n) {
            v.push(n);
        }
    }
    v
}

// ---------- formatting ----------

fn fmt(ctx: &Ctx, files: &[PathBuf], check: bool) -> (Vec<String>, Vec<String>) {
    let Some(cf) = exe("clang-format", None) else { return (Vec::new(), vec!["clang-format not found: C/C++ skipped".into()]) };
    let mut d: &Path = &ctx.root;
    while ![".clang-format", "_clang-format"].iter().any(|f| d.join(f).exists()) {
        match d.parent() {
            Some(p) => d = p,
            None => return (Vec::new(), vec!["no .clang-format: C/C++ left untouched (would impose LLVM style)".into()]),
        }
    }
    let mut c = vec![cf];
    if check {
        c.extend(["--dry-run".to_string(), "--Werror".to_string()]);
    } else {
        c.push("-i".into());
    }
    c.extend(files.iter().map(|f| s(f)));
    let o = run(&c, &ctx.root, 900);
    if !check {
        return (Vec::new(), Vec::new());
    }
    (clang_format_files(&o.stderr), Vec::new())
}

/// Files named in `clang-format --dry-run` warnings, sorted, unique.
fn clang_format_files(err: &str) -> Vec<String> {
    let mut v: Vec<String> = err
        .lines()
        .filter_map(|l| pmatch(re!(r"^(\S+?):\d+:\d+: (?:error|warning)"), l).map(|m| g(&m, 1).to_string()))
        .collect();
    v.sort();
    v.dedup();
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(d: &Diags) -> Vec<(String, usize, usize, String, String, String)> {
        d.items.iter().map(|x| (x.file.replace('\\', "/"), x.line, x.col, x.sev.clone(), x.code.clone(), x.msg.clone())).collect()
    }

    #[test]
    fn gcc_clang_unix_and_windows() {
        let mut d = Diags::new(Path::new("/p/build"));
        let out = "[1/2] Building CXX object CMakeFiles/app.dir/main.cpp.o\n\
/p/main.cpp:5:10: error: 'y' was not declared in this scope\n\
../src/util.cpp:3:1: warning: unused variable 'z' [-Wunused-variable]\r\n\
C:\\p\\src\\win.cpp:7:2: error: expected ';' after expression\n\
In file included from /p/a.h:1:\n\
/usr/bin/ld: main.o: in function `main':\nmain.cpp:(.text+0x5): undefined reference to `foo()'\n";
        parse_gnu(&mut d, &lf(out), Path::new("/p/build"), false);
        let v = files(&d);
        assert!(v.iter().any(|x| x.0.ends_with("p/main.cpp") && x.1 == 5 && x.2 == 10 && x.3 == "E"), "{v:?}");
        assert!(v.iter().any(|x| x.0.ends_with("src/util.cpp") && x.3 == "W" && x.4 == "-Wunused-variable"));
        assert!(v.iter().any(|x| x.0.ends_with("C:/p/src/win.cpp") && x.1 == 7 && x.2 == 2));
        assert!(v.iter().any(|x| x.4 == "ld" && x.5 == "undefined reference to foo()"));
    }

    #[test]
    fn msvc_format() {
        let mut d = Diags::new(Path::new("C:\\p"));
        let out = "  main.cpp\n\
C:\\p\\src\\main.cpp(12,5): error C2065: 'nope': undeclared identifier [C:\\p\\build\\app.vcxproj]\n\
  C:\\p\\src\\util.h(3): warning C4996: 'strcpy': This function may be unsafe. [C:\\p\\build\\app.vcxproj]\n\
C:\\p\\src\\x.cpp(1): fatal error C1083: Cannot open include file: 'nope.h': No such file or directory\n\
C:\\p\\src\\cl.cpp(4,9): error: use of undeclared identifier 'q'\n\
main.obj : error LNK2019: unresolved external symbol \"void __cdecl foo(void)\" referenced in function main [C:\\p\\build\\app.vcxproj]\n";
        parse_msvc(&mut d, out);
        let v = files(&d);
        assert_eq!(v.len(), 5, "{v:?}");
        assert!(v[0].0.ends_with(r"C:/p/src/main.cpp") && v[0].1 == 12 && v[0].2 == 5 && v[0].3 == "E" && v[0].4 == "C2065");
        assert_eq!(v[0].5, "'nope': undeclared identifier");
        assert_eq!((v[1].1, v[1].2, v[1].3.as_str(), v[1].4.as_str()), (3, 0, "W", "C4996"));
        assert_eq!((v[2].3.as_str(), v[2].4.as_str()), ("F", "C1083"));
        assert_eq!((v[3].1, v[3].2, v[3].4.as_str()), (4, 9, ""));
        assert_eq!((v[4].0.as_str(), v[4].4.as_str()), ("", "LNK2019"));
        assert!(v[4].5.starts_with("main.obj: unresolved external symbol") && !v[4].5.contains("vcxproj"));
    }

    #[test]
    fn ctest_output() {
        let text = "Test project /p/build\n\
    Start 1: adds\n1/3 Test #1: adds .............................   Passed    0.00 sec\n\
    Start 2: subs\n2/3 Test #2: subs .............................***Failed    0.01 sec\n\
/p/test/t.cpp:9: Failure\nExpected equality of these values:\n  sub(3, 1)\n    Which is: 2\n  3\nnoise line\n\
    Start 3: crash\n3/3 Test #3: crash ............................***Exception: SegFault  0.01 sec\n\
\n33% tests passed, 2 tests failed out of 3\n\nTotal Test time (real) =   0.03 sec\n\n\
The following tests FAILED:\n\t  2 - subs (Failed)\n\t  3 - crash (SEGFAULT)\nErrors while running CTest\n";
        let v = ctest_report(text, 0.5, 10);
        assert_eq!(v[0], "ctest: 1 passed, 2 failed [0.5s]");
        assert_eq!(v[1], "FAIL subs (Failed)");
        assert!(v.contains(&"    /p/test/t.cpp:9: Failure".to_string()) && v.contains(&"    Which is: 2".to_string()));
        assert!(!v.iter().any(|l| l.contains("noise")));
        assert!(v.contains(&"FAIL crash (SEGFAULT)".to_string()));
        // Windows: CRLF (normalized by lf) and drive paths
        let w = lf("    Start 1: t\r\n1/1 Test #1: t ...***Failed\r\nC:\\p\\t.cpp(4): error: Value of: x\r\n\r\n0% tests passed, 1 tests failed out of 1\r\nThe following tests FAILED:\r\n\t  1 - t (Failed)\r\n");
        let v = ctest_report(&w, 0.1, 10);
        assert_eq!(v[0], "ctest: 0 passed, 1 failed [0.1s]");
        assert_eq!(v[2], r"    C:\p\t.cpp(4): error: Value of: x");
    }

    #[test]
    fn generators_and_targets() {
        assert_eq!(keep_going("CMAKE_GENERATOR:INTERNAL=Ninja\n"), vec!["--", "-k", "0"]);
        assert!(keep_going("CMAKE_GENERATOR:INTERNAL=Visual Studio 17 2022\n").is_empty());
        assert_eq!(keep_going("CMAKE_GENERATOR:INTERNAL=Unix Makefiles\n"), vec!["--", "-k"]);
        assert!(multi_config("CMAKE_GENERATOR:INTERNAL=Visual Studio 17 2022") && !multi_config("CMAKE_GENERATOR:INTERNAL=Ninja"));
        assert_eq!(make_targets("CC:=gcc\nall: app\napp: main.o\n.PHONY: all\nall: x\ntest:\n"), vec!["all", "app", "test"]);
        assert_eq!(
            clang_format_files("C:\\p\\a.cpp:1:2: warning: code should be clang-formatted [-Wclang-format-violations]\n/p/b.h:3:4: error: x\n"),
            vec!["/p/b.h".to_string(), "C:\\p\\a.cpp".to_string()]
        );
    }

    #[test]
    fn decl_regexes() {
        let rx = Regex::new(DECL).unwrap();
        assert!(pmatch(&rx, "class Foo {").is_some());
        assert!(pmatch(&rx, "inline int add(int a, int b);").is_some());
        assert!(pmatch(&rx, "// just prose (here);").is_none());
        let r = sym_decl("add");
        assert!(pmatch(&r, "int add(int a, int b);").is_some());
        assert!(pmatch(&r, "add(1, 2);").is_none());
    }
}
