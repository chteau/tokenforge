//! `tmap kit distill`: a small model reads big output so the main model never has to.

use super::util::{self, die};
use regex::Regex;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::Stdio;

const HELP: &str = "Let a small model read big output so the main model never has to.

  tmap kit distill -q \"which tests fail and why\" -- npm test
  tmap kit distill -q \"list error codes with counts\" -f build.log -f other.log
  some-command | tmap kit distill -q \"what changed in the API?\"

Output that is already small (< --min-bytes, default 6000) is printed raw:
a model call would cost more than it saves. Larger input goes to Haiku
(TFORGE_DISTILL_MODEL) through a minimal headless `claude -p` (custom system
prompt, no tools, no MCP, no hooks), which returns at most -n lines (default 15)
with paths, line numbers, names and errors quoted verbatim.
TFORGE_DISTILL_TIMEOUT (default 120 s), TFORGE_DISTILL_MAX_BYTES (default 480000).

LOSSY. Use for logs, test/build output, search results, docs, data dumps.
Never for source you will edit or reason about line by line, never for
security review: read those slices directly.
Fallback (claude CLI missing or call fails): error-line grep + head/tail.
";

const DEFAULT_Q: &str = "Summarize the essential facts.";

fn env_or(k: &str, d: &str) -> String {
    std::env::var(k).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| d.to_string())
}

pub fn temp_path(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    std::env::temp_dir().join(format!("tforge-{tag}-{}-{nanos}", std::process::id()))
}

/// Run `cmd` in `cwd` with stdout and stderr interleaved (like `cmd >f 2>&1`). Exit 127 if missing.
pub fn run_combined(cmd: &[String], cwd: &Path) -> (i32, String) {
    let path = temp_path("out");
    let res = (|| -> std::io::Result<i32> {
        let f = File::create(&path)?;
        let mut c = util::command(cmd);
        c.current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::from(f.try_clone()?)).stderr(Stdio::from(f));
        for (k, v) in [("NO_COLOR", "1"), ("CARGO_TERM_COLOR", "never"), ("FORCE_COLOR", "0"), ("TERM", "dumb")] {
            c.env(k, v);
        }
        Ok(c.status()?.code().unwrap_or(1))
    })();
    let text = String::from_utf8_lossy(&std::fs::read(&path).unwrap_or_default()).into_owned();
    let _ = std::fs::remove_file(&path);
    util::note_raw(text.len());
    match res {
        Ok(rc) => (rc, text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (127, format!("{}: command not found\n", cmd[0])),
        Err(e) => (126, format!("{}: {e}\n", cmd[0])),
    }
}

/// argv running `script` through the platform shell (bash when available).
pub fn shell(script: &str) -> Vec<String> {
    if cfg!(windows) {
        vec!["cmd".into(), "/C".into(), script.into()]
    } else {
        let sh = if util::tool("bash", None).is_some() { "bash" } else { "sh" };
        vec![sh.into(), "-c".into(), script.into()]
    }
}

