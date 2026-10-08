mod common;

use common::Tally;

fn sample() -> Tally {
    let t = Tally::new();
    t.ok(&["add", "2026-01-03", "12.50", "groceries"]);
    t.ok(&["add", "2026-01-31", "1200", "rent"]);
    t.ok(&["add", "2026-02-01", "2500", "salary", "--income"]);
    t.ok(&["add", "2026-02-14", "45.20", "eating-out"]);
    t
}

#[test]
fn categories_totals() {
    let t = sample();
    let expected = "\
CATEGORY    COUNT  EXPENSES    INCOME
eating-out      1    $45.20     $0.00
groceries       1    $12.50     $0.00
rent            1  $1200.00     $0.00
salary          1     $0.00  $2500.00
";
    assert_eq!(t.ok(&["categories"]), expected);
}

#[test]
fn monthly_report_with_totals() {
    let t = sample();
    let expected = "\
MONTH    COUNT  EXPENSES    INCOME        NET
2026-01      2  $1212.50     $0.00  -$1212.50
2026-02      2    $45.20  $2500.00   $2454.80
---------------------------------------------
total        4  $1257.70  $2500.00   $1242.30
";
    assert_eq!(t.ok(&["report", "monthly"]), expected);
    let csv = t.ok(&["report", "monthly", "--year", "2025", "--format", "csv"]);
    assert_eq!(csv, "month,count,expenses,income,net\n");
}

#[test]
fn category_breakdown_orders_by_spend() {
    let t = sample();
    let out = t.ok(&["report", "categories", "--format", "csv"]);
    assert_eq!(
        out,
        "category,count,expenses,income,net,share\n\
         rent,1,1200.00,0.00,-1200.00,95.4%\n\
         eating-out,1,45.20,0.00,-45.20,3.6%\n\
         groceries,1,12.50,0.00,-12.50,1.0%\n\
         salary,1,0.00,2500.00,2500.00,0.0%\n"
    );
    let feb = t.ok(&[
        "report",
        "categories",
        "--month",
        "2026-02",
        "--format",
        "json",
    ]);
    assert!(feb.contains("\"category\": \"eating-out\""), "{feb}");
    assert!(!feb.contains("rent"), "{feb}");
}

#[test]
fn summaries_follow_new_entries() {
    let t = sample();
    t.ok(&["categories"]);
    assert!(t.dir.join("summary.cache").exists());
    t.ok(&["add", "2026-02-20", "7.50", "groceries"]);
    let out = t.ok(&["categories", "--format", "csv"]);
    assert!(out.contains("groceries,2,20.00,0.00\n"), "{out}");
    t.ok(&["remove", "2"]);
    let out = t.ok(&["report", "monthly", "--format", "csv"]);
    assert!(out.contains("2026-01,1,12.50,0.00,-12.50\n"), "{out}");
}

#[test]
fn cache_can_be_disabled() {
    let t = sample();
    t.write("config.ini", "[cache]\nenabled = false\n");
    t.ok(&["categories"]);
    assert!(!t.dir.join("summary.cache").exists());
}

#[test]
fn corrupt_cache_is_rebuilt() {
    let t = sample();
    t.ok(&["categories"]);
    t.write("summary.cache", "garbage\n");
    let out = t.ok(&["categories", "--format", "csv"]);
    assert!(out.contains("rent,1,1200.00,0.00\n"), "{out}");
    assert!(t
        .read("summary.cache")
        .starts_with("# tally summary cache v1\n"));
}
