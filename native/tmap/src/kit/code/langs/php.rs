//! PHP: Composer, PHPStan/Psalm, PHPUnit/Pest, Pint/PHP-CS-Fixer (port of `kit/langs/php.py`).

use super::super::common::{
    cap_print, changed_files, die, doc_and_block, exe, g, glob, gn, junit, outline, pmatch, pystr, re, read, run, s, tail, Ctx, Diags,
};
use super::Lang;
use regex::Regex;
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const LANG: Lang = Lang { name: "php", fmt_ext: &[".php"], check, test, deps, proj, fmt };

/// CRLF -> LF (python text mode does this for files and subprocess output).
fn nl(t: &str) -> String {
    t.replace("\r\n", "\n")
}

/// Project-local launcher `dir/name`. Unix: the executable file. Windows: `name.bat|.cmd|.exe`
/// (composer writes `vendor/bin/phpunit.bat`), else the extension-less proxy script run through `interp`.
pub(super) fn local_launcher(dir: &Path, name: &str, interp: &str) -> Option<Vec<String>> {
    #[cfg(windows)]
    {
        for e in [".bat", ".cmd", ".exe"] {
            let p = dir.join(format!("{name}{e}"));
            if p.is_file() {
                return Some(vec![s(&p)]);
            }
        }
        let p = dir.join(name);
        if p.is_file() {
            let i = exe(interp, None).unwrap_or_else(|| interp.to_string());
            return Some(vec![i, s(&p)]);
        }
        None
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = interp;
        let p = dir.join(name);
        let x = p.is_file() && p.metadata().map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false);
        x.then(|| vec![s(&p)])
    }
}

/// Display name of a launcher (`vendor/bin/phpunit.bat` -> "phpunit").
pub(super) fn label(cmd: &[String]) -> String {
    let last = cmd.last().map(String::as_str).unwrap_or("");
    let base = last.rsplit(['/', '\\']).next().unwrap_or(last);
    let lower = base.to_ascii_lowercase();
    for e in [".bat", ".cmd", ".exe"] {
        if lower.ends_with(e) {
            return base[..base.len() - e.len()].to_string();
        }
    }
    base.to_string()
}

/// `vendor/bin/name` (Windows variants included), else `name` on PATH.
fn bin_(root: &Path, name: &str) -> Option<Vec<String>> {
    local_launcher(&root.join("vendor").join("bin"), name, "php").or_else(|| exe(name, None).map(|e| vec![e]))
}

fn cmdv(base: &[String], args: &[&str]) -> Vec<String> {
    base.iter().cloned().chain(args.iter().map(|a| a.to_string())).collect()
}

/// `path` has a `vendor` component below `root` (python: `"/vendor/" not in f`).
fn in_vendor(p: &Path, root: &Path) -> bool {
    p.strip_prefix(root).unwrap_or(p).components().any(|c| c.as_os_str() == "vendor")
}

fn php_files(root: &Path) -> Vec<PathBuf> {
    glob(root.join("**").join("*.php")).into_iter().filter(|f| !in_vendor(f, root)).collect()
}

/// `phpstan analyse --error-format=raw`: `path:line:message`.
fn parse_phpstan(d: &mut Diags, out: &str) {
    for ln in out.lines() {
        if let Some(m) = pmatch(re!(r"^(.+?\.php):(\d+):(.*)$"), ln) {
            d.add(g(&m, 1), gn(&m, 2), 0, "E", "phpstan", g(&m, 3), None);
        }
    }
}

/// `psalm --output-format=compact` table rows.
fn parse_psalm(d: &mut Diags, out: &str) {
    let rx = re!(r"^\|?\s*(ERROR|INFO)\s*\|\s*(\d+)\s*\|\s*(\S+?\.php)\s*\|\s*(\d+)\s*\|\s*(.*?)\|?$");
    for ln in out.lines() {
        if let Some(m) = pmatch(rx, ln) {
            d.add(g(&m, 3), gn(&m, 4), 0, if g(&m, 1) == "ERROR" { "E" } else { "W" }, "psalm", g(&m, 5), None);
        }
    }
}

