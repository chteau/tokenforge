//! Java / Kotlin / Groovy on the JVM: Maven (mvnw) or Gradle (gradlew). Port of `kit/langs/java.py`.
//! The jar helpers (`jar_candidates`, `jar_api`) are shared with `scala`.

use super::super::common::{
    cap_print, exe, g, glob, gn, junit, newest, parse_gnu, pmatch, re, read, run, s, tail, ver_key, ws, Ctx, Diags, OrdMap,
};
use super::Lang;
use crate::kit::util::{self, die};
use regex::{Captures, Regex};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub const LANG: Lang = Lang { name: "java", fmt_ext: &[".java", ".kt", ".kts"], check, test, deps, proj, fmt };

/// Python text-mode newline handling (subprocess `text=True`, `open().read()`): CRLF -> LF.
pub(super) fn lf(t: &str) -> String {
    t.replace("\r\n", "\n")
}

/// File contents with LF line ends ("" when unreadable).
pub(super) fn rd(p: impl AsRef<Path>) -> String {
    lf(&read(p))
}

/// Path separators as '/', for substring tests like `"/build/" in path`.
pub(super) fn slash(p: &str) -> String {
    p.replace('\\', "/")
}

/// Last path component (python `os.path.basename`).
pub(super) fn base(p: &Path) -> String {
    p.file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default()
}

/// `/C:/x/Y.java` (maven on Windows, `file:///C:/…` URIs) -> `C:/x/Y.java`.
pub(super) fn fix_path(p: &str) -> &str {
    let b = p.as_bytes();
    if b.len() > 2 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' { &p[1..] } else { p }
}

#[cfg(unix)]
fn is_exec(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    p.is_file() && p.metadata().map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(not(unix))]
fn is_exec(p: &Path) -> bool {
    p.is_file()
}

/// Project wrapper script: `name.cmd` / `name.bat` on Windows, executable `./name` elsewhere.
fn wrapper_in(root: &Path, name: &str, windows: bool) -> Option<String> {
    if windows {
        return [".cmd", ".bat"].iter().map(|e| root.join(format!("{name}{e}"))).find(|p| p.is_file()).map(|p| s(&p));
    }
    let p = root.join(name);
    is_exec(&p).then(|| s(&p))
}

fn wrapper(root: &Path, name: &str) -> Option<String> {
    wrapper_in(root, name, cfg!(windows))
}

/// ("maven" | "gradle", executable): the project wrapper, else the tool on PATH.
fn build_tool(root: &Path) -> (&'static str, String) {
    if root.join("pom.xml").exists() {
        let e = wrapper(root, "mvnw").or_else(|| exe("mvn", None)).unwrap_or_else(|| die("kit", "mvn not found (no ./mvnw either)", 2));
        return ("maven", e);
    }
    let e = wrapper(root, "gradlew").or_else(|| exe("gradle", None)).unwrap_or_else(|| die("kit", "gradle not found (no ./gradlew either)", 2));
    ("gradle", e)
}

/// Is there a wrapper script of either flavour (for the proj header)?
fn has_wrapper(root: &Path, name: &str) -> bool {
    [name.to_string(), format!("{name}.cmd"), format!("{name}.bat")].iter().any(|f| root.join(f).exists())
}

// ---------- diagnostics ----------

/// maven `[ERROR] /abs/File.java:[12,5] msg`; Windows: `C:\x\File.java`, `/C:/x/File.java`, `file:///C:/x/F.kt`.
fn mvn_rx() -> &'static Regex {
    re!(r"^\[(ERROR|WARNING)\]\s+(?:file://)?((?:/?[A-Za-z]:)?[/\\][^\s:]+?\.(?:java|kt|groovy|scala)):\[?(\d+)[,:](\d+)\]?\s*(.*)$")
}

/// kotlinc `e: file:///x/A.kt:3:5 msg` or `e: /x/A.kt: (3, 5): msg`.
fn kt_rx() -> &'static Regex {
    re!(r"^([ew]): (?:file://)?(.+?\.kts?):(?:(\d+):(\d+)|\s*\((\d+), (\d+)\):)\s*(.*)$")
}

