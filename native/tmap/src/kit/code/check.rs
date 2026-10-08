//! `tmap kit check`: build / typecheck / lint, one normalized line per diagnostic.

use super::common::*;
use super::langs;
use crate::kit::util::Output;
use serde_json::Value;
use std::path::Path;
use std::time::Instant;

const HELP: &str = "Build / typecheck / lint the current project; one normalized line per diagnostic.

  tmap kit check [-l STACK] [--fast] [--lint] [--changed] [-e] [-a] [-C DIR]

  -l STACK   only this stack: rust go ts cs luau dart py java cpp php ruby swift elixir zig scala
             (default: all found at the nearest manifest)
  --fast     cheapest pass only (rust: cargo check, not clippy; ts: no eslint; go: no golangci-lint)
  --lint     also run linters that are off by default (eslint)
  --changed  only report diagnostics in files changed vs HEAD (+ untracked)
  -e         errors only     -a  no cap (default 30 lines)     -C DIR  run from DIR

Per stack: rust  cargo clippy --all-targets (json) | go  go build + go vet (+ golangci-lint if configured)
  ts  tsc --noEmit (+ eslint with --lint) | cs  dotnet build | luau  luau-lsp analyze / luau-analyze + selene
  dart  dart analyze | py  ruff + mypy/pyright if configured | java/kotlin  mvn compile / gradle classes
  cpp  cmake --build / meson / make -k (+ clang-tidy with --lint) | php  phpstan or psalm, php -l
  ruby  rubocop/standardrb (+ sorbet) | swift  swift build (+ swiftlint) | elixir  mix compile (+ credo)
  zig  zig build | scala  sbt compile.
Output: \"<stack> (<tools>): N errors, M warnings [time]\" then \"path:line:col SEV CODE message\".
Exit 1 if any error (2 if a detected stack is not ported to tmap kit yet).";

const T: &str = "check";

pub fn main(args: Vec<String>) -> i32 {
    crate::kit::util::count_runs();
    let mut ctx = Ctx { cap: 30, nmax: 10, ..Default::default() };
    let mut want: Option<String> = None;
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
            "--fast" => ctx.opt.fast = true,
            "--lint" => ctx.opt.lint = true,
            "--changed" => ctx.opt.changed = true,
            "-e" => ctx.opt.errors_only = true,
            _ => die(T, &format!("unknown arg {x}"), 2),
        }
    }
    if let Some(w) = &want {
        if !STACKS.contains(&w.as_str()) {
            die(T, &format!("unknown stack {w} (one of {})", STACKS.join(" ")), 2);
        }
    }
    let (root, stacks) = find_root(Path::new("."), want.as_deref());
    let Some(root) = root else {
        die(T, "no project manifest found here or above (Cargo.toml, go.mod, package.json, *.csproj, default.project.json, pubspec.yaml, pyproject.toml)", 2)
    };
    ctx.root = root;
    let chg = ctx.opt.changed.then(|| changed_files(&ctx.root));
    if ctx.root != crate::kit::util::cwd() {
        println!("root: {}", rel(&s(&ctx.root), &ctx.root));
    }
    let mut worst = 0;
    for st in stacks {
        let mut d = Diags::new(&ctx.root);
        let mut used: Vec<String> = Vec::new();
        let t = Instant::now();
        match st {
            "rust" => rust(&ctx, &mut d, &mut used),
            "go" => go(&ctx, &mut d, &mut used),
            "ts" => ts(&ctx, &mut d, &mut used),
            "cs" => cs(&ctx, &mut d, &mut used),
            "luau" => luau(&ctx, &mut d, &mut used),
            "dart" => dart(&ctx, &mut d, &mut used),
            "py" => py(&ctx, &mut d, &mut used),
            other => match langs::get(other) {
                Some(l) => (l.check)(&ctx, &mut d, &mut used),
                None => {
                    println!("{}", langs::not_ported(other));
                    worst = worst.max(2);
                    continue;
                }
            },
        }
        if let Some(c) = &chg {
            d.filter_files(c);
        }
        let (e, w) = (d.count("E"), d.count("W"));
        if e > 0 {
            worst = worst.max(1);
        }
        let tools = if used.is_empty() { "-".to_string() } else { used.join(", ") };
        println!(
            "{st} ({tools}): {e} errors, {w} warnings [{:.1}s]{}",
            t.elapsed().as_secs_f64(),
            if chg.is_some() { " (changed files only)" } else { "" }
        );
        for n in &d.notes {
            println!("  note: {n}");
        }
        d.print(ctx.cap, ctx.opt.errors_only);
    }
    worst
}

