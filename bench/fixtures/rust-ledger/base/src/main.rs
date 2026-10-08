use std::io::Write;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let env = |name: &str| std::env::var(name).ok();
    let stdout = std::io::stdout();
    let stderr = std::io::stderr();
    let mut out = stdout.lock();
    let mut err = stderr.lock();
    let code = tally::run(&args, &env, &mut out, &mut err);
    let _ = out.flush();
    std::process::exit(code);
}
