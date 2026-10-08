//! Ruby: Bundler, RuboCop/Standard, Sorbet, RSpec/Minitest (port of `kit/langs/ruby.py`).

use super::super::common::{
    cap_print, die, exe, fail_lines, g, generic_failures, glob, gn, normpath, outline, pmatch, pystr, re, read, run, s, summary_line, tail, Ctx,
    Diags,
};
use super::php::{label, local_launcher};
use super::Lang;
use regex::Regex;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const LANG: Lang = Lang { name: "ruby", fmt_ext: &[".rb", ".rake", ".gemspec"], check, test, deps, proj, fmt };

/// CRLF -> LF (python text mode does this for files and subprocess output).
fn nl(t: &str) -> String {
    t.replace("\r\n", "\n")
}

/// `bundle exec name` when Gemfile.lock has it, else the `bin/` binstub (Windows: `.bat`/`.cmd`, or the
/// ruby script run through `ruby`), else PATH.
fn bx(root: &Path, name: &str) -> Option<Vec<String>> {
    if let Some(stub) = local_launcher(&root.join("bin"), name, "ruby") {
        return Some(stub);
    }
    if let Some(b) = exe("bundle", None) {
        let lock = nl(&read(root.join("Gemfile.lock")));
        let rx = Regex::new(&format!(r"(?m)^\s{{4}}{} \(", regex::escape(name))).expect("gem regex");
        if root.join("Gemfile.lock").exists() && rx.is_match(&lock) {
            return Some(vec![b, "exec".into(), name.into()]);
        }
    }
    exe(name, None).map(|e| vec![e])
}

fn with(base: &[String], args: &[&str]) -> Vec<String> {
    base.iter().cloned().chain(args.iter().map(|a| a.to_string())).collect()
}

fn in_vendor(p: &Path, root: &Path) -> bool {
    p.strip_prefix(root).unwrap_or(p).components().any(|c| c.as_os_str() == "vendor")
}

fn rb_files(root: &Path) -> Vec<PathBuf> {
    glob(root.join("**").join("*.rb")).into_iter().filter(|f| !in_vendor(f, root)).collect()
}

/// `rubocop --format json` / `standardrb --format json`. Err when stdout is not JSON.
fn parse_rubocop(d: &mut Diags, out: &str, root: &Path) -> Result<(), ()> {
    let v: Value = serde_json::from_str(out).map_err(|_| ())?;
    for f in v["files"].as_array().into_iter().flatten() {
        let path = root.join(f["path"].as_str().unwrap_or(""));
        for o in f["offenses"].as_array().into_iter().flatten() {
            let sev = if matches!(o["severity"].as_str(), Some("error" | "fatal")) { "E" } else { "W" };
            let loc = &o["location"];
            d.add(
                &s(&path),
                loc["line"].as_u64().unwrap_or(0) as usize,
                loc["column"].as_u64().unwrap_or(0) as usize,
                sev,
                o["cop_name"].as_str().unwrap_or(""),
                o["message"].as_str().unwrap_or(""),
                None,
            );
        }
    }
    Ok(())
}

/// `srb tc` stderr: `path:line: message https://srb.help/NNNN`.
fn parse_sorbet(d: &mut Diags, err: &str, root: &Path) {
    for m in re!(r"(?m)^(.+?\.rb):(\d+): (.*?) https://srb\.help/(\d+)").captures_iter(err) {
        d.add(&s(&root.join(g(&m, 1))), gn(&m, 2), 0, "E", &format!("srb{}", g(&m, 4)), g(&m, 3), None);
    }
}

/// `ruby -wc` stderr: `path:line: [warning: ]message`.
fn parse_rubywc(d: &mut Diags, err: &str) {
    for m in re!(r"(?m)^(.+?\.rb):(\d+): (warning: )?(.*)$").captures_iter(err) {
        d.add(g(&m, 1), gn(&m, 2), 0, if m.get(3).is_some() { "W" } else { "E" }, "ruby", g(&m, 4), None);
    }
}

