//! `tmap kit ssh`: remote commands over the system ssh, never prompting, with capped output
//! and one reused connection per host (ControlMaster, unix only).

use super::util::{cwd, home, run, tool, Output};
use std::path::PathBuf;

const HELP: &str = "Remote work over SSH with compact, bounded output. Never prompts (BatchMode);
reuses one connection per host for 10 min, so repeated calls are fast.
  tmap kit ssh hosts                     aliases from ~/.ssh/config: alias, user@host:port
  tmap kit ssh check HOST[,HOST..]       one line per host: reachable/auth, OS, uptime, load, disk /, mem
  tmap kit ssh HOST[,HOST..] CMD..       run CMD (joined like ssh does); output capped (TFORGE_SSH_MAX lines,
                                         default 200: head + tail), exit code shown when non-zero.
                                         Several hosts run in parallel, lines prefixed \"host| \".
  tmap kit ssh tail HOST FILE [-n N] [-e REGEX]   last N (default 80) lines of a remote file, optionally filtered
  tmap kit ssh svc HOST UNIT [-n N]      systemd unit state + last N (default 30) journal lines
  tmap kit ssh get HOST:PATH [DEST]      copy down (rsync if both ends have it, else scp); one summary line
  tmap kit ssh put SRC.. HOST:PATH       copy up
  tmap kit ssh run HOST CMD.. --stdin    same as HOST CMD, but forward this process's stdin";

const PROBE: &str = r#". /etc/os-release 2>/dev/null; printf "%s | %s | up %s | load %s | / %s used | mem %s\n" "${PRETTY_NAME:-$(uname -s)}" "$(uname -r)" "$(uptime -p 2>/dev/null | sed "s/^up //")" "$(cut -d" " -f1-3 /proc/loadavg 2>/dev/null)" "$(df -P / | awk "NR==2{print \$5}")" "$(free -m 2>/dev/null | awk "/^Mem/{printf \"%d/%dM\", \$3, \$2}")""#;
/// No overall time limit, like plain ssh (ConnectTimeout and ServerAlive still apply).
const NO_LIMIT: u64 = 7 * 24 * 3600;

fn env_or(k: &str, d: &str) -> String {
    std::env::var(k).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| d.to_string())
}

fn max_lines() -> usize {
    env_or("TFORGE_SSH_MAX", "200").parse().unwrap_or(200)
}