fn need(name: &str, root: Option<&Path>, msg: &str) -> String {
    exe(name, root).unwrap_or_else(|| die(T, msg, 2))
}

/// python `out + err` (no separator).
pub fn both(o: &Output) -> String {
    format!("{}{}", o.stdout, o.stderr)
}

// ---------- rust ----------

/// cargo `--message-format=json` compiler messages with a span. `errors_only`: skip warnings;
/// `with_help`: append the span label and a "help: …" extra line (check), else plain errors (test build).
pub fn parse_cargo(d: &mut Diags, out: &str, root: &Path, errors_only: bool, with_help: bool) {
    for ln in out.lines().filter(|l| l.starts_with('{')) {
        let Ok(m) = serde_json::from_str::<Value>(ln) else { continue };
        if m["reason"] != "compiler-message" {
            continue;
        }
        let msg = &m["message"];
        let lvl = msg["level"].as_str().unwrap_or("");
        let spans = msg["spans"].as_array().map(Vec::as_slice).unwrap_or(&[]);
        if !(lvl == "error" || (lvl == "warning" && !errors_only)) || spans.is_empty() {
            continue; // "aborting due to…", "N warnings emitted"
        }
        let mut sp = spans.iter().find(|s| s["is_primary"] == true).unwrap_or(&spans[0]);
        if with_help {
            // follow macro expansions back to user code
            while sp["expansion"].is_object() && sp["file_name"].as_str().unwrap_or("").starts_with('<') {
                sp = &sp["expansion"]["span"];
            }
        }
        let code = msg["code"]["code"].as_str().unwrap_or("");
        let text = msg["message"].as_str().unwrap_or("");
        let file = join(root, sp["file_name"].as_str().unwrap_or(""));
        let (line, col) = (sp["line_start"].as_u64().unwrap_or(0) as usize, sp["column_start"].as_u64().unwrap_or(0) as usize);
        if !with_help {
            d.add(&file, line, col, "E", code, text, None);
            continue;
        }
        let text = match sp["label"].as_str() {
            Some(l) if !l.is_empty() => format!("{text} ({l})"),
            _ => text.to_string(),
        };
        let children = msg["children"].as_array().map(Vec::as_slice).unwrap_or(&[]);
        let help = children.iter().find(|c| c["level"] == "help" && c["message"].as_str().is_some_and(|s| !s.is_empty()));
        let sugg = children
            .iter()
            .flat_map(|c| c["spans"].as_array().map(Vec::as_slice).unwrap_or(&[]))
            .filter_map(|s| s["suggested_replacement"].as_str())
            .find(|s| !s.is_empty());
        let extra = help.map(|h| {
            format!(
                "help: {}{}",
                h["message"].as_str().unwrap_or(""),
                sugg.map(|s| format!(" -> `{}`", trunc(s.trim(), 80))).unwrap_or_default()
            )
        });
        d.add(&file, line, col, lvl, code, &text, extra);
    }
}

fn rust(ctx: &Ctx, d: &mut Diags, used: &mut Vec<String>) {
    let cargo = need("cargo", None, "cargo not found");
    let clippy = !ctx.opt.fast && run(&[&cargo, "clippy", "--version"], &ctx.root, 30).code == 0;
    let sub = if clippy { "clippy" } else { "check" };
    used.push(format!("cargo {sub}"));
    let o = run(&[&cargo, sub, "--workspace", "--all-targets", "--message-format=json"], &ctx.root, 900);
    parse_cargo(d, &o.stdout, &ctx.root, false, true);
    if o.code != 0 && d.count("E") == 0 {
        d.add("", 0, 0, "E", "cargo", &tail(&o.stderr, 6), None);
    }
}

