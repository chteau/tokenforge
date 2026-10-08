//! `tmap kit deps`: dependency facts without reading registries, lockfiles or docs sites.

use super::check::python;
use super::common::*;
use super::langs;
use crate::kit::util;
use regex::Regex;
use serde_json::Value;
use std::path::{Path, PathBuf};

const HELP: &str = "Dependency facts without reading registries, lockfiles or docs sites.

  tmap kit deps ls                     direct dependencies with resolved versions
  tmap kit deps where PKG              source dir of the resolved version
  tmap kit deps api PKG [SYMBOL]       public API outline (file:line signature); with SYMBOL: its
                                       declaration, doc comment, and methods (rust impls, ts members, go doc)
  tmap kit deps why PKG                who pulls PKG in (reverse dependency path)
  -l STACK  -C DIR  -a (no cap)

Sources: rust cargo metadata + ~/.cargo/registry | go go list / go doc | ts node_modules (.d.ts)
  cs ~/.nuget/packages (XML docs) | dart .dart_tool/package_config.json | luau Packages/_Index (wally)
  py site-packages (inspect) | java/kotlin/scala ~/.m2, ~/.gradle, coursier jars + javap | cpp headers from
  FetchContent _deps, vcpkg, conan, pkg-config, /usr/include | php vendor/ | ruby bundle info | swift
  .build/checkouts | elixir deps/ | zig build.zig.zon + zig cache.";

const T: &str = "deps";

pub fn main(args: Vec<String>) -> i32 {
    let mut ctx = Ctx { cap: 80, nmax: 10, ..Default::default() };
    let mut want = None;
    let mut pos: Vec<String> = Vec::new();
    let mut it = args.into_iter();
    while let Some(x) = it.next() {
        match x.as_str() {
            "-h" | "--help" => {
                println!("{HELP}");
                return 0;
            }
            "-l" => want = Some(it.next().unwrap_or_else(|| die(T, "-l needs a value", 2))),
            "-C" => {
                let d = it.next().unwrap_or_else(|| die(T, "-C needs a value", 2));
                if let Err(e) = std::env::set_current_dir(&d) {
                    die(T, &format!("-C {d}: {e}"), 2);
                }
            }
            "-a" => ctx.cap = usize::MAX,
            _ => pos.push(x),
        }
    }
    if pos.is_empty() {
        println!("{HELP}");
        return 2;
    }
    let cmd = pos[0].clone();
    if !["ls", "where", "api", "why"].contains(&cmd.as_str()) {
        die(T, &format!("unknown command {cmd}"), 2);
    }
    ctx.pkg = pos.get(1).cloned();
    ctx.sym = pos.get(2).cloned();
    if cmd != "ls" && ctx.pkg.is_none() {
        die(T, &format!("{cmd} needs PKG"), 2);
    }
    ctx.cmd = Some(cmd.clone());
    let (root, stacks) = find_root(Path::new("."), want.as_deref());
    let Some(root) = root else { die(T, "no project manifest found here or above", 2) };
    ctx.root = root;
    // ls covers every stack; lookups use the first one (pick another with -l)
    let n = if cmd == "ls" { stacks.len() } else { 1 };
    let mut rc = 0;
    for st in stacks.iter().take(n) {
        if cmd == "ls" && stacks.len() > 1 {
            println!("[{st}]");
        }
        let q = Q { ctx: &ctx, cmd: &cmd, pkg: ctx.pkg.as_deref().unwrap_or(""), sym: ctx.sym.as_deref() };
        match *st {
            "rust" => rust(&q),
            "go" => go(&q),
            "ts" => ts(&q),
            "cs" => cs(&q),
            "dart" => dart(&q),
            "py" => py(&q),
            "luau" => luau(&q),
            other => match langs::get(other) {
                Some(l) => (l.deps)(&ctx),
                None => {
                    println!("{}", langs::not_ported(other));
                    rc = 2;
                }
            },
        }
    }
    rc
}

struct Q<'a> {
    ctx: &'a Ctx,
    cmd: &'a str,
    pkg: &'a str,
    sym: Option<&'a str>,
}