/// Quote for a POSIX shell (like bash's printf %q, but with single quotes).
fn q(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "_./=:@%+,-".contains(c)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

/// Common -o options: BatchMode, timeouts and (unix) connection multiplexing.
fn opts() -> Vec<String> {
    let mut o = vec![
        "BatchMode=yes".to_string(),
        format!("ConnectTimeout={}", env_or("TFORGE_SSH_TIMEOUT", "8")),
        "ServerAliveInterval=15".into(),
    ];
    if cfg!(unix) {
        let cp = PathBuf::from(env_or("XDG_RUNTIME_DIR", "/tmp")).join("tforge-ssh-%C");
        o.extend(["ControlMaster=auto".into(), "ControlPersist=10m".into(), format!("ControlPath={}", cp.display())]);
    }
    o.push("LogLevel=ERROR".into());
    o.into_iter().flat_map(|x| ["-o".to_string(), x]).collect()
}

fn ssh_args(host: &str, stdin: bool, cmd: &str) -> Vec<String> {
    let mut v = vec!["ssh".to_string()];
    if !stdin {
        v.push("-n".into());
    }
    v.extend(opts());
    v.extend([host.to_string(), cmd.to_string()]);
    v
}

fn exec(args: &[String], stdin: Option<&str>) -> Output {
    let v: Vec<&str> = args.iter().map(String::as_str).collect();
    run(&v, &cwd(), NO_LIMIT, &[], stdin)
}

/// ssh's stderr as one actionable line.
fn explain(err: &str) -> String {
    let lines: Vec<&str> = err.lines().filter(|l| !l.trim().is_empty()).collect();
    let e = lines[lines.len().saturating_sub(3)..].join(" ");
    let has = |s: &str| e.contains(s);
    if has("Permission denied") {
        "auth failed (no password prompts here): load a key with ssh-add, or set IdentityFile in ~/.ssh/config".into()
    } else if has("Host key verification failed") || has("REMOTE HOST IDENTIFICATION") {
        "host key unknown or changed: verify it, then connect once by hand (ssh HOST) to accept it".into()
    } else if has("Could not resolve") {
        "hostname does not resolve (typo, or alias missing from ~/.ssh/config: tmap kit ssh hosts)".into()
    } else if has("timed out") {
        "connection timed out (host down, firewall, or VPN off)".into()
    } else if has("Connection refused") {
        "connection refused (sshd not running or wrong port)".into()
    } else {
        e.chars().take(300).collect()
    }
}

/// At most `max` lines (2/5 head + rest tail, gap counted), ANSI colours stripped.
fn cap(text: &str, max: usize) -> Vec<String> {
    let ansi = regex::Regex::new(r"\x1b\[[0-9;]*[mK]").unwrap();
    let lines: Vec<String> = text.lines().map(|l| ansi.replace_all(l, "").into_owned()).collect();
    let n = lines.len();
    if n <= max {
        return lines;
    }
    let (h, t) = (max * 2 / 5, max - max * 2 / 5);
    let mut out = lines[..h].to_vec();
    out.push(format!("... [{} lines omitted of {n}; narrow the command, or TFORGE_SSH_MAX=N] ...", n - h - t));
    out.extend_from_slice(&lines[n - t..]);
    out
}

/// Run `cmd` on one host: capped stdout+stderr, "[exit N]" when non-zero.
fn run1(host: &str, stdin: Option<&str>, cmd: &str) -> (Vec<String>, i32) {
    let o = exec(&ssh_args(host, stdin.is_some(), cmd), stdin);
    if o.code == 255 && o.stdout.is_empty() {
        return (vec![format!("ssh {host}: {}", explain(&o.stderr))], 255);
    }
    let mut out = cap(&(o.stdout + &o.stderr), max_lines());
    if o.code != 0 {
        out.push(format!("[exit {}]", o.code));
    }
    (out, o.code)
}

/// One host: its output and code. Several (comma list): parallel, lines prefixed "host| ", code 1 if any failed.
fn multi(hosts: &str, stdin: Option<&str>, cmd: &str) -> i32 {
    let hl: Vec<&str> = hosts.split(',').filter(|h| !h.is_empty()).collect();
    if hl.len() <= 1 {
        let (out, rc) = run1(hosts, stdin, cmd);
        out.iter().for_each(|l| println!("{l}"));
        return rc;
    }
    let res: Vec<(Vec<String>, i32)> = std::thread::scope(|s| {
        let hs: Vec<_> = hl.iter().map(|h| s.spawn(move || run1(h, stdin, cmd))).collect();
        hs.into_iter().map(|j| j.join().unwrap_or((vec!["thread panicked".into()], 1))).collect()
    });
    let mut rc = 0;
    for (h, (out, code)) in hl.iter().zip(res) {
        out.iter().for_each(|l| println!("{h}| {l}"));
        if code != 0 {
            rc = 1;
        }
    }
    rc
}

fn wild(p: &[u8], s: &[u8]) -> bool {
    match (p.first(), s.first()) {
        (None, None) => true,
        (Some(b'*'), _) => wild(&p[1..], s) || (!s.is_empty() && wild(p, &s[1..])),
        (Some(b'?'), Some(_)) => wild(&p[1..], &s[1..]),
        (Some(a), Some(b)) if a == b => wild(&p[1..], &s[1..]),
        _ => false,
    }
}

/// Include targets: ~ expanded, relative to ~/.ssh, globs in the file name.
fn includes(tok: &str) -> Vec<PathBuf> {
    let h = home();
    let p = match tok.strip_prefix("~/") {
        Some(r) => h.join(r),
        None if PathBuf::from(tok).is_absolute() => PathBuf::from(tok),
        None => h.join(".ssh").join(tok),
    };
    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !name.contains(['*', '?']) {
        return vec![p].into_iter().filter(|p| p.is_file()).collect();
    }
    let dir = p.parent().map(PathBuf::from).unwrap_or_default();
    let mut v: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map(|rd| rd.flatten().filter(|e| wild(name.as_bytes(), e.file_name().to_string_lossy().as_bytes())).map(|e| e.path()).collect())
        .unwrap_or_default();
    v.retain(|p| p.is_file());
    v.sort();
    v
}

/// Values of `key` lines (case-insensitive first word) in an ssh config.
fn words_of(cfg: &str, key: &str) -> Vec<String> {
    cfg.lines()
        .filter_map(|l| {
            let mut w = l.split_whitespace();
            w.next().filter(|k| k.eq_ignore_ascii_case(key)).map(|_| w.map(str::to_string).collect::<Vec<_>>())
        })
        .flatten()
        .collect()
}

fn hosts() -> i32 {
    let cfg = home().join(".ssh").join("config");
    let Ok(main) = std::fs::read_to_string(&cfg) else {
        println!("no ~/.ssh/config");
        return 0;
    };
    let mut text = main.clone();
    for f in words_of(&main, "include").iter().flat_map(|t| includes(t)) {
        text.push('\n');
        text.push_str(&std::fs::read_to_string(f).unwrap_or_default());
    }
    let mut names: Vec<String> = words_of(&text, "host").into_iter().filter(|h| !h.contains(['*', '?', '!'])).collect();
    names.sort();
    names.dedup();
    let rows: Vec<String> = std::thread::scope(|s| {
        let hs: Vec<_> = names
            .iter()
            .map(|a| {
                s.spawn(move || {
                    let o = run(&["ssh", "-G", a], &cwd(), 10, &[], None);
                    let get = |k: &str| o.stdout.lines().find_map(|l| l.strip_prefix(k).and_then(|r| r.strip_prefix(' '))).unwrap_or("").to_string();
                    format!("{a:<20} {}@{}:{}", get("user"), get("hostname"), get("port"))
                })
            })
            .collect();
        hs.into_iter().filter_map(|j| j.join().ok()).collect()
    });
    rows.iter().for_each(|r| println!("{r}"));
    0
}

fn tail_cmd(f: &str, n: &str, re: Option<&str>) -> String {
    match re {
        Some(re) => format!("grep -E {} {} | tail -n {n}", q(re), q(f)),
        None => format!("tail -n {n} {}", q(f)),
    }
}

fn svc_cmd(unit: &str, n: &str) -> String {
    let u = q(unit);
    format!(
        "systemctl show {u} -p ActiveState,SubState,MainPID,ExecMainStartTimestamp,NRestarts --no-pager | tr '\\n' ' '; echo; journalctl -u {u} -n {n} --no-pager -o short-iso 2>&1 | grep -v '^-- '"
    )
}

/// get: copy HOST:PATH down to DEST; put: copy SRC.. up to HOST:PATH. rsync when both ends have it, else scp.
fn copy(dir: &str, a: &[String]) -> i32 {
    let (src, dst, host) = if dir == "get" {
        (vec![a[0].clone()], a.get(1).cloned().unwrap_or_else(|| ".".into()), a[0].split(':').next().unwrap_or("").to_string())
    } else {
        let dst = a[a.len() - 1].clone();
        let host = dst.split(':').next().unwrap_or("").to_string();
        (a[..a.len() - 1].to_vec(), dst, host)
    };
    let o = opts();
    let remote_rsync = || exec(&ssh_args(&host, false, "command -v rsync"), None).code == 0;
    // Windows rsync builds (cwRsync, msys) read `C:\x` as a remote host spec: use scp there.
    let (res, rsync) = if cfg!(unix) && tool("rsync", None).is_some() && remote_rsync() {
        let rsh = std::iter::once("ssh".to_string()).chain(o.iter().map(|x| q(x))).collect::<Vec<_>>().join(" ");
        let mut v: Vec<String> = ["rsync", "-az", "--partial", "--info=stats1", "-e", &rsh].map(String::from).to_vec();
        v.extend(src.iter().cloned());
        v.push(dst.clone());
        (exec(&v, None), true)
    } else {
        let mut v: Vec<String> = vec!["scp".into(), "-rq".into()];
        v.extend(o);
        v.extend(src.iter().cloned());
        v.push(dst.clone());
        (exec(&v, None), false)
    };
    if res.code != 0 {
        println!("{dir} failed: {}", explain(&res.stderr));
        return res.code;
    }
    if rsync {
        let stats: Vec<&str> = res
            .stdout
            .lines()
            .filter(|l| l.contains("Number of regular files transferred") || l.contains("Total transferred file size"))
            .map(str::trim_start)
            .collect();
        println!("{dir} ok: {}", stats.join(";"));
    } else {
        println!("{dir} ok: {} -> {dst}", src.join(" "));
    }
    0
}

fn usage(m: &str) -> i32 {
    println!("usage: tmap kit ssh {m}");
    2
}

pub fn main(a: Vec<String>) -> i32 {
    super::util::count_runs();
    let Some(first) = a.first() else {
        println!("{HELP}");
        return 0;
    };
    let n = a.len();
    match first.as_str() {
        "-h" | "--help" => {
            println!("{HELP}");
            0
        }
        "hosts" => hosts(),
        "check" if n < 2 => usage("check HOST[,HOST..]"),
        "check" => multi(&a[1], None, &format!("sh -c {}", q(PROBE))),
        "tail" if n < 3 => usage("tail HOST FILE [-n N] [-e REGEX]"),
        "tail" => {
            let (mut lines, mut re, mut i) = ("80".to_string(), None, 3);
            while i < n {
                match a[i].as_str() {
                    "-n" => lines = a.get(i + 1).cloned().unwrap_or_default(),
                    "-e" => re = a.get(i + 1).cloned(),
                    _ => {
                        i += 1;
                        continue;
                    }
                }
                i += 2;
            }
            multi(&a[1], None, &tail_cmd(&a[2], &lines, re.as_deref()))
        }
        "svc" if n < 3 => usage("svc HOST UNIT [-n N]"),
        "svc" => {
            let lines = if a.get(3).is_some_and(|x| x == "-n") { a.get(4).cloned().unwrap_or_else(|| "30".into()) } else { "30".into() };
            multi(&a[1], None, &svc_cmd(&a[2], &lines))
        }
        "get" | "put" if n < if first == "get" { 2 } else { 3 } => usage("get HOST:PATH [DEST] | tmap kit ssh put SRC.. HOST:PATH"),
        "get" | "put" => copy(first, &a[1..]),
        "run" if n < 3 => usage("run HOST CMD.. [--stdin]"),
        "run" => {
            let stdin = a[n - 1] == "--stdin";
            let end = if stdin { n - 1 } else { n };
            let input = stdin.then(super::util::read_stdin);
            multi(&a[1], input.as_deref(), &a[2..end].join(" "))
        }
        h if n < 2 => {
            println!("tmap kit ssh runs commands, not shells: tmap kit ssh {h} 'CMD' (interactive sessions hang here)");
            2
        }
        h => multi(h, None, &a[1..].join(" ")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_and_commands() {
        assert_eq!(q("/var/log/x.log"), "/var/log/x.log");
        assert_eq!(q("a b'c"), r"'a b'\''c'");
        assert_eq!(tail_cmd("/v/l", "5", Some("err|warn")), "grep -E 'err|warn' /v/l | tail -n 5");
        assert_eq!(tail_cmd("my file", "80", None), "tail -n 80 'my file'");
        assert!(svc_cmd("nginx", "30").starts_with("systemctl show nginx -p ActiveState"));
        assert!(svc_cmd("nginx", "30").contains("journalctl -u nginx -n 30 --no-pager"));
    }

    #[test]
    fn ssh_argv() {
        let v = ssh_args("web1", false, "uptime");
        assert_eq!(&v[..4], ["ssh", "-n", "-o", "BatchMode=yes"]);
        assert_eq!(&v[v.len() - 2..], ["web1", "uptime"]);
        assert!(v.contains(&"LogLevel=ERROR".to_string()));
        assert_eq!(v.iter().any(|x| x == "ControlMaster=auto"), cfg!(unix));
        assert_eq!(ssh_args("h", true, "cat")[1], "-o");
    }

    #[test]
    fn capping_and_errors() {
        let text: String = (1..=10).map(|i| format!("\x1b[31ml{i}\x1b[0m\n")).collect();
        let c = cap(&text, 5);
        assert_eq!(c, ["l1", "l2", "... [5 lines omitted of 10; narrow the command, or TFORGE_SSH_MAX=N] ...", "l8", "l9", "l10"]);
        assert_eq!(cap("a\nb", 5), ["a", "b"]);
        assert!(explain("x\nuser@h: Permission denied (publickey).\n").starts_with("auth failed"));
        assert_eq!(explain("weird\n\nerror\n"), "weird error");
    }

    #[test]
    fn config_parsing() {
        let cfg = "Host web1 web2\n  HostName 10.0.0.1\nhost *.corp !x db\nInclude config.d/*\n";
        assert_eq!(words_of(cfg, "host"), ["web1", "web2", "*.corp", "!x", "db"]);
        assert_eq!(words_of(cfg, "include"), ["config.d/*"]);
        assert!(wild(b"*.conf", b"a.conf") && !wild(b"*.conf", b"a.cfg") && wild(b"h?", b"h1"));
    }
}