// ---------- go ----------

/// `file.go:line[:col]: msg` lines (go build / go vet).
pub fn parse_go(d: &mut Diags, text: &str, root: &Path, sev: &str, code: &str) {
    let rx = re!(r"^(?:vet: )?(.+?\.go):(\d+)(?::(\d+))?: (.*)$");
    for ln in text.lines() {
        if let Some(m) = rx.captures(ln.trim()) {
            d.add(&join(root, g(&m, 1)), gn(&m, 2), gn(&m, 3), sev, code, g(&m, 4), None);
        }
    }
}

fn go(ctx: &Ctx, d: &mut Diags, used: &mut Vec<String>) {
    let gobin = need("go", None, "go not found");
    used.push("go build+vet".into());
    let o = run(&[&gobin, "build", "./..."], &ctx.root, 900);
    parse_go(d, &both(&o), &ctx.root, "E", "build");
    if o.code != 0 && d.count("E") == 0 {
        d.add("", 0, 0, "E", "go", &tail(&o.stderr, 6), None);
    }
    if d.count("E") > 0 {
        return; // vet on broken code just repeats the errors
    }
    let o = run(&[&gobin, "vet", "./..."], &ctx.root, 900);
    parse_go(d, &both(&o), &ctx.root, "W", "vet");
    let cfg = [".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json"].iter().any(|f| ctx.root.join(f).exists());
    if let (true, Some(gl), false) = (cfg, exe("golangci-lint", None), ctx.opt.fast) {
        used.push("golangci-lint".into());
        let o = run(&[&gl, "run", "./..."], &ctx.root, 900);
        let rx = re!(r"^(.+?\.go):(\d+)(?::(\d+))?: (.*?)(?: \((\w+)\))?$");
        for ln in o.stdout.lines() {
            if let Some(m) = rx.captures(ln.trim()) {
                let code = if g(&m, 5).is_empty() { "lint" } else { g(&m, 5) };
                d.add(&join(&ctx.root, g(&m, 1)), gn(&m, 2), gn(&m, 3), "W", code, g(&m, 4), None);
            }
        }
    }
}

// ---------- ts ----------

/// `tsc --pretty false` output; an indented continuation line becomes the extra line.
pub fn parse_tsc(d: &mut Diags, out: &str, root: &Path) {
    let rx = re!(r"^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$");
    let mut last: Option<usize> = None;
    for ln in out.lines() {
        if let Some(m) = rx.captures(ln) {
            d.add(&join(root, g(&m, 1)), gn(&m, 2), gn(&m, 3), g(&m, 4), g(&m, 5), g(&m, 6), None);
            last = d.items.len().checked_sub(1);
        } else if ln.starts_with("  ") {
            if let Some(it) = last.and_then(|i| d.items.get_mut(i)).filter(|it| it.extra.is_none()) {
                it.extra = Some(ln.trim().to_string());
            }
        }
    }
}

/// `eslint -f json` output; false when it is not JSON.
pub fn parse_eslint(d: &mut Diags, out: &str) -> bool {
    let Ok(Value::Array(files)) = serde_json::from_str::<Value>(if out.trim().is_empty() { "[]" } else { out }) else { return false };
    for f in &files {
        let fp = f["filePath"].as_str().unwrap_or("");
        for m in f["messages"].as_array().into_iter().flatten() {
            let n = |k: &str| m[k].as_u64().unwrap_or(0) as usize;
            let rule = m["ruleId"].as_str().unwrap_or("eslint");
            d.add(fp, n("line"), n("column"), if m["severity"] == 2 { "E" } else { "W" }, rule, m["message"].as_str().unwrap_or(""), None);
        }
    }
    true
}