/// `php -l` output: (file, line, message).
fn parse_lint(text: &str) -> Option<(String, usize, String)> {
    re!(r"(?:PHP )?(Parse|Fatal) error:\s*(.*?) in (.+?) on line (\d+)")
        .captures(text)
        .map(|m| (g(&m, 3).to_string(), gn(&m, 4), g(&m, 2).to_string()))
}

fn check(ctx: &Ctx, d: &mut Diags, used: &mut Vec<String>) {
    let root = &ctx.root;
    let stan = bin_(root, "phpstan");
    let psalm = bin_(root, "psalm");
    if let Some(st) = stan.as_ref().filter(|_| !glob(root.join("phpstan.neon*")).is_empty() || psalm.is_none()) {
        used.push("phpstan".into());
        let o = run(&cmdv(st, &["analyse", "--error-format=raw", "--no-progress", "--memory-limit=2G"]), root, 1800);
        let out = nl(&o.stdout);
        parse_phpstan(d, &out);
        if o.code != 0 && d.items.is_empty() {
            d.add("", 0, 0, "E", "phpstan", &tail(&format!("{out}{}", nl(&o.stderr)), 6), None);
        }
    } else if let Some(ps) = &psalm {
        used.push("psalm".into());
        let o = run(&cmdv(ps, &["--output-format=compact", "--no-progress"]), root, 1800);
        parse_psalm(d, &nl(&o.stdout));
    }
    let Some(php) = exe("php", None) else { die("kit", "php not found", 2) };
    let mut files: Vec<PathBuf> = if d.items.is_empty() { changed_files(root) } else { Vec::new() };
    files.retain(|f| f.to_string_lossy().ends_with(".php"));
    files.truncate(200);
    if stan.is_none() && psalm.is_none() {
        d.notes.push("no phpstan/psalm (vendor/bin or PATH): php -l syntax check only".into());
        files = php_files(root);
        files.truncate(500);
    }
    if !files.is_empty() {
        used.push("php -l".into());
        for f in &files {
            let o = run(&[php.as_str(), "-l", &s(f)], root, 60);
            if let Some((file, line, msg)) = parse_lint(&nl(&format!("{}{}", o.stdout, o.stderr))) {
                d.add(&file, line, 0, "E", "syntax", &msg, None);
            }
        }
    }
}

fn tmpdir(prefix: &str) -> PathBuf {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let d = std::env::temp_dir().join(format!("{prefix}{}-{n}", std::process::id()));
    let _ = std::fs::create_dir_all(&d);
    d
}

fn test(ctx: &Ctx) -> i32 {
    let root = &ctx.root;
    let pest = bin_(root, "pest");
    let unit = bin_(root, "phpunit");
    let pick = if pest.is_some() && root.join("tests").join("Pest.php").exists() { pest } else { unit.or(pest) };
    let Some(exe_) = pick else { die("kit", "no vendor/bin/phpunit or pest (composer install)", 2) };
    let dir = tmpdir("kit-php-");
    let rep = s(&dir.join("junit.xml"));
    let mut cmd = cmdv(&exe_, &["--log-junit", &rep, "--colors=never"]);
    if let Some(f) = &ctx.flt {
        cmd.extend(["--filter".to_string(), f.clone()]);
    }
    cmd.extend(ctx.extra.iter().cloned());
    let o = run(&cmd, root, 3600);
    let text = nl(&format!("{}{}", o.stdout, o.stderr));
    if ctx.opt.raw {
        println!("{text}");
        let _ = std::fs::remove_dir_all(&dir);
        return o.code;
    }
    let name = label(&exe_);
    if junit(&[rep], &name, Some(o.secs), ctx.nmax, None).is_none() {
        println!("{name}: exit {}, no report", o.code);
        println!("{}", tail(&text, 20));
    }
    let _ = std::fs::remove_dir_all(&dir);
    o.code
}

fn json_file(p: &Path) -> Value {
    serde_json::from_str(&read(p)).unwrap_or(Value::Null)
}

/// composer.lock packages (+dev) by name.
fn lock(root: &Path) -> serde_json::Map<String, Value> {
    let j = json_file(&root.join("composer.lock"));
    let mut m = serde_json::Map::new();
    for sec in ["packages", "packages-dev"] {
        for x in j[sec].as_array().into_iter().flatten() {
            if let Some(n) = x["name"].as_str() {
                m.insert(n.to_string(), x.clone());
            }
        }
    }
    m
}

