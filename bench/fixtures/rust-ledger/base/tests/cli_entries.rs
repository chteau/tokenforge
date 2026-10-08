mod common;

use common::Tally;

#[test]
fn init_is_idempotent() {
    let t = Tally::bare();
    let out = t.ok(&["init"]);
    assert!(out.starts_with("initialised empty ledger in "), "{out}");
    let again = t.ok(&["init"]);
    assert!(again.starts_with("ledger already exists in "), "{again}");
    assert_eq!(t.read("ledger.txt"), "# tally ledger v1\nnext_id=1\n");
}

#[test]
fn commands_require_an_initialised_ledger() {
    let t = Tally::bare();
    let (code, err) = t.fail(&["list"]);
    assert_eq!(code, 1);
    assert!(err.contains("no ledger found in"), "{err}");
    assert!(err.contains("run `tally init` first"), "{err}");
}

#[test]
fn add_assigns_sequential_ids_and_persists() {
    let t = Tally::new();
    assert_eq!(
        t.ok(&["add", "2026-01-03", "12.50", "groceries"]),
        "added entry 1\n"
    );
    assert_eq!(
        t.ok(&["add", "2026-01-04", "3", "coffee"]),
        "added entry 2\n"
    );
    let ledger = t.read("ledger.txt");
    assert!(ledger.contains("next_id=3\n"), "{ledger}");
    assert!(
        ledger.contains("1|2026-01-03|expense|12.50|groceries|||\n"),
        "{ledger}"
    );
    assert!(
        ledger.contains("2|2026-01-04|expense|3.00|coffee|||\n"),
        "{ledger}"
    );
}

#[test]
fn add_normalises_fields() {
    let t = Tally::new();
    t.ok(&[
        "add",
        "2026-01-03",
        "12.5",
        "  Groceries ",
        "--payee",
        " Corner Shop ",
        "--tag",
        "#Food",
        "--tag",
        "food",
        "--tag",
        "home",
    ]);
    let ledger = t.read("ledger.txt");
    assert!(
        ledger.contains("1|2026-01-03|expense|12.50|groceries|Corner Shop||food,home\n"),
        "{ledger}"
    );
}

#[test]
fn add_escapes_separators_in_text() {
    let t = Tally::new();
    t.ok(&[
        "add",
        "2026-01-03",
        "9.99",
        "books",
        "--payee",
        "Smith | Sons",
        "--note",
        "a\\b",
    ]);
    assert!(t.read("ledger.txt").contains("|Smith \\| Sons|a\\\\b|"));
    let json = t.ok(&["list", "--format", "json"]);
    assert!(json.contains("\"payee\": \"Smith | Sons\""), "{json}");
    assert!(json.contains("\"note\": \"a\\\\b\""), "{json}");
}

#[test]
fn add_rejects_invalid_values() {
    let t = Tally::new();
    let cases: &[(&[&str], &str)] = &[
        (
            &["add", "2026-01-03", "0", "food"],
            "amount must be greater than zero",
        ),
        (
            &["add", "2026-01-03", "-4", "food"],
            "amount must be greater than zero",
        ),
        (
            &["add", "2026-01-03", "1", "eating out"],
            "may only contain letters, digits",
        ),
        (
            &["add", "1969-12-31", "1", "food"],
            "outside the supported range",
        ),
        (
            &["add", "2026-01-03", "1", "food", "--tag", "a b"],
            "tag 'a b' may only contain",
        ),
    ];
    for (args, msg) in cases {
        let (code, err) = t.fail(args);
        assert_eq!(code, 1, "{args:?}");
        assert!(err.contains(msg), "{args:?}: {err}");
    }
    assert_eq!(t.read("ledger.txt"), "# tally ledger v1\nnext_id=1\n");
}

