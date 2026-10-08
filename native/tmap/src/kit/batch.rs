//! `tmap kit batch`: several independent commands in one call, each output compacted and labelled.

use super::run::{cap, clean, collapse};
use super::util::{cwd, die, run};

const HELP: &str = "Run independent commands in ONE call (one round trip instead of many).
  tmap kit batch [-n LINES] 'cmd one' 'cmd two' ..     each argument is a shell command line
  tmap kit batch [-n LINES] <<'EOF'                    or one command per line on stdin
  cmd one
  cmd two
  EOF
Output: \"$ cmd\" then its compacted output (colours/progress stripped, repeats collapsed, capped at
LINES each, default 40), \"[exit N]\" when non-zero. All commands run, in order; exit code = worst one.";

fn shell(line: &str) -> Vec<String> {
    if cfg!(windows) {
        vec!["cmd".into(), "/C".into(), line.into()]
    } else {
        vec!["sh".into(), "-c".into(), line.into()]
    }
}

pub fn main(mut a: Vec<String>) -> i32 {
    if a.first().is_some_and(|x| x == "--help" || x == "-h") {
        println!("{HELP}");
        return 0;
    }
    let mut max = 40;
    if a.len() > 1 && a[0] == "-n" {
        max = a[1].parse().unwrap_or_else(|_| die("batch", "-n needs a number", 2));
        a.drain(..2);
    }
    let cmds: Vec<String> = if a.is_empty() {
        super::util::read_stdin().lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')).map(String::from).collect()
    } else {
        a
    };
    if cmds.is_empty() {
        die("batch", "no commands (arguments or stdin lines)", 2);
    }
    super::util::count_runs();
    let mut worst = 0;
    for c in &cmds {
        let argv = shell(c);
        let argv: Vec<&str> = argv.iter().map(String::as_str).collect();
        let o = run(&argv, &cwd(), 900, &[], None);
        let all = o.stdout + &o.stderr;
        println!("$ {c}");
        for l in cap(collapse(clean(&all), false), max, o.code != 0, "(rerun this command alone for all of it)") {
            println!("{l}");
        }
        if o.code != 0 {
            println!("[exit {}]", o.code);
        }
        worst = worst.max(o.code);
    }
    worst
}