fn check(ctx: &Ctx, d: &mut Diags, used: &mut Vec<String>) {
    let root = &ctx.root;
    let rc_ = bx(root, "rubocop").or_else(|| bx(root, "standardrb"));
    if let Some(rc_) = &rc_ {
        used.push(label(rc_));
        let o = run(&with(rc_, &["--format", "json"]), root, 1800);
        if parse_rubocop(d, &o.stdout, root).is_err() {
            let t = nl(if o.stderr.is_empty() { &o.stdout } else { &o.stderr });
            d.add("", 0, 0, "W", "rubocop", &tail(&t, 4), None);
        }
    }
    if let Some(srb) = bx(root, "srb").filter(|_| root.join("sorbet").is_dir() && !ctx.opt.fast) {
        used.push("sorbet".into());
        let o = run(&with(&srb, &["tc"]), root, 1800);
        parse_sorbet(d, &nl(&o.stderr), root);
    }
    if rc_.is_none() {
        let Some(rb) = exe("ruby", None) else { die("kit", "ruby not found", 2) };
        d.notes.push("no rubocop/standardrb: ruby -wc syntax check only".into());
        used.push("ruby -wc".into());
        for f in rb_files(root).into_iter().take(500) {
            let o = run(&[rb.as_str(), "-wc", &s(&f)], root, 30);
            parse_rubywc(d, &nl(&o.stderr));
        }
    }
}

fn tmpdir(prefix: &str) -> PathBuf {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let d = std::env::temp_dir().join(format!("{prefix}{}-{n}", std::process::id()));
    let _ = std::fs::create_dir_all(&d);
    d
}

