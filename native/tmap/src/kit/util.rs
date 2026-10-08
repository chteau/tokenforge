//! Shared helpers for the kit tools: argument parsing, subprocesses with a timeout, tool lookup, git.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

// Savings ledger (see kit::main): tokens the tool read on the model's behalf, and tokens the model
// reads besides stdout (a fitted image). About 4 bytes per token for text.
static RAW: AtomicU64 = AtomicU64::new(0);
static EXTRA_OUT: AtomicU64 = AtomicU64::new(0);
static COUNT_RUNS: AtomicBool = AtomicBool::new(false);

pub fn tokens(bytes: usize) -> u64 {
    (bytes as u64).div_ceil(4)
}

/// Text the model would have read without this tool (a full build log, a whole page or file).
pub fn note_raw(bytes: usize) {
    RAW.fetch_add(tokens(bytes), Ordering::Relaxed);
}

pub fn note_raw_tokens(t: u64) {
    RAW.fetch_add(t, Ordering::Relaxed);
}

/// Tokens the model will read besides what the tool prints.
pub fn note_out_tokens(t: u64) {
    EXTRA_OUT.fetch_add(t, Ordering::Relaxed);
}

/// Count the output of every subprocess `run` starts as raw (check, test, diff, ssh).
pub fn count_runs() {
    COUNT_RUNS.store(true, Ordering::Relaxed);
}