pub fn parse_jvm(d: &mut Diags, text: &str, root: &Path) {
    let text = lf(text);
    let lines: Vec<&str> = text.lines().collect();
    let tag = re!(r"^\[\w+\]\s*");
    for (i, ln) in lines.iter().enumerate() {
        let st = ln.trim();
        if let Some(m) = pmatch(mvn_rx(), st) {
            // javac puts "symbol: …" / "location: …" on the following lines
            let sym = lines.iter().skip(i + 1).take(2).find(|l| l.contains("symbol:")).map(|l| tag.replace(l, "").trim().to_string());
            let msg = match sym {
                Some(x) => format!("{} ({})", g(&m, 5), ws(&x)),
                None => g(&m, 5).to_string(),
            };
            d.add(fix_path(g(&m, 2)), gn(&m, 3), gn(&m, 4), g(&m, 1), "", &msg, None);
            continue;
        }
        if let Some(m) = pmatch(kt_rx(), st) {
            let num = |a: usize, b: usize| if m.get(a).is_some() { gn(&m, a) } else { gn(&m, b) };
            d.add(fix_path(g(&m, 2)), num(3, 5), num(4, 6), if g(&m, 1) == "e" { "E" } else { "W" }, "kotlin", g(&m, 7), None);
        }
    }
    parse_gnu(d, &text, root, false); // javac via gradle: File.java:12: error: msg
}

fn check(ctx: &Ctx, d: &mut Diags, used: &mut Vec<String>) {
    let (kind, x) = build_tool(&ctx.root);
    let o = if kind == "maven" {
        used.push("mvn compile".into());
        run(&[x.as_str(), "-B", "-q", "-e", "compile", "test-compile"], &ctx.root, 1800)
    } else {
        used.push("gradle classes".into());
        run(&[x.as_str(), "--console=plain", "classes", "testClasses"], &ctx.root, 1800)
    };
    let (out, err) = (lf(&o.stdout), lf(&o.stderr));
    parse_jvm(d, &format!("{out}\n{err}"), &ctx.root);
    if o.code != 0 && d.count("E") == 0 {
        let both = format!("{out}{err}");
        let hits: Vec<&str> = both.lines().filter(|l| l.contains("ERROR") || l.contains("FAIL") || l.contains("error")).collect();
        let t = if hits.is_empty() { err.clone() } else { hits.join("\n") };
        d.add("", 0, 0, "E", kind, &tail(&t, 8), None);
    }
}

fn test(ctx: &Ctx) -> i32 {
    let (kind, x) = build_tool(&ctx.root);
    let t = SystemTime::now();
    let mut cmd: Vec<String> = vec![x];
    let pats: Vec<String> = if kind == "maven" {
        cmd.extend(["-B", "test", "-Dsurefire.failIfNoSpecifiedTests=false", "-DfailIfNoTests=false"].map(String::from));
        if let Some(f) = &ctx.flt {
            cmd.push(format!("-Dtest={f}"));
        }
        vec![s(&ctx.root.join("**").join("target").join("surefire-reports").join("*.xml"))]
    } else {
        cmd.extend(["--console=plain", "test", "--continue"].map(String::from));
        if let Some(f) = &ctx.flt {
            cmd.extend(["--tests".to_string(), format!("*{f}*")]);
        }
        vec![s(&ctx.root.join("**").join("build").join("test-results").join("**").join("*.xml"))]
    };
    cmd.extend(ctx.extra.iter().cloned());
    let o = run(&cmd, &ctx.root, 3600);
    let (out, err) = (lf(&o.stdout), lf(&o.stderr));
    if ctx.opt.raw {
        println!("{out}{err}");
        return o.code;
    }
    let reports: Vec<String> = newest(&pats, t).iter().map(|p| s(p)).collect();
    if reports.is_empty() {
        let mut d = Diags::new(&ctx.root);
        parse_jvm(&mut d, &format!("{out}\n{err}"), &ctx.root);
        let e = d.count("E");
        if e > 0 {
            println!("{kind}: build failed, {e} errors");
        } else {
            println!("{kind} test: exit {}, no test reports", o.code);
        }
        d.print(30, false);
        if d.items.is_empty() {
            println!("{}", tail(&format!("{out}{err}"), 20));
        }
        return o.code;
    }
    junit(&reports, kind, Some(o.secs), ctx.nmax, None);
    o.code
}

// ---------- dependencies ----------

/// `<properties>` of a pom as a `${name}` substituter.
fn props(pom: &str) -> impl Fn(&str) -> String {
    let body = re!(r"(?s)<properties>(.*?)</properties>").captures(pom).map(|c| g(&c, 1).to_string()).unwrap_or_default();
    let mut p: OrdMap<String, String> = OrdMap::default();
    // python `<([\w.-]+)>([^<]+)</\1>` (no backreferences in `regex`: compare the tags instead)
    for c in re!(r"<([\w.-]+)>([^<]+)</([\w.-]+)>").captures_iter(&body) {
        if g(&c, 1) == g(&c, 3) {
            p.insert(g(&c, 1).to_string(), g(&c, 2).to_string());
        }
    }
    move |x: &str| {
        re!(r"\$\{([\w.-]+)\}")
            .replace_all(x, |c: &Captures| p.get(&g(c, 1).to_string()).cloned().unwrap_or_else(|| g(c, 0).to_string()))
            .into_owned()
    }
}