impl Q<'_> {
    fn root(&self) -> &Path {
        &self.ctx.root
    }
    fn cap(&self, lines: &[String]) {
        cap_print(lines, self.ctx.cap);
    }
    fn lines(&self, text: &str) {
        self.cap(&text.lines().map(str::to_string).collect::<Vec<_>>());
    }
}

fn need(name: &str, msg: &str) -> String {
    exe(name, None).unwrap_or_else(|| die(T, msg, 2))
}

fn json(p: impl AsRef<Path>) -> Value {
    serde_json::from_str(&read(p)).unwrap_or(Value::Null)
}

/// Dotted-version max; the last of equal keys wins (python `sorted(..., key=ver_key)[-1]`).
fn newest_by<T>(v: &[T], key: impl Fn(&T) -> Vec<u64>) -> Option<&T> {
    v.iter().max_by(|a, b| key(a).cmp(&key(b)))
}

// ---------- rust ----------

fn rust(q: &Q) {
    let cargo = need("cargo", "cargo not found");
    let o = run(&[cargo.as_str(), "metadata", "--format-version", "1"], q.root(), 300);
    if o.code != 0 {
        let last = o.stderr.trim().lines().last().unwrap_or("").to_string();
        die(T, &format!("cargo metadata failed: {last}"), 2);
    }
    let md: Value = serde_json::from_str(&o.stdout).unwrap_or(Value::Null);
    let pkgs = md["packages"].as_array().cloned().unwrap_or_default();
    let by_id = |id: &str| pkgs.iter().find(|p| p["id"] == id);
    if q.cmd == "ls" {
        let mut members: Vec<&Value> = md["workspace_members"].as_array().into_iter().flatten().filter_map(|m| by_id(m.as_str()?)).collect();
        members.sort_by_key(|p| p["name"].as_str().unwrap_or("").to_string());
        let nodes = md["resolve"]["nodes"].as_array().cloned().unwrap_or_default();
        for p in members {
            let node = nodes.iter().find(|n| n["id"] == p["id"]);
            let resolved: std::collections::HashMap<&str, &str> = node
                .and_then(|n| n["deps"].as_array())
                .into_iter()
                .flatten()
                .filter_map(|d| by_id(d["pkg"].as_str()?))
                .map(|dp| (dp["name"].as_str().unwrap_or(""), dp["version"].as_str().unwrap_or("")))
                .collect();
            println!("{} {}:", p["name"].as_str().unwrap_or(""), p["version"].as_str().unwrap_or(""));
            for d in p["dependencies"].as_array().into_iter().flatten() {
                let name = d["name"].as_str().unwrap_or("");
                let kind = match d["kind"].as_str() {
                    Some("dev") => " (dev)",
                    Some("build") => " (build)",
                    _ => "",
                };
                let feats: Vec<&str> = d["features"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
                let feats = if feats.is_empty() { String::new() } else { format!(" [{}]", feats.join(",")) };
                let v = resolved.get(name.replace('-', "_").as_str()).or(resolved.get(name)).copied().unwrap_or(d["req"].as_str().unwrap_or(""));
                println!("  {name} {v}{kind}{feats}");
            }
        }
        return;
    }
    let name = q.pkg.replace('_', "-");
    let cands: Vec<&Value> = pkgs.iter().filter(|p| p["name"].as_str().unwrap_or("").replace('_', "-") == name).collect();
    if cands.is_empty() {
        die(T, &format!("{} not in the dependency graph (cargo metadata)", q.pkg), 2);
    }
    let p = *newest_by(&cands, |p| ver_key(p["version"].as_str().unwrap_or(""), &['.', '+', '-'])).unwrap();
    let (pname, pver) = (p["name"].as_str().unwrap_or(""), p["version"].as_str().unwrap_or(""));
    let src = Path::new(p["manifest_path"].as_str().unwrap_or("")).parent().map(Path::to_path_buf).unwrap_or_default();
    if q.cmd == "where" {
        println!("{pname} {pver}  {}", s(&src));
        if cands.len() > 1 {
            let others: Vec<&str> = cands.iter().filter(|c| !std::ptr::eq(**c, p)).filter_map(|c| c["version"].as_str()).collect();
            println!("  other versions: {}", others.join(", "));
        }
        return;
    }
    if q.cmd == "why" {
        let spec = format!("{pname}@{pver}");
        let o = run(&[cargo.as_str(), "tree", "-i", &spec, "-e", "normal,build", "--depth", "6"], q.root(), 300);
        q.lines(if o.stdout.is_empty() { &o.stderr } else { &o.stdout });
        return;
    }
    let mut files = glob(src.join("src").join("**").join("*.rs"));
    let main_file = |f: &PathBuf| {
        let t = s(f).replace('\\', "/");
        t.ends_with("src/lib.rs") || t.ends_with("src/main.rs")
    };
    files.sort_by_key(|f| (!main_file(f), f.clone()));
    println!("{pname} {pver}  {}", s(&src));
    let Some(sym) = q.sym else {
        let rx = re!(r#"^\s*pub(\([^)]*\))?\s+(unsafe\s+|async\s+|const\s+|extern\s+"\w+"\s+)*(fn|struct|enum|trait|type|const|static|mod|union|macro)\b|^\s*#\[macro_export\]|^\s*pub use\b"#);
        let lines: Vec<String> = outline(&files, rx, &src, None, None).into_iter().filter(|l| !re!(r"pub\(crate\)|pub\(super\)").is_match(l)).collect();
        q.cap(&lines);
        return;
    };
    let es = regex::escape(sym);
    let decl = Regex::new(&format!(r"^\s*pub(\([^)]*\))?\s+.*\b(fn|struct|enum|trait|type|const|static|mod|union)\s+{es}\b")).unwrap();
    let mut out = outline(&files, &decl, &src, Some(sym), Some(&|l: &[String], i, loc: &str| doc_and_block(l, i, loc, "{", "}", None, 40)));
    // impl blocks for the type: method signatures only
    let target_rx = Regex::new(&format!(r"^\s*&?(mut\s+)?(\w+::)*{es}\b")).unwrap();
    let impl_on_sym = |l: &str| {
        if !re!(r"^\s*impl\b").is_match(l) {
            return false;
        }
        let head = re!(r"^\s*impl\s*(<[^{]*?>)?\s*").replace(l, "");
        let target = head.split_once(" for ").map_or(head.as_ref(), |(_, t)| t);
        target_rx.is_match(target)
    };
    let pubfn = re!(r"^\s*pub(\([^)]*\))?\s+(const\s+|async\s+|unsafe\s+)*fn\b");
    let mut n_impl = 0;
    for f in &files {
        let lines: Vec<String> = read(f).lines().map(str::to_string).collect();
        for (i, l) in lines.iter().enumerate() {
            if !impl_on_sym(l) {
                continue;
            }
            n_impl += 1;
            if n_impl > 15 {
                continue;
            }
            out.push(format!("── {}:{}  {}", relpath(f, &src), i + 1, l.trim()));
            let mut depth = 0i64;
            for (k, x) in lines.iter().enumerate().skip(i) {
                depth += x.matches('{').count() as i64 - x.matches('}').count() as i64;
                if k > i && pubfn.is_match(x) {
                    out.push(format!("   {}: {}", k + 1, x.trim().trim_end_matches('{').trim()));
                }
                if k > i && depth <= 0 {
                    break;
                }
            }
        }
    }
    if n_impl > 15 {
        out.push(format!("… {} more impl blocks", n_impl - 15));
    }
    if out.is_empty() {
        out.push(format!("no pub item named {sym}"));
    }
    q.cap(&out);
}

// ---------- go ----------

fn go(q: &Q) {
    let gobin = need("go", "go not found");
    let g = gobin.as_str();
    let pick = |o: &util::Output| if o.stdout.is_empty() { o.stderr.clone() } else { o.stdout.clone() };
    match q.cmd {
        "ls" => {
            let o = run(&[g, "list", "-m", "-f", "{{if not .Indirect}}{{.Path}} {{.Version}}{{end}}", "all"], q.root(), 300);
            let mut l: Vec<String> = o.stdout.lines().filter(|l| !l.trim().is_empty()).skip(1).map(str::to_string).collect();
            if l.is_empty() {
                l.push(o.stderr.trim().to_string());
            }
            q.cap(&l);
        }
        "where" => {
            let mut o = run(&[g, "list", "-m", "-f", "{{.Path}} {{.Version}}  {{.Dir}}", q.pkg], q.root(), 120);
            if o.code != 0 {
                o = run(&[g, "list", "-f", "{{.ImportPath}}  {{.Dir}}", q.pkg], q.root(), 120);
            }
            println!("{}", pick(&o).trim());
        }
        "why" => println!("{}", pick(&run(&[g, "mod", "why", "-m", q.pkg], q.root(), 300)).trim()),
        _ => {
            let target = q.sym.map_or(q.pkg.to_string(), |s| format!("{}.{s}", q.pkg));
            let mut cmd = vec![g, "doc"];
            if q.sym.is_none() {
                cmd.push("-short");
            }
            cmd.push(&target);
            let mut o = run(&cmd, q.root(), 120);
            if let (true, Some(sym)) = (o.code != 0, q.sym) {
                o = run(&[g, "doc", q.pkg, sym], q.root(), 120); // method on a type: pkg.Type.Method
            }
            q.lines(pick(&o).trim_end());
        }
    }
}

// ---------- ts ----------

fn realpath(p: &Path) -> PathBuf {
    if cfg!(windows) { p.to_path_buf() } else { p.canonicalize().unwrap_or_else(|_| p.to_path_buf()) }
}

/// node_modules/<name> in root or any parent.
fn node_pkg_dir(root: &Path, name: &str) -> Option<PathBuf> {
    root.ancestors().map(|d| d.join("node_modules").join(name)).find(|p| p.is_dir()).map(|p| realpath(&p))
}

fn ts(q: &Q) {
    let root = q.root();
    let pj = json(root.join("package.json"));
    if q.cmd == "ls" {
        for sec in ["dependencies", "devDependencies", "peerDependencies"] {
            let Some(deps) = pj[sec].as_object() else { continue };
            let mut names: Vec<(&String, &Value)> = deps.iter().collect();
            names.sort_by(|a, b| a.0.cmp(b.0));
            for (n, req) in names {
                let v = node_pkg_dir(root, n).map(|d| pystr(&json(d.join("package.json"))["version"])).unwrap_or_else(|| "not installed".into());
                let tag = match sec {
                    "devDependencies" => ", dev",
                    "peerDependencies" => ", peer",
                    _ => "",
                };
                println!("{n} {v}  (req {}{tag})", pystr(req));
            }
        }
        return;
    }
    let pkg = q.pkg;
    let types_name = |p: &str| format!("@types/{}", p.trim_start_matches('@').replace('/', "__"));
    let mut d = node_pkg_dir(root, pkg);
    if d.is_none() && !pkg.starts_with("@types/") {
        d = node_pkg_dir(root, &format!("@types/{}", pkg.replace('@', "").replace('/', "__")));
    }
    let Some(mut d) = d else { die(T, &format!("{pkg} not found in node_modules (install first)"), 2) };
    let meta = json(d.join("package.json"));
    let (mname, mver) = (pystr(&meta["name"]), pystr(&meta["version"]));
    if q.cmd == "where" {
        println!("{mname} {mver}  {}", s(&d));
        return;
    }
    if q.cmd == "why" {
        let npm = need("npm", "npm not found");
        let o = run(&[npm.as_str(), "ls", pkg, "--all"], root, 120);
        q.lines(if o.stdout.is_empty() { &o.stderr } else { &o.stdout });
        return;
    }
    let mut types = meta["types"].as_str().or(meta["typings"].as_str()).map(str::to_string);
    if types.is_none() {
        let ex = &meta["exports"];
        let ex = if ex.get(".").is_some() { &ex["."] } else { ex };
        types = ex["types"].as_str().or(ex["import"]["types"].as_str()).map(str::to_string);
    }
    let in_pkg = |f: &PathBuf, d: &Path| !s(f)[s(d).len()..].contains("node_modules");
    let mut files: Vec<PathBuf> = types.map(|t| d.join(t)).filter(|p| p.exists()).into_iter().collect();
    let extra: Vec<PathBuf> = glob(d.join("**").join("*.d.ts")).into_iter().filter(|f| in_pkg(f, &d) && !files.contains(f)).take(40).collect();
    files.extend(extra);
    if files.is_empty() && !pkg.starts_with("@types/") {
        if let Some(t) = node_pkg_dir(root, &types_name(pkg)) {
            files = glob(t.join("**").join("*.d.ts")).into_iter().take(40).collect();
            d = t;
        }
    }
    if files.is_empty() {
        die(T, &format!("{pkg} ships no .d.ts (and no @types package installed)"), 2);
    }
    println!("{mname} {mver}  {}", s(&d));
    let Some(sym) = q.sym else {
        let rx = re!(r"^\s*(export\s+)?(declare\s+)?(default\s+)?(abstract\s+)?(function|class|interface|type|const|let|enum|namespace|module)\s+[\w$]+|^\s*export\s+\{|^\s*export\s+\*");
        q.cap(&outline(&files, rx, &d, None, None));
        return;
    };
    let decl = Regex::new(&format!(
        r"^\s*(export\s+)?(declare\s+)?(default\s+)?(abstract\s+)?(function|class|interface|type|const|let|enum|namespace)\s+{}\b",
        regex::escape(sym)
    ))
    .unwrap();
    let mut out = outline(&files, &decl, &d, Some(sym), Some(&|l: &[String], i, loc: &str| doc_and_block(l, i, loc, "{", "}", None, 80)));
    if out.is_empty() {
        out.push(format!("no declaration named {sym}"));
    }
    q.cap(&out);
}

// ---------- c# ----------

fn cs(q: &Q) {
    let root = q.root();
    let mut refs: OrdMap<String, String> = OrdMap::default();
    for p in glob(root.join("**").join("*.csproj")) {
        for m in re!(r#"<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?"#).captures_iter(&read(&p)) {
            let v = if g(&m, 2).is_empty() { "(central)" } else { g(&m, 2) };
            refs.insert(g(&m, 1).to_string(), v.to_string());
        }
    }
    let nuget = std::env::var_os("NUGET_PACKAGES").map(PathBuf::from).unwrap_or_else(|| util::home().join(".nuget").join("packages"));
    if q.cmd == "ls" {
        let mut v: Vec<&(String, String)> = refs.items.iter().collect();
        v.sort();
        for (n, ver) in v {
            println!("{n} {ver}");
        }
        if refs.items.is_empty() {
            println!("no PackageReference in *.csproj");
        }
        return;
    }
    if q.cmd == "why" {
        let dn = need("dotnet", "dotnet not found");
        let o = run(&[dn.as_str(), "list", "package", "--include-transitive"], root, 300);
        let lp = q.pkg.to_lowercase();
        q.cap(&o.stdout.lines().filter(|l| l.to_lowercase().contains(&lp) || l.starts_with("Project")).map(str::to_string).collect::<Vec<_>>());
        return;
    }
    let base = nuget.join(q.pkg.to_lowercase());
    let mut vers: Vec<String> = std::fs::read_dir(&base).map(|r| r.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    vers.sort_by_key(|v| ver_key(v, &['.', '-']));
    if vers.is_empty() {
        die(T, &format!("{} not in {} (dotnet restore first)", q.pkg, s(&nuget)), 2);
    }
    let want = refs.get(&q.pkg.to_string()).cloned().or_else(|| refs.items.iter().find(|(k, _)| k.eq_ignore_ascii_case(q.pkg)).map(|(_, v)| v.clone()));
    let ver = want.filter(|w| vers.contains(w)).unwrap_or_else(|| vers.last().unwrap().clone());
    let d = base.join(&ver);
    if q.cmd == "where" {
        println!("{} {ver}  {}", q.pkg, s(&d));
        return;
    }
    let mut xmls = glob(d.join("lib").join("*").join("*.xml"));
    xmls.sort_by_key(|p| (!s(p).contains("net"), p.clone()));
    let Some(last) = xmls.last() else { die(T, &format!("{} {ver} ships no XML docs; members unavailable without decompiling", q.pkg), 2) };
    let tfm_dir = last.parent().map(Path::to_path_buf).unwrap_or_default();
    xmls.retain(|x| x.parent() == Some(tfm_dir.as_path()));
    println!("{} {ver}  {}", q.pkg, s(&tfm_dir));
    let word = q.sym.map(|s| Regex::new(&format!(r"\b{}\b", regex::escape(s))).unwrap());
    let mut out = Vec::new();
    for x in &xmls {
        for m in xml_elems(&read(x), "member") {
            let n = m.attr("name").unwrap_or("");
            let (kind, full) = n.split_once(':').unwrap_or((n, ""));
            match &word {
                Some(w) if !w.is_match(full) => continue,
                None if kind != "T" => continue,
                _ => {}
            }
            let summ = xml_child(&m, "summary").and_then(|e| e.inner).map(|i| ws(&xml_text(&i))).unwrap_or_default();
            let summ = if summ.is_empty() { String::new() } else { format!("  // {}", trunc(&summ, 140)) };
            out.push(format!("{kind} {}{summ}", trunc(full, 160)));
        }
    }
    if out.is_empty() {
        out.push(format!("no member matching {}", q.sym.unwrap_or("None")));
    }
    q.cap(&out);
}

// ---------- dart ----------

fn dart(q: &Q) {
    let root = q.root();
    let cfgp = root.join(".dart_tool").join("package_config.json");
    if !cfgp.exists() {
        die(T, "no .dart_tool/package_config.json (run dart pub get)", 2);
    }
    let cfg = json(&cfgp);
    let pkgs: Vec<&Value> = cfg["packages"].as_array().into_iter().flatten().collect();
    let find = |n: &str| pkgs.iter().find(|p| p["name"] == n).copied();
    let pdir = |p: &Value| {
        let u = p["rootUri"].as_str().unwrap_or("");
        normpath(&cfgp.parent().unwrap().join(util::file_url_path(u).unwrap_or_else(|| u.to_string())))
    };
    if q.cmd == "ls" {
        let pubspec = read(root.join("pubspec.yaml"));
        for c in re!(r"(?m)^(dependencies|dev_dependencies):\n((?:[ \t]+.*\n?)*)").captures_iter(&pubspec) {
            let dev = if g(&c, 1).starts_with("dev") { " (dev)" } else { "" };
            for n in re!(r"(?m)^  (\w+):").captures_iter(g(&c, 2)) {
                let n = g(&n, 1);
                let v = find(n).and_then(|p| re!(r"-(\d[\w.+-]*)$").captures(&s(&pdir(p))).map(|m| g(&m, 1).to_string()));
                println!("{n} {}{dev}", v.unwrap_or_else(|| "(sdk/path)".into()));
            }
        }
        return;
    }
    let Some(p) = find(q.pkg) else { die(T, &format!("{} not in package_config.json", q.pkg), 2) };
    let d = pdir(p);
    if q.cmd == "where" {
        println!("{}  {}", q.pkg, s(&d));
        return;
    }
    if q.cmd == "why" {
        let dt = need("dart", "dart not found");
        let o = run(&[dt.as_str(), "pub", "deps", "-s", "compact"], root, 120);
        q.cap(&o.stdout.lines().filter(|l| l.contains(q.pkg)).map(str::to_string).collect::<Vec<_>>());
        return;
    }
    let all = glob(d.join("lib").join("**").join("*.dart"));
    let in_src = |f: &PathBuf| s(f)[s(&d).len()..].replace('\\', "/").contains("/src/");
    let mut files: Vec<PathBuf> = all.iter().filter(|f| !in_src(f)).cloned().collect();
    files.extend(all.iter().filter(|f| in_src(f)).cloned());
    let Some(sym) = q.sym else {
        let rx = re!(r"^(abstract\s+|sealed\s+|base\s+|final\s+|interface\s+|mixin\s+)*(class|mixin|extension|enum|typedef)\s+[A-Z]\w*|^[A-Z]\w*(<.*>)?\??\s+[a-z]\w*\(|^(Future|Stream|void|bool|int|double|String)\b.*\(");
        let lines: Vec<String> = outline(&files, rx, &d, None, None).into_iter().filter(|l| !re!(r"\s_\w").is_match(l)).collect();
        q.cap(&lines);
        return;
    };
    let es = regex::escape(sym);
    let decl = Regex::new(&format!(r"^(abstract\s+|sealed\s+|base\s+|final\s+|interface\s+|mixin\s+)*(class|mixin|extension|enum|typedef)\s+{es}\b|^\S.*\b{es}\(")).unwrap();
    // members: methods, constructors, getters/setters; private ones (leading _) excluded
    // (python `^\s{2}(?!_)…`: the lookahead is folded into the first character class)
    let body = re!(r"^\s{2}([^\W_]|[<>?,\s])[\w<>?,\s]*\(.*|^\s{2}[A-Z]\w*(\.\w+)?\(.*|^\s{2}[^\W_][\w<>?]*\s+(get|set)\s+\w+");
    let blk = |l: &[String], i: usize, loc: &str| doc_and_block(l, i, loc, "{", "}", Some(body), 60);
    let mut out = outline(&files, &decl, &d, Some(sym), Some(&blk));
    if out.is_empty() {
        out.push(format!("no declaration named {sym}"));
    }
    q.cap(&out);
}

// ---------- luau ----------

fn luau(q: &Q) {
    let root = q.root();
    let idx: Vec<PathBuf> = glob(root.join("*Packages").join("_Index").join("*")).into_iter().filter(|p| p.is_dir()).collect();
    let wt = root.join("wally.toml");
    if q.cmd == "ls" {
        if !wt.exists() {
            println!("no wally.toml");
            return;
        }
        let w: toml::Value = toml::from_str(&read(&wt)).unwrap_or(toml::Value::Table(Default::default()));
        for sec in ["dependencies", "server-dependencies", "dev-dependencies"] {
            for (n, spec) in w.get(sec).and_then(|v| v.as_table()).into_iter().flatten() {
                let spec = spec.as_str().map(str::to_string).unwrap_or_else(|| spec.to_string());
                let tag = if sec == "dependencies" { String::new() } else { format!(" ({})", sec.split('-').next().unwrap_or("")) };
                println!("{n} {spec}{tag}");
            }
        }
        return;
    }
    let want = q.pkg.to_lowercase().replace('/', "_");
    let name = |p: &Path| p.file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default();
    let hits: Vec<&PathBuf> = idx.iter().filter(|p| name(p).to_lowercase().contains(&want)).collect();
    let Some(d) = hits.first() else { die(T, &format!("{} not under Packages/_Index (wally install first)", q.pkg), 2) };
    let inner: Vec<PathBuf> = glob(d.join("*")).into_iter().filter(|x| x.is_dir()).collect();
    let src = inner.first().cloned().unwrap_or_else(|| d.to_path_buf());
    if q.cmd == "where" {
        println!("{}  {}", name(d), s(&src));
        return;
    }
    if q.cmd == "why" {
        let names: Vec<String> = hits.iter().map(|p| name(p)).collect();
        println!("wally has no reverse-dependency query; Packages/_Index entries: {}", names.join(", "));
        return;
    }
    let mut files = glob(src.join("**").join("*.lua"));
    files.extend(glob(src.join("**").join("*.luau")));
    files.sort();
    files.retain(|f| !re!(r"(\.spec|\.test|/__tests__/|/tests?/)").is_match(&s(f).replace('\\', "/")));
    let Some(sym) = q.sym else {
        let rx = re!(r"^\s*(export\s+type\s+\w+|function\s+[\w.:]+\s*\(|local\s+function\s+[A-Z]\w*\s*\(|[\w.]+\s*=\s*function\s*\()");
        let lines: Vec<String> = outline(&files, rx, &src, None, None).into_iter().filter(|l| !re!(r"function\s+_|[.:]_").is_match(l)).collect();
        q.cap(&lines);
        return;
    };
    let es = regex::escape(sym);
    let decl = Regex::new(&format!(r"^\s*(export\s+type\s+{es}\b|function\s+[\w.:]*\b{es}\b|local\s+function\s+{es}\b|[\w.]*\b{es}\s*=\s*function)")).unwrap();
    let blk = |l: &[String], i: usize, loc: &str| {
        let mut j = i;
        while j > 0 && l[j - 1].trim_start().starts_with("--") {
            j -= 1;
        }
        let mut v = vec![format!("── {loc}")];
        v.extend(l[j..=i].iter().map(|x| x.trim_end().to_string()));
        v
    };
    let mut out = outline(&files, &decl, &src, Some(sym), Some(&blk));
    if out.is_empty() {
        out.push(format!("no declaration named {sym}"));
    }
    q.cap(&out);
}

// ---------- python ----------

const PY_INSPECT: &str = r#"
import importlib, importlib.metadata as md, inspect, json, sys
cmd, pkg, sym = sys.argv[1], sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else None)
if cmd == "ls":
    for d in sorted(md.distributions(), key=lambda d: d.metadata["Name"].lower()): print(d.metadata["Name"], d.version)
    sys.exit()
mod = importlib.import_module(pkg)
try: ver = md.version(pkg)
except Exception: ver = getattr(mod, "__version__", "?")
loc = getattr(mod, "__file__", None) or list(getattr(mod, "__path__", ["?"]))[0]
if cmd == "where": print(pkg, ver, " ", loc); sys.exit()
print(pkg, ver, " ", loc)
obj = mod
if sym:
    for part in sym.split("."): obj = getattr(obj, part)
    try: print(f"{sym}{inspect.signature(obj)}")
    except (TypeError, ValueError): print(sym)
    doc = inspect.getdoc(obj) or ""
    print("\n".join(doc.splitlines()[:15]))
    if inspect.isclass(obj):
        for n, m in inspect.getmembers(obj):
            if n.startswith("_") and n != "__init__": continue
            try: sig = str(inspect.signature(m))
            except (TypeError, ValueError): sig = ""
            d = (inspect.getdoc(m) or "").split("\n")[0][:100]
            print(f"  {n}{sig}" + (f"  # {d}" if d else ""))
else:
    names = getattr(mod, "__all__", None) or [n for n in dir(mod) if not n.startswith("_")]
    for n in names[:400]:
        o = getattr(mod, n, None); kind = "class" if inspect.isclass(o) else "def" if callable(o) else "mod" if inspect.ismodule(o) else "val"
        try: sig = str(inspect.signature(o)) if kind == "def" else ""
        except (TypeError, ValueError): sig = ""
        print(f"{kind} {n}{sig}")
"#;

fn py(q: &Q) {
    let root = q.root();
    if q.cmd == "why" {
        let o = run(&[python().as_str(), "-m", "pipdeptree", "-r", "-p", q.pkg], root, 120);
        println!("{}", if o.code == 0 { o.stdout } else { "pipdeptree not installed; reverse deps unavailable".into() });
        return;
    }
    let venv = [".venv/bin/python", "venv/bin/python", ".venv/Scripts/python.exe", "venv/Scripts/python.exe"]
        .iter()
        .map(|p| root.join(p))
        .find(|p| p.exists())
        .map(|p| s(&p))
        .unwrap_or_else(python);
    let mut cmd = vec![venv.as_str(), "-c", PY_INSPECT, q.cmd, q.pkg];
    cmd.extend(q.sym);
    let o = run(&cmd, root, 120);
    if o.stdout.trim().is_empty() {
        let e: Vec<&str> = o.stderr.trim().lines().collect();
        q.cap(&e[e.len().saturating_sub(3)..].iter().map(|x| x.to_string()).collect::<Vec<_>>());
    } else {
        q.lines(&o.stdout);
    }
}