/// Summary + failures from an rspec JSON report; `text` = runner output (for load errors).
fn rspec_report(r: &Value, text: &str, secs: f64, nmax: usize) -> Vec<String> {
    let sm = &r["summary"];
    let n = |k: &str| sm[k].as_i64().unwrap_or(0);
    let (ex, fail, pend) = (n("example_count"), n("failure_count"), n("pending_count"));
    let mut out = vec![summary_line("rspec", ex - fail - pend, fail, pend.max(0) as usize, Some(secs), "")];
    if n("errors_outside_of_examples_count") != 0 {
        out.push(tail(text, 15));
    }
    let failed = r["examples"].as_array().into_iter().flatten().filter(|e| e["status"].as_str() == Some("failed"));
    for e in failed.take(nmax) {
        let x = &e["exception"];
        let bt = x["backtrace"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .find(|l| !l.contains("/gems/") && !l.contains("\\gems\\") && !l.contains("rspec-"));
        let place = bt.map(str::to_string).unwrap_or_else(|| {
            format!("{}:{}", pystr(&e["file_path"]), pystr(&e["line_number"]))
        });
        let place = place.split(":in").next().unwrap_or("").to_string();
        let name = e.get("full_description").map(pystr).unwrap_or_else(|| "None".into());
        let body = format!("{}: {}", x["class"].as_str().unwrap_or(""), x["message"].as_str().unwrap_or(""));
        out.extend(fail_lines(&name, &body, Some(&place)));
    }
    out
}

/// Minitest `Failure:` / `Error:` blocks (python `^\s*(?:Failure|Error):\n(.*?)(?=\n\n)`, re.S|re.M).
/// Also accepts the numbered `  1) Failure:` header of the plain minitest reporter.
fn minitest_blocks(text: &str) -> Vec<&str> {
    let hdr = re!(r"(?m)^\s*(?:\d+\) )?(?:Failure|Error):\n");
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(h) = hdr.find_at(text, at) {
        let Some(end) = text[h.end()..].find("\n\n") else { break };
        out.push(&text[h.end()..h.end() + end]);
        at = h.end() + end;
    }
    out
}

/// Summary + failures for minitest / rails test output; `label` = runner shown when no summary line.
fn minitest_report(text: &str, rc: i32, secs: f64, nmax: usize, label: &str) -> Vec<String> {
    let mut out = Vec::new();
    let m = re!(r"(\d+) (?:runs|tests), \d+ assertions, (\d+) failures, (\d+) errors, (\d+) skips").captures(text);
    match &m {
        Some(m) => {
            let (r, f, e, sk) = (gn(m, 1) as i64, gn(m, 2) as i64, gn(m, 3) as i64, gn(m, 4));
            out.push(summary_line("minitest", r - f - e - sk as i64, f + e, sk, Some(secs), ""));
        }
        None => out.push(format!("{label}: exit {rc} [{secs:.1}s]")),
    }
    let loc_rx = re!(r"\[?((?:[A-Za-z]:)?[\w/\\.-]+\.rb):(\d+)");
    for b in minitest_blocks(text).into_iter().take(nmax) {
        let lines: Vec<&str> = b.lines().collect();
        let Some(first) = lines.first() else { continue };
        let place = loc_rx.captures(b).map(|c| format!("{}:{}", g(&c, 1), g(&c, 2)));
        out.extend(fail_lines(first.trim(), &lines[1..].join("\n"), place.as_deref()));
    }
    if rc != 0 && m.is_none() {
        out.push(generic_failures(text, 60));
    }
    out
}

fn emit(lines: Vec<String>) {
    for l in lines {
        println!("{l}");
    }
}

fn test(ctx: &Ctx) -> i32 {
    let root = &ctx.root;
    if let Some(rspec) = bx(root, "rspec").filter(|_| root.join("spec").is_dir()) {
        let dir = tmpdir("kit-rb-");
        let rep = dir.join("r.json");
        let mut cmd = with(&rspec, &["--format", "json", "--out", &s(&rep), "--format", "progress"]);
        if let Some(f) = &ctx.flt {
            cmd.extend(["-e".into(), f.clone()]);
        }
        cmd.extend(ctx.extra.iter().cloned());
        let o = run(&cmd, root, 3600);
        let text = nl(&format!("{}{}", o.stdout, o.stderr));
        if ctx.opt.raw {
            println!("{text}");
        } else if !rep.exists() {
            println!("rspec: no report (load error?)");
            println!("{}", tail(&text, 20));
        } else {
            let r: Value = serde_json::from_str(&read(&rep)).unwrap_or(Value::Null);
            emit(rspec_report(&r, &text, o.secs, ctx.nmax));
        }
        let _ = std::fs::remove_dir_all(&dir);
        return o.code;
    }
    let rails = local_launcher(&root.join("bin"), "rails", "ruby");
    let mut cmd = match &rails {
        Some(r) => with(r, &["test"]),
        None => {
            let rake = bx(root, "rake").unwrap_or_else(|| match exe("rake", None) {
                Some(r) => vec![r],
                None => die("kit", "rake not found", 2),
            });
            with(&rake, &["test"])
        }
    };
    let shown = {
        let base = |x: &str| label(&[x.to_string()]);
        let n = if rails.as_ref().is_some_and(|r| r.len() == 2) { 1 } else { 0 };
        cmd.iter().skip(n).take(2).map(|c| base(c)).collect::<Vec<_>>().join(" ")
    };
    if let Some(f) = &ctx.flt {
        if rails.is_some() {
            cmd.extend(["-n".into(), format!("/{f}/")]);
        } else {
            cmd.push(format!("TESTOPTS=--name=/{f}/"));
        }
    }
    cmd.extend(ctx.extra.iter().cloned());
    let o = run(&cmd, root, 3600);
    let text = nl(&format!("{}{}", o.stdout, o.stderr));
    if ctx.opt.raw {
        println!("{text}");
        return o.code;
    }
    emit(minitest_report(&text, o.code, o.secs, ctx.nmax, &shown));
    o.code
}

/// Gemfile.lock `    name (version)` specs.
fn locked(root: &Path) -> BTreeMap<String, String> {
    locked_text(&nl(&read(root.join("Gemfile.lock"))))
}

fn locked_text(t: &str) -> BTreeMap<String, String> {
    re!(r"(?m)^    ([\w.-]+) \(([^)]+)\)$").captures_iter(t).map(|m| (g(&m, 1).to_string(), g(&m, 2).to_string())).collect()
}

/// Gems in Gemfile.lock whose dependency list names `pkg`.
fn why_users(lock: &str, pkg: &str) -> Vec<String> {
    let dep = Regex::new(&format!(r"(?m)^      {}\b", regex::escape(pkg))).expect("dep regex");
    re!(r"(?m)^    ([\w.-]+) \([^)]+\)\n((?:      .*\n)*)")
        .captures_iter(lock)
        .filter(|m| dep.is_match(g(m, 2)))
        .map(|m| g(&m, 1).to_string())
        .collect()
}

/// Python `os.path.commonpath`.
fn commonpath(paths: &[&str]) -> String {
    let mut it = paths.iter().map(|p| normpath(Path::new(p)));
    let Some(first) = it.next() else { return String::new() };
    let mut common: Vec<_> = first.components().map(|c| c.as_os_str().to_os_string()).collect();
    for p in it {
        let c: Vec<_> = p.components().map(|c| c.as_os_str().to_os_string()).collect();
        let n = common.iter().zip(&c).take_while(|(a, b)| a == b).count();
        common.truncate(n);
    }
    s(&common.iter().collect::<PathBuf>())
}

/// `deps api SYM` block: comments above, the declaration, and for class/module its public defs.
fn ruby_block(l: &[String], i: usize, loc: &str) -> Vec<String> {
    let mut j = i;
    while j > 0 && l[j - 1].trim_start().starts_with('#') {
        j -= 1;
    }
    let ind = l[i].chars().count() - l[i].trim_start().chars().count();
    let mut out = vec![format!("── {loc}")];
    let head = &l[j..=i];
    out.extend(head[head.len().saturating_sub(8)..].iter().map(|x| x.trim_end().to_string()));
    if pmatch(re!(r"^\s*(class|module)"), &l[i]).is_some() {
        let end = Regex::new(&format!(r"^\s{{{ind}}}end\b")).expect("end regex");
        for (k, x) in l.iter().enumerate().take(l.len().min(i + 2000)).skip(i + 1) {
            if pmatch(&end, x).is_some() || pmatch(re!(r"^\s*(private|protected)\s*$"), x).is_some() {
                break;
            }
            if pmatch(re!(r"^\s*(def\s|attr_\w+\s)"), x).is_some() {
                out.push(format!("   {}: {}", k + 1, x.trim()));
            }
        }
    }
    out
}

fn deps(ctx: &Ctx) {
    let root = &ctx.root;
    let cmd = ctx.cmd.as_deref().unwrap_or("ls");
    let pkg = ctx.pkg.clone().unwrap_or_default();
    let lk = locked(root);
    if cmd == "ls" {
        let gf = nl(&read(root.join("Gemfile")));
        for m in re!(r#"(?m)^\s*gem\s+["']([\w.-]+)["']"#).captures_iter(&gf) {
            let n = g(&m, 1);
            println!("{n} {}", lk.get(n).map(String::as_str).unwrap_or("not locked"));
        }
        return;
    }
    if cmd == "why" {
        let users = why_users(&nl(&read(root.join("Gemfile.lock"))), &pkg);
        let u = if users.is_empty() { "(direct in Gemfile, or nothing)".to_string() } else { users.join(", ") };
        println!("{pkg} required by: {u}");
        return;
    }
    let mut d = match exe("bundle", None) {
        Some(b) => run(&[b.as_str(), "info", "--path", &pkg], root, 60).stdout.trim().to_string(),
        None => String::new(),
    };
    if d.is_empty() || !Path::new(&d).is_dir() {
        let gc = match exe("gem", None) {
            Some(gm) => nl(&run(&[gm.as_str(), "contents", &pkg], root, 60).stdout),
            None => String::new(),
        };
        let lines: Vec<&str> = gc.lines().filter(|x| !x.is_empty()).collect();
        d = if lines.is_empty() { String::new() } else { commonpath(&lines) };
    }
    if d.is_empty() {
        die("kit", &format!("{pkg}: gem not installed (bundle install)"), 2);
    }
    let ver = lk.get(&pkg).cloned().unwrap_or_default();
    if cmd == "where" {
        println!("{pkg} {ver}  {d}");
        return;
    }
    let dp = PathBuf::from(&d);
    let mut files = glob(dp.join("lib").join("**").join("*.rb"));
    files.truncate(600);
    println!("{pkg} {ver}  {d}");
    let Some(sym) = ctx.sym.as_deref() else {
        cap_print(&outline(&files, re!(r"^\s*(class|module)\s+[A-Z][\w:]*"), &dp, None, None), ctx.cap);
        return;
    };
    let e = regex::escape(sym);
    let decl = Regex::new(&format!(r"^\s*(class|module)\s+([\w:]*::)?{e}\b|^\s*def\s+(self\.)?{e}\b")).expect("decl regex");
    let mut out = outline(&files, &decl, &dp, Some(sym), Some(&ruby_block));
    if out.is_empty() {
        out.push(format!("no declaration named {sym}"));
    }
    cap_print(&out, ctx.cap);
}

const NOTABLE: [&str; 7] = ["rails", "sinatra", "hanami", "rspec-core", "minitest", "rubocop", "sorbet"];

fn proj(ctx: &Ctx) {
    let d = &ctx.root;
    let v = match exe("ruby", None) {
        Some(r) => nl(&run(&[r.as_str(), "-v"], d, 10).stdout).trim().to_string(),
        None => "ruby not installed".into(),
    };
    let rvp = d.join(".ruby-version");
    let rv = rvp.exists().then(|| read(&rvp).trim().to_string());
    let lk = locked(d);
    let fw: Vec<String> = NOTABLE.iter().filter_map(|x| lk.get(*x).map(|v| format!("{x} {v}"))).collect();
    let name = d.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    println!("ruby: {name}  {v}{}", rv.map(|r| format!("  (.ruby-version {r})")).unwrap_or_default());
    if !fw.is_empty() {
        println!("  notable: {}", fw.join(", "));
    }
    if let Some(gs) = glob(d.join("*.gemspec")).first() {
        println!("  gemspec: {}", gs.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
    }
    let tests = if d.join("spec").is_dir() {
        "spec/ (rspec)"
    } else if d.join("test").is_dir() {
        "test/ (minitest)"
    } else {
        "none"
    };
    println!("  gems locked: {}; .rb files: {}; tests: {tests}", lk.len(), rb_files(d).len());
}

fn fmt(ctx: &Ctx, files: &[PathBuf], check: bool) -> (Vec<String>, Vec<String>) {
    let Some(rc_) = bx(&ctx.root, "rubocop").or_else(|| bx(&ctx.root, "standardrb")) else {
        return (Vec::new(), vec!["no rubocop/standardrb: .rb skipped".into()]);
    };
    let fs = files.iter().map(|f| s(f));
    if check {
        let o = run(&with(&rc_, &["--format", "files", "--only", "Layout"]).into_iter().chain(fs).collect::<Vec<_>>(), &ctx.root, 900);
        return (o.stdout.split_whitespace().map(str::to_string).collect(), Vec::new());
    }
    run(&with(&rc_, &["-a", "--format", "quiet"]).into_iter().chain(fs).collect::<Vec<_>>(), &ctx.root, 900);
    (Vec::new(), Vec::new())
}


#[cfg(test)]
mod tests {
    use super::*;

    fn dg() -> Diags {
        Diags::new(Path::new("/r"))
    }

    #[test]
    fn rubocop_json() {
        let mut d = dg();
        let out = r#"{"metadata":{},"files":[{"path":"lib/a.rb","offenses":[
{"severity":"convention","message":"Use snake_case.","cop_name":"Naming/MethodName","location":{"line":3,"column":7}},
{"severity":"fatal","message":"unexpected token kEND","cop_name":"Lint/Syntax","location":{"line":9,"column":1}}]},
{"path":"app\\models\\user.rb","offenses":[{"severity":"error","message":"boom","cop_name":"X/Y","location":{"line":1,"column":2}}]}]}"#;
        parse_rubocop(&mut d, out, Path::new("/r")).unwrap();
        assert_eq!(d.items.len(), 3);
        assert_eq!((d.items[0].sev.as_str(), d.items[0].line, d.items[0].col), ("W", 3, 7));
        assert_eq!(d.items[0].code, "Naming/MethodName");
        assert_eq!(d.items[1].sev, "E");
        assert!(d.items[2].file.ends_with("user.rb"));
        assert!(parse_rubocop(&mut d, "rubocop: command not found", Path::new("/r")).is_err());
    }

    #[test]
    fn sorbet_and_ruby_wc() {
        let mut d = dg();
        parse_sorbet(
            &mut d,
            "lib/a.rb:5: Method `foo` does not exist on `A` https://srb.help/7003\n     5 |  A.new.foo\nErrors: 1\n",
            Path::new("/r"),
        );
        assert_eq!((d.items[0].line, d.items[0].code.as_str()), (5, "srb7003"));
        assert_eq!(d.items[0].msg, "Method `foo` does not exist on `A`");
        let mut d = dg();
        parse_rubywc(
            &mut d,
            "/r/lib/a.rb:4: warning: assigned but unused variable - x\nC:\\r\\lib\\b.rb:7: syntax error, unexpected end-of-input\n",
        );
        assert_eq!((d.items[0].sev.as_str(), d.items[0].line), ("W", 4));
        assert_eq!(d.items[0].msg, "assigned but unused variable - x");
        assert_eq!((d.items[1].sev.as_str(), d.items[1].line), ("E", 7));
        assert!(d.items[1].file.ends_with("b.rb"));
    }

    #[test]
    fn rspec_json() {
        let r: Value = serde_json::from_str(
            r#"{"examples":[
{"full_description":"Calc adds","status":"passed","file_path":"./spec/calc_spec.rb","line_number":3},
{"full_description":"Calc subtracts","status":"failed","file_path":"./spec/calc_spec.rb","line_number":7,
 "exception":{"class":"RSpec::Expectations::ExpectationNotMetError","message":"expected: 1\n     got: 2",
  "backtrace":["C:/Ruby32/lib/ruby/gems/3.2.0/gems/rspec-support-3.12/lib/x.rb:1:in `y'","C:/proj/spec/calc_spec.rb:8:in `block (2 levels)'"]}},
{"full_description":"Calc divides","status":"failed","file_path":"./spec/calc_spec.rb","line_number":12,
 "exception":{"class":"ZeroDivisionError","message":"divided by 0","backtrace":null}}],
"summary":{"duration":0.01,"example_count":4,"failure_count":2,"pending_count":1,"errors_outside_of_examples_count":0}}"#,
        )
        .unwrap();
        let out = rspec_report(&r, "", 1.25, 10);
        assert_eq!(out[0], "rspec: 1 passed, 2 failed, 1 skipped [1.2s]");
        assert_eq!(out[1], "FAIL Calc subtracts  (C:/proj/spec/calc_spec.rb:8)");
        assert_eq!(out[2], "    RSpec::Expectations::ExpectationNotMetError: expected: 1");
        assert!(out.contains(&"FAIL Calc divides  (./spec/calc_spec.rb:12)".to_string()));
    }

    #[test]
    fn minitest_rails_and_plain() {
        let rails = "Running 3 tests in a single process\n# Running:\n\n.F\n\nFailure:\nUserTest#test_name [C:/app/test/models/user_test.rb:9]:\nExpected false to be truthy.\n\n\nbin/rails test test/models/user_test.rb:7\n\nE\n\nError:\nUserTest#test_boom:\nRuntimeError: boom\n    app/models/user.rb:3:in `boom'\n    test/models/user_test.rb:13:in `block in <class:UserTest>'\n\n\nFinished in 0.1s\n3 runs, 3 assertions, 1 failures, 1 errors, 0 skips\n";
        let out = minitest_report(rails, 1, 2.0, 10, "rails test");
        assert_eq!(out[0], "minitest: 1 passed, 2 failed [2.0s]");
        assert_eq!(out[1], "FAIL UserTest#test_name [C:/app/test/models/user_test.rb:9]:  (C:/app/test/models/user_test.rb:9)");
        assert_eq!(out[2], "    Expected false to be truthy.");
        assert_eq!(out[3], "FAIL UserTest#test_boom:  (app/models/user.rb:3)");
        let plain = "  1) Failure:\nCalcTest#test_add [test/calc_test.rb:6]:\nExpected: 4\n  Actual: 3\n\n2 runs, 2 assertions, 1 failures, 0 errors, 1 skips\n";
        let out = minitest_report(plain, 1, 0.5, 10, "rake test");
        assert_eq!(out[0], "minitest: 0 passed, 1 failed, 1 skipped [0.5s]");
        assert_eq!(out[1], "FAIL CalcTest#test_add [test/calc_test.rb:6]:  (test/calc_test.rb:6)");
        let out = minitest_report("rake aborted!\nLoadError: cannot load such file\n", 1, 0.3, 10, "rake test");
        assert_eq!(out[0], "rake test: exit 1 [0.3s]");
        assert!(out[1].contains("LoadError"));
    }

    #[test]
    fn gemfile_lock() {
        let lock = "GEM\r\n  remote: https://rubygems.org/\r\n  specs:\r\n    actionpack (7.1.0)\r\n      rack (>= 2.2.4)\r\n      rails-html-sanitizer (~> 1.6)\r\n    rack (3.0.8)\r\n    rails (7.1.0)\r\n      actionpack (= 7.1.0)\r\n\r\nPLATFORMS\r\n  x64-mingw-ucrt\r\n";
        let t = nl(lock);
        let lk = locked_text(&t);
        assert_eq!(lk.get("rack").map(String::as_str), Some("3.0.8"));
        assert_eq!(lk.get("rails").map(String::as_str), Some("7.1.0"));
        assert_eq!(why_users(&t, "rack"), vec!["actionpack"]);
        assert_eq!(why_users(&t, "actionpack"), vec!["rails"]);
        assert_eq!(why_users(&t, "nokogiri"), Vec::<String>::new());
    }

    #[test]
    fn common_path() {
        // compared as paths: Windows builds it with `\`
        assert_eq!(Path::new(&commonpath(&["/g/foo-1.0/lib/foo.rb", "/g/foo-1.0/README.md"])), Path::new("/g/foo-1.0"));
    }

    #[test]
    fn class_block() {
        let src: Vec<String> = "# A thing.\nclass Foo\n  attr_reader :x\n  def bar; end\n  def baz\n    1\n  end\n  private\n  def hidden; end\nend"
            .lines()
            .map(str::to_string)
            .collect();
        assert_eq!(
            ruby_block(&src, 1, "lib/foo.rb:2"),
            vec!["── lib/foo.rb:2", "# A thing.", "class Foo", "   3: attr_reader :x", "   4: def bar; end", "   5: def baz"]
        );
    }
}