/// First `<k>text</k>` in `t`.
fn tag_text<'a>(t: &'a str, k: &str) -> Option<&'a str> {
    let rx = Regex::new(&format!("<{k}>([^<]+)</{k}>")).ok()?;
    rx.captures(t).and_then(|c| c.get(1)).map(|m| m.as_str())
}

/// Remove `<tag>…</tag>` blocks for any of `tags`, scanning left to right like
/// python `re.sub(r"<(a|b)>.*?</\1>", "", t, flags=re.S)`.
fn strip_blocks(t: &str, tags: &[&str]) -> String {
    let open = Regex::new(&format!("<({})>", tags.join("|"))).expect("tags regex");
    let (mut out, mut pos) = (String::new(), 0);
    while let Some(c) = open.captures_at(t, pos) {
        let m = c.get(0).expect("match");
        let close = format!("</{}>", g(&c, 1));
        match t[m.end()..].find(&close) {
            Some(i) => {
                out.push_str(&t[pos..m.start()]);
                pos = m.end() + i + close.len();
            }
            None => {
                // no closing tag here: keep this char and retry from the next position
                let nxt = m.start() + t[m.start()..].chars().next().map_or(1, char::len_utf8);
                out.push_str(&t[pos..nxt]);
                pos = nxt;
            }
        }
    }
    out.push_str(&t[pos..]);
    out
}

fn tv_str(v: &toml::Value) -> String {
    v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())
}

