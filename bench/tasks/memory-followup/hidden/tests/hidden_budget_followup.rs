mod common;

use common::Tally;

/// March 2026: $240 groceries, $45 + $80 eating out, a $60 groceries refund,
/// salary, and a large February groceries expense that must not count.
fn sample() -> Tally {
    let t = Tally::new();
    t.ok(&["add", "2026-03-03", "240", "groceries"]);
    t.ok(&["add", "2026-03-10", "45", "eating-out"]);
    t.ok(&["add", "2026-03-12", "80", "eating-out"]);
    t.ok(&["add", "2026-03-15", "60", "groceries", "--income"]);
    t.ok(&["add", "2026-02-27", "999", "groceries"]);
    t.ok(&["add", "2026-03-01", "3000", "salary", "--income"]);
    t
}

fn budgeted() -> Tally {
    let t = sample();
    t.ok(&["budget", "set", "groceries", "300"]);
    t.ok(&["budget", "set", "eating-out", "100"]);
    t.ok(&["budget", "set", "rent", "1200"]);
    t
}

// ---------------------------------------------------------------- clear

#[test]
fn clear_without_budgets_is_a_noop() {
    let t = sample();
    assert_eq!(t.ok(&["budget", "clear"]), "no budgets to clear\n");
    assert_eq!(t.ok(&["budget", "clear", "--yes"]), "no budgets to clear\n");
    assert_eq!(
        t.ok(&["budget", "list", "--format", "csv"]),
        "category,limit\n"
    );
}

#[test]
fn clear_requires_yes_and_keeps_budgets() {
    let t = budgeted();
    let (code, err) = t.fail(&["budget", "clear"]);
    assert_eq!(code, 1, "{err}");
    assert!(
        err.contains("this would remove 3 budgets; re-run with --yes to confirm"),
        "{err}"
    );
    assert_eq!(
        t.ok(&["budget", "list", "--format", "csv"]),
        "category,limit\neating-out,100.00\ngroceries,300.00\nrent,1200.00\n"
    );
}

#[test]
fn clear_with_yes_removes_everything() {
    let t = budgeted();
    assert_eq!(t.ok(&["budget", "clear", "--yes"]), "cleared 3 budgets\n");
    assert_eq!(t.ok(&["budget", "list"]), "(no rows)\n");
    assert_eq!(t.ok(&["budget", "list", "--format", "json"]).trim(), "[]");
    assert_eq!(
        t.ok(&["budget", "status", "--month", "2026-03", "--format", "csv"]),
        "category,limit,spent,remaining,used,status\n"
    );
    assert_eq!(t.ok(&["budget", "clear", "--yes"]), "no budgets to clear\n");
}

#[test]
fn clear_uses_singular_for_one_budget() {
    let t = sample();
    t.ok(&["budget", "set", "groceries", "300"]);
    let (code, err) = t.fail(&["budget", "clear"]);
    assert_eq!(code, 1);
    assert!(err.contains("this would remove 1 budget;"), "{err}");
    assert_eq!(t.ok(&["budget", "clear", "--yes"]), "cleared 1 budget\n");
}

#[test]
fn clear_keeps_the_ledger_and_allows_new_budgets() {
    let t = budgeted();
    let ledger = t.read("ledger.txt");
    t.ok(&["budget", "clear", "--yes"]);
    assert_eq!(t.read("ledger.txt"), ledger);
    t.ok(&["budget", "set", "fun", "50"]);
    assert_eq!(
        t.ok(&["budget", "list", "--format", "csv"]),
        "category,limit\nfun,50.00\n"
    );
}

#[test]
fn clear_rejects_extra_arguments() {
    let t = budgeted();
    assert_eq!(t.fail(&["budget", "clear", "all"]).0, 2);
    assert_eq!(t.fail(&["budget", "clear", "--yes", "groceries"]).0, 2);
    assert_eq!(t.fail(&["budget", "clear", "--force"]).0, 2);
    assert_eq!(
        t.ok(&["budget", "list", "--format", "csv"]).lines().count(),
        4
    );
}

#[test]
fn clear_requires_initialised_ledger() {
    let t = Tally::bare();
    let (code, err) = t.fail(&["budget", "clear", "--yes"]);
    assert_eq!(code, 1);
    assert!(err.contains("no ledger found"), "{err}");
}

// ---------------------------------------------------------------- alerts

#[test]
fn alerts_text_table_with_totals() {
    let t = budgeted();
    let expected = "\
CATEGORY      LIMIT    SPENT  REMAINING    USED  STATUS
eating-out  $100.00  $125.00    -$25.00  125.0%  over
groceries   $300.00  $240.00     $60.00   80.0%  warning
--------------------------------------------------------
total       $400.00  $365.00     $35.00   91.3%
";
    assert_eq!(
        t.ok(&["budget", "status", "--month", "2026-03", "--alerts"]),
        expected
    );
}