#[test]
fn malformed_arguments_are_usage_errors() {
    let t = Tally::new();
    let (code, err) = t.fail(&["add", "2026-02-30", "1", "food"]);
    assert_eq!(code, 2);
    assert!(err.contains("invalid date '2026-02-30'"), "{err}");
    let (code, err) = t.fail(&["add", "2026-02-01", "1.234", "food"]);
    assert_eq!(code, 2);
    assert!(err.contains("invalid amount '1.234'"), "{err}");
    let (code, _) = t.fail(&["explode"]);
    assert_eq!(code, 2);
}

#[test]
fn edit_changes_only_given_fields() {
    let t = Tally::new();
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
    assert_eq!(
        t.ok(&["edit", "1", "--amount", "14", "--note", "receipt lost"]),
        "updated entry 1\n"
    );
    assert!(t
        .read("ledger.txt")
        .contains("1|2026-01-03|expense|14.00|groceries|Shop|receipt lost|food\n"));
    t.ok(&["edit", "1", "--clear-tags", "--income"]);
    assert!(t
        .read("ledger.txt")
        .contains("1|2026-01-03|income|14.00|groceries|Shop|receipt lost|\n"));
}

#[test]
fn edit_validates_and_reports_missing_entries() {
    let t = Tally::new();
    t.ok(&["add", "2026-01-03", "12.50", "groceries"]);
    let (code, err) = t.fail(&["edit", "7", "--amount", "1"]);
    assert_eq!(code, 3);
    assert!(err.contains("no entry with id 7"), "{err}");
    let (code, err) = t.fail(&["edit", "1", "--category", "bad name"]);
    assert_eq!(code, 1);
    assert!(err.contains("may only contain"), "{err}");
    let (code, err) = t.fail(&["edit", "1"]);
    assert_eq!(code, 2);
    assert!(err.contains("nothing to change"), "{err}");
}

#[test]
fn remove_deletes_without_reusing_ids() {
    let t = Tally::new();
    t.ok(&["add", "2026-01-03", "1", "a"]);
    t.ok(&["add", "2026-01-04", "2", "b"]);
    assert_eq!(t.ok(&["remove", "2"]), "removed entry 2\n");
    assert_eq!(t.ok(&["add", "2026-01-05", "3", "c"]), "added entry 3\n");
    let (code, _) = t.fail(&["remove", "2"]);
    assert_eq!(code, 3);
}

#[test]
fn rename_category_moves_all_entries() {
    let t = Tally::new();
    t.ok(&["add", "2026-01-03", "1", "food"]);
    t.ok(&["add", "2026-01-04", "2", "rent"]);
    t.ok(&["add", "2026-01-05", "3", "food"]);
    assert_eq!(
        t.ok(&["rename-category", "Food", "Groceries"]),
        "renamed 'food' to 'groceries' (2 entries)\n"
    );
    let csv = t.ok(&["list", "--format", "csv"]);
    assert_eq!(csv.matches(",groceries,").count(), 2, "{csv}");
    let (code, err) = t.fail(&["rename-category", "food", "x"]);
    assert_eq!(code, 3);
    assert!(err.contains("no entries in category 'food'"), "{err}");
}

#[test]
fn help_and_version() {
    let t = Tally::bare();
    assert!(t.ok(&["--help"]).contains("usage: tally"));
    assert!(t.ok(&["help", "list"]).contains("--sort"));
    assert!(t.ok(&["--version"]).starts_with("tally "));
}

#[test]
fn hand_edited_ledger_with_comments_is_accepted() {
    let t = Tally::new();
    t.write(
        "ledger.txt",
        "# tally ledger v1\n# my notes\n\n4|2026-03-01|expense|5.00|misc|||\n",
    );
    assert_eq!(t.ok(&["add", "2026-03-02", "1", "misc"]), "added entry 5\n");
}

#[test]
fn corrupt_ledger_reports_line() {
    let t = Tally::new();
    t.write(
        "ledger.txt",
        "# tally ledger v1\nnext_id=2\n1|2026-03-01|expense|five|misc|||\n",
    );
    let (code, err) = t.fail(&["list"]);
    assert_eq!(code, 1);
    assert!(err.contains("ledger.txt:3: invalid amount 'five'"), "{err}");
}
