//! Helpers for running the `tally` binary against a throw-away data directory.
#![allow(dead_code)]

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

static COUNTER: AtomicUsize = AtomicUsize::new(0);

pub struct Run {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub struct Tally {
    pub dir: PathBuf,
    env: Vec<(String, String)>,
}

impl Tally {
    /// A fresh, initialised ledger.
    pub fn new() -> Tally {
        let t = Tally::bare();
        t.ok(&["init"]);
        t
    }

    /// A fresh directory without a ledger.
    pub fn bare() -> Tally {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos();
        let dir =
            std::env::temp_dir().join(format!("tally-it-{}-{}-{}", std::process::id(), n, nanos));
        fs::create_dir_all(&dir).unwrap();
        Tally {
            dir,
            env: Vec::new(),
        }
    }

    pub fn env(mut self, key: &str, value: &str) -> Tally {
        self.env.push((key.to_string(), value.to_string()));
        self
    }

    pub fn run(&self, args: &[&str]) -> Run {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_tally"));
        for (k, _) in std::env::vars() {
            if k.starts_with("TALLY_") {
                cmd.env_remove(k);
            }
        }
        cmd.env("HOME", &self.dir);
        for (k, v) in &self.env {
            cmd.env(k, v);
        }
        cmd.arg("--dir").arg(&self.dir).args(args);
        let out = cmd.output().expect("failed to run tally");
        Run {
            code: out.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        }
    }

    /// Run and assert success; returns stdout.
    pub fn ok(&self, args: &[&str]) -> String {
        let r = self.run(args);
        assert_eq!(
            r.code, 0,
            "tally {args:?} failed\nstdout:\n{}\nstderr:\n{}",
            r.stdout, r.stderr
        );
        r.stdout
    }

    /// Run and assert failure; returns (exit code, stderr).
    pub fn fail(&self, args: &[&str]) -> (i32, String) {
        let r = self.run(args);
        assert_ne!(
            r.code, 0,
            "tally {args:?} unexpectedly succeeded:\n{}",
            r.stdout
        );
        (r.code, r.stderr)
    }

    pub fn write(&self, name: &str, contents: &str) -> PathBuf {
        let p = self.dir.join(name);
        fs::write(&p, contents).unwrap();
        p
    }

    pub fn read(&self, name: &str) -> String {
        fs::read_to_string(self.dir.join(name)).unwrap()
    }
}

impl Drop for Tally {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}
