//! Acceptance tests for the `budget` command.

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

static N: AtomicUsize = AtomicUsize::new(0);

struct T {
    dir: PathBuf,
    env: Vec<(String, String)>,
}

struct Out {
    code: i32,
    stdout: String,
    stderr: String,
}

impl T {
    fn bare() -> T {
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("tally-hb-{}-{}", std::process::id(), n));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        T { dir, env: vec![] }
    }

    fn new() -> T {
        let t = T::bare();
        t.ok(&["init"]);
        t
    }

    fn with_env(mut self, k: &str, v: &str) -> T {
        self.env.push((k.into(), v.into()));
        self
    }

    fn run(&self, args: &[&str]) -> Out {
        let mut c = Command::new(env!("CARGO_BIN_EXE_tally"));
        for (k, _) in std::env::vars() {
            if k.starts_with("TALLY_") {
                c.env_remove(k);
            }
        }
        c.env("HOME", &self.dir);
        for (k, v) in &self.env {
            c.env(k, v);
        }
        c.arg("--dir").arg(&self.dir).args(args);
        let o = c.output().unwrap();
        Out {
            code: o.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
        }
    }

    fn ok(&self, args: &[&str]) -> String {
        let o = self.run(args);
        assert_eq!(
            o.code, 0,
            "{args:?}\nstdout: {}\nstderr: {}",
            o.stdout, o.stderr
        );
        o.stdout
    }

    fn fail(&self, args: &[&str]) -> (i32, String) {
        let o = self.run(args);
        assert_ne!(o.code, 0, "{args:?} should fail; stdout: {}", o.stdout);
        (o.code, o.stderr)
    }

    fn write(&self, name: &str, text: &str) {
        fs::write(self.dir.join(name), text).unwrap();
    }
}

