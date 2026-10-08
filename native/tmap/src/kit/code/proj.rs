//! `tmap kit proj`: project facts in one call, instead of reading manifests, READMEs and listings.

use super::common::*;
use super::langs;
use crate::kit::util;
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

const HELP: &str = "Project facts in one call, instead of reading manifests, READMEs and directory listings.

  tmap kit proj [-C DIR]

Per stack found at the nearest manifest (plus sub-projects up to 2 levels down):
name/version, toolchain version, workspace members / targets, scripts, entry points,
direct dependency count, test layout, and the kit commands that apply.";

/// Toolchain version (first dotted number in the output of `cmd`), "not installed" or "?".
fn ver(base: &Path, cmd: &[&str], rx: Option<&regex::Regex>) -> String {
    let Some(e) = exe(cmd[0], None) else { return "not installed".into() };
    let mut c = vec![e.as_str()];
    c.extend_from_slice(&cmd[1..]);
    let o = run(&c, base, 20);
    let rx = rx.unwrap_or(re!(r"(\d+\.\d+(\.\d+)?)"));
    rx.captures(&format!("{}{}", o.stdout, o.stderr)).map(|m| g(&m, 1).to_string()).unwrap_or_else(|| "?".into())
}

/// Dirs left out of file counts.
const COUNT_SKIP: &[&str] = &["node_modules", "target", "bin", "obj", ".git", ".dart_tool", "Packages", "build", "dist"];

/// Files named like `pat` below `d` outside build dirs.
fn count(pat: &str, d: &Path) -> usize {
    walk_files(d, pat, COUNT_SKIP, true).len()
}

fn first<'a>(rx: &regex::Regex, t: &'a str) -> Option<&'a str> {
    rx.captures(t).and_then(|c| c.get(1)).map(|m| m.as_str())
}

fn list(v: &[String], n: usize) -> String {
    let more = if v.len() > n { " …" } else { "" };
    format!("{}{more}", v.iter().take(n).cloned().collect::<Vec<_>>().join(", "))
}

struct P {
    base: PathBuf,
    ws_members: HashSet<PathBuf>,
}

type Res = Result<(), String>;