/// Size of `text` as a person would see it: JSON lines (cargo --message-format=json, go test -json,
/// dart --machine, ...) count only their human-readable strings, not the metadata around them.
pub fn plain_len(text: &str) -> usize {
    fn strings(v: &serde_json::Value) -> usize {
        match v {
            serde_json::Value::Object(m) => m
                .iter()
                .map(|(k, x)| match (k.as_str(), x) {
                    ("rendered" | "message" | "Output" | "output" | "text" | "error" | "stack", serde_json::Value::String(s)) => s.len(),
                    (_, serde_json::Value::Object(_) | serde_json::Value::Array(_)) => strings(x),
                    _ => 0,
                })
                .sum(),
            serde_json::Value::Array(a) => a.iter().map(strings).sum(),
            _ => 0,
        }
    }
    let t = text.trim_start();
    if !t.starts_with('{') && !t.starts_with('[') {
        return text.len();
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(t) {
        return strings(&v);
    }
    text.lines()
        .map(|l| match serde_json::from_str::<serde_json::Value>(l) {
            Ok(v @ (serde_json::Value::Object(_) | serde_json::Value::Array(_))) => strings(&v),
            _ => l.len() + 1,
        })
        .sum()
}

pub fn noted() -> (u64, u64) {
    (RAW.load(Ordering::Relaxed), EXTRA_OUT.load(Ordering::Relaxed))
}

/// Print "tool: msg" to stderr and exit with `code`.
pub fn die(tool: &str, msg: &str, code: i32) -> ! {
    eprintln!("{tool}: {msg}");
    std::process::exit(code)
}

/// Remove a boolean flag (any of `names`) from `args`; true if it was there.
pub fn take_flag(args: &mut Vec<String>, names: &[&str]) -> bool {
    let before = args.len();
    args.retain(|a| !names.contains(&a.as_str()));
    args.len() != before
}

/// Remove `name VALUE` from `args` and return VALUE. Exits if the value is missing.
pub fn take_opt(tool: &str, args: &mut Vec<String>, names: &[&str]) -> Option<String> {
    let i = args.iter().position(|a| names.contains(&a.as_str()))?;
    if i + 1 >= args.len() {
        die(tool, &format!("{} needs a value", args[i]), 2);
    }
    let v = args.remove(i + 1);
    args.remove(i);
    Some(v)
}

/// Apply a `-C DIR` option by changing the working directory.
pub fn apply_chdir(tool: &str, args: &mut Vec<String>) {
    if let Some(d) = take_opt(tool, args, &["-C"]) {
        if let Err(e) = std::env::set_current_dir(&d) {
            die(tool, &format!("-C {d}: {e}"), 2);
        }
    }
}

pub fn read_stdin() -> String {
    let mut s = String::new();
    let _ = std::io::stdin().read_to_string(&mut s);
    s
}

pub struct Output {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub secs: f64,
}

/// The program to spawn for `name`. Windows: a bare name goes through [`tool`], because
/// `Command::new("npm")` only finds `npm.exe`, never the `npm.cmd`/`.bat` shims npm, npx, yarn,
/// pnpm, tsc, eslint, flutter… install (Rust escapes the arguments of a `.cmd`/`.bat` given by
/// full path). `python3` falls back to `python`, the usual name there.
fn program(name: &str) -> PathBuf {
    if !cfg!(windows) || name.contains(['/', '\\']) || Path::new(name).extension().is_some() {
        return PathBuf::from(name);
    }
    let alt: &[&str] = if name == "python3" { &["python3", "python"] } else { &[name] };
    alt.iter().find_map(|n| tool(n, None)).unwrap_or_else(|| PathBuf::from(name))
}

/// `Command` for argv `cmd` (program resolved as in [`program`]). Windows: `cmd /C SCRIPT`
/// hands SCRIPT to cmd.exe verbatim (`/D /S /C "SCRIPT"`), since cmd.exe does not parse the
/// MSVC-style quoting Rust applies to ordinary arguments.
pub fn command<S: AsRef<str>>(cmd: &[S]) -> Command {
    let prog = cmd[0].as_ref();
    #[cfg(windows)]
    if cmd.len() >= 3 && prog.eq_ignore_ascii_case("cmd") && cmd[1].as_ref().eq_ignore_ascii_case("/C") {
        use std::os::windows::process::CommandExt;
        let script: Vec<&str> = cmd[2..].iter().map(AsRef::as_ref).collect();
        let mut c = Command::new("cmd");
        c.raw_arg("/D /S /C").raw_arg(format!("\"{}\"", script.join(" ")));
        return c;
    }
    let mut c = Command::new(program(prog));
    c.args(cmd[1..].iter().map(AsRef::as_ref));
    c
}

/// Kill `child` and, on Windows, its whole process tree: a `.cmd` shim runs node/dotnet under
/// cmd.exe, and a surviving grandchild would keep the output pipes open forever.
fn kill_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &child.id().to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

/// Run `cmd` in `cwd`, capturing output, with a timeout and colour-free env.
/// Exit 124 on timeout, 127 if the program is missing.
pub fn run(cmd: &[&str], cwd: &Path, timeout_s: u64, env: &[(&str, &str)], stdin: Option<&str>) -> Output {
    let t = Instant::now();
    let mut c = command(cmd);
    c.current_dir(cwd)
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in [
        ("NO_COLOR", "1"),
        ("CARGO_TERM_COLOR", "never"),
        ("FORCE_COLOR", "0"),
        ("TERM", "dumb"),
        ("DOTNET_CLI_TELEMETRY_OPTOUT", "1"),
        ("DOTNET_NOLOGO", "1"),
    ] {
        c.env(k, v);
    }
    for (k, v) in env {
        c.env(k, v);
    }
    let mut child = match c.spawn() {
        Ok(ch) => ch,
        Err(e) => {
            let msg = if e.kind() == std::io::ErrorKind::NotFound { format!("not found: {}", cmd[0]) } else { e.to_string() };
            return Output { code: 127, stdout: String::new(), stderr: msg, secs: 0.0 };
        }
    };
    if let (Some(s), Some(mut w)) = (stdin, child.stdin.take()) {
        let s = s.to_string();
        std::thread::spawn(move || {
            use std::io::Write;
            let _ = w.write_all(s.as_bytes());
        });
    }
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();
    let ho = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = so.read_to_end(&mut b);
        b
    });
    let he = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = se.read_to_end(&mut b);
        b
    });
    let deadline = Duration::from_secs(timeout_s);
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) if t.elapsed() >= deadline => {
                kill_tree(&mut child);
                let _ = child.wait();
                timed_out = true;
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => break None,
        }
    };
    let stdout = String::from_utf8_lossy(&ho.join().unwrap_or_default()).into_owned();
    let mut stderr = String::from_utf8_lossy(&he.join().unwrap_or_default()).into_owned();
    if COUNT_RUNS.load(Ordering::Relaxed) {
        note_raw(plain_len(&stdout) + plain_len(&stderr));
    }
    let code = if timed_out {
        stderr = format!("timeout after {timeout_s}s");
        124
    } else {
        status.and_then(|s| s.code()).unwrap_or(1)
    };
    Output { code, stdout, stderr, secs: t.elapsed().as_secs_f64() }
}

