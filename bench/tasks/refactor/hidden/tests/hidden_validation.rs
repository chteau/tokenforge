//! Behaviour of entry validation across every command that writes entries.
//! The rules and messages of `add` are canonical.

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

static N: AtomicUsize = AtomicUsize::new(0);

struct T {
    dir: PathBuf,
}

struct Out {
    code: i32,
    stdout: String,
    stderr: String,
}

impl T {
    fn new() -> T {
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("tally-hv-{}-{}", std::process::id(), n));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let t = T { dir };
        t.ok(&["init"]);
        t
    }

    fn run(&self, args: &[&str]) -> Out {
        let mut c = Command::new(env!("CARGO_BIN_EXE_tally"));
        for (k, _) in std::env::vars() {
            if k.starts_with("TALLY_") {
                c.env_remove(k);
            }
        }
        c.env("HOME", &self.dir)
            .arg("--dir")
            .arg(&self.dir)
            .args(args);
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

    /// Assert the command fails with exit code 1 and exactly `error: <msg>`.
    fn rejects(&self, args: &[&str], msg: &str) {
        let before = self.ledger();
        let o = self.run(args);
        assert_eq!(
            o.code, 1,
            "{args:?} should be rejected; stdout: {}",
            o.stdout
        );
        assert_eq!(o.stderr, format!("error: {msg}\n"), "{args:?}");
        assert_eq!(self.ledger(), before, "{args:?} must not change the ledger");
    }

    fn ledger(&self) -> String {
        fs::read_to_string(self.dir.join("ledger.txt")).unwrap()
    }

    fn line(&self, id: u64) -> String {
        let prefix = format!("{id}|");
        self.ledger()
            .lines()
            .find(|l| l.starts_with(&prefix))
            .unwrap_or_else(|| panic!("no entry {id} in\n{}", self.ledger()))
            .to_string()
    }

    fn write(&self, name: &str, text: &str) -> String {
        let p = self.dir.join(name);
        fs::write(&p, text).unwrap();
        p.to_string_lossy().into_owned()
    }
}