fn platform_req(n: &str) -> bool {
    n == "php" || n.starts_with("ext-")
}

/// `deps ls` lines.
fn ls_lines(cj: &Value, lk: &serde_json::Map<String, Value>) -> Vec<String> {
    let mut out = Vec::new();
    for sec in ["require", "require-dev"] {
        for (n, req) in cj[sec].as_object().into_iter().flatten() {
            if platform_req(n) {
                continue;
            }
            let ver = lk.get(n).and_then(|x| x.get("version")).map(pystr).unwrap_or_else(|| "not installed".into());
            let dev = if sec.ends_with("dev") { ", dev" } else { "" };
            out.push(format!("{n} {ver}  (req {}{dev})", pystr(req)));
        }
    }
    out
}

fn deps(ctx: &Ctx) {
    let root = &ctx.root;
    let cmd = ctx.cmd.as_deref().unwrap_or("ls");
    let pkg = ctx.pkg.clone().unwrap_or_default();
    let cj = json_file(&root.join("composer.json"));
    let lk = lock(root);
    if cmd == "ls" {
        for l in ls_lines(&cj, &lk) {
            println!("{l}");
        }
        return;
    }
    if cmd == "why" {
        let Some(c) = exe("composer", None) else { die("kit", "composer not found", 2) };
        let o = run(&[c.as_str(), "why", &pkg], root, 120);
        let t = nl(if o.stdout.is_empty() { &o.stderr } else { &o.stdout });
        cap_print(&t.lines().map(str::to_string).collect::<Vec<_>>(), ctx.cap);
        return;
    }
    let d = pkg.split('/').fold(root.join("vendor"), |p, c| p.join(c));
    if !d.is_dir() {
        die("kit", &format!("{pkg} not in vendor/ (composer install)"), 2);
    }
    let ver = lk.get(&pkg).and_then(|x| x.get("version")).map(pystr).unwrap_or_else(|| "?".into());
    if cmd == "where" {
        println!("{pkg} {ver}  {}", s(&d));
        return;
    }
    let skip = re!(r"/(tests?|Tests?|fixtures?)/");
    let mut files: Vec<PathBuf> = glob(d.join("**").join("*.php")).into_iter().filter(|f| !skip.is_match(&s(f).replace('\\', "/"))).collect();
    files.truncate(600);
    println!("{pkg} {ver}  {}", s(&d));
    let types = re!(r"^\s*(final\s+|abstract\s+|readonly\s+)*(class|interface|trait|enum)\s+\w+");
    let Some(sym) = ctx.sym.as_deref() else {
        cap_print(&outline(&files, types, &d, None, None), ctx.cap);
        return;
    };
    let e = regex::escape(sym);
    let decl = Regex::new(&format!(
        r"^\s*(final\s+|abstract\s+|readonly\s+)*(class|interface|trait|enum)\s+{e}\b|^\s*(public\s+)(static\s+)?function\s+{e}\b"
    ))
    .expect("decl regex");
    let body = re!(r"^\s*(public\s+)(static\s+|abstract\s+|final\s+)*(function|const|readonly|\??[\w\\]+\s+\$)");
    let blk = |l: &[String], i: usize, loc: &str| doc_and_block(l, i, loc, "{", "}", Some(body), 60);
    let mut out = outline(&files, &decl, &d, Some(sym), Some(&blk));
    if out.is_empty() {
        out.push(format!("no declaration named {sym}"));
    }
    cap_print(&out, ctx.cap);
}

const NOTABLE: [&str; 8] = [
    "laravel/framework",
    "symfony/framework-bundle",
    "slim/slim",
    "cakephp/cakephp",
    "yiisoft/yii2",
    "phpunit/phpunit",
    "pestphp/pest",
    "phpstan/phpstan",
];

