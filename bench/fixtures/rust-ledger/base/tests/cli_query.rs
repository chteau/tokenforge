mod common;

use common::Tally;

fn sample() -> Tally {
    let t = Tally::new();
    t.ok(&[
        "add",
        "2026-01-03",
        "12.50",
        "groceries",
        "--payee",
        "Corner Shop",
        "--tag",
        "food",
    ]);
    t.ok(&["add", "2026-01-31", "1200", "rent", "--payee", "Landlord"]);
    t.ok(&[
        "add",
        "2026-02-01",
        "2500",
        "salary",
        "--income",
        "--payee",
        "ACME Ltd",
    ]);
    t.ok(&[
        "add",
        "2026-02-14",
        "45.20",
        "eating-out",
        "--payee",
        "Night Market",
        "--tag",
        "food",
    ]);
    t.ok(&[
        "add",
        "2026-02-28",
        "30",
        "groceries",
        "--payee",
        "Market Hall",
    ]);
    t
}

fn ids(t: &Tally, args: &[&str]) -> Vec<u64> {
    let mut full = vec!["list", "--format", "csv"];
    full.extend_from_slice(args);
    t.ok(&full)
        .lines()
        .skip(1)
        .map(|l| l.split(',').next().unwrap().parse().unwrap())
        .collect()
}

#[test]
fn list_table_layout() {
    let t = sample();
    let out = t.ok(&["list", "--limit", "2"]);
    let expected = "\
ID  DATE        CATEGORY      AMOUNT  PAYEE        TAGS  NOTE
 1  2026-01-03  groceries    -$12.50  Corner Shop  food
 2  2026-01-31  rent       -$1200.00  Landlord
-------------------------------------------------------------
    total                  -$1212.50
";
    assert_eq!(out, expected);
}

#[test]
fn list_empty_ledger() {
    let t = Tally::new();
    assert_eq!(t.ok(&["list"]), "(no rows)\n");
    assert_eq!(t.ok(&["list", "--format", "json"]), "[]\n");
    assert_eq!(
        t.ok(&["list", "--format", "csv"]),
        "id,date,category,amount,payee,tags,note\n"
    );
}

#[test]
fn filter_expressions() {
    let t = sample();
    assert_eq!(ids(&t, &["--filter", "category=groceries"]), vec![1, 5]);
    assert_eq!(
        ids(&t, &["--filter", "amount>=30 and kind=expense"]),
        vec![2, 4, 5]
    );
    assert_eq!(
        ids(&t, &["--filter", "payee~market or tag=food"]),
        vec![1, 4, 5]
    );
    assert_eq!(ids(&t, &["--filter", "not (month=2026-02)"]), vec![1, 2]);
    assert_eq!(ids(&t, &["--filter", "payee=\"corner shop\""]), vec![1]);
}

#[test]
fn bad_filter_is_reported() {
    let t = sample();
    let (code, err) = t.fail(&["list", "--filter", "colour=red"]);
    assert_eq!(code, 1);
    assert!(err.contains("bad filter: unknown field 'colour'"), "{err}");
}

#[test]
fn month_and_date_ranges_are_inclusive() {
    let t = sample();
    assert_eq!(ids(&t, &["--month", "2026-01"]), vec![1, 2]);
    assert_eq!(ids(&t, &["--month", "2026-02"]), vec![3, 4, 5]);
    assert_eq!(
        ids(&t, &["--from", "2026-01-31", "--to", "2026-02-14"]),
        vec![2, 3, 4]
    );
    let (code, _) = t.fail(&["list", "--month", "2026-01", "--from", "2026-01-01"]);
    assert_eq!(code, 2);
}

#[test]
fn sorting_and_limit() {
    let t = sample();
    assert_eq!(ids(&t, &["--sort", "amount"]), vec![1, 5, 4, 2, 3]);
    assert_eq!(
        ids(&t, &["--sort", "amount", "--desc", "--limit", "2"]),
        vec![3, 2]
    );
    assert_eq!(ids(&t, &["--sort", "category"]), vec![4, 1, 5, 2, 3]);
    assert_eq!(ids(&t, &["--sort", "payee"]), vec![3, 1, 2, 5, 4]);
}

#[test]
fn json_output_types() {
    let t = sample();
    let out = t.ok(&["list", "--format", "json", "--filter", "id=3"]);
    assert_eq!(
        out,
        "[\n  {\"id\": 3, \"date\": \"2026-02-01\", \"category\": \"salary\", \"amount\": 2500.00, \"payee\": \"ACME Ltd\", \"tags\": \"\", \"note\": \"\"}\n]\n"
    );
}

#[test]
fn config_file_sets_format_and_currency() {
    let t = sample();
    t.write(
        "config.ini",
        "[general]\ncurrency_symbol = \"EUR \"\n[output]\nformat = csv\n",
    );
    let out = t.ok(&["list", "--limit", "1"]);
    assert!(out.starts_with("id,date,"), "{out}");
    let table = t.ok(&["list", "--limit", "1", "--format", "table"]);
    assert!(table.contains("-EUR 12.50"), "{table}");
}

#[test]
fn environment_overrides_config_file() {
    let t = sample().env("TALLY_OUTPUT_FORMAT", "json");
    t.write("config.ini", "[output]\nformat = csv\n");
    assert!(t.ok(&["list", "--limit", "1"]).starts_with("[\n"));
    let cfg = t.ok(&["config", "--format", "csv"]);
    assert!(cfg.contains("output.format,json,env\n"), "{cfg}");
}

#[test]
fn invalid_config_is_reported() {
    let t = sample();
    t.write("config.ini", "[output]\nformat = xml\n");
    let (code, err) = t.fail(&["list"]);
    assert_eq!(code, 1);
    assert!(
        err.contains("config line 2: output.format: unknown format 'xml'"),
        "{err}"
    );
}

#[test]
fn long_notes_are_truncated_in_table_only() {
    let t = Tally::new();
    let note = "a very long note that goes on and on and on";
    t.ok(&["add", "2026-01-01", "1", "misc", "--note", note]);
    t.write("config.ini", "[output]\nnote_width = 12\n");
    assert!(t.ok(&["list"]).contains("a very lo..."));
    assert!(t.ok(&["list", "--format", "csv"]).contains(note));
}