impl Drop for T {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn sample() -> T {
    let t = T::new();
    t.ok(&["add", "2026-03-03", "240", "groceries"]);
    t.ok(&["add", "2026-03-10", "45", "eating-out"]);
    t.ok(&["add", "2026-03-12", "80", "eating-out"]);
    t.ok(&["add", "2026-02-27", "999", "groceries"]);
    t.ok(&["add", "2026-04-01", "500", "groceries"]);
    t.ok(&["add", "2026-03-01", "3000", "salary", "--income"]);
    t.ok(&[
        "add",
        "2026-03-15",
        "60",
        "groceries",
        "--income",
        "--note",
        "refund",
    ]);
    t
}

fn three_budgets(t: &T) {
    t.ok(&["budget", "set", "groceries", "300"]);
    t.ok(&["budget", "set", "eating-out", "100"]);
    t.ok(&["budget", "set", "rent", "1200"]);
}

fn today() -> (i64, i64, i64) {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let z = secs / 86_400 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

// ---------- set ----------

#[test]
fn budget_set_prints_normalised_confirmation() {
    let t = sample();
    assert_eq!(
        t.ok(&["budget", "set", "  Groceries ", "300"]),
        "set budget for 'groceries' to 300.00\n"
    );
    assert_eq!(
        t.ok(&["budget", "set", "eating-out", "1,250.5"]),
        "set budget for 'eating-out' to 1250.50\n"
    );
}

#[test]
fn budget_set_replaces_existing_limit() {
    let t = sample();
    t.ok(&["budget", "set", "groceries", "300"]);
    t.ok(&["budget", "set", "GROCERIES", "275.25"]);
    assert_eq!(
        t.ok(&["budget", "list", "--format", "csv"]),
        "category,limit\ngroceries,275.25\n"
    );
}

#[test]
fn budget_set_allows_category_without_entries() {
    let t = T::new();
    t.ok(&["budget", "set", "holiday", "50"]);
    assert_eq!(
        t.ok(&["budget", "list", "--format", "csv"]),
        "category,limit\nholiday,50.00\n"
    );
}

#[test]
fn budget_set_persists_in_plain_text_file() {
    let t = sample();
    t.ok(&["budget", "set", "groceries", "300"]);
    let text = fs::read_to_string(t.dir.join("budgets.txt")).expect("budgets.txt");
    assert!(text.contains("groceries"), "{text}");
    let ledger = fs::read_to_string(t.dir.join("ledger.txt")).unwrap();
    assert!(
        !ledger.contains("300.00"),
        "budgets must not go into the ledger: {ledger}"
    );
    let leftovers: Vec<_> = fs::read_dir(&t.dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[test]
fn budget_set_rejects_invalid_amounts() {
    let t = sample();
    for amount in ["0", "-5", "1000000.01"] {
        let (code, err) = t.fail(&["budget", "set", "groceries", amount]);
        assert_eq!(code, 1, "{amount}");
        let want = if amount == "1000000.01" {
            "amount exceeds the maximum of 1000000.00"
        } else {
            "amount must be greater than zero"
        };
        assert!(err.contains(want), "{amount}: {err}");
    }
    let (code, err) = t.fail(&["budget", "set", "groceries", "1.234"]);
    assert_eq!(code, 2);
    assert!(err.contains("invalid amount '1.234'"), "{err}");
    assert_eq!(t.ok(&["budget", "list"]), "(no rows)\n");
}

#[test]
fn budget_set_rejects_invalid_categories() {
    let t = sample();
    let (code, err) = t.fail(&["budget", "set", "eating out", "10"]);
    assert_eq!(code, 1);
    assert!(
        err.contains("category 'eating out' may only contain letters, digits, '-' and '_'"),
        "{err}"
    );
    let long = "x".repeat(33);
    let (code, err) = t.fail(&["budget", "set", &long, "10"]);
    assert_eq!(code, 1);
    assert!(
        err.contains("category is longer than 32 characters"),
        "{err}"
    );
}

// ---------- list ----------

#[test]
fn budget_list_formats() {
    let t = sample();
    three_budgets(&t);
    assert_eq!(
        t.ok(&["budget", "list"]),
        "CATEGORY       LIMIT\neating-out   $100.00\ngroceries    $300.00\nrent        $1200.00\n"
    );
    assert_eq!(
        t.ok(&["budget", "list", "--format", "json"]),
        "[\n  {\"category\": \"eating-out\", \"limit\": 100.00},\n  {\"category\": \"groceries\", \"limit\": 300.00},\n  {\"category\": \"rent\", \"limit\": 1200.00}\n]\n"
    );
}

#[test]
fn budget_list_empty_and_config_format() {
    let t = sample();
    assert_eq!(t.ok(&["budget", "list"]), "(no rows)\n");
    assert_eq!(t.ok(&["budget", "list", "--format", "json"]), "[]\n");
    t.write(
        "config.ini",
        "[output]\nformat = csv\n[general]\ncurrency_symbol = EUR\n",
    );
    t.ok(&["budget", "set", "rent", "1200"]);
    assert_eq!(t.ok(&["budget", "list"]), "category,limit\nrent,1200.00\n");
    assert!(t
        .ok(&["budget", "list", "--format", "table"])
        .contains("EUR1200.00"));
}

// ---------- remove ----------

#[test]
fn budget_remove_deletes_budget() {
    let t = sample();
    three_budgets(&t);
    assert_eq!(
        t.ok(&["budget", "remove", "Eating-Out"]),
        "removed budget for 'eating-out'\n"
    );
    assert_eq!(
        t.ok(&["budget", "list", "--format", "csv"]),
        "category,limit\ngroceries,300.00\nrent,1200.00\n"
    );
}

#[test]
fn budget_remove_missing_is_not_found() {
    let t = sample();
    t.ok(&["budget", "set", "rent", "1200"]);
    let (code, err) = t.fail(&["budget", "remove", "groceries"]);
    assert_eq!(code, 3);
    assert!(err.contains("no budget for category 'groceries'"), "{err}");
    assert!(t.ok(&["budget", "list"]).contains("rent"));
}

// ---------- status ----------

#[test]
fn budget_status_table_layout() {
    let t = sample();
    three_budgets(&t);
    let expected = "\
CATEGORY       LIMIT    SPENT  REMAINING    USED  STATUS
eating-out   $100.00  $125.00    -$25.00  125.0%  over
groceries    $300.00  $240.00     $60.00   80.0%  warning
rent        $1200.00    $0.00   $1200.00    0.0%  ok
---------------------------------------------------------
total       $1600.00  $365.00   $1235.00   22.8%
";
    assert_eq!(t.ok(&["budget", "status", "--month", "2026-03"]), expected);
}

#[test]
fn budget_status_csv_and_json() {
    let t = sample();
    three_budgets(&t);
    assert_eq!(
        t.ok(&["budget", "status", "--month", "2026-03", "--format", "csv"]),
        "category,limit,spent,remaining,used,status\n\
         eating-out,100.00,125.00,-25.00,125.0%,over\n\
         groceries,300.00,240.00,60.00,80.0%,warning\n\
         rent,1200.00,0.00,1200.00,0.0%,ok\n"
    );
    let json = t.ok(&["budget", "status", "--month", "2026-03", "--format", "json"]);
    assert_eq!(
        json,
        "[\n  {\"category\": \"eating-out\", \"limit\": 100.00, \"spent\": 125.00, \"remaining\": -25.00, \"used\": 125.0, \"status\": \"over\"},\n  {\"category\": \"groceries\", \"limit\": 300.00, \"spent\": 240.00, \"remaining\": 60.00, \"used\": 80.0, \"status\": \"warning\"},\n  {\"category\": \"rent\", \"limit\": 1200.00, \"spent\": 0.00, \"remaining\": 1200.00, \"used\": 0.0, \"status\": \"ok\"}\n]\n"
    );
}

#[test]
fn budget_status_counts_only_expenses_of_that_month() {
    let t = T::new();
    t.ok(&["add", "2026-01-31", "10", "food"]);
    t.ok(&["add", "2026-02-01", "20", "food"]);
    t.ok(&["add", "2026-02-28", "30", "food"]);
    t.ok(&["add", "2026-03-01", "40", "food"]);
    t.ok(&["add", "2026-02-10", "1000", "food", "--income"]);
    t.ok(&["add", "2026-02-10", "7", "other"]);
    t.ok(&["budget", "set", "food", "200"]);
    assert_eq!(
        t.ok(&["budget", "status", "--month", "2026-02", "--format", "csv"]),
        "category,limit,spent,remaining,used,status\nfood,200.00,50.00,150.00,25.0%,ok\n"
    );
}

#[test]
fn budget_status_thresholds() {
    let t = T::new();
    t.ok(&["add", "2026-05-02", "100", "exact"]);
    t.ok(&["add", "2026-05-02", "80", "atwarn"]);
    t.ok(&["add", "2026-05-02", "79.99", "below"]);
    t.ok(&["add", "2026-05-02", "100.01", "over"]);
    t.ok(&["add", "2026-05-02", "1", "third"]);
    for c in ["exact", "atwarn", "below", "over"] {
        t.ok(&["budget", "set", c, "100"]);
    }
    t.ok(&["budget", "set", "third", "3"]);
    let csv = t.ok(&["budget", "status", "--month", "2026-05", "--format", "csv"]);
    assert_eq!(
        csv,
        "category,limit,spent,remaining,used,status\n\
         atwarn,100.00,80.00,20.00,80.0%,warning\n\
         below,100.00,79.99,20.01,80.0%,ok\n\
         exact,100.00,100.00,0.00,100.0%,warning\n\
         over,100.00,100.01,-0.01,100.0%,over\n\
         third,3.00,1.00,2.00,33.3%,ok\n"
    );
}

#[test]
fn budget_status_uses_currency_symbol() {
    let t = sample();
    t.write("config.ini", "[general]\ncurrency_symbol = \"€\"\n");
    t.ok(&["budget", "set", "groceries", "300"]);
    let out = t.ok(&["budget", "status", "--month", "2026-03"]);
    assert!(out.contains("€300.00"), "{out}");
    assert!(out.contains("€240.00"), "{out}");
}

#[test]
fn budget_status_without_budgets() {
    let t = sample();
    assert_eq!(
        t.ok(&["budget", "status", "--month", "2026-03"]),
        "(no rows)\n"
    );
}

#[test]
fn budget_status_defaults_to_current_month() {
    let t = T::new();
    let (y, m, d) = today();
    let date = format!("{y:04}-{m:02}-{d:02}");
    t.ok(&["add", &date, "12.34", "snacks"]);
    t.ok(&["budget", "set", "snacks", "100"]);
    let out = t.ok(&["budget", "status", "--format", "csv"]);
    assert!(out.contains("snacks,100.00,12.34,87.66,12.3%,ok"), "{out}");
}

#[test]
fn budget_status_rejects_bad_month() {
    let t = sample();
    let (code, _) = t.fail(&["budget", "status", "--month", "2026-13"]);
    assert_eq!(code, 2);
}

// ---------- configuration ----------

#[test]
fn budget_config_warn_percent_from_file() {
    let t = sample();
    three_budgets(&t);
    t.write("config.ini", "[budget]\nwarn_percent = 90\n");
    let csv = t.ok(&["budget", "status", "--month", "2026-03", "--format", "csv"]);
    assert!(
        csv.contains("groceries,300.00,240.00,60.00,80.0%,ok\n"),
        "{csv}"
    );
    t.write("config.ini", "[budget]\nwarn_percent = 0\n");
    let csv = t.ok(&["budget", "status", "--month", "2026-03", "--format", "csv"]);
    assert!(
        csv.contains("rent,1200.00,0.00,1200.00,0.0%,warning\n"),
        "{csv}"
    );
}

#[test]
fn budget_config_env_override_and_listing() {
    let t = sample().with_env("TALLY_BUDGET_WARN_PERCENT", "50");
    t.write("config.ini", "[budget]\nwarn_percent = 95\n");
    t.ok(&["budget", "set", "groceries", "400"]);
    let csv = t.ok(&["budget", "status", "--month", "2026-03", "--format", "csv"]);
    assert!(
        csv.contains("groceries,400.00,240.00,160.00,60.0%,warning\n"),
        "{csv}"
    );
    let cfg = t.ok(&["config", "--format", "csv"]);
    assert!(cfg.contains("budget.warn_percent,50,env\n"), "{cfg}");
}

#[test]
fn budget_config_default_and_validation() {
    let t = sample();
    let cfg = t.ok(&["config", "--format", "csv"]);
    assert!(cfg.contains("budget.warn_percent,80,default\n"), "{cfg}");
    assert!(cfg.contains("cache.enabled,true,default\n"), "{cfg}");
    t.write("config.ini", "[budget]\nwarn_percent = lots\n");
    let (code, err) = t.fail(&["budget", "list"]);
    assert_eq!(code, 1);
    assert!(err.contains("config line 2"), "{err}");
}

// ---------- rename-category ----------

#[test]
fn budget_rename_moves_budget() {
    let t = sample();
    three_budgets(&t);
    assert_eq!(
        t.ok(&["rename-category", "eating-out", "Dining"]),
        "renamed 'eating-out' to 'dining' (2 entries)\n"
    );
    assert_eq!(
        t.ok(&["budget", "list", "--format", "csv"]),
        "category,limit\ndining,100.00\ngroceries,300.00\nrent,1200.00\n"
    );
    let csv = t.ok(&["budget", "status", "--month", "2026-03", "--format", "csv"]);
    assert!(
        csv.contains("dining,100.00,125.00,-25.00,125.0%,over\n"),
        "{csv}"
    );
}

#[test]
fn budget_rename_keeps_existing_target_budget() {
    let t = sample();
    t.ok(&["budget", "set", "eating-out", "100"]);
    t.ok(&["budget", "set", "groceries", "300"]);
    t.ok(&["rename-category", "eating-out", "groceries"]);
    assert_eq!(
        t.ok(&["budget", "list", "--format", "csv"]),
        "category,limit\ngroceries,300.00\n"
    );
}

#[test]
fn budget_rename_without_budget_is_unchanged() {
    let t = sample();
    t.ok(&["budget", "set", "rent", "1200"]);
    t.ok(&["rename-category", "groceries", "food"]);
    assert_eq!(
        t.ok(&["budget", "list", "--format", "csv"]),
        "category,limit\nrent,1200.00\n"
    );
}

// ---------- errors ----------

#[test]
fn budget_errors_require_initialised_ledger() {
    let t = T::bare();
    let (code, err) = t.fail(&["budget", "set", "food", "10"]);
    assert_eq!(code, 1);
    assert!(err.contains("no ledger found in"), "{err}");
    assert!(!t.dir.join("budgets.txt").exists());
}

#[test]
fn budget_errors_usage() {
    let t = sample();
    assert_eq!(t.fail(&["budget"]).0, 2);
    assert_eq!(t.fail(&["budget", "grow", "food"]).0, 2);
    assert_eq!(t.fail(&["budget", "set", "food"]).0, 2);
    assert_eq!(t.fail(&["budget", "list", "extra"]).0, 2);
    let help = t.ok(&["help", "budget"]);
    assert!(help.contains("budget set"), "{help}");
    assert!(help.contains("status"), "{help}");
}

// ---------- existing behaviour ----------

#[test]
fn existing_commands_unaffected() {
    let t = sample();
    three_budgets(&t);
    let out = t.ok(&["categories", "--format", "csv"]);
    assert_eq!(
        out,
        "category,count,expenses,income\neating-out,2,125.00,0.00\ngroceries,4,1739.00,60.00\nsalary,1,0.00,3000.00\n"
    );
    assert!(t.ok(&["--help"]).contains("usage: tally"));
}