/// `proj` lines after the version probe (`v` = first line of `php -v`), `nfiles` = .php files outside vendor.
fn proj_lines(cj: &Value, v: &str, nfiles: usize) -> Vec<String> {
    let req = cj["require"].as_object().cloned().unwrap_or_default();
    let dev = cj["require-dev"].as_object().cloned().unwrap_or_default();
    let fw: Vec<&str> = NOTABLE.iter().copied().filter(|x| req.contains_key(*x) || dev.contains_key(*x)).collect();
    let name = cj.get("name").map(pystr).unwrap_or_else(|| "?".into());
    let preq = req.get("php").map(pystr).unwrap_or_else(|| "?".into());
    let mut out = vec![format!("php: {name}  {v}  requires php {preq}")];
    if !fw.is_empty() {
        out.push(format!("  notable: {}", fw.join(", ")));
    }
    if let Some(sc) = cj["scripts"].as_object().filter(|m| !m.is_empty()) {
        out.push(format!("  scripts: {}", sc.keys().cloned().collect::<Vec<_>>().join(", ")));
    }
    if let Some(al) = cj["autoload"]["psr-4"].as_object().filter(|m| !m.is_empty()) {
        out.push(format!("  psr-4: {}", al.iter().map(|(k, v)| format!("{k}->{}", pystr(v))).collect::<Vec<_>>().join(", ")));
    }
    let n = req.keys().filter(|k| !platform_req(k)).count();
    out.push(format!("  deps {n} + dev {}; .php files: {nfiles}", dev.len()));
    out
}

fn proj(ctx: &Ctx) {
    let d = &ctx.root;
    let cj = json_file(&d.join("composer.json"));
    let v = match exe("php", None) {
        Some(p) => nl(&run(&[p.as_str(), "-v"], d, 10).stdout).split('\n').next().unwrap_or("").to_string(),
        None => "php not installed".into(),
    };
    for l in proj_lines(&cj, &v, php_files(d).len()) {
        println!("{l}");
    }
}