#[test]
fn alerts_csv_and_json() {
    let t = budgeted();
    assert_eq!(
        t.ok(&["budget", "status", "--alerts", "--month", "2026-03", "--format", "csv"]),
        "category,limit,spent,remaining,used,status\n\
         eating-out,100.00,125.00,-25.00,125.0%,over\n\
         groceries,300.00,240.00,60.00,80.0%,warning\n"
    );
    let json = t.ok(&[
        "--format", "json", "budget", "status", "--month", "2026-03", "--alerts",
    ]);
    assert!(json.contains("\"category\": \"eating-out\""), "{json}");
    assert!(json.contains("\"category\": \"groceries\""), "{json}");
    assert!(!json.contains("rent"), "{json}");
    assert!(!json.contains("total"), "{json}");
}

#[test]
fn alerts_with_nothing_flagged_is_empty() {
    let t = budgeted();
    assert_eq!(
        t.ok(&["budget", "status", "--month", "2026-01", "--alerts"]),
        "(no rows)\n"
    );
    assert_eq!(
        t.ok(&["budget", "status", "--month", "2026-01", "--alerts", "--format", "json"])
            .trim(),
        "[]"
    );
    assert_eq!(
        t.ok(&["budget", "status", "--month", "2026-01", "--alerts", "--format", "csv"]),
        "category,limit,spent,remaining,used,status\n"
    );
}

#[test]
fn alerts_follow_warn_percent() {
    let t = budgeted();
    t.write("config.ini", "[budget]\nwarn_percent = 90\n");
    assert_eq!(
        t.ok(&["budget", "status", "--month", "2026-03", "--alerts", "--format", "csv"]),
        "category,limit,spent,remaining,used,status\neating-out,100.00,125.00,-25.00,125.0%,over\n"
    );
    let t = t.env("TALLY_BUDGET_WARN_PERCENT", "0");
    let out = t.ok(&[
        "budget", "status", "--month", "2026-01", "--alerts", "--format", "csv",
    ]);
    assert_eq!(out.lines().count(), 4, "{out}");
}

#[test]
fn alerts_without_budgets() {
    let t = sample();
    assert_eq!(
        t.ok(&["budget", "status", "--month", "2026-03", "--alerts"]),
        "(no rows)\n"
    );
}

#[test]
fn alerts_rejects_a_value_and_bad_month() {
    let t = budgeted();
    assert_eq!(t.fail(&["budget", "status", "--alerts=yes"]).0, 2);
    assert_eq!(
        t.fail(&["budget", "status", "--alerts", "--month", "2026-13"])
            .0,
        2
    );
    assert_eq!(t.fail(&["budget", "list", "--alerts"]).0, 2);
}

// ---------------------------------------------------------------- help

#[test]
fn followup_help_mentions_new_options() {
    let t = Tally::bare();
    let help = t.ok(&["help", "budget"]);
    assert!(help.contains("clear"), "{help}");
    assert!(help.contains("--yes"), "{help}");
    assert!(help.contains("--alerts"), "{help}");
    let general = t.ok(&["help"]);
    assert!(general.contains("budget"), "{general}");
}

#[test]
fn followup_help_unknown_action_still_usage_error() {
    let t = Tally::new();
    let (code, err) = t.fail(&["budget", "wipe"]);
    assert_eq!(code, 2);
    assert!(err.contains("clear"), "{err}");
    assert_eq!(t.fail(&["budget"]).0, 2);
}

// ---------------------------------------------------------------- existing behaviour

#[test]
fn existing_budget_set_list_remove() {
    let t = sample();
    assert_eq!(
        t.ok(&["budget", "set", " Groceries ", "300"]),
        "set budget for 'groceries' to 300.00\n"
    );
    t.ok(&["budget", "set", "rent", "1200"]);
    assert_eq!(
        t.ok(&["budget", "list"]),
        "CATEGORY      LIMIT\ngroceries   $300.00\nrent       $1200.00\n"
    );
    assert_eq!(
        t.ok(&["budget", "remove", "RENT"]),
        "removed budget for 'rent'\n"
    );
    let (code, err) = t.fail(&["budget", "remove", "rent"]);
    assert_eq!(code, 3);
    assert!(err.contains("no budget for category 'rent'"), "{err}");
    assert_eq!(t.fail(&["budget", "set", "food", "1.234"]).0, 2);
    assert_eq!(t.fail(&["budget", "set", "food", "0"]).0, 1);
}

#[test]
fn existing_budget_status_unchanged_without_alerts() {
    let t = budgeted();
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
fn existing_budget_rename_moves_budget() {
    let t = budgeted();
    t.ok(&["rename-category", "eating-out", "dining"]);
    assert_eq!(
        t.ok(&["budget", "list", "--format", "csv"]),
        "category,limit\ndining,100.00\ngroceries,300.00\nrent,1200.00\n"
    );
}

#[test]
fn existing_budget_file_is_plain_text() {
    let t = budgeted();
    let text = t.read("budgets.txt");
    assert!(text.contains("groceries"), "{text}");
    assert!(!t.read("ledger.txt").contains("1200.00"));
}