pub fn cut(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Last `n` lines, blank ones included (like `tail -n`).
pub fn last_lines(text: &str, n: usize) -> Vec<&str> {
    let v: Vec<&str> = text.lines().collect();
    v[v.len().saturating_sub(n)..].to_vec()
}

/// Head + error-like lines + tail when the input exceeds `max` bytes.
fn bound(text: &str, max: usize) -> String {
    let b = text.as_bytes();
    if b.len() <= max {
        return text.to_string();
    }
    let third = max / 3;
    let errs = Regex::new(r"(?i)error|fail|exception|panic|traceback|assert|fatal|warn").unwrap();
    let mut mid = String::new();
    for (i, l) in text.lines().enumerate().filter(|(_, l)| errs.is_match(l)) {
        mid.push_str(&format!("{}:{l}\n", i + 1));
        if mid.len() >= third {
            break;
        }
    }
    let mid = String::from_utf8_lossy(&mid.as_bytes()[..mid.len().min(third)]).into_owned();
    format!(
        "{}\n... [middle omitted; error-like lines from it follow] ...\n{mid}\n... [tail] ...\n{}",
        String::from_utf8_lossy(&b[..third]),
        String::from_utf8_lossy(&b[b.len() - third..])
    )
}

/// The model's answer, or None when the CLI is missing or the call fails.
fn ask_model(question: &str, input: &str, n: usize) -> Option<String> {
    let claude = util::tool("claude", None)?;
    let sys = format!("You distill tool output for an engineer who will NOT see the original text. Answer the question using only the text. Quote file paths, line numbers, symbol and test names, error messages and numbers exactly. At most {n} short lines. If the text does not contain the answer, say so. No preamble, no advice beyond the question.");
    let model = env_or("TFORGE_DISTILL_MODEL", "haiku");
    let timeout = env_or("TFORGE_DISTILL_TIMEOUT", "120").parse().unwrap_or(120);
    let prompt = format!("Question: {question}\n\n<output>\n{input}\n</output>\n");
    let dir = temp_path("distill-cwd");
    std::fs::create_dir_all(&dir).ok()?;
    let exe = claude.to_string_lossy().into_owned();
    let cmd = [
        exe.as_str(), "-p", "--model", &model, "--setting-sources", "project", "--strict-mcp-config", "--tools", "", "--disable-slash-commands",
        "--no-session-persistence", "--system-prompt", &sys,
    ];
    let env = [("TOKEN_SURGEON", "off"), ("TOKEN_SURGEON_CODEGRAPH", "off"), ("TFORGE_WATCH", "0")];
    let o = util::run(&cmd, &dir, timeout, &env, Some(&prompt));
    let _ = std::fs::remove_dir(&dir);
    let out = o.stdout.trim_end_matches('\n');
    (o.code == 0 && !out.trim().is_empty()).then(|| out.to_string())
}

/// Heuristic excerpt used when no model answer is available.
fn excerpt(text: &str, tag: &str) -> String {
    let mut out = format!("[distill unavailable; heuristic excerpt of {} KB / {} lines; {tag}]\n", text.len() / 1024, text.matches('\n').count());
    let errs = Regex::new(r"(?i)error|fail|exception|panic|traceback|assert|fatal").unwrap();
    for (i, l) in text.lines().enumerate().filter(|(_, l)| errs.is_match(l)).take(20) {
        out.push_str(&cut(&format!("{}:{l}", i + 1), 200));
        out.push('\n');
    }
    out.push_str("... last lines:\n");
    for l in last_lines(text, 10) {
        out.push_str(&cut(l, 200));
        out.push('\n');
    }
    out
}

/// What `distill` prints for `text`: raw when small, else the model's answer or a heuristic excerpt.
/// `rc` is the exit code of the command that produced `text`, if any.
pub fn render(text: &str, rc: Option<i32>, question: &str, n: usize, min: usize) -> String {
    let tag = format!("exit={}", rc.map_or("n/a".to_string(), |c| c.to_string()));
    if text.len() < min {
        return rc.map(|_| format!("[{tag}]\n")).unwrap_or_default() + text;
    }
    let max = env_or("TFORGE_DISTILL_MAX_BYTES", "480000").parse().unwrap_or(480_000);
    match ask_model(question, &bound(text, max), n) {
        Some(ans) => {
            let model = env_or("TFORGE_DISTILL_MODEL", "haiku");
            let mut out = format!("[distilled by {model} from {} KB / {} lines; {tag}]\n", text.len() / 1024, text.matches('\n').count());
            for l in ans.lines().take(n + 5) {
                out.push_str(l);
                out.push('\n');
            }
            out
        }
        None => excerpt(text, &tag),
    }
}

/// Ask a small model `question` about `text`; returns only the answer. Shared with `web --ask`.
pub fn distill_text(question: &str, text: &str) -> Result<String, String> {
    Ok(render(text, None, question, 15, 6000))
}

pub fn main(mut args: Vec<String>) -> i32 {
    const T: &str = "distill";
    let mut cmd = Vec::new();
    if let Some(i) = args.iter().position(|a| a == "--") {
        cmd = args.split_off(i + 1);
        args.pop();
    }
    if util::take_flag(&mut args, &["-h", "--help"]) {
        print!("{HELP}");
        return 0;
    }
    let q = util::take_opt(T, &mut args, &["-q"]).unwrap_or_else(|| DEFAULT_Q.into());
    let num = |v: Option<String>, d: usize| v.map_or(d, |s| s.parse().unwrap_or_else(|_| die(T, &format!("not a number: {s}"), 2)));
    let n = num(util::take_opt(T, &mut args, &["-n"]), 15);
    let min = num(util::take_opt(T, &mut args, &["--min-bytes"]), 6000);
    let mut files = Vec::new();
    while let Some(f) = util::take_opt(T, &mut args, &["-f"]) {
        files.push(f);
    }
    if let Some(a) = args.first() {
        eprintln!("unknown arg: {a} (use -- before a command)");
        return 2;
    }
    let (rc, text) = if !cmd.is_empty() {
        let (rc, t) = run_combined(&cmd, &util::cwd());
        (Some(rc), t)
    } else if !files.is_empty() {
        let mut t = String::new();
        for f in &files {
            t.push_str(&format!("===== {f} =====\n"));
            match std::fs::read(f) {
                Ok(b) => t.push_str(&String::from_utf8_lossy(&b)),
                Err(e) => t.push_str(&format!("{f}: {e}\n")),
            }
        }
        util::note_raw(t.len());
        (None, t)
    } else {
        let t = util::read_stdin();
        util::note_raw(t.len());
        (None, t)
    };
    print!("{}", render(&text, rc, &q, n, min));
    rc.unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_output_is_raw() {
        assert_eq!(render("ok\n", Some(3), "q", 5, 6000), "[exit=3]\nok\n");
        assert_eq!(render("ok\n", None, "q", 5, 6000), "ok\n");
    }

    #[test]
    fn bound_keeps_head_errors_tail() {
        let text = format!("{}\nerror: boom\n{}", "a".repeat(3000), "z".repeat(3000));
        let b = bound(&text, 900);
        assert!(b.starts_with(&"a".repeat(300)));
        assert!(b.contains("2:error: boom"));
        assert!(b.ends_with(&"z".repeat(300)));
        assert_eq!(bound("short", 900), "short");
    }

    #[test]
    fn excerpt_greps_errors_then_tail() {
        let text = format!("{}line two FAILED\n{}", "x\n".repeat(10), "y\n".repeat(20));
        let out = excerpt(&text, "exit=1");
        assert!(out.starts_with("[distill unavailable; heuristic excerpt of 0 KB / 31 lines; exit=1]\n11:line two FAILED\n... last lines:\n"));
        assert_eq!(out.lines().count(), 13);
    }

    #[test]
    fn tail_keeps_blank_lines() {
        assert_eq!(last_lines("a\n\nb\nc\n", 3), vec!["", "b", "c"]);
        assert_eq!(cut("héllo", 2), "hé");
    }

    #[test]
    #[cfg(unix)]
    fn combined_output_and_missing_program() {
        let (rc, t) = run_combined(&["sh".into(), "-c".into(), "echo out; echo err >&2; exit 4".into()], Path::new("."));
        assert_eq!((rc, t.as_str()), (4, "out\nerr\n"));
        assert_eq!(run_combined(&["no-such-prog-xyz".into()], Path::new(".")).0, 127);
    }
}