fn ts(ctx: &Ctx, d: &mut Diags, used: &mut Vec<String>) {
    let root = &ctx.root;
    if root.join("tsconfig.json").exists() {
        let mut cmd = match exe("tsc", Some(root)) {
            Some(t) => vec![t],
            None => vec![need("npx", None, "tsc not found"), "--no-install".into(), "tsc".into()],
        };
        used.push("tsc".into());
        cmd.extend(["--noEmit".into(), "--pretty".into(), "false".into()]);
        let o = run(&cmd, root, 900);
        parse_tsc(d, &o.stdout, root);
        if o.code != 0 && d.items.is_empty() {
            d.add("", 0, 0, "E", "tsc", &tail(&both(&o), 6), None);
        }
    } else if let (true, Some(deno)) = (root.join("deno.json").exists(), exe("deno", None)) {
        used.push("deno check".into());
        let o = run(&[&deno, "check", "."], root, 900);
        if o.code != 0 {
            d.add("", 0, 0, "E", "deno", &tail(&both(&o), 10), None);
        }
    }
    if let (true, Some(es)) = (ctx.opt.lint, exe("eslint", Some(root))) {
        used.push("eslint".into());
        let o = run(&[&es, "-f", "json", "."], root, 900);
        if !parse_eslint(d, &o.stdout) {
            d.add("", 0, 0, "W", "eslint", &tail(if o.stderr.is_empty() { &o.stdout } else { &o.stderr }, 4), None);
        }
    }
}

// ---------- c# ----------

/// MSBuild `file(line,col[,l,c]): error CODE: msg [proj]` lines.
pub fn parse_dotnet(d: &mut Diags, text: &str, errors_only: bool) {
    let rx = re!(r"^\s*(.+?)\((\d+),(\d+)(?:,\d+,\d+)?\): (error|warning) (\w+): (.*?)(?: \[[^\]]+\])?$");
    for ln in text.lines() {
        if let Some(m) = rx.captures(ln) {
            if errors_only && g(&m, 4) != "error" {
                continue;
            }
            d.add(g(&m, 1), gn(&m, 2), gn(&m, 3), g(&m, 4), g(&m, 5), g(&m, 6), None);
        }
    }
}

fn cs(ctx: &Ctx, d: &mut Diags, used: &mut Vec<String>) {
    let dn = need("dotnet", None, "dotnet not found (also looked in ~/.dotnet)");
    used.push("dotnet build".into());
    let o = run(&[&dn, "build", "-nologo", "-v", "q", "-clp:NoSummary", "-p:GenerateFullPaths=true"], &ctx.root, 900);
    parse_dotnet(d, &both(&o), false);
    if o.code != 0 && d.count("E") == 0 {
        d.add("", 0, 0, "E", "dotnet", &tail(&both(&o), 8), None);
    }
}

// ---------- luau ----------

/// luau-lsp / luau-analyze lines: `file(l,c): TypeError: msg`, `file:l:c-…: error[Code]: msg`.
pub fn parse_luau(d: &mut Diags, text: &str, root: &Path) {
    let rx = re!(r"^(.+?\.luau?)[(:](\d+)[,:.](\d+)[^:]*?:\s*(?:(error|warning)\[([\w-]+)\]|(\w+)):\s*(.*)$");
    for ln in text.lines() {
        if let Some(m) = rx.captures(ln.trim()) {
            let kind = if !g(&m, 6).is_empty() { g(&m, 6) } else { g(&m, 5) };
            let sev = if !g(&m, 4).is_empty() {
                g(&m, 4)
            } else if kind.ends_with("Error") || kind.eq_ignore_ascii_case("error") {
                "E"
            } else {
                "W" // lints: LocalUnused, …
            };
            d.add(&join(root, g(&m, 1)), gn(&m, 2), gn(&m, 3), sev, kind, g(&m, 7), None);
        }
    }
}

