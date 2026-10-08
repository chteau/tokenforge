//! Scala: sbt (compile, test with JUnit XML reports), coursier cache + javap for dependency APIs, scalafmt.
//! Port of `kit/langs/scala.py`.

use super::super::common::{cap_print, exe, g, glob, gn, junit, newest, pmatch, re, run, s, tail, trunc, Ctx, Diags};
use super::java::{base, fix_path, jar_api, jar_candidates, lf, rd, slash};
use super::Lang;
use crate::kit::util::die;
use regex::Regex;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub const LANG: Lang = Lang { name: "scala", fmt_ext: &[".scala", ".sbt", ".sc"], check, test, deps, proj, fmt };

fn sbt() -> String {
    exe("sbt", None).unwrap_or_else(|| die("kit", "sbt not found", 2))
}

/// `[error] /abs/A.scala:3:5: msg`, scala 3 `[error] -- [E006] Not Found Error: /abs/A.scala:3:10 `;
/// Windows paths `C:\x\A.scala`, `/C:/x/A.scala`.
fn err_rx() -> &'static Regex {
    re!(r"^\[(error|warn)\]\s+(?:-- (?:\[\w+\] )?[\w ]+: )?((?:/?[A-Za-z]:)?[/\\][^\s:]+?\.(?:scala|java|sc)):(\d+):(\d+):?\s*(.*)$")
}

pub fn parse(d: &mut Diags, text: &str) {
    let text = lf(text);
    let lines: Vec<&str> = text.lines().collect();
    let cont = re!(r"^\[(?:error|warn)\]\s*(\d*)\s*\|\s?(.*)$");
    let marks = re!(r"^[\s^~]*$");
    for (i, ln) in lines.iter().enumerate() {
        let Some(m) = pmatch(err_rx(), ln.trim()) else { continue };
        let mut msg = g(&m, 5).trim().to_string();
        if msg.is_empty() {
            // scala 3: "[error] 3 |  code", "[error]   |  ^^^^", "[error]   |  Not found: nope"
            for l in lines.iter().skip(i + 1).take(9) {
                let Some(m2) = pmatch(cont, l) else { break };
                if !g(&m2, 1).is_empty() || marks.is_match(g(&m2, 2)) {
                    continue; // code line / caret line
                }
                msg = g(&m2, 2).trim().to_string();
                break;
            }
        }
        d.add(fix_path(g(&m, 2)), gn(&m, 3), gn(&m, 4), if g(&m, 1) == "error" { "E" } else { "W" }, "", &msg, None);
    }
}

fn check(ctx: &Ctx, d: &mut Diags, used: &mut Vec<String>) {
    used.push("sbt compile".into());
    let o = run(&[sbt().as_str(), "-batch", "-no-colors", "compile", "Test/compile"], &ctx.root, 3600);
    let (out, err) = (lf(&o.stdout), lf(&o.stderr));
    parse(d, &format!("{out}\n{err}"));
    if o.code != 0 && d.count("E") == 0 {
        let both = format!("{out}{err}");
        let hits: Vec<&str> = both.lines().filter(|l| l.starts_with("[error]")).collect();
        let t = if hits.is_empty() { out.clone() } else { hits.join("\n") };
        d.add("", 0, 0, "E", "sbt", &tail(&t, 8), None);
    }
}

/// Summary + failure lines from plain sbt output when no JUnit XML was written.
fn text_summary(out: &str, code: i32, secs: f64) -> Vec<String> {
    let m = re!(r"Passed: Total (\d+), Failed (\d+), Errors (\d+), Passed (\d+)").captures(out);
    let head = match m {
        Some(m) => format!("sbt: {} passed, {} failed [{secs:.1}s]", g(&m, 4), gn(&m, 2) + gn(&m, 3)),
        None => format!("sbt test: exit {code}"),
    };
    let fl = re!(r"\*\*\* FAILED|==> X|failed:|\[error\]");
    let body: Vec<&str> = out.lines().filter(|l| fl.is_match(l)).collect();
    vec![head, trunc(&body.join("\n"), 4000).to_string()]
}

fn test(ctx: &Ctx) -> i32 {
    let t = SystemTime::now();
    let task = match &ctx.flt {
        Some(f) => format!("testOnly *{f}*"),
        None => "test".into(),
    };
    let mut cmd = vec![sbt(), "-batch".into(), "-no-colors".into(), task];
    cmd.extend(ctx.extra.iter().cloned());
    let o = run(&cmd, &ctx.root, 3600);
    let (out, err) = (lf(&o.stdout), lf(&o.stderr));
    if ctx.opt.raw {
        println!("{out}{err}");
        return o.code;
    }
    let pats = vec![s(&ctx.root.join("**").join("target").join("test-reports").join("*.xml"))];
    let reports: Vec<String> = newest(&pats, t).iter().map(|p| s(p)).collect();
    if !reports.is_empty() {
        junit(&reports, "sbt", Some(o.secs), ctx.nmax, None);
        return o.code;
    }
    let mut d = Diags::new(&ctx.root);
    parse(&mut d, &format!("{out}{err}"));
    if d.count("E") > 0 {
        println!("sbt: compile failed, {} errors", d.count("E"));
        d.print(30, false);
    } else {
        for l in text_summary(&out, o.code, o.secs) {
            println!("{l}");
        }
    }
    o.code
}