/// The user's home: $HOME, or %USERPROFILE% first on Windows (Git Bash/MSYS export a $HOME
/// that native programs may not share).
pub fn home() -> PathBuf {
    let (a, b) = if cfg!(windows) { ("USERPROFILE", "HOME") } else { ("HOME", "USERPROFILE") };
    let var = |k| std::env::var_os(k).filter(|v| !v.is_empty());
    var(a).or_else(|| var(b)).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

/// Per-user cache dir: $XDG_CACHE_HOME, else %LOCALAPPDATA% on Windows, else ~/.cache.
pub fn cache_home() -> PathBuf {
    let var = |k| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    var("XDG_CACHE_HOME").or_else(|| if cfg!(windows) { var("LOCALAPPDATA") } else { None }).unwrap_or_else(|| home().join(".cache"))
}

/// `canonicalize`, minus the `\\?\` verbatim prefix Windows adds (`\\?\C:\x` -> `C:\x`,
/// `\\?\UNC\srv\share` -> `\\srv\share`), so the result compares, joins and prints like the paths
/// git, compilers and cmd.exe use (cmd.exe refuses a verbatim cwd). `p` unchanged on error.
pub fn canon(p: &Path) -> PathBuf {
    p.canonicalize().map(strip_verbatim).unwrap_or_else(|_| p.to_path_buf())
}

pub fn strip_verbatim(p: PathBuf) -> PathBuf {
    let Some(s) = p.to_str() else { return p };
    if let Some(r) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{r}"));
    }
    match s.strip_prefix(r"\\?\") {
        Some(r) if r.len() >= 2 && r.as_bytes()[0].is_ascii_alphabetic() && r.as_bytes()[1] == b':' => PathBuf::from(r),
        _ => p,
    }
}

/// Path as text with '/' separators on Windows (how git prints paths); unchanged elsewhere.
pub fn slash(p: &Path) -> String {
    let s = p.to_string_lossy();
    if cfg!(windows) { s.replace('\\', "/") } else { s.into_owned() }
}

/// True when `s` has line breaks and all of them are CRLF.
pub fn is_crlf(s: &str) -> bool {
    let n = s.matches('\n').count();
    n > 0 && s.matches("\r\n").count() == n
}

/// Local path of a `file://` URL: `file:///C:/a%20b` -> `C:/a b`, `file:///x` -> `/x`.
pub fn file_url_path(u: &str) -> Option<String> {
    let p = u.strip_prefix("file://")?;
    let p = p.strip_prefix("localhost").unwrap_or(p);
    let b = p.as_bytes();
    let p = if b.len() >= 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' { &p[1..] } else { p };
    let (b, mut out, mut i) = (p.as_bytes(), Vec::new(), 0);
    while i < b.len() {
        let hex = (b[i] == b'%' && i + 2 < b.len())
            .then(|| std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()))
            .flatten();
        match hex {
            Some(c) => {
                out.push(c);
                i += 3;
            }
            None => {
                out.push(b[i]);
                i += 1;
            }
        }
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}

/// Move `tmp` over `dest`. Windows refuses the rename while another process (editor, indexer,
/// antivirus, a running dev server) holds `dest` open without delete sharing: retry briefly,
/// then overwrite `dest` in place with `data`. `tmp` is removed either way.
pub fn replace_file(tmp: &Path, dest: &Path, data: &[u8]) -> std::io::Result<()> {
    let mut res = std::fs::rename(tmp, dest);
    if cfg!(windows) {
        for _ in 0..5 {
            match &res {
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                    std::thread::sleep(Duration::from_millis(50));
                    res = std::fs::rename(tmp, dest);
                }
                _ => break,
            }
        }
        if matches!(&res, Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied) {
            res = std::fs::write(dest, data);
        }
    }
    if res.is_err() || cfg!(windows) {
        let _ = std::fs::remove_file(tmp);
    }
    res
}

/// Windows has no SIGPIPE: `println!` into a closed pipe (`tmap kit … | head`) panics there.
/// Exit quietly instead, like the default SIGPIPE action does on unix.
pub fn quiet_broken_pipe() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let p = info.payload();
        let msg = p.downcast_ref::<String>().map(String::as_str).or_else(|| p.downcast_ref::<&str>().copied()).unwrap_or("");
        if msg.starts_with("failed printing to stdout") {
            std::process::exit(0);
        }
        prev(info)
    }));
}

/// Executable file names to try for `name`: Windows uses the launchable PATHEXT extensions
/// (an extensionless `npm` next to `npm.cmd` is a sh script CreateProcess cannot start).
fn exe_names(name: &str, windows: bool, pathext: Option<&str>) -> Vec<String> {
    if !windows {
        return vec![name.to_string()];
    }
    let mut exts: Vec<String> = pathext.unwrap_or("").split(';').map(|e| e.trim().to_ascii_lowercase()).collect();
    exts.retain(|e| matches!(e.as_str(), ".com" | ".exe" | ".bat" | ".cmd"));
    if exts.is_empty() {
        exts = [".com", ".exe", ".bat", ".cmd"].map(String::from).to_vec();
    }
    let lower = name.to_ascii_lowercase();
    if exts.iter().any(|e| lower.ends_with(e.as_str())) {
        return vec![name.to_string()];
    }
    exts.iter().map(|e| format!("{name}{e}")).collect()
}