impl Drop for T {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn one_entry() -> T {
    let t = T::new();
    t.ok(&[
        "add",
        "2026-01-03",
        "12.50",
        "groceries",
        "--payee",
        "Shop",
        "--tag",
        "food",
    ]);
    t
}

const CAT_CHARS: &str = "may only contain letters, digits, '-' and '_'";

// ---------- add (canonical) ----------

#[test]
fn add_rules_normalise_fields() {
    let t = T::new();
    t.ok(&[
        "add",
        "2026-01-03",
        "12.5",
        "  Eating-Out_2 ",
        "--payee",
        "  Corner Shop  ",
        "--note",
        "  hi  ",
        "--tag",
        "#Food",
        "--tag",
        " food ",
        "--tag",
        "Home",
    ]);
    assert_eq!(
        t.line(1),
        "1|2026-01-03|expense|12.50|eating-out_2|Corner Shop|hi|food,home"
    );
}

#[test]
fn add_rules_reject_with_messages() {
    let t = T::new();
    t.rejects(
        &["add", "2026-01-03", "0", "food"],
        "amount must be greater than zero",
    );
    t.rejects(
        &["add", "2026-01-03", "1000000.01", "food"],
        "amount exceeds the maximum of 1000000.00",
    );
    t.rejects(
        &["add", "2026-01-03", "1", "  "],
        "category must not be empty",
    );
    t.rejects(
        &["add", "2026-01-03", "1", &"c".repeat(33)],
        "category is longer than 32 characters",
    );
    t.rejects(
        &["add", "2026-01-03", "1", "Eating Out"],
        &format!("category 'eating out' {CAT_CHARS}"),
    );
    t.rejects(
        &["add", "2101-01-01", "1", "food"],
        "date 2101-01-01 is outside the supported range (1970-2100)",
    );
    t.rejects(
        &["add", "2026-01-03", "1", "food", "--payee", &"p".repeat(65)],
        "payee is longer than 64 characters",
    );
    t.rejects(
        &["add", "2026-01-03", "1", "food", "--payee", "a\tb"],
        "payee must not contain control characters",
    );
    t.rejects(
        &["add", "2026-01-03", "1", "food", "--note", &"n".repeat(201)],
        "note is longer than 200 characters",
    );
    t.rejects(
        &["add", "2026-01-03", "1", "food", "--tag", "#"],
        "tag must not be empty",
    );
    t.rejects(
        &["add", "2026-01-03", "1", "food", "--tag", &"t".repeat(17)],
        &format!("tag '{}' is longer than 16 characters", "t".repeat(17)),
    );
    t.rejects(
        &["add", "2026-01-03", "1", "food", "--tag", "a_b"],
        "tag 'a_b' may only contain letters, digits and '-'",
    );
}

#[test]
fn add_rules_accept_limits() {
    let t = T::new();
    t.ok(&[
        "add",
        "1970-01-01",
        "0.01",
        &"c".repeat(32),
        "--payee",
        &"p".repeat(64),
    ]);
    t.ok(&[
        "add",
        "2100-12-31",
        "1000000",
        "food",
        "--note",
        &"n".repeat(200),
        "--tag",
        &"t".repeat(16),
    ]);
    assert!(t.line(2).contains("|1000000.00|food|"));
}

// ---------- edit ----------

#[test]
fn edit_rules_normalise_category() {
    let t = one_entry();
    t.ok(&["edit", "1", "--category", "  Dining "]);
    assert_eq!(t.line(1), "1|2026-01-03|expense|12.50|dining|Shop||food");
    let out = t.ok(&["rename-category", "dining", "restaurants"]);
    assert_eq!(out, "renamed 'dining' to 'restaurants' (1 entry)\n");
}

#[test]
fn edit_rules_category_errors_match_add() {
    let t = one_entry();
    t.rejects(
        &["edit", "1", "--category", "Eating Out"],
        &format!("category 'eating out' {CAT_CHARS}"),
    );
    t.rejects(
        &["edit", "1", "--category", " "],
        "category must not be empty",
    );
    t.rejects(
        &["edit", "1", "--category", &"c".repeat(33)],
        "category is longer than 32 characters",
    );
}

#[test]
fn edit_rules_reject_zero_amount() {
    let t = one_entry();
    t.rejects(
        &["edit", "1", "--amount", "0"],
        "amount must be greater than zero",
    );
    t.rejects(
        &["edit", "1", "--amount", "0.00"],
        "amount must be greater than zero",
    );
    t.rejects(
        &["edit", "1", "--amount", "1000000.01"],
        "amount exceeds the maximum of 1000000.00",
    );
    t.ok(&["edit", "1", "--amount", "0.01"]);
    assert!(t.line(1).contains("|0.01|"));
}

#[test]
fn edit_rules_check_date_range() {
    let t = one_entry();
    t.rejects(
        &["edit", "1", "--date", "1969-12-31"],
        "date 1969-12-31 is outside the supported range (1970-2100)",
    );
    t.rejects(
        &["edit", "1", "--date", "2101-01-01"],
        "date 2101-01-01 is outside the supported range (1970-2100)",
    );
    t.ok(&["edit", "1", "--date", "2100-12-31"]);
    assert!(t.line(1).starts_with("1|2100-12-31|"));
}

#[test]
fn edit_rules_trim_payee() {
    let t = one_entry();
    t.ok(&["edit", "1", "--payee", "  Market Hall  "]);
    assert_eq!(
        t.line(1),
        "1|2026-01-03|expense|12.50|groceries|Market Hall||food"
    );
    t.rejects(
        &["edit", "1", "--payee", "a\tb"],
        "payee must not contain control characters",
    );
    t.rejects(
        &["edit", "1", "--payee", &"p".repeat(65)],
        "payee is longer than 64 characters",
    );
    t.ok(&["edit", "1", "--payee", &format!(" {} ", "p".repeat(64))]);
}

#[test]
fn edit_rules_note_limit() {
    let t = one_entry();
    t.rejects(
        &["edit", "1", "--note", &"n".repeat(201)],
        "note is longer than 200 characters",
    );
    t.rejects(
        &["edit", "1", "--note", &"n".repeat(250)],
        "note is longer than 200 characters",
    );
    t.ok(&["edit", "1", "--note", &format!("  {}  ", "n".repeat(200))]);
    assert!(t.line(1).contains(&format!("|{}|", "n".repeat(200))));
}

#[test]
fn edit_rules_tags_like_add() {
    let t = one_entry();
    t.ok(&[
        "edit",
        "1",
        "--tag",
        "#Work",
        "--tag",
        "work",
        "--tag",
        "#trip-2026",
    ]);
    assert_eq!(
        t.line(1),
        "1|2026-01-03|expense|12.50|groceries|Shop||work,trip-2026"
    );
    t.rejects(&["edit", "1", "--tag", "#"], "tag must not be empty");
    t.rejects(
        &["edit", "1", "--tag", "a b"],
        "tag 'a b' may only contain letters, digits and '-'",
    );
}

#[test]
fn edit_rules_untouched_fields_kept() {
    let t = one_entry();
    t.ok(&["edit", "1", "--note", "x"]);
    assert_eq!(
        t.line(1),
        "1|2026-01-03|expense|12.50|groceries|Shop|x|food"
    );
    t.ok(&["edit", "1", "--income"]);
    assert_eq!(t.line(1), "1|2026-01-03|income|12.50|groceries|Shop|x|food");
}

// ---------- rename-category ----------

#[test]
fn rename_rules_length_limit_is_32() {
    let t = one_entry();
    let c31 = "c".repeat(31);
    let c32 = "d".repeat(32);
    t.ok(&["rename-category", "groceries", &c31]);
    t.ok(&["rename-category", &c31, &c32]);
    assert!(t.line(1).contains(&format!("|{c32}|")));
    t.rejects(
        &["rename-category", &c32, &"e".repeat(33)],
        "category is longer than 32 characters",
    );
}

#[test]
fn rename_rules_messages_match_add() {
    let t = one_entry();
    t.rejects(
        &["rename-category", "groceries", "Fresh Food"],
        &format!("category 'fresh food' {CAT_CHARS}"),
    );
    t.rejects(
        &["rename-category", "groceries", "  "],
        "category must not be empty",
    );
    t.ok(&["rename-category", "groceries", " Fresh-Food "]);
    assert!(t.line(1).contains("|fresh-food|"));
}

#[test]
fn rename_rules_other_errors_unchanged() {
    let t = one_entry();
    t.rejects(
        &["rename-category", "groceries", "Groceries"],
        "old and new category are the same",
    );
    let o = t.run(&["rename-category", "nope", "other"]);
    assert_eq!(o.code, 3);
    assert_eq!(o.stderr, "error: no entries in category 'nope'\n");
}

// ---------- import ----------

const HEADER: &str = "Date,Description,Amount,Balance\n";

#[test]
fn import_rules_lowercase_category() {
    let t = T::new();
    let f = t.write(
        "bank.csv",
        &format!("{HEADER}03/01/2026,Cafe,-3.50,10.00\n"),
    );
    t.ok(&["import", &f, "--category", " Bank "]);
    assert_eq!(t.line(1), "1|2026-01-03|expense|3.50|bank|Cafe||");
    t.write("config.ini", "[import]\ndefault_category = Inbox\n");
    let g = t.write(
        "bank2.csv",
        &format!("{HEADER}04/01/2026,Shop,-1.00,9.00\n"),
    );
    t.ok(&["import", &g]);
    assert_eq!(t.line(2), "2|2026-01-04|expense|1.00|inbox|Shop||");
}

#[test]
fn import_rules_category_errors_match_add() {
    let t = T::new();
    let f = t.write(
        "bank.csv",
        &format!("{HEADER}03/01/2026,Cafe,-3.50,10.00\n"),
    );
    t.rejects(
        &["import", &f, "--category", "My Bank"],
        &format!("line 2: category 'my bank' {CAT_CHARS}"),
    );
}

#[test]
fn import_rules_amount_limit() {
    let t = T::new();
    let f = t.write(
        "bank.csv",
        &format!("{HEADER}03/01/2026,Ok,-3.50,10.00\n04/01/2026,House,-1000000.01,0.00\n"),
    );
    t.rejects(
        &["import", &f],
        "line 3: amount exceeds the maximum of 1000000.00",
    );
    let g = t.write(
        "zero.csv",
        &format!("{HEADER}03/01/2026,Nothing,0.00,10.00\n"),
    );
    t.rejects(&["import", &g], "line 2: amount must be greater than zero");
}

#[test]
fn import_rules_date_range() {
    let t = T::new();
    let f = t.write("bank.csv", &format!("{HEADER}31/12/1969,Old,-3.50,10.00\n"));
    t.rejects(
        &["import", &f],
        "line 2: date 1969-12-31 is outside the supported range (1970-2100)",
    );
}

#[test]
fn import_rules_payee_handling_kept() {
    let t = T::new();
    let long = "X".repeat(80);
    let f = t.write(
        "bank.csv",
        &format!(
            "{HEADER}03/01/2026,  {long}  ,-3.50,10.00\n04/01/2026,\"Tab\there\",-1.00,9.00\n"
        ),
    );
    t.rejects(
        &["import", &f],
        "line 3: payee must not contain control characters",
    );
    let g = t.write(
        "ok.csv",
        &format!("{HEADER}03/01/2026,  {long}  ,-3.50,10.00\n"),
    );
    t.ok(&["import", &g]);
    assert!(
        t.line(1).contains(&format!("|{}...|", "X".repeat(61))),
        "{}",
        t.line(1)
    );
}

#[test]
fn import_rules_duplicates_still_skipped() {
    let t = T::new();
    let f = t.write(
        "bank.csv",
        &format!("{HEADER}03/01/2026,Cafe,-3.50,10.00\n05/01/2026,Pay,100,110\n"),
    );
    assert_eq!(
        t.ok(&["import", &f, "--category", "Bank"]),
        "imported 2 entries, skipped 0 duplicates\n"
    );
    assert_eq!(
        t.ok(&["import", &f, "--category", "Bank"]),
        "imported 0 entries, skipped 2 duplicates\n"
    );
    assert_eq!(t.line(2), "2|2026-01-05|income|100.00|bank|Pay||");
}
