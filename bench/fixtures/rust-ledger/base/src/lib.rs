//! tally: a plain-text expense ledger.
//!
//! The binary in `main.rs` only forwards to [`run`], which keeps the whole
//! program testable without spawning processes.

pub mod cache;
pub mod cli;
pub mod commands;
pub mod config;
pub mod error;
pub mod import;
pub mod index;
pub mod model;
pub mod output;
pub mod query;
pub mod report;
pub mod store;
pub mod util;

use std::io::Write;
use std::path::PathBuf;

use crate::cli::{Command, Invocation};
use crate::commands::Context;
use crate::config::Config;
use crate::error::{Error, Result};

/// Look up an environment variable.
pub type EnvLookup<'a> = &'a dyn Fn(&str) -> Option<String>;

/// Run the program with the given arguments (without the program name) and
/// return the process exit code.
pub fn run(args: &[String], env: EnvLookup, out: &mut dyn Write, err: &mut dyn Write) -> i32 {
    match try_run(args, env, out) {
        Ok(()) => 0,
        Err(e) => {
            let _ = writeln!(err, "error: {e}");
            e.exit_code()
        }
    }
}

/// `--dir`, then `$TALLY_DIR`, then `$HOME/.tally`, then `./.tally`.
pub fn resolve_dir(flag: Option<PathBuf>, env: EnvLookup) -> PathBuf {
    if let Some(d) = flag {
        return d;
    }
    if let Some(d) = env("TALLY_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(d);
    }
    match env("HOME").filter(|h| !h.is_empty()) {
        Some(home) => PathBuf::from(home).join(".tally"),
        None => PathBuf::from(".tally"),
    }
}

fn try_run(args: &[String], env: EnvLookup, out: &mut dyn Write) -> Result<()> {
    let Invocation {
        dir,
        format,
        command,
    } = cli::parse(args)?;
    match &command {
        Command::Help { topic: None } => {
            out.write_all(cli::USAGE.as_bytes())?;
            return Ok(());
        }
        Command::Help { topic: Some(t) } => {
            let text = cli::command_help(t)
                .ok_or_else(|| Error::usage(format!("no help for unknown command '{t}'")))?;
            out.write_all(text.as_bytes())?;
            return Ok(());
        }
        Command::Version => {
            writeln!(out, "tally {}", env!("CARGO_PKG_VERSION"))?;
            return Ok(());
        }
        _ => {}
    }
    let dir = resolve_dir(dir, env);
    let config = Config::load(&dir, env)?;
    let format = format.unwrap_or_else(|| config.format());
    let mut ctx = Context {
        dir,
        config,
        format,
        out,
    };
    commands::dispatch(command, &mut ctx)
}
