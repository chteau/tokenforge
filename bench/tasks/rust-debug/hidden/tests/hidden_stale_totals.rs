//! Regression tests: summaries must reflect every change to the ledger.

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

static N: AtomicUsize = AtomicUsize::new(0);

struct T {
    dir: PathBuf,
}

impl T {
    fn new() -> T {
        let n = N.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("tally-hs-{}-{}", std::process::id(), n));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let t = T { dir };
        t.ok(&["init"]);
        t
    }

    fn ok(&self, args: &[&str]) -> String {
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
        let stdout = String::from_utf8_lossy(&o.stdout).into_owned();
        assert!(
            o.status.success(),
            "{args:?}\nstdout: {stdout}\nstderr: {}",
            String::from_utf8_lossy(&o.stderr)
        );
        stdout
    }

    fn categories(&self) -> String {
        self.ok(&["categories", "--format", "csv"])
    }

    fn monthly(&self) -> String {
        self.ok(&["report", "monthly", "--format", "csv"])
    }

    fn ledger(&self) -> String {
        fs::read_to_string(self.dir.join("ledger.txt")).unwrap()
    }

    fn set_ledger(&self, text: &str) {
        fs::write(self.dir.join("ledger.txt"), text).unwrap();
    }

    fn cache_path(&self) -> PathBuf {
        self.dir.join("summary.cache")
    }
}

impl Drop for T {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn two_entries() -> T {
    let t = T::new();
    t.ok(&["add", "2026-01-03", "12.50", "groceries"]);
    t.ok(&["add", "2026-01-20", "20.00", "rent"]);
    t
}

#[test]
fn stale_edit_amount_updates_categories() {
    let t = two_entries();
    assert!(t.categories().contains("groceries,1,12.50,0.00\n"));
    t.ok(&["edit", "1", "--amount", "13.50"]);
    let out = t.categories();
    assert!(out.contains("groceries,1,13.50,0.00\n"), "{out}");
}

#[test]
fn stale_edit_amount_updates_monthly_report() {
    let t = two_entries();
    assert!(t.monthly().contains("2026-01,2,32.50,0.00,-32.50\n"));
    t.ok(&["edit", "2", "--amount", "40.00"]);
    let out = t.monthly();
    assert!(out.contains("2026-01,2,52.50,0.00,-52.50\n"), "{out}");
}

#[test]
fn stale_edit_date_moves_entry_between_months() {
    let t = two_entries();
    t.monthly();
    t.ok(&["edit", "1", "--date", "2026-02-03"]);
    let out = t.monthly();
    assert!(out.contains("2026-01,1,20.00,0.00,-20.00\n"), "{out}");
    assert!(out.contains("2026-02,1,12.50,0.00,-12.50\n"), "{out}");
}

#[test]
fn stale_edit_category_same_length() {
    let t = T::new();
    t.ok(&["add", "2026-01-03", "5.00", "food"]);
    t.categories();
    t.ok(&["edit", "1", "--category", "fuel"]);
    let out = t.categories();
    assert_eq!(out, "category,count,expenses,income\nfuel,1,5.00,0.00\n");
}

#[test]
fn stale_edit_kind_and_amount_together() {
    let t = two_entries();
    t.categories();
    t.monthly();
    t.ok(&["edit", "1", "--income", "--amount", "112.50"]);
    let out = t.categories();
    assert!(out.contains("groceries,1,0.00,112.50\n"), "{out}");
    let out = t.monthly();
    assert!(out.contains("2026-01,2,20.00,112.50,92.50\n"), "{out}");
}

#[test]
fn stale_repeated_edits_each_visible() {
    let t = two_entries();
    for amount in ["13.50", "14.50", "12.50", "19.99"] {
        t.ok(&["edit", "1", "--amount", amount]);
        let out = t.categories();
        assert!(
            out.contains(&format!("groceries,1,{amount},0.00\n")),
            "{amount}: {out}"
        );
    }
}

#[test]
fn stale_rename_category_same_length() {
    let t = T::new();
    t.ok(&["add", "2026-01-03", "5.00", "food"]);
    t.ok(&["add", "2026-01-04", "7.00", "food"]);
    t.ok(&["add", "2026-01-05", "1.00", "misc"]);
    t.categories();
    t.ok(&["rename-category", "food", "meal"]);
    let out = t.categories();
    assert_eq!(
        out,
        "category,count,expenses,income\nmeal,2,12.00,0.00\nmisc,1,1.00,0.00\n"
    );
}

#[test]
fn stale_hand_edited_amount() {
    let t = two_entries();
    t.categories();
    t.monthly();
    let edited = t.ledger().replace("|12.50|", "|99.50|");
    t.set_ledger(&edited);
    let out = t.categories();
    assert!(out.contains("groceries,1,99.50,0.00\n"), "{out}");
    let out = t.monthly();
    assert!(out.contains("2026-01,2,119.50,0.00,-119.50\n"), "{out}");
}

#[test]
fn stale_hand_edited_categories_swapped() {
    let t = T::new();
    t.ok(&["add", "2026-01-03", "5.00", "aaaa"]);
    t.ok(&["add", "2026-01-04", "7.00", "bbbb"]);
    t.categories();
    let edited = t
        .ledger()
        .replace("|aaaa|", "|tmp0|")
        .replace("|bbbb|", "|aaaa|")
        .replace("|tmp0|", "|bbbb|");
    t.set_ledger(&edited);
    let out = t.categories();
    assert_eq!(
        out,
        "category,count,expenses,income\naaaa,1,7.00,0.00\nbbbb,1,5.00,0.00\n"
    );
}

#[test]
fn cache_kept_and_used_when_ledger_unchanged() {
    let t = two_entries();
    t.categories();
    let cache = fs::read_to_string(t.cache_path()).expect("summary cache should still be written");
    assert!(cache.contains("groceries"), "{cache}");
    fs::write(t.cache_path(), cache.replace("12.50", "77.77")).unwrap();
    let out = t.categories();
    assert!(
        out.contains("groceries,1,77.77,0.00\n"),
        "an up-to-date cache should be served without recomputing: {out}"
    );
}

#[test]
fn cache_kept_refreshed_after_change() {
    let t = two_entries();
    t.categories();
    t.ok(&["edit", "1", "--amount", "13.50"]);
    t.categories();
    let cache = fs::read_to_string(t.cache_path()).unwrap();
    assert!(cache.contains("13.50"), "{cache}");
    assert!(!cache.contains("12.50"), "{cache}");
}