fn fmt(ctx: &Ctx, files: &[PathBuf], check: bool) -> (Vec<String>, Vec<String>) {
    let fs: Vec<String> = files.iter().map(|f| s(f)).collect();
    if let Some(pint) = bin_(&ctx.root, "pint") {
        let mut c = pint.clone();
        if check {
            c.push("--test".into());
        }
        c.extend(fs.iter().cloned());
        let o = run(&c, &ctx.root, 900);
        if !check {
            return (Vec::new(), Vec::new());
        }
        let would = files
            .iter()
            .filter(|f| f.file_name().is_some_and(|b| o.stdout.contains(&*b.to_string_lossy())))
            .map(|f| s(f))
            .collect();
        return (would, Vec::new());
    }
    if let Some(fixer) = bin_(&ctx.root, "php-cs-fixer") {
        let mut c = cmdv(&fixer, &["fix", "--quiet"]);
        if check {
            c.push("--dry-run".into());
        }
        c.push("--".into());
        c.extend(fs.iter().cloned());
        let o = run(&c, &ctx.root, 900);
        return (if check && o.code != 0 { fs } else { Vec::new() }, Vec::new());
    }
    (Vec::new(), vec!["no pint / php-cs-fixer: .php skipped".into()])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dg() -> Diags {
        Diags::new(Path::new("/r"))
    }

    #[test]
    fn phpstan_raw() {
        let mut d = dg();
        parse_phpstan(
            &mut d,
            "/r/src/Foo.php:12:Call to an undefined method Foo::bar().\nC:\\proj\\src\\Bar.php:7:Undefined variable: $x\n -- 2 errors\n",
        );
        assert_eq!(d.items.len(), 2);
        assert_eq!((d.items[0].line, d.items[0].code.as_str()), (12, "phpstan"));
        assert_eq!(d.items[0].msg, "Call to an undefined method Foo::bar().");
        assert!(d.items[1].file.ends_with("Bar.php"));
        assert_eq!((d.items[1].line, d.items[1].msg.as_str()), (7, "Undefined variable: $x"));
    }

    #[test]
    fn psalm_compact() {
        let mut d = dg();
        let out = "+----------+------+-----------------------+------+----------------------------+\n\
| SEVERITY | LINE | FILE                  | LINE | MESSAGE                    |\n\
+----------+------+-----------------------+------+----------------------------+\n\
| ERROR    | 3    | src/A.php             | 3    | UndefinedClass: Class Nope |\n\
| INFO     | 9    | C:\\p\\src\\B.php       | 9    | MissingReturnType: f()     |\n";
        parse_psalm(&mut d, out);
        assert_eq!(d.items.len(), 2);
        assert_eq!((d.items[0].sev.as_str(), d.items[0].line), ("E", 3));
        assert_eq!(d.items[0].msg, "UndefinedClass: Class Nope");
        assert_eq!(d.items[1].sev, "W");
        assert!(d.items[1].file.ends_with("B.php"));
    }

    #[test]
    fn php_lint() {
        let (f, l, m) = parse_lint("PHP Parse error:  syntax error, unexpected '}' in /r/src/x.php on line 4\nErrors parsing /r/src/x.php\n").unwrap();
        assert_eq!((f.as_str(), l, m.as_str()), ("/r/src/x.php", 4, "syntax error, unexpected '}'"));
        let (f, l, _) = parse_lint("PHP Parse error: syntax error, unexpected end of file in C:\\proj\\src\\x.php on line 9").unwrap();
        assert_eq!((f.as_str(), l), ("C:\\proj\\src\\x.php", 9));
        let (_, _, m) = parse_lint("Fatal error: Cannot redeclare f() in /a/b.php on line 2").unwrap();
        assert_eq!(m, "Cannot redeclare f()");
        assert!(parse_lint("No syntax errors detected in x.php").is_none());
    }

    #[test]
    fn labels() {
        assert_eq!(label(&["/p/vendor/bin/phpunit".into()]), "phpunit");
        assert_eq!(label(&["C:\\p\\vendor\\bin\\pest.BAT".into()]), "pest");
        assert_eq!(label(&["php".into(), "C:\\p\\vendor\\bin\\phpunit".into()]), "phpunit");
    }

    #[test]
    fn vendor_filter() {
        let r = Path::new("/w/vendor/app");
        assert!(!in_vendor(&r.join("src").join("a.php"), r));
        assert!(in_vendor(&r.join("vendor").join("x").join("a.php"), r));
    }

    #[test]
    fn composer_ls_and_proj() {
        let cj: Value = serde_json::from_str(
            r#"{"name":"acme/app","require":{"php":"^8.2","ext-json":"*","laravel/framework":"^11.0","guzzlehttp/guzzle":"^7"},
               "require-dev":{"phpunit/phpunit":"^10"},"scripts":{"test":"phpunit","lint":"pint"},
               "autoload":{"psr-4":{"App\\":"app/","Lib\\":["lib/","src/"]}}}"#,
        )
        .unwrap();
        let lk = {
            let mut m = serde_json::Map::new();
            m.insert("laravel/framework".into(), serde_json::json!({"name":"laravel/framework","version":"v11.2.0"}));
            m
        };
        assert_eq!(
            ls_lines(&cj, &lk),
            vec![
                "laravel/framework v11.2.0  (req ^11.0)",
                "guzzlehttp/guzzle not installed  (req ^7)",
                "phpunit/phpunit not installed  (req ^10, dev)"
            ]
        );
        assert_eq!(
            proj_lines(&cj, "PHP 8.3.1 (cli)", 5),
            vec![
                "php: acme/app  PHP 8.3.1 (cli)  requires php ^8.2",
                "  notable: laravel/framework, phpunit/phpunit",
                "  scripts: test, lint",
                "  psr-4: App\\->app/, Lib\\->['lib/', 'src/']",
                "  deps 2 + dev 1; .php files: 5"
            ]
        );
    }

    #[test]
    fn phpunit_junit_report() {
        let d = tmpdir("kit-php-test-");
        let rep = d.join("junit.xml");
        std::fs::write(
            &rep,
            r#"<?xml version="1.0" encoding="UTF-8"?>
<testsuites><testsuite name="t" tests="2" failures="1">
<testcase name="testOk" class="Tests\MathTest" classname="Tests.MathTest" file="/r/tests/MathTest.php" line="5"/>
<testcase name="testAdd" class="Tests\MathTest" classname="Tests.MathTest" file="C:\r\tests\MathTest.php" line="9">
<failure type="PHPUnit\Framework\ExpectationFailedException">Tests\MathTest::testAdd
Failed asserting that 3 matches expected 4.

C:\r\tests\MathTest.php:11</failure></testcase></testsuite></testsuites>"#,
        )
        .unwrap();
        assert_eq!(junit(&[s(&rep)], "phpunit", Some(0.1), 10, None), Some(1));
        let _ = std::fs::remove_dir_all(&d);
    }
}