/// (group, artifact, version, scope) from pom.xml or Gradle build files + version catalog.
pub fn declared(root: &Path) -> Vec<(String, String, String, String)> {
    let mut out: Vec<(String, String, String, String)> = Vec::new();
    let pom = root.join("pom.xml");
    if pom.exists() {
        let t = rd(&pom);
        let sub = props(&t);
        let body = re!(r"(?s)<dependencyManagement>.*?</dependencyManagement>").replace_all(&t, "");
        for c in re!(r"(?s)<dependency>(.*?)</dependency>").captures_iter(&body) {
            let dep = g(&c, 1);
            let f = |k: &str| tag_text(dep, k).unwrap_or("").trim().to_string();
            let ver = sub(&f("version"));
            let scope = f("scope");
            out.push((
                sub(&f("groupId")),
                sub(&f("artifactId")),
                if ver.is_empty() { "(managed)".into() } else { ver },
                if scope.is_empty() { "compile".into() } else { scope },
            ));
        }
        return out;
    }
    let mut cat: OrdMap<String, (String, String, String)> = OrdMap::default();
    let toml_p = root.join("gradle").join("libs.versions.toml");
    if toml_p.exists() {
        if let Ok(c) = toml::from_str::<toml::Value>(&rd(&toml_p)) {
            let empty = toml::map::Map::new();
            let vers = c.get("versions").and_then(|v| v.as_table()).unwrap_or(&empty);
            let vref = |r: Option<&toml::Value>| r.and_then(|r| r.as_str()).and_then(|r| vers.get(r)).map(tv_str).unwrap_or_default();
            for (k, v) in c.get("libraries").and_then(|v| v.as_table()).unwrap_or(&empty) {
                let (gr, a, ver) = if let Some(sv) = v.as_str() {
                    let p: Vec<&str> = sv.split(':').collect();
                    (p.first().copied().unwrap_or("").to_string(), p.get(1).copied().unwrap_or("").to_string(), p.get(2).copied().unwrap_or("").to_string())
                } else {
                    let gs = |key: &str| v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string();
                    let (gr, a) = if v.get("module").is_some() {
                        let m = gs("module");
                        let mut it = m.split(':');
                        (it.next().unwrap_or("").to_string(), it.next().unwrap_or("").to_string())
                    } else {
                        (gs("group"), gs("name"))
                    };
                    let ver = match v.get("version") {
                        Some(t @ toml::Value::Table(_)) => vref(t.get("ref")),
                        Some(x) => tv_str(x),
                        None => String::new(),
                    };
                    let ver = if !matches!(v.get("version"), Some(toml::Value::Table(_))) && v.get("version.ref").is_some() {
                        vref(v.get("version.ref"))
                    } else {
                        ver
                    };
                    (gr, a, ver)
                };
                cat.insert(format!("libs.{}", k.replace(['-', '_'], ".")), (gr, a, ver));
            }
        }
    }
    let lit = re!(r#"\b(implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|kapt|ksp|annotationProcessor)\s*\(?\s*["']([^"':]+):([^"':]+)(?::([^"']+))?["']"#);
    let refs = re!(r"\b(implementation|api|compileOnly|runtimeOnly|testImplementation|kapt|ksp)\s*\(\s*(libs\.[\w.]+)\s*\)");
    for bf in glob(root.join("**").join("build.gradle*")) {
        let bs = slash(&s(&bf));
        if bs.contains("/build/") || bs.contains("/.gradle/") {
            continue;
        }
        let t = rd(&bf);
        for c in lit.captures_iter(&t) {
            let v = if g(&c, 4).is_empty() { "(bom)" } else { g(&c, 4) };
            out.push((g(&c, 2).into(), g(&c, 3).into(), v.into(), g(&c, 1).into()));
        }
        for c in refs.captures_iter(&t) {
            let r = g(&c, 2).to_string();
            let (gr, a, v) = cat.get(&r).cloned().unwrap_or_else(|| ("?".into(), r.clone(), String::new()));
            out.push((gr, a, if v.is_empty() { "(bom)".into() } else { v }, g(&c, 1).into()));
        }
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|x| seen.insert(x.clone()));
    out
}

/// Glob pattern below `base` from '/'-separated `rel` (each part a path component).
fn pat(base: &Path, rel: &str) -> PathBuf {
    rel.split('/').filter(|x| !x.is_empty()).fold(base.to_path_buf(), |p, c| p.join(c))
}

/// Jars in the local Maven, Gradle and Coursier caches, oldest version first.
pub fn jar_candidates(group: &str, artifact: &str, version: Option<&str>) -> Vec<String> {
    let home = util::home();
    let gpath = if group.is_empty() { "**".to_string() } else { group.replace('.', "/") };
    let v = version.unwrap_or("*");
    let jar = format!("{artifact}-*.jar");
    let mut pats = vec![
        pat(&home, &format!(".m2/repository/{gpath}/{artifact}/{v}/{jar}")),
        pat(&home, &format!(".gradle/caches/modules-2/files-2.1/{}/{artifact}/{v}/*/{jar}", if group.is_empty() { "*" } else { group })),
        pat(&home, &format!(".cache/coursier/v1/https/*/**/{gpath}/{artifact}/{v}/{jar}")),
    ];
    if cfg!(windows) {
        // coursier's default cache on Windows
        if let Some(la) = std::env::var_os("LOCALAPPDATA") {
            pats.push(pat(Path::new(&la), &format!("Coursier/cache/v1/https/*/**/{gpath}/{artifact}/{v}/{jar}")));
        }
    }
    let skip = re!(r"-(sources|javadoc|tests)\.jar$");
    let mut jars: Vec<String> = pats.iter().flat_map(glob).map(|p| s(&p)).filter(|j| !skip.is_match(j)).collect();
    let key = |j: &String| {
        let p = Path::new(j);
        let d = if j.contains("modules-2") { p.parent().and_then(Path::parent) } else { p.parent() };
        ver_key(&d.map(base).unwrap_or_default(), &['.', '-'])
    };
    jars.sort_by_key(key);
    jars
}

/// (group, artifact, version, jars) for a `group:artifact` or bare `artifact`.
fn resolve(root: &Path, pkg: &str) -> (String, String, Option<String>, Vec<String>) {
    let (mut group, artifact) = match pkg.rfind(':') {
        Some(i) => (pkg[..i].to_string(), pkg[i + 1..].to_string()),
        None => (String::new(), pkg.to_string()),
    };
    let dl = declared(root);
    if group.is_empty() {
        group = dl.iter().find(|x| x.1 == artifact).map(|x| x.0.clone()).unwrap_or_default();
    }
    let ver = dl
        .iter()
        .find(|x| x.1 == artifact && (group.is_empty() || x.0 == group) && !x.2.is_empty() && !x.2.starts_with('('))
        .map(|x| x.2.clone());
    let mut jars = jar_candidates(&group, &artifact, ver.as_deref());
    if jars.is_empty() {
        jars = jar_candidates(&group, &artifact, None);
    }
    (group, artifact, ver, jars)
}

/// Public top-level classes of a jar, dotted, sorted.
fn jar_classes(jar: &str) -> Vec<String> {
    let z = std::fs::File::open(jar).ok().and_then(|f| zip::ZipArchive::new(f).ok());
    let Some(z) = z else { die("kit", &format!("{jar}: not a readable jar"), 2) };
    let mut v: Vec<String> = z
        .file_names()
        .filter(|n| n.ends_with(".class") && !n.contains('$') && !n.ends_with("module-info.class") && !n.ends_with("package-info.class"))
        .map(|n| n[..n.len() - 6].replace('/', "."))
        .collect();
    v.sort();
    v
}

/// Packages and classes of a jar, or `javap -public` of the classes named `sym`.
pub fn jar_api(jar: &str, sym: Option<&str>, cap: usize, label: &str) {
    let classes = jar_classes(jar);
    println!("{label}  {jar}");
    let Some(sym) = sym else {
        let mut pk: OrdMap<String, Vec<String>> = OrdMap::default();
        for c in &classes {
            let (p, n) = c.rsplit_once('.').unwrap_or(("", c));
            pk.entry(p.to_string(), Vec::new).push(n.to_string());
        }
        let mut items = pk.items;
        items.sort_by(|a, b| a.0.cmp(&b.0));
        let lines: Vec<String> = items
            .iter()
            .map(|(p, cs)| format!("{p}: {}{}", cs.iter().take(25).cloned().collect::<Vec<_>>().join(", "), if cs.len() > 25 { " …" } else { "" }))
            .collect();
        cap_print(&lines, cap);
        return;
    };
    let suffix = format!(".{sym}");
    let hits: Vec<&String> = classes.iter().filter(|c| c.as_str() == sym || c.ends_with(&suffix)).collect();
    if hits.is_empty() {
        println!("no class named {sym}");
        return;
    }
    let jp = exe("javap", None).unwrap_or_else(|| die("kit", "javap not found (needs a JDK)", 2));
    for c in hits.iter().take(3) {
        let o = run(&[jp.as_str(), "-public", "-cp", jar, c.as_str()], &util::cwd(), 60);
        let t = lf(if o.stdout.is_empty() { &o.stderr } else { &o.stdout });
        let lines: Vec<String> = t.lines().filter(|l| !l.starts_with("Compiled from")).map(str::to_string).collect();
        cap_print(&lines, cap);
    }
}

fn deps(ctx: &Ctx) {
    let cmd = ctx.cmd.as_deref().unwrap_or("ls");
    let pkg = ctx.pkg.as_deref().unwrap_or("");
    if cmd == "ls" {
        for (gr, a, v, sc) in declared(&ctx.root) {
            let tail = if ["compile", "implementation", "api"].contains(&sc.as_str()) { String::new() } else { format!(" ({sc})") };
            println!("{gr}:{a} {v}{tail}");
        }
        return;
    }
    if cmd == "why" {
        let (kind, x) = build_tool(&ctx.root);
        let art = pkg.rsplit(':').next().unwrap_or(pkg);
        let o = if kind == "maven" {
            run(&[x.as_str(), "-B", "-q", "dependency:tree", &format!("-Dincludes=:{art}")], &ctx.root, 600)
        } else {
            run(&[x.as_str(), "--console=plain", "-q", "dependencyInsight", "--dependency", art, "--configuration", "runtimeClasspath"], &ctx.root, 600)
        };
        let t = lf(if o.stdout.is_empty() { &o.stderr } else { &o.stdout });
        cap_print(&t.lines().map(str::to_string).collect::<Vec<_>>(), ctx.cap);
        return;
    }
    let (group, artifact, ver, jars) = resolve(&ctx.root, pkg);
    let Some(jar) = jars.last() else { die("kit", &format!("{pkg}: no jar in ~/.m2, ~/.gradle or coursier caches (build once to download)"), 2) };
    if cmd == "where" {
        let v = ver.clone().unwrap_or_else(|| base(Path::new(jar)));
        println!("{}:{artifact} {v}  {jar}", if group.is_empty() { "?" } else { &group });
        return;
    }
    let label = format!("{group}:{artifact} {}", ver.as_deref().unwrap_or(""));
    jar_api(jar, ctx.sym.as_deref(), ctx.cap, label.trim());
}

// ---------- project facts ----------

fn proj(ctx: &Ctx) {
    let d = &ctx.root;
    let java = exe("java", None).unwrap_or_else(|| "java".into());
    let jv = run(&[java.as_str(), "-version"], d, 20);
    let jtext = format!("{}{}", jv.stderr, jv.stdout);
    let jver = re!(r#"version "([^"]+)""#).captures(&jtext).map(|c| g(&c, 1).to_string()).unwrap_or_else(|| "none".into());
    if d.join("pom.xml").exists() {
        let t = rd(d.join("pom.xml"));
        let sub = props(&t);
        let top = strip_blocks(&t, &["parent", "dependencies", "dependencyManagement", "build", "profiles"]);
        let gt = |k: &str| sub(tag_text(&top, k).unwrap_or("?"));
        let parent = re!(r"(?s)<parent>.*?<artifactId>([^<]+)</artifactId>.*?<version>([^<]+)</version>").captures(&t);
        let rel = re!(r"<(maven\.compiler\.release|maven\.compiler\.source|java\.version)>([^<]+)<").captures(&t);
        println!(
            "java (maven{}): {}:{}:{} {}  java {} (jdk {jver}){}",
            if has_wrapper(d, "mvnw") { "w" } else { "" },
            gt("groupId"),
            gt("artifactId"),
            gt("version"),
            if top.contains("<packaging>") { gt("packaging") } else { "jar".into() },
            rel.as_ref().map_or("?", |c| g(c, 2)),
            parent.as_ref().map(|c| format!("  parent {} {}", g(c, 1), g(c, 2))).unwrap_or_default()
        );
        let mods: Vec<&str> = re!(r"<module>([^<]+)</module>").captures_iter(&t).map(|c| c.get(1).map_or("", |m| m.as_str())).collect();
        if !mods.is_empty() {
            println!("  modules ({}): {}", mods.len(), mods.iter().take(20).copied().collect::<Vec<_>>().join(", "));
        }
    } else {
        let sf = ["settings.gradle.kts", "settings.gradle"].iter().map(|f| d.join(f)).find(|p| p.exists());
        let st = sf.as_ref().map(rd).unwrap_or_default();
        let bf = ["build.gradle.kts", "build.gradle"].iter().map(|f| d.join(f)).find(|p| p.exists());
        let bt = bf.as_ref().map(rd).unwrap_or_default();
        let name = re!(r#"rootProject\.name\s*=\s*["']([^"']+)"#).captures(&st).map(|c| g(&c, 1).to_string()).unwrap_or_else(|| base(d));
        let tc = re!(r#"languageVersion\.set\(JavaLanguageVersion\.of\((\d+)\)|languageVersion\s*=\s*JavaLanguageVersion\.of\((\d+)\)|jvmToolchain\((\d+)\)|sourceCompatibility\s*=\s*['"]?(?:JavaVersion\.VERSION_)?([\d_.]+)"#)
            .captures(&bt)
            .map(|c| (1..=4).map(|i| g(&c, i)).find(|x| !x.is_empty()).unwrap_or("?").to_string())
            .unwrap_or_else(|| "?".into());
        let pb = re!(r"(?s)plugins\s*\{(.*?)\n\}").captures(&bt).map(|c| g(&c, 1).to_string()).unwrap_or_default();
        let mut plugins: Vec<String> = Vec::new();
        for c in re!(r#"id\s*\(?\s*["']([\w.-]+)["']|kotlin\("([\w-]+)"\)|alias\(libs\.plugins\.([\w.]+)\)"#).captures_iter(&pb) {
            if let Some(x) = (1..=3).map(|i| g(&c, i)).find(|x| !x.is_empty()) {
                if !plugins.iter().any(|p| p == x) {
                    plugins.push(x.to_string());
                }
            }
        }
        let kts = bf.as_ref().is_some_and(|p| s(p).ends_with("kts"));
        println!(
            "java (gradle{}{}): {name}  java {tc} (jdk {jver})",
            if has_wrapper(d, "gradlew") { "w" } else { "" },
            if kts { ", kotlin dsl" } else { "" }
        );
        if !plugins.is_empty() {
            println!("  plugins: {}", plugins.join(", "));
        }
        let mods: Vec<String> = re!(r"include\s*\(?\s*([^)\n]+)")
            .captures_iter(&st)
            .flat_map(|c| g(&c, 1).split(',').map(|m| m.trim_matches([' ', '\'', '"', ':', '\r']).to_string()).collect::<Vec<_>>())
            .collect();
        if !mods.is_empty() {
            println!("  modules ({}): {}", mods.len(), mods.iter().take(20).cloned().collect::<Vec<_>>().join(", "));
        }
    }
    let dl = declared(d);
    if !dl.is_empty() {
        let names: Vec<&str> = dl.iter().take(15).map(|x| x.1.as_str()).collect();
        println!("  deps {}: {}{}", dl.len(), names.join(", "), if dl.len() > 15 { " …" } else { "" });
    }
    let src = glob(pat(d, "**/src/main/**/*.*")).len();
    let tst = glob(pat(d, "**/src/test/**/*.*")).len();
    println!("  src/main files: {src}, src/test files: {tst}");
}

// ---------- formatting ----------

fn fmt(ctx: &Ctx, files: &[PathBuf], check: bool) -> (Vec<String>, Vec<String>) {
    let (mut notes, mut would) = (Vec::new(), Vec::new());
    let j: Vec<String> = files.iter().map(|f| s(f)).filter(|f| f.ends_with(".java")).collect();
    let k: Vec<String> = files.iter().map(|f| s(f)).filter(|f| f.ends_with(".kt") || f.ends_with(".kts")).collect();
    let (gjf, ktl) = (exe("google-java-format", None), exe("ktlint", None));
    if !j.is_empty() {
        match &gjf {
            Some(x) => {
                let mut c = vec![x.clone(), if check { "--dry-run" } else { "-i" }.to_string()];
                c.extend(j);
                let o = run(&c, &ctx.root, 900);
                if check {
                    would.extend(o.stdout.split_whitespace().map(str::to_string));
                }
            }
            None => notes.push("google-java-format not found: .java skipped".to_string()),
        }
    }
    if !k.is_empty() {
        match &ktl {
            Some(x) => {
                let mut c = vec![x.clone()];
                if !check {
                    c.push("-F".into());
                }
                c.extend(k);
                let o = run(&c, &ctx.root, 900);
                if check {
                    would.extend(ktlint_files(&format!("{}{}", o.stdout, o.stderr)));
                }
            }
            None => notes.push("ktlint not found: .kt skipped".to_string()),
        }
    }
    (would, notes)
}

/// Files named in ktlint `path:line:col: msg` lines, sorted, unique. The path is captured up to
/// `.kt:`/`.kts:` (python split on ':' which would cut `C:\…` drive paths).
fn ktlint_files(text: &str) -> Vec<String> {
    let rx = re!(r"^(\S+?\.kts?):\d+");
    let mut v: Vec<String> = text.lines().filter_map(|l| pmatch(rx, l).map(|m| g(&m, 1).to_string())).collect();
    v.sort();
    v.dedup();
    v
}


#[cfg(test)]
mod tests {
    use super::*;

    fn dg() -> Diags {
        Diags::new(Path::new("/proj"))
    }

    #[test]
    fn maven_javac_unix_and_windows() {
        let mut d = dg();
        let out = "[INFO] Compiling 2 source files\n\
[ERROR] /proj/src/main/java/App.java:[5,9] cannot find symbol\n\
[ERROR]   symbol:   variable nope\n\
[ERROR]   location: class App\n\
[WARNING] /proj/src/main/java/Old.java:[3,1] [deprecation] Foo in bar has been deprecated\r\n\
[ERROR] /C:/work/app/src/main/java/Win.java:[7,13] ';' expected\r\n\
[ERROR] C:\\work\\app\\src\\main\\java\\Win2.java:[8,2] class, interface, enum, or record expected\n\
[ERROR] file:///C:/work/app/src/main/kotlin/K.kt:[4,5] Unresolved reference: x\n";
        parse_jvm(&mut d, out, Path::new("/proj"));
        assert_eq!(d.items.len(), 5, "{:?}", d.items);
        let a = &d.items[0];
        assert!(a.file.ends_with("src/main/java/App.java"));
        assert_eq!((a.line, a.col, a.sev.as_str(), a.msg.as_str()), (5, 9, "E", "cannot find symbol (symbol: variable nope)"));
        assert_eq!((d.items[1].sev.as_str(), d.items[1].line), ("W", 3));
        assert!(d.items[2].file.ends_with("C:/work/app/src/main/java/Win.java"), "{}", d.items[2].file);
        assert_eq!((d.items[2].line, d.items[2].col, d.items[2].msg.as_str()), (7, 13, "';' expected"));
        assert!(d.items[3].file.ends_with(r"C:\work\app\src\main\java\Win2.java"));
        assert_eq!((d.items[3].line, d.items[3].col), (8, 2));
        assert!(d.items[4].file.ends_with("C:/work/app/src/main/kotlin/K.kt"));
    }

    #[test]
    fn gradle_javac_and_kotlin() {
        let mut d = dg();
        let out = "> Task :app:compileJava\n\
/proj/app/src/main/java/A.java:12: error: incompatible types: String cannot be converted to int\n\
C:\\proj\\app\\src\\main\\java\\B.java:3: warning: [unchecked] unchecked call\n\
e: file:///proj/app/src/main/kotlin/M.kt:3:17 Unresolved reference: foo\n\
w: /proj/app/src/main/kotlin/N.kt: (10, 5): Parameter 'x' is never used\n\
e: file:///C:/proj/app/src/main/kotlin/W.kt:9:1 Expecting member declaration\n\
e: C:\\proj\\app\\build.gradle.kts:2:3: Unresolved reference: foo\n";
        parse_jvm(&mut d, out, Path::new("/proj"));
        let got: Vec<(String, usize, usize, String, String)> =
            d.items.iter().map(|x| (x.file.replace('\\', "/"), x.line, x.col, x.sev.clone(), x.code.clone())).collect();
        let has = |suf: &str, l: usize, c: usize, sev: &str| got.iter().any(|x| x.0.ends_with(suf) && x.1 == l && x.2 == c && x.3 == sev);
        assert!(has("kotlin/M.kt", 3, 17, "E"), "{got:?}");
        assert!(has("kotlin/N.kt", 10, 5, "W"));
        assert!(has("C:/proj/app/src/main/kotlin/W.kt", 9, 1, "E"));
        assert!(has("C:/proj/app/build.gradle.kts", 2, 3, "E"));
        assert!(has("java/A.java", 12, 0, "E"));
        assert!(has("C:/proj/app/src/main/java/B.java", 3, 0, "W"));
    }

    #[test]
    fn wrapper_choice() {
        let d = std::env::temp_dir().join(format!("kit-java-wrap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("mvnw"), "#!/bin/sh\n").unwrap();
        std::fs::write(d.join("mvnw.cmd"), "@echo off\r\n").unwrap();
        assert_eq!(wrapper_in(&d, "mvnw", true), Some(s(&d.join("mvnw.cmd"))));
        assert_eq!(wrapper_in(&d, "gradlew", true), None);
        std::fs::write(d.join("gradlew.bat"), "").unwrap();
        assert_eq!(wrapper_in(&d, "gradlew", true), Some(s(&d.join("gradlew.bat"))));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(wrapper_in(&d, "mvnw", false), None); // not executable
            std::fs::set_permissions(d.join("mvnw"), std::fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(wrapper_in(&d, "mvnw", false), Some(s(&d.join("mvnw"))));
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn pom_and_gradle_declared() {
        let d = std::env::temp_dir().join(format!("kit-java-decl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("m")).unwrap();
        std::fs::write(
            d.join("m").join("pom.xml"),
            "<project>\r\n<properties><junit.version>5.10.0</junit.version></properties>\r\n\
<dependencyManagement><dependencies><dependency><groupId>x</groupId><artifactId>bom</artifactId></dependency></dependencies></dependencyManagement>\r\n\
<dependencies>\r\n<dependency><groupId>org.junit</groupId><artifactId>junit-jupiter</artifactId><version>${junit.version}</version><scope>test</scope></dependency>\r\n\
<dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId></dependency>\r\n</dependencies></project>",
        )
        .unwrap();
        assert_eq!(
            declared(&d.join("m")),
            vec![
                ("org.junit".into(), "junit-jupiter".into(), "5.10.0".into(), "test".into()),
                ("com.google.guava".into(), "guava".into(), "(managed)".into(), "compile".into())
            ]
        );
        let gd = d.join("g");
        std::fs::create_dir_all(gd.join("gradle")).unwrap();
        std::fs::write(
            gd.join("gradle").join("libs.versions.toml"),
            "[versions]\nkt = \"1.9.0\"\n[libraries]\nkotlin-stdlib = { module = \"org.jetbrains.kotlin:kotlin-stdlib\", version.ref = \"kt\" }\n\
okio = \"com.squareup.okio:okio:3.6.0\"\nfoo_bar = { group = \"a.b\", name = \"foo\", version = \"2\" }\n",
        )
        .unwrap();
        std::fs::write(
            gd.join("build.gradle.kts"),
            "dependencies {\n  implementation(libs.kotlin.stdlib)\n  testImplementation(\"junit:junit:4.13.2\")\n  api(libs.okio)\n  implementation(libs.foo.bar)\n  implementation(platform(\"x:y\"))\n}\n",
        )
        .unwrap();
        let got = declared(&gd);
        assert!(got.contains(&("org.jetbrains.kotlin".into(), "kotlin-stdlib".into(), "1.9.0".into(), "implementation".into())), "{got:?}");
        assert!(got.contains(&("junit".into(), "junit".into(), "4.13.2".into(), "testImplementation".into())));
        assert!(got.contains(&("com.squareup.okio".into(), "okio".into(), "3.6.0".into(), "api".into())));
        assert!(got.contains(&("a.b".into(), "foo".into(), "2".into(), "implementation".into())));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn strip_and_props() {
        let t = "<project><parent><artifactId>p</artifactId></parent><artifactId>me</artifactId><build><x/></build><profiles>";
        assert_eq!(strip_blocks(t, &["parent", "build", "profiles"]), "<project><artifactId>me</artifactId><profiles>");
        let sub = props("<properties><a.b>1</a.b><c>2</d></properties>");
        assert_eq!(sub("v${a.b}-${c}"), "v1-${c}");
    }

    #[test]
    fn ktlint_windows_paths() {
        let out = "C:\\p\\src\\A.kt:1:1: Unexpected indentation\n/p/src/B.kts:3:4: Missing newline\nC:\\p\\src\\A.kt:2:1: x\nsummary";
        assert_eq!(ktlint_files(out), vec!["/p/src/B.kts".to_string(), "C:\\p\\src\\A.kt".to_string()]);
    }

    #[test]
    fn fix_drive() {
        assert_eq!(fix_path("/C:/x/A.java"), "C:/x/A.java");
        assert_eq!(fix_path("/home/A.java"), "/home/A.java");
    }
}
