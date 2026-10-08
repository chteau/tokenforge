mod common;

use common::Tally;

const BANK: &str = "\
Date,Description,Amount,Balance
03/01/2026,\"CORNER SHOP, HIGH ST\",-12.50,987.50
04/01/2026,SALARY ACME,2500.00,3487.50
05/01/2026,Coffee Corner,-3.20,3484.30
";

#[test]
fn imports_bank_rows() {
    let t = Tally::new();
    let file = t.write("bank.csv", BANK);
    let out = t.ok(&["import", file.to_str().unwrap()]);
    assert_eq!(out, "imported 3 entries, skipped 0 duplicates\n");
    let csv = t.ok(&["list", "--format", "csv"]);
    assert_eq!(
        csv,
        "id,date,category,amount,payee,tags,note\n\
         1,2026-01-03,uncategorized,-12.50,\"CORNER SHOP, HIGH ST\",,\n\
         2,2026-01-04,uncategorized,2500.00,SALARY ACME,,\n\
         3,2026-01-05,uncategorized,-3.20,Coffee Corner,,\n"
    );
}

#[test]
fn reimport_skips_duplicates() {
    let t = Tally::new();
    let file = t.write("bank.csv", BANK);
    let path = file.to_str().unwrap();
    t.ok(&["import", path, "--category", "bank"]);
    assert_eq!(
        t.ok(&["import", path, "--category", "bank"]),
        "imported 0 entries, skipped 3 duplicates\n"
    );
    t.write("config.ini", "[import]\nskip_duplicates = no\n");
    assert_eq!(
        t.ok(&["import", path]),
        "imported 3 entries, skipped 0 duplicates\n"
    );
}

#[test]
fn dry_run_changes_nothing() {
    let t = Tally::new();
    let file = t.write("bank.csv", BANK);
    let out = t.ok(&[
        "import",
        file.to_str().unwrap(),
        "--dry-run",
        "--format",
        "csv",
    ]);
    assert!(
        out.ends_with("would import 3 entries, skipped 0 duplicates\n"),
        "{out}"
    );
    assert_eq!(t.read("ledger.txt"), "# tally ledger v1\nnext_id=1\n");
}

#[test]
fn default_category_comes_from_config() {
    let t = Tally::new();
    t.write("config.ini", "[import]\ndefault_category = Inbox\n");
    let file = t.write("bank.csv", BANK);
    t.ok(&["import", file.to_str().unwrap()]);
    let csv = t.ok(&["list", "--format", "csv", "--filter", "category=inbox"]);
    assert_eq!(csv.lines().count(), 4, "{csv}");
}

#[test]
fn bad_rows_abort_the_import() {
    let t = Tally::new();
    let file = t.write(
        "bank.csv",
        "Date,Description,Amount\n03/01/2026,A,-1.00\n32/01/2026,B,-2.00\n",
    );
    let (code, err) = t.fail(&["import", file.to_str().unwrap()]);
    assert_eq!(code, 1);
    assert!(err.contains("line 3: invalid date '32/01/2026'"), "{err}");
    assert_eq!(t.read("ledger.txt"), "# tally ledger v1\nnext_id=1\n");
    let (_, err) = t.fail(&["import", "/no/such/file.csv"]);
    assert!(err.contains("/no/such/file.csv"), "{err}");
}
