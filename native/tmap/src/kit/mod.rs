//! `tmap kit <tool>`: token-saving helpers for coding agents (ported from token-surgeon).
//! Each tool takes its raw arguments and returns the process exit code.

pub mod util;

// context
pub mod analog;
pub mod debug;
pub mod diff;
pub mod distill;
pub mod patch;
pub mod symctx;
// code (language-aware)
pub mod code;
// utilities
pub mod edit;
pub mod http;
pub mod img;
pub mod jx;
pub mod pdf;
pub mod batch;
pub mod port;
pub mod run;
pub mod ssh;
pub mod tab;
pub mod tally;
pub mod web;

type Tool = fn(Vec<String>) -> i32;

pub const TOOLS: &[(&str, Tool, &str)] = &[
    ("diff", diff::main, "review a diff: stat, touched symbols with callers, affected tests, whole-function diff"),
    ("debug", debug::main, "debug context: failures, top-frame code, code under test, recent changes"),
    ("analog", analog::main, "write context: locate by literal, print analog files and one import hop"),
    ("ctx", symctx::main, "symbol context: definition slice, --refs, --outline"),
    ("patch", patch::main, "atomic find/replace edits from JSON, then the narrowest tests"),
    ("distill", distill::main, "answer a question about big output with a small model; only the answer is printed"),
    ("proj", code::proj::main, "stack facts for the nearest project"),
    ("check", code::check::main, "build + lint, one line per diagnostic"),
    ("test", code::test::main, "run tests: summary + failures only"),
    ("deps", code::deps::main, "dependency API and source: ls | where | api | why"),
    ("fmt", code::fmt::main, "format changed files"),
    ("edit", edit::main, "atomic multi-file edits from <<< old === new >>> blocks"),
    ("jx", jx::main, "JSON/JSONL/TOML: shape | get | keys | find | set | del | merge"),
    ("tab", tab::main, "SQL over CSV/TSV/JSON/JSONL"),
    ("tally", tally::main, "count matches, stats, per file"),
    ("pdf", pdf::main, "PDF as text, one section per page (exit 3 = scanned: read the pages instead)"),
    ("img", img::main, "image info | fit | crop | grid | diff"),
    ("http", http::main, "HTTP request with a compact response"),
    ("port", port::main, "who listens on a port, --kill"),
    ("batch", batch::main, "several independent commands in one call, each output compacted and labelled"),
    ("run", run::main, "any command with compact output: no colours/progress, repeats collapsed, capped, full log saved"),
    ("ssh", ssh::main, "ssh without prompts, capped output, reused connection"),
    ("web", web::main, "web page outline | -s terms | -n section | --ask question"),
];

fn help() -> String {
    let mut s = String::from("tmap kit: token-saving tools for coding agents.\n\nUsage: tmap kit <tool> [args]   (tmap kit <tool> --help)\n\n");
    for (name, _, desc) in TOOLS {
        s.push_str(&format!("  {name:<8} {desc}\n"));
    }
    s
}

const CHILD_ENV: &str = "TFORGE_KIT_CHILD";

pub fn main(mut args: Vec<String>) -> i32 {
    util::quiet_broken_pipe();
    if args.is_empty() || matches!(args[0].as_str(), "-h" | "--help" | "help") {
        print!("{}", help());
        return 0;
    }
    let name = args.remove(0);
    let Some((_, f, _)) = TOOLS.iter().find(|(n, _, _)| *n == name) else {
        eprintln!("tmap kit: unknown tool {name}\n\n{}", help());
        return 2;
    };
    if let Some(report) = std::env::var_os(CHILD_ENV) {
        let code = f(args);
        let (raw, extra) = util::noted();
        let _ = std::fs::write(report, format!("{raw} {extra}"));
        return code;
    }
    if std::env::var("TFORGE_SAVINGS").as_deref() == Ok("0") || args.iter().any(|a| a == "-h" || a == "--help") {
        return f(args);
    }
    metered(&name, &args).unwrap_or_else(|| f(args))
}

/// Run the tool in a child process, pass its stdout through while counting it, and append
/// {t, tool, cwd, raw, out} to savings.jsonl (tokens; see lib/savings.mjs). None if the child
/// could not start, so the caller runs the tool in-process instead.
fn metered(name: &str, args: &[String]) -> Option<i32> {
    use std::io::{Read, Write};
    let report = std::env::temp_dir().join(format!("tforge-kit-{}-{}.txt", std::process::id(), name));
    let mut child = std::process::Command::new(std::env::current_exe().ok()?)
        .arg("kit")
        .arg(name)
        .args(args)
        .env(CHILD_ENV, &report)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .ok()?;
    // The model sees stderr too: forward it as it comes and count it.
    let mut err_pipe = child.stderr.take()?;
    let err = std::thread::spawn(move || {
        let (mut n, mut buf) = (0usize, [0u8; 8192]);
        while let Ok(k) = err_pipe.read(&mut buf) {
            if k == 0 {
                break;
            }
            n += k;
            let mut e = std::io::stderr().lock();
            let _ = e.write_all(&buf[..k]).and_then(|_| e.flush());
        }
        n
    });
    let mut pipe = child.stdout.take()?;
    let (mut shown, mut buf, mut out) = (0usize, [0u8; 16384], std::io::stdout().lock());
    loop {
        match pipe.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                shown += n;
                // A closed reader (`| head`) must not stop the child mid-run: keep draining.
                let _ = out.write_all(&buf[..n]).and_then(|_| out.flush());
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    let code = child.wait().ok().and_then(|s| s.code()).unwrap_or(1);
    shown += err.join().unwrap_or(0);
    let noted = std::fs::read_to_string(&report).unwrap_or_default();
    let _ = std::fs::remove_file(&report);
    let mut it = noted.split_whitespace().map(|x| x.parse::<u64>().unwrap_or(0));
    let (raw, extra) = (it.next().unwrap_or(0), it.next().unwrap_or(0));
    if raw > 0 {
        let line = serde_json::json!({
            "t": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs()),
            "tool": name,
            "cwd": util::cwd().to_string_lossy(),
            "raw": raw,
            "out": util::tokens(shown) + extra,
        });
        let dir = util::cache_home().join("tokenforge");
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("savings.jsonl")) {
            let _ = writeln!(f, "{line}");
        }
    }
    Some(code)
}