fn toml_at(p: &Path) -> Result<toml::Value, String> {
    toml::from_str::<toml::Value>(&std::fs::read_to_string(p).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

fn tstr(v: Option<&toml::Value>) -> Option<String> {
    v.and_then(|x| x.as_str()).map(str::to_string)
}

impl P {
    fn rust(&mut self, d: &Path) -> Res {
        let c = toml_at(&d.join("Cargo.toml"))?;
        let empty = toml::Value::Table(Default::default());
        let p = c.get("package").unwrap_or(&empty);
        let ws = c.get("workspace").unwrap_or(&empty);
        let wsp = ws.get("package");
        let field = |k: &str| tstr(p.get(k)).or_else(|| tstr(wsp.and_then(|w| w.get(k))));
        println!(
            "rust: {} {} edition {}  rustc {}",
            tstr(p.get("name")).unwrap_or_else(|| "(workspace)".into()),
            field("version").unwrap_or_default(),
            field("edition").unwrap_or_else(|| "?".into()),
            ver(&self.base, &["rustc", "-V"], None)
        );
        if let Some(members) = ws.get("members").and_then(|m| m.as_array()).filter(|m| !m.is_empty()) {
            let mut mem: Vec<String> = members
                .iter()
                .filter_map(|m| m.as_str())
                .flat_map(|m| glob(d.join(m)))
                .filter(|x| x.join("Cargo.toml").exists())
                .map(|x| relpath(&x, d))
                .collect();
            mem.sort();
            println!("  workspace members ({}): {}", mem.len(), mem.iter().take(20).cloned().collect::<Vec<_>>().join(", "));
            let rd = PathBuf::from(relpath(d, &self.base));
            self.ws_members.extend(mem.iter().map(|m| normpath(&rd.join(m))));
        }
        let mut bins: Vec<String> = c.get("bin").and_then(|b| b.as_array()).into_iter().flatten().filter_map(|b| tstr(b.get("name"))).collect();
        if bins.is_empty() && d.join("src/main.rs").exists() {
            bins.push("main".into());
        }
        let mut tg = String::new();
        if d.join("src/lib.rs").exists() {
            tg.push_str("lib ");
        }
        if !bins.is_empty() {
            tg.push_str(&format!("bin {}", bins.join(",")));
        }
        if d.join("examples").is_dir() {
            tg.push_str(" examples");
        }
        if d.join("benches").is_dir() {
            tg.push_str(" benches");
        }
        if !tg.trim().is_empty() {
            println!("  targets: {}", tg.trim());
        }
        let mut deps: Vec<String> = Vec::new();
        for t in [c.get("dependencies"), ws.get("dependencies")].into_iter().flatten().filter_map(|t| t.as_table()) {
            for k in t.keys() {
                if !deps.contains(k) {
                    deps.push(k.clone());
                }
            }
        }
        if !deps.is_empty() {
            let feats = c.get("features").and_then(|f| f.as_table()).filter(|f| !f.is_empty());
            let feats = feats.map(|f| format!("; features: {}", f.keys().cloned().collect::<Vec<_>>().join(", "))).unwrap_or_default();
            println!("  deps {}: {}{feats}", deps.len(), list(&deps, 15));
        }
        let tests = if d.join("tests").is_dir() { count("*.rs", &d.join("tests")) } else { 0 };
        println!("  tests: {tests} files in tests/, plus #[test] in src; .rs files: {}", count("*.rs", d));
        Ok(())
    }

    fn go(&self, d: &Path) -> Res {
        let m = read(d.join("go.mod"));
        let module = first(re!(r"(?m)^module\s+(\S+)"), &m).unwrap_or("?");
        let gv = first(re!(r"(?m)^go\s+(\S+)"), &m).unwrap_or("?");
        let req: Vec<String> = re!(r"(?m)^\s+(\S+)\s+v\S+$").captures_iter(&m).map(|c| g(&c, 1).rsplit('/').next().unwrap_or("").to_string()).collect();
        println!("go: {module}  go.mod {gv}  toolchain {}", ver(&self.base, &["go", "version"], Some(re!(r"go(\d+\.\d+(\.\d+)?)"))));
        let mut mains: Vec<String> = walk_files(d, "*.go", &["vendor"], true)
            .into_iter()
            .filter(|f| {
                let t = read(f);
                re!(r"(?m)^package main\b").is_match(trunc(&t, 2000))
            })
            .filter_map(|f| f.parent().map(|p| relpath(p, d)))
            .collect();
        mains.sort();
        mains.dedup();
        if !mains.is_empty() {
            println!("  main packages: {}", mains.iter().take(15).cloned().collect::<Vec<_>>().join(", "));
        }
        println!("  direct deps {}: {}", req.len(), list(&req, 15));
        println!("  .go files: {}, test files: {}", count("*.go", d), count("*_test.go", d));
        Ok(())
    }

    fn ts(&self, d: &Path) -> Res {
        let pj: Value = serde_json::from_str(&read(d.join("package.json"))).unwrap_or(Value::Object(Default::default()));
        let pm = if !glob(d.join("bun.lock*")).is_empty() {
            "bun"
        } else if d.join("pnpm-lock.yaml").exists() {
            "pnpm"
        } else if d.join("yarn.lock").exists() {
            "yarn"
        } else {
            "npm"
        };
        let gs = |k: &str, def: &str| pj.get(k).map(pystr).unwrap_or_else(|| def.to_string());
        println!(
            "ts/js: {} {}  {pm}  node {}{}",
            gs("name", "?"),
            gs("version", ""),
            ver(&self.base, &["node", "-v"], None),
            if pj["type"] == "module" { "  (type: module)" } else { "" }
        );
        if let Some(w) = pj.get("workspaces").filter(|w| !w.is_null() && w != &&Value::Bool(false)) {
            let shown = if w.is_array() { w.clone() } else { w["packages"].clone() };
            println!("  workspaces: {}", pyrepr(&shown));
        }
        if let Some(sc) = pj["scripts"].as_object().filter(|s| !s.is_empty()) {
            let v: Vec<String> = sc.iter().take(12).map(|(k, v)| format!("{k}={}", trunc(&pystr(v), 60))).collect();
            println!("  scripts: {}", v.join("; "));
        }
        let (deps, dev) = (pj["dependencies"].as_object(), pj["devDependencies"].as_object());
        let n = |o: Option<&serde_json::Map<String, Value>>| o.map_or(0, |m| m.len());
        let has = |k: &str| deps.is_some_and(|m| m.contains_key(k)) || dev.is_some_and(|m| m.contains_key(k));
        let fw: Vec<&str> = [
            "next", "react", "vue", "svelte", "@angular/core", "express", "fastify", "hono", "electron", "vite", "vitest", "jest",
            "typescript", "eslint", "@biomejs/biome", "prisma", "drizzle-orm",
        ]
        .into_iter()
        .filter(|k| has(k))
        .collect();
        println!("  deps {} + dev {}; notable: {}", n(deps), n(dev), if fw.is_empty() { "-".into() } else { fw.join(", ") });
        if d.join("tsconfig.json").exists() {
            let tc = read(d.join("tsconfig.json"));
            let flags: Vec<&str> = ["strict", "noUncheckedIndexedAccess", "exactOptionalPropertyTypes"]
                .into_iter()
                .filter(|f| regex::Regex::new(&format!(r#""{f}"\s*:\s*true"#)).unwrap().is_match(&tc))
                .collect();
            println!("  tsconfig: {}", if flags.is_empty() { "not strict".into() } else { flags.join(", ") });
        }
        let truthy = |k: &str| pj.get(k).is_some_and(|v| !(v.is_null() || v == "" || v == &Value::Bool(false)));
        if truthy("main") || truthy("bin") {
            println!("  entry: main={} bin={}", gs("main", "-"), gs("bin", "-"));
        }
        let tests = count("*.test.*", d) + count("*.spec.*", d);
        println!("  .ts/.tsx files: {}, test files: {tests}", count("*.ts", d) + count("*.tsx", d));
        Ok(())
    }

    fn cs(&self, d: &Path) -> Res {
        let mut sln = glob(d.join("*.sln"));
        sln.extend(glob(d.join("*.slnx")));
        let mut projs = glob(d.join("**").join("*.csproj"));
        projs.sort();
        let sname = sln.first().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "(no .sln)".into());
        println!("c#: {sname}  dotnet {}  {} projects", ver(&self.base, &["dotnet", "--version"], None), projs.len());
        for p in projs.iter().take(15) {
            let t = read(p);
            let tfm = first(re!(r"<TargetFrameworks?>([^<]+)"), &t).unwrap_or("?");
            let out = first(re!(r"<OutputType>([^<]+)"), &t).unwrap_or("Library");
            let sdk = first(re!(r#"Sdk="([^"]+)""#), &t).unwrap_or("");
            let n = re!(r"<PackageReference").find_iter(&t).count();
            let test = if re!(r"(?i)xunit|nunit|MSTest|Microsoft\.NET\.Test\.Sdk").is_match(&t) { "test" } else { "" };
            println!("{}", format!("  {}: {tfm} {out} {sdk} pkgs {n} {test}", relpath(p, d)).trim_end());
        }
        Ok(())
    }

    fn luau(&self, d: &Path) -> Res {
        let b = &self.base;
        println!(
            "luau: rojo {}, luau-lsp {}, selene {}, stylua {}, lune {}",
            ver(b, &["rojo", "--version"], None),
            ver(b, &["luau-lsp", "--version"], None),
            ver(b, &["selene", "--version"], None),
            ver(b, &["stylua", "--version"], None),
            ver(b, &["lune", "--version"], None)
        );
        for tc in ["rokit.toml", "aftman.toml", "foreman.toml"] {
            let p = d.join(tc);
            if p.exists() {
                let t = read(&p);
                let tools: Vec<String> = re!(r#"(?m)^(\w[\w-]*)\s*=\s*"([^"]+)""#)
                    .captures_iter(&t)
                    .map(|c| format!("{}={}", g(&c, 1), g(&c, 2).rsplit('@').next().unwrap_or("")))
                    .collect();
                println!("  {tc}: {}", tools.join(", "));
            }
        }
        let mut pfs = glob(d.join("*.project.json"));
        pfs.sort();
        for pf in pfs.iter().take(3) {
            let Ok(j) = serde_json::from_str::<Value>(&read(pf)) else { continue };
            fn walk(node: &Value, path: &str, maps: &mut Vec<String>) {
                for (k, v) in node.as_object().into_iter().flatten() {
                    if k.starts_with('$') || !v.is_object() {
                        continue;
                    }
                    if let Some(p) = v.get("$path") {
                        maps.push(format!("{path}{k} <- {}", pystr(p)));
                    }
                    walk(v, &format!("{path}{k}."), maps);
                }
            }
            let mut maps = Vec::new();
            walk(&j["tree"], "", &mut maps);
            let name = pf.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            println!("  {name}: {}", maps.iter().take(12).cloned().collect::<Vec<_>>().join("; "));
        }
        if d.join("wally.toml").exists() {
            let w = toml_at(&d.join("wally.toml"))?;
            let name = tstr(w.get("package").and_then(|p| p.get("name"))).unwrap_or_else(|| "?".into());
            let deps: Vec<String> = w.get("dependencies").and_then(|x| x.as_table()).map(|t| t.keys().cloned().collect()).unwrap_or_default();
            println!("  wally: {name} deps: {}", deps.join(", "));
        }
        let specs = count("*.spec.lua*", d) + count("*.test.lua*", d);
        println!("  .lua/.luau files: {}, specs: {specs}", count("*.luau", d) + count("*.lua", d));
        Ok(())
    }

    fn dart(&self, d: &Path) -> Res {
        let pubspec = std::fs::read_to_string(d.join("pubspec.yaml")).map_err(|e| e.to_string())?;
        let n = first(re!(r"(?m)^name:\s*(\S+)"), &pubspec).unwrap_or("?");
        let v = first(re!(r"(?m)^version:\s*(\S+)"), &pubspec).unwrap_or("");
        let fl = re!(r"sdk:\s*flutter").is_match(&pubspec);
        let head = re!(r"(?m)^dev_dependencies:").split(&pubspec).next().unwrap_or("");
        let sec = head.split_once("dependencies:").map_or(head, |(_, b)| b);
        let deps: Vec<String> = re!(r"(?m)^  (\w+):").captures_iter(sec).map(|c| g(&c, 1).to_string()).collect();
        let tc = if fl { format!("flutter {}", ver(&self.base, &["flutter", "--version"], None)) } else { format!("dart {}", ver(&self.base, &["dart", "--version"], None)) };
        println!("dart: {n} {v}  {tc}");
        let plats: Vec<&str> = ["android", "ios", "web", "linux", "macos", "windows"].into_iter().filter(|p| d.join(p).is_dir()).collect();
        if !plats.is_empty() {
            println!("  platforms: {}", plats.join(", "));
        }
        println!("  deps {}: {}", deps.len(), deps.iter().take(15).cloned().collect::<Vec<_>>().join(", "));
        println!("  .dart files in lib: {}, tests: {}", count("*.dart", &d.join("lib")), count("*_test.dart", d));
        Ok(())
    }

    fn py(&self, d: &Path) -> Res {
        let t = read(d.join("pyproject.toml"));
        let dirname = d.file_name().map(|x| x.to_string_lossy().into_owned()).unwrap_or_default();
        let n = first(re!(r#"(?m)^name\s*=\s*"([^"]+)""#), &t).map(str::to_string).unwrap_or(dirname);
        let rp = first(re!(r#"requires-python\s*=\s*"([^"]+)""#), &t).map(|r| format!(" requires {r}")).unwrap_or_default();
        let mut tools: Vec<String> = Vec::new();
        for c in re!(r"(?m)^\[tool\.(\w+)").captures_iter(&t) {
            if !tools.iter().any(|x| x == g(&c, 1)) {
                tools.push(g(&c, 1).to_string());
            }
        }
        let venv = [".venv", "venv"].into_iter().find(|v| d.join(v).is_dir()).map(|v| format!("  venv {v}")).unwrap_or_default();
        println!("py: {n}  python {}{rp}{venv}", ver(&self.base, &["python3", "--version"], None));
        if !tools.is_empty() {
            println!("  tools: {}", tools.join(", "));
        }
        println!("  .py files: {}, tests: {}", count("*.py", d), count("test_*.py", d) + count("*_test.py", d));
        Ok(())
    }
}

pub fn main(mut args: Vec<String>) -> i32 {
    if args.first().is_some_and(|a| a == "-h" || a == "--help") {
        println!("{HELP}");
        return 0;
    }
    util::apply_chdir("proj", &mut args);
    let (root, stacks) = find_root(Path::new("."), None);
    let here = util::cwd();
    let base = root.clone().or_else(|| util::git_root(&here)).unwrap_or(here);
    let mut p = P { base: base.clone(), ws_members: HashSet::new() };
    let groot = util::git_root(&base);
    let gnote = match &groot {
        Some(g) if normpath(g) != normpath(&base) => format!("  (git: {})", relpath(&base, g)),
        _ => String::new(),
    };
    println!("root: {}{gnote}", s(&base));
    let log = run(&["git", "log", "-1", "--format=%h %cr: %s"], &base, 10).stdout;
    let br = run(&["git", "branch", "--show-current"], &base, 10).stdout;
    if !log.trim().is_empty() {
        let br = if br.trim().is_empty() { "(detached)" } else { br.trim() };
        println!("git: {br} @ {}", trunc(log.trim(), 100));
    }
    let ctx = Ctx { root: root.clone().unwrap_or_default(), cap: 80, nmax: 10, ..Default::default() };
    if let Some(r) = &root {
        for st in &stacks {
            let res = match *st {
                "rust" => p.rust(r),
                "go" => p.go(r),
                "ts" => p.ts(r),
                "cs" => p.cs(r),
                "luau" => p.luau(r),
                "dart" => p.dart(r),
                "py" => p.py(r),
                other => {
                    match langs::get(other) {
                        Some(l) => (l.proj)(&ctx),
                        None => println!("{}", langs::not_ported(other)),
                    }
                    Ok(())
                }
            };
            if let Err(e) = res {
                println!("{st}: (could not read manifest: {e})");
            }
        }
    }
    let subs: Vec<(String, Vec<&str>)> =
        subprojects(&base, 2).into_iter().filter(|(rp, _)| !p.ws_members.contains(&normpath(Path::new(rp)))).collect();
    if !subs.is_empty() {
        let v: Vec<String> = subs.iter().take(20).map(|(rp, st)| format!("{rp} [{}]", st.join("/"))).collect();
        println!("sub-projects ({}): {}{}", subs.len(), v.join(", "), if subs.len() > 20 { " …" } else { "" });
    }
    if stacks.is_empty() && subs.is_empty() {
        println!("no project manifest found");
    }
    if !stacks.is_empty() {
        println!("kit: check | test [FILTER] | deps ls|where|api|why PKG [SYM] | fmt  (run from here; -C DIR for a sub-project)");
    }
    0
}