fn luau(ctx: &Ctx, d: &mut Diags, used: &mut Vec<String>) {
    let root = &ctx.root;
    let mut src: Vec<String> =
        ["src", "lib", "shared", "server", "client"].iter().filter(|x| root.join(x).is_dir()).map(|x| x.to_string()).collect();
    if src.is_empty() {
        src.push(".".into());
    }
    let mut text = String::new();
    if let Some(lsp) = exe("luau-lsp", None) {
        let mut args = vec![lsp, "analyze".to_string()];
        let proj = root.join("default.project.json");
        if let (Some(rojo), true) = (exe("rojo", None), proj.exists()) {
            run(&[rojo, "sourcemap".into(), s(&proj), "--output".into(), "sourcemap.json".into()], root, 120);
        }
        if root.join("sourcemap.json").exists() {
            args.push("--sourcemap=sourcemap.json".into());
        }
        if let Some(df) = ["globalTypes.d.luau", "globalTypes.d.lua", "types/globalTypes.d.luau"].iter().find(|f| root.join(f).exists()) {
            args.push(format!("--definitions={df}"));
        }
        if root.join(".vscode/settings.json").exists() {
            args.push("--settings=.vscode/settings.json".into());
        }
        used.push("luau-lsp analyze".into());
        args.extend(src.iter().cloned());
        text = both(&run(&args, root, 900));
    } else if let Some(an) = exe("luau-analyze", None) {
        used.push("luau-analyze".into());
        let mut args = vec![an];
        args.extend(src.iter().cloned());
        text = both(&run(&args, root, 900));
    } else {
        d.notes.push("no luau-lsp / luau-analyze found: type check skipped".into());
    }
    parse_luau(d, &text, root);
    if let (Some(sel), false) = (exe("selene", None), ctx.opt.fast) {
        used.push("selene".into());
        let mut args = vec![sel, "--display-style=quiet".into()];
        args.extend(src.iter().cloned());
        let o = run(&args, root, 900);
        let rx = re!(r"^(.+?):(\d+):(\d+): (error|warning)\[([\w-]+)\]: (.*)$");
        for ln in o.stdout.lines() {
            if let Some(m) = rx.captures(ln.trim()) {
                d.add(&join(root, g(&m, 1)), gn(&m, 2), gn(&m, 3), g(&m, 4), g(&m, 5), g(&m, 6), None);
            }
        }
    }
}

// ---------- dart ----------

/// `dart analyze --format=machine`: SEVERITY|TYPE|CODE|file|line|col|len|message.
pub fn parse_dart(d: &mut Diags, text: &str) {
    for ln in text.lines() {
        let p: Vec<&str> = ln.split('|').collect();
        if p.len() >= 8 && matches!(p[0], "ERROR" | "WARNING" | "INFO") {
            let n = |s: &str| s.parse().unwrap_or(0);
            d.add(p[3], n(p[4]), n(p[5]), p[0], &p[2].to_lowercase(), &p[7..].join("|").replace("\\|", "|"), None);
        }
    }
}

fn dart(ctx: &Ctx, d: &mut Diags, used: &mut Vec<String>) {
    let dt = exe("dart", None).or_else(|| exe("flutter", None)).unwrap_or_else(|| die(T, "dart not found", 2));
    used.push("dart analyze".into());
    let o = run(&[&dt, "analyze", "--format=machine", "."], &ctx.root, 900);
    parse_dart(d, &both(&o));
}

// ---------- python ----------

/// `ruff check --output-format=concise`; E9xx/F8xx (syntax, undefined names) count as errors.
pub fn parse_ruff(d: &mut Diags, out: &str, root: &Path) {
    let rx = re!(r"^(.+?\.pyi?):(\d+):(\d+): (\S+) (.*)$");
    for ln in out.lines() {
        if let Some(m) = rx.captures(ln) {
            let code = g(&m, 4);
            let sev = if code.starts_with("E9") || code.starts_with("F8") { "E" } else { "W" };
            d.add(&join(root, g(&m, 1)), gn(&m, 2), gn(&m, 3), sev, code, g(&m, 5), None);
        }
    }
}

/// mypy `file:line[:col]: error: msg  [code]`; notes dropped.
pub fn parse_mypy(d: &mut Diags, out: &str, root: &Path) {
    let rx = re!(r"^(.+?\.pyi?):(\d+):(?:(\d+):)? (error|warning|note): (.*?)(?:  \[([\w-]+)\])?$");
    for ln in out.lines() {
        if let Some(m) = rx.captures(ln) {
            if g(&m, 4) != "note" {
                let code = if g(&m, 6).is_empty() { "mypy" } else { g(&m, 6) };
                d.add(&join(root, g(&m, 1)), gn(&m, 2), gn(&m, 3), g(&m, 4), code, g(&m, 5), None);
            }
        }
    }
}