// ---------- dependencies ----------

/// (group, artifact, version, config) from build.sbt `"g" %% "a" % "v" % Test`.
fn declared(root: &Path) -> Vec<(String, String, String, String)> {
    let t = rd(root.join("build.sbt"));
    re!(r#""([\w.-]+)"\s*%%?%?\s*"([\w.-]+)"\s*%\s*"([^"]+)"(?:\s*%\s*(\w+))?"#)
        .captures_iter(&t)
        .map(|c| (g(&c, 1).to_string(), g(&c, 2).to_string(), g(&c, 3).to_string(), g(&c, 4).to_string()))
        .collect()
}

/// Cached jars of `art` (any `_2.13` / `_3` cross suffix), preferring version `ver`.
fn jars_for(group: &str, art: &str, ver: Option<&str>) -> Vec<String> {
    let rx = Regex::new(&format!(r"[/\\]{}(_[\d.]+)?[/\\]", regex::escape(art))).expect("art regex");
    let jars: Vec<String> = jar_candidates(group, &format!("{art}*"), None).into_iter().filter(|j| rx.is_match(j)).collect();
    match ver {
        Some(v) => {
            let want = format!("/{v}/");
            let hit: Vec<String> = jars.iter().filter(|j| slash(j).contains(&want)).cloned().collect();
            if hit.is_empty() { jars } else { hit }
        }
        None => jars,
    }
}

fn deps(ctx: &Ctx) {
    let root = &ctx.root;
    let cmd = ctx.cmd.as_deref().unwrap_or("ls");
    let pkg = ctx.pkg.as_deref().unwrap_or("");
    let dl = declared(root);
    if cmd == "ls" {
        for (gr, a, v, sc) in &dl {
            println!("{gr}:{a} {v}{}", if sc.is_empty() { String::new() } else { format!(" ({sc})") });
        }
        return;
    }
    if cmd == "why" {
        let o = run(&[sbt(), "-batch".into(), "-no-colors".into(), format!("whatDependsOn {}", pkg.replace(':', " "))], root, 900);
        let lines: Vec<String> = lf(&o.stdout).lines().filter(|l| !l.starts_with("[info] welcome")).map(str::to_string).collect();
        cap_print(&lines, ctx.cap);
        return;
    }
    let (group, art) = match pkg.rfind(':') {
        Some(i) => (&pkg[..i], &pkg[i + 1..]),
        None => ("", pkg),
    };
    let ver = dl.iter().find(|x| x.1 == art && (group.is_empty() || x.0 == group)).map(|x| x.2.clone());
    let jars = jars_for(group, art, ver.as_deref());
    let Some(jar) = jars.last() else { die("kit", &format!("{pkg}: no jar in coursier/ivy/m2 caches (sbt update)"), 2) };
    let v = ver.as_deref().unwrap_or("");
    if cmd == "where" {
        println!("{pkg} {v}  {jar}");
        return;
    }
    jar_api(jar, ctx.sym.as_deref(), ctx.cap, &format!("{pkg} {v}"));
}

// ---------- project facts ----------

fn proj(ctx: &Ctx) {
    let d = &ctx.root;
    let t = rd(d.join("build.sbt"));
    let cap1 = |rx: &Regex, t: &str| rx.captures(t).map(|c| g(&c, 1).to_string());
    let sv = cap1(re!(r#"scalaVersion\s*:=\s*"([^"]+)""#), &t).unwrap_or_else(|| "?".into());
    let n = cap1(re!(r#"name\s*:=\s*"([^"]+)""#), &t).unwrap_or_else(|| base(d));
    let bp = d.join("project").join("build.properties");
    let sb = if bp.exists() { cap1(re!(r"sbt\.version\s*=\s*(\S+)"), &rd(&bp)) } else { None };
    println!("scala: {n}  scala {sv}  sbt {}", sb.as_deref().unwrap_or("?"));
    let sub: Vec<&str> = re!(r"lazy val (\w+)\s*=\s*(?:\(?project|crossProject)").captures_iter(&t).map(|c| c.get(1).map_or("", |m| m.as_str())).collect();
    if !sub.is_empty() {
        println!("  projects: {}", sub.join(", "));
    }
    let pl = d.join("project").join("plugins.sbt");
    if pl.exists() {
        let pt = rd(&pl);
        let names: Vec<&str> =
            re!(r#"addSbtPlugin\("([\w.-]+)"\s*%\s*"([\w.-]+)""#).captures_iter(&pt).map(|c| c.get(2).map_or("", |m| m.as_str())).collect();
        println!("  plugins: {}", names.join(", "));
    }
    let count = |sub: &str| glob(d.join("**").join("src").join(sub).join("**").join("*.scala")).len();
    println!("  deps {}; .scala files: {}, tests: {}", declared(d).len(), count("main"), count("test"));
}

fn fmt(ctx: &Ctx, files: &[PathBuf], check: bool) -> (Vec<String>, Vec<String>) {
    let Some(sf) = exe("scalafmt", None) else { return (Vec::new(), vec!["scalafmt not found: .scala skipped".into()]) };
    let mut c = vec![sf];
    if check {
        c.push("--list".into());
    }
    c.extend(files.iter().map(|f| s(f)));
    let o = run(&c, &ctx.root, 900);
    (if check { o.stdout.split_whitespace().map(str::to_string).collect() } else { Vec::new() }, Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scala2_scala3_windows() {
        let mut d = Diags::new(Path::new("/p"));
        let out = "[info] compiling 2 Scala sources\n\
[error] /p/src/main/scala/A.scala:3:5: not found: value nope\n\
[warn] /p/src/main/scala/B.scala:10:3: method x in class Y is deprecated\r\n\
[error] -- [E006] Not Found Error: /p/src/main/scala/C.scala:4:10 \n\
[error] 4 |  val x = nope\n\
[error]   |          ^^^^\n\
[error]   |          Not found: nope\n\
[error] C:\\p\\src\\main\\scala\\W.scala:7:1: ';' expected but '}' found.\n\
[error] -- Error: /C:/p/src/main/scala/V.scala:2:3 \n\
[error] 2 | x\n\
[error]   | ^\n\
[error]   | Missing return type\n\
[error] (Compile / compileIncremental) Compilation failed\n";
        parse(&mut d, out);
        let got: Vec<(String, usize, usize, String, String)> =
            d.items.iter().map(|x| (x.file.replace('\\', "/"), x.line, x.col, x.sev.clone(), x.msg.clone())).collect();
        assert_eq!(got.len(), 5, "{got:?}");
        assert!(got[0].0.ends_with("scala/A.scala") && got[0].1 == 3 && got[0].2 == 5 && got[0].4 == "not found: value nope");
        assert_eq!((got[1].3.as_str(), got[1].1), ("W", 10));
        assert_eq!((got[2].1, got[2].2, got[2].4.as_str()), (4, 10, "Not found: nope"));
        assert!(got[3].0.ends_with("C:/p/src/main/scala/W.scala") && got[3].1 == 7);
        assert!(got[4].0.ends_with("C:/p/src/main/scala/V.scala") && got[4].4 == "Missing return type", "{:?}", got[4]);
    }

    #[test]
    fn plain_test_summary() {
        let out = "[info] - adds *** FAILED ***\n[info]   2 did not equal 3 (AddSpec.scala:7)\n[error] Failed: Total 3, Failed 1, Errors 0, Passed 2\n\
[info] Passed: Total 3, Failed 1, Errors 0, Passed 2\n";
        let v = text_summary(out, 1, 2.0);
        assert_eq!(v[0], "sbt: 2 passed, 1 failed [2.0s]");
        assert!(v[1].contains("*** FAILED") && v[1].contains("[error] Failed: Total"));
        assert_eq!(text_summary("x", 3, 0.0)[0], "sbt test: exit 3");
    }

    #[test]
    fn sbt_declared_and_jar_filter() {
        let d = std::env::temp_dir().join(format!("kit-scala-decl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(
            d.join("build.sbt"),
            "libraryDependencies ++= Seq(\r\n  \"org.typelevel\" %% \"cats-core\" % \"2.10.0\",\r\n  \"org.scalameta\" %% \"munit\" % \"1.0.0\" % Test\r\n)\r\n",
        )
        .unwrap();
        assert_eq!(
            declared(&d),
            vec![
                ("org.typelevel".into(), "cats-core".into(), "2.10.0".into(), String::new()),
                ("org.scalameta".into(), "munit".into(), "1.0.0".into(), "Test".into())
            ]
        );
        let _ = std::fs::remove_dir_all(&d);
        let rx = Regex::new(&format!(r"[/\\]{}(_[\d.]+)?[/\\]", regex::escape("cats-core"))).unwrap();
        assert!(rx.is_match(r"C:\Users\u\AppData\Local\Coursier\cache\v1\https\repo1.maven.org\maven2\org\typelevel\cats-core_2.13\2.10.0\cats-core_2.13-2.10.0.jar"));
        assert!(!rx.is_match("/c/org/typelevel/cats-core-extra_2.13/1/x.jar"));
    }
}
