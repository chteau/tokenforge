//! `tmap kit eval`: throwaway code from stdin, run so that it leaves no files. Linux: inside bubblewrap, with the
//! filesystem read-only and a private /tmp that is gone when the run ends. Elsewhere, or when bwrap cannot set up
//! the sandbox: in a fresh temp dir (TMPDIR) removed afterwards, and the output says so.

use super::run::{cap, collapse, save_log};
use super::util::{count_runs, cwd, die, read_stdin, run, take_opt, tool, Output};
use regex::Regex;
use std::path::{Path, PathBuf};

const HELP: &str = "Run throwaway code from stdin; it leaves no files.
  tmap kit eval py|js|sh [-n LINES] <<'EOF'
  code
  EOF
py: python3 (python on Windows), js: node (an ES module when it imports, exports or awaits at the top), sh: bash.
Linux: sandboxed with bwrap: files are read-only, /tmp is private and gone after the run.
Elsewhere, or without bwrap: runs with a temp dir as TMPDIR, removed afterwards, and says [unsandboxed].
Output: capped at LINES (default 80, full output saved when cut), \"[exit N]\" when non-zero.";

const TIMEOUT: u64 = 300;
// python.org installs no python3.exe on Windows; that name is the Microsoft Store stub there
const PYTHON: &str = if cfg!(windows) { "python" } else { "python3" };

fn interpreter(lang: &str, code: &str) -> Vec<&'static str> {
    match lang {
        "py" | "python" => vec![PYTHON, "-"],
        "js" | "node" if Regex::new(r#"(?m)^(import[\s{*'"]|export\s|await\s)"#).unwrap().is_match(code) => {
            vec!["node", "--input-type=module", "-"]
        }
        "js" | "node" => vec!["node", "-"],
        "sh" | "bash" => vec!["bash", "-s"],
        _ => die("eval", "language: py, js or sh", 2),
    }
}

/// Inside bwrap; None when bwrap is missing or could not set up the sandbox (the code never ran).
fn sandboxed(argv: &[&str], here: &Path, code: &str) -> Option<Output> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let bwrap = tool("bwrap", None)?;
    let dir = here.to_str()?;
    let mut cmd = vec![bwrap.to_str()?, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
    // a working dir under /tmp (a scratch dir) would be hidden by the private /tmp
    if here.starts_with("/tmp") {
        cmd.extend(["--ro-bind", dir, dir]);
    }
    cmd.extend(["--unshare-pid", "--die-with-parent", "--new-session", "--chdir", dir]);
    cmd.extend(["--setenv", "TMPDIR", "/tmp", "--setenv", "XDG_CACHE_HOME", "/tmp/.cache", "--setenv", "PYTHONDONTWRITEBYTECODE", "1", "--"]);
    cmd.extend_from_slice(argv);
    let o = run(&cmd, here, TIMEOUT, &[], Some(code));
    (o.code == 0 || !o.stdout.is_empty() || !o.stderr.starts_with("bwrap:")).then_some(o)
}

/// Without a sandbox: a fresh temp dir (in memory when /dev/shm exists) as TMPDIR, removed afterwards.
fn scratch(argv: &[&str], here: &Path, code: &str) -> Output {
    let base = if Path::new("/dev/shm").is_dir() { PathBuf::from("/dev/shm") } else { std::env::temp_dir() };
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let dir = base.join(format!("tkit-eval-{}-{t}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let d = dir.to_string_lossy();
    let o = run(argv, here, TIMEOUT, &[("TMPDIR", &d), ("TEMP", &d), ("TMP", &d), ("PYTHONDONTWRITEBYTECODE", "1")], Some(code));
    let _ = std::fs::remove_dir_all(&dir);
    o
}

pub fn main(mut a: Vec<String>) -> i32 {
    if a.is_empty() || a[0] == "--help" || a[0] == "-h" {
        println!("{HELP}");
        return 0;
    }
    let max = take_opt("eval", &mut a, &["-n"]).map_or(80, |v| v.parse().unwrap_or_else(|_| die("eval", "-n needs a number", 2)));
    let code = read_stdin();
    if code.trim().is_empty() {
        die("eval", "no code on stdin", 2);
    }
    let argv = interpreter(&a[0], &code);
    count_runs();
    let here = cwd();
    let boxed = sandboxed(&argv, &here, &code);
    let unboxed = boxed.is_none();
    let o = boxed.unwrap_or_else(|| scratch(&argv, &here, &code));
    let all = o.stdout + &o.stderr;
    let mut lines: Vec<String> = all.lines().map(|l| l.trim_end().to_string()).collect();
    while lines.last().is_some_and(|l| l.is_empty()) {
        lines.pop();
    }
    let lines = collapse(lines, false);
    let log = if lines.len() > max { save_log(&all) } else { String::new() };
    for l in cap(lines, max, o.code != 0, &log) {
        println!("{l}");
    }
    if unboxed {
        println!("[unsandboxed]");
    }
    if o.code != 0 {
        println!("[exit {}]", o.code);
    }
    o.code
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_interpreter() {
        assert_eq!(interpreter("py", "print(1)"), [PYTHON, "-"]);
        assert_eq!(interpreter("js", "console.log(1)"), ["node", "-"]);
        assert_eq!(interpreter("js", "import fs from 'node:fs'\n"), ["node", "--input-type=module", "-"]);
        assert_eq!(interpreter("js", "const x = await import('node:fs')"), ["node", "-"]);
        assert_eq!(interpreter("sh", "ls"), ["bash", "-s"]);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn leaves_no_files() {
        let here = Path::new(env!("CARGO_MANIFEST_DIR"));
        let probe = Path::new("/tmp").join(format!("tkit-eval-probe-{}", std::process::id()));
        let code = format!("mkdir -p {0} && echo hi > {0}/f && cat {0}/f && echo x > \"$TMPDIR/t\" && cat \"$TMPDIR/t\"", probe.display());
        let sh = ["bash", "-s"];
        let Some(o) = sandboxed(&sh, here, &code) else {
            // no usable bwrap: the fallback runs it the same way
            assert_eq!(scratch(&sh, here, &code).stdout, "hi\nx\n");
            let _ = std::fs::remove_dir_all(&probe);
            return;
        };
        assert_eq!(o.stdout, "hi\nx\n", "{}", o.stderr);
        assert!(!probe.exists());
        // a working dir under /tmp stays reachable inside the private /tmp
        std::fs::create_dir_all(&probe).unwrap();
        let o = sandboxed(&sh, &probe, "pwd");
        let _ = std::fs::remove_dir_all(&probe);
        assert_eq!(o.map(|o| o.stdout), Some(format!("{}\n", probe.display())));
    }
}