/// System python (python3, then python; python first on Windows, where python3.exe is often
/// only the Microsoft Store stub).
pub fn python() -> String {
    let order = if cfg!(windows) { ["python", "python3"] } else { ["python3", "python"] };
    order.iter().find_map(|n| exe(n, None)).unwrap_or_else(|| order[0].into())
}

fn py(ctx: &Ctx, d: &mut Diags, used: &mut Vec<String>) {
    let root = &ctx.root;
    let ruff = exe("ruff", None);
    if let Some(r) = &ruff {
        used.push("ruff".into());
        parse_ruff(d, &run(&[r, "check", "--output-format=concise", "."], root, 900).stdout, root);
    }
    let cfg = read(root.join("pyproject.toml"));
    if let (true, Some(mypy), false) = (cfg.contains("[tool.mypy]") || root.join("mypy.ini").exists(), exe("mypy", None), ctx.opt.fast) {
        used.push("mypy".into());
        parse_mypy(d, &run(&[&mypy, "."], root, 900).stdout, root);
    }
    if let (true, Some(pr), false) =
        (cfg.contains("[tool.pyright]") || root.join("pyrightconfig.json").exists(), exe("pyright", None), ctx.opt.fast)
    {
        used.push("pyright".into());
        let o = run(&[&pr, "--outputjson"], root, 900);
        if let Ok(v) = serde_json::from_str::<Value>(&o.stdout) {
            for gd in v["generalDiagnostics"].as_array().into_iter().flatten() {
                let st = &gd["range"]["start"];
                d.add(
                    gd["file"].as_str().unwrap_or(""),
                    st["line"].as_u64().unwrap_or(0) as usize + 1,
                    st["character"].as_u64().unwrap_or(0) as usize + 1,
                    gd["severity"].as_str().unwrap_or("error"),
                    gd["rule"].as_str().unwrap_or("pyright"),
                    gd["message"].as_str().unwrap_or(""),
                    None,
                );
            }
        }
    }
    if ruff.is_none() {
        d.notes.push("ruff not found: syntax check only (py_compile)".into());
        used.push("py_compile".into());
        let cmd = [python(), "-m".into(), "compileall".into(), "-q".into(), "-x".into(), r"(\.venv|venv|node_modules|\.git)".into(), ".".into()];
        let o = run(&cmd, root, 900);
        let rx = re!(r#"File "(.+?)", line (\d+)\n(?:.*\n)*?\s*(\w+Error: .*)"#);
        for m in rx.captures_iter(&both(&o)) {
            d.add(g(&m, 1), gn(&m, 2), 0, "E", "syntax", g(&m, 3), None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dg() -> Diags {
        Diags::new(Path::new("/r"))
    }

    #[test]
    fn cargo_json() {
        let out = r#"{"reason":"compiler-artifact","target":{}}
{"reason":"compiler-message","message":{"level":"warning","message":"unused variable: `x`","code":{"code":"unused_variables"},"spans":[{"file_name":"src/main.rs","line_start":3,"column_start":9,"is_primary":true,"label":null}],"children":[{"level":"help","message":"if this is intentional, prefix it with an underscore","spans":[{"suggested_replacement":"_x"}]}]}}
{"reason":"compiler-message","message":{"level":"error","message":"mismatched types","code":{"code":"E0308"},"spans":[{"file_name":"<macro>","line_start":1,"column_start":1,"is_primary":true,"label":"expected u8","expansion":{"span":{"file_name":"src/lib.rs","line_start":7,"column_start":5,"label":"here"}}}],"children":[]}}
{"reason":"compiler-message","message":{"level":"error","message":"aborting due to 1 previous error","code":null,"spans":[],"children":[]}}"#;
        let mut d = dg();
        parse_cargo(&mut d, out, Path::new("/r"), false, true);
        assert_eq!(d.items.len(), 2);
        assert_eq!(d.items[0].code, "unused_variables");
        assert_eq!(d.items[0].extra.as_deref(), Some("help: if this is intentional, prefix it with an underscore -> `_x`"));
        assert!(d.items[1].file.ends_with("src/lib.rs") && d.items[1].line == 7 && d.items[1].msg == "mismatched types (here)");
        let mut d = dg();
        parse_cargo(&mut d, out, Path::new("/r"), true, false);
        assert_eq!(d.items.len(), 1);
        assert_eq!(d.items[0].sev, "E");
    }

    #[test]
    fn go_and_tsc() {
        let mut d = dg();
        parse_go(&mut d, "# example.com/x\n./main.go:12:5: undefined: foo\nvet: pkg/a.go:3: bad printf\n", Path::new("/r"), "E", "build");
        assert_eq!(d.items.len(), 2);
        assert_eq!((d.items[0].line, d.items[0].col, d.items[0].msg.as_str()), (12, 5, "undefined: foo"));
        assert_eq!(d.items[1].col, 0);
        let mut d = dg();
        parse_tsc(&mut d, "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n  Details here.\nsrc/b.ts(1,1): warning TS6133: unused.\n", Path::new("/r"));
        assert_eq!(d.items.len(), 2);
        assert_eq!(d.items[0].code, "TS2322");
        assert_eq!(d.items[0].extra.as_deref(), Some("Details here."));
        assert_eq!(d.items[1].sev, "W");
        let mut d = dg();
        assert!(parse_eslint(&mut d, r#"[{"filePath":"/r/a.js","messages":[{"line":2,"column":3,"severity":2,"ruleId":"no-undef","message":"x is not defined"}]}]"#));
        assert_eq!(d.items[0].code, "no-undef");
        assert!(!parse_eslint(&mut d, "Oops"));
    }

    #[test]
    fn dotnet_dart_luau() {
        let mut d = dg();
        parse_dotnet(&mut d, "/r/A/Program.cs(10,13,10,20): error CS0103: The name 'x' does not exist in the current context [/r/A/A.csproj]\n/r/A/B.cs(2,1): warning CS8618: Non-nullable. [/r/A/A.csproj]\n", false);
        assert_eq!(d.items.len(), 2);
        assert_eq!(d.items[0].msg, "The name 'x' does not exist in the current context");
        assert_eq!((d.items[0].line, d.items[0].col), (10, 13));
        let mut d = dg();
        parse_dart(&mut d, "ERROR|COMPILE_TIME_ERROR|UNDEFINED_IDENTIFIER|/r/lib/main.dart|4|3|5|Undefined name 'x'.\nINFO|LINT|PREFER_CONST|/r/lib/a.dart|1|1|1|Use const \\| or not.\nAnalyzing...\n");
        assert_eq!(d.items.len(), 2);
        assert_eq!((d.items[0].sev.as_str(), d.items[0].code.as_str()), ("E", "undefined_identifier"));
        assert_eq!(d.items[1].msg, "Use const | or not.");
        let mut d = dg();
        parse_luau(&mut d, "src/a.luau(3,5): TypeError: Type 'string' could not be converted into 'number'\nsrc/b.luau(1,7): LocalUnused: Variable 'x' is never used\nsrc/c.lua:2:1-4: error[SyntaxError]: oops\n", Path::new("/r"));
        assert_eq!(d.items.len(), 3);
        assert_eq!((d.items[0].sev.as_str(), d.items[1].sev.as_str()), ("E", "W"));
        assert_eq!(d.items[2].code, "SyntaxError");
    }

    #[test]
    fn ruff_mypy() {
        let mut d = dg();
        parse_ruff(&mut d, "a.py:1:8: F401 [*] `os` imported but unused\nb.py:3:1: F821 Undefined name `x`\nFound 2 errors.\n", Path::new("/r"));
        assert_eq!(d.items.len(), 2);
        assert_eq!((d.items[0].sev.as_str(), d.items[1].sev.as_str()), ("W", "E"));
        assert_eq!(d.items[0].msg, "[*] `os` imported but unused");
        let mut d = dg();
        parse_mypy(&mut d, "a.py:3: error: Incompatible types  [assignment]\na.py:3: note: see docs\nSuccess", Path::new("/r"));
        assert_eq!(d.items.len(), 1);
        assert_eq!(d.items[0].code, "assignment");
    }
}