fn is_exe(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        p.is_file() && p.metadata().map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

/// Resolve an executable: project node_modules/.bin, PATH, then the usual toolchain bin dirs.
pub fn tool(name: &str, root: Option<&Path>) -> Option<PathBuf> {
    let names = exe_names(name, cfg!(windows), std::env::var("PATHEXT").ok().as_deref());
    let try_dir = |d: &Path| names.iter().map(|n| d.join(n)).find(|p| is_exe(p));
    if let Some(r) = root {
        if let Some(p) = try_dir(&r.join("node_modules").join(".bin")) {
            return Some(p);
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for d in std::env::split_paths(&path) {
            if let Some(p) = try_dir(&d) {
                return Some(p);
            }
        }
    }
    let h = home();
    for d in [
        ".cargo/bin", "go/bin", ".dotnet", ".dotnet/tools", ".rokit/bin", ".aftman/bin", ".foreman/bin", ".local/bin", ".bun/bin",
        ".pub-cache/bin", "flutter/bin",
    ] {
        if let Some(p) = try_dir(&h.join(d)) {
            return Some(p);
        }
    }
    if cfg!(windows) {
        // Global npm installs, Dart's pub cache and scoop shims on Windows.
        let var = |k: &str| std::env::var_os(k).map(PathBuf::from);
        let dirs = [var("APPDATA").map(|d| d.join("npm")), var("LOCALAPPDATA").map(|d| d.join("Pub").join("Cache").join("bin")), Some(h.join("scoop").join("shims"))];
        return dirs.iter().flatten().find_map(|d| try_dir(d));
    }
    None
}

/// `git rev-parse --show-toplevel` from `start`.
pub fn git_root(start: &Path) -> Option<PathBuf> {
    let o = run(&["git", "rev-parse", "--show-toplevel"], start, 5, &[], None);
    let s = o.stdout.trim();
    // git prints C:/x on Windows: use native separators so it prints and prefixes like other paths.
    (o.code == 0 && !s.is_empty()).then(|| PathBuf::from(if cfg!(windows) { s.replace('/', "\\") } else { s.to_string() }))
}

/// Run git in `cwd` and return stdout ("" on failure).
pub fn git(cwd: &Path, args: &[&str]) -> String {
    let mut v = vec!["git"];
    v.extend_from_slice(args);
    let o = run(&v, cwd, 60, &[], None);
    if o.code == 0 { o.stdout } else { String::new() }
}

pub fn cwd() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// Last `n` non-empty lines of `text`.
pub fn tail_lines(text: &str, n: usize) -> Vec<String> {
    let v: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    v[v.len().saturating_sub(n)..].iter().map(|s| s.to_string()).collect()
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_len_counts_readable_text_of_machine_output() {
        assert_eq!(plain_len("error: x\n"), 9);
        let cargo = "{\"reason\":\"compiler-artifact\",\"package_id\":\"a 1.0\",\"filenames\":[\"/t/liba.rlib\"]}\n{\"reason\":\"compiler-message\",\"message\":{\"rendered\":\"warning: unused\\n\",\"spans\":[]}}\n";
        assert_eq!(plain_len(cargo), "warning: unused\n".len());
        assert_eq!(plain_len("[{\"message\":\"boom\",\"line\":3}]"), 4);
        assert_eq!(plain_len("{bad json\nplain\n"), 10 + 6);
    }

    #[test]
    fn windows_exe_names() {
        assert_eq!(exe_names("npm", false, None), vec!["npm"]);
        assert_eq!(exe_names("npm", true, Some(".COM;.EXE;.BAT;.CMD;.VBS;.PS1")), vec!["npm.com", "npm.exe", "npm.bat", "npm.cmd"]);
        assert_eq!(exe_names("npm", true, None), vec!["npm.com", "npm.exe", "npm.bat", "npm.cmd"]);
        assert_eq!(exe_names("tsc.CMD", true, Some(".EXE;.CMD")), vec!["tsc.CMD"]);
    }

    #[test]
    fn verbatim_urls_and_eol() {
        assert_eq!(strip_verbatim(PathBuf::from(r"\\?\C:\proj\src")), PathBuf::from(r"C:\proj\src"));
        assert_eq!(strip_verbatim(PathBuf::from(r"\\?\UNC\srv\share\x")), PathBuf::from(r"\\srv\share\x"));
        assert_eq!(strip_verbatim(PathBuf::from(r"\\?\GLOBALROOT\x")), PathBuf::from(r"\\?\GLOBALROOT\x"));
        assert_eq!(strip_verbatim(PathBuf::from("/home/x")), PathBuf::from("/home/x"));
        assert_eq!(file_url_path("file:///C:/Users/a%20b/x.dart").as_deref(), Some("C:/Users/a b/x.dart"));
        assert_eq!(file_url_path("file:///home/x/").as_deref(), Some("/home/x/"));
        assert_eq!(file_url_path("../x"), None);
        assert!(is_crlf("a\r\nb\r\n") && !is_crlf("a\r\nb\n") && !is_crlf("a"));
    }
}
