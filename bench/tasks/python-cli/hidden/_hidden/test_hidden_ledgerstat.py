"""Black-box tests for `python3 -m ledgerstat` (run from the repository root)."""
import csv
import io
import json
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
FX = "_hidden/fixtures/"
MAIN = FX + "main.csv"
APRIL = FX + "april.csv"
BAD = FX + "bad_rows.csv"
BUDGETS = FX + "budgets.toml"


def run(*args):
    p = subprocess.run([sys.executable, "-m", "ledgerstat", *args], cwd=REPO, capture_output=True,
                       text=True, timeout=30)
    return p.returncode, p.stdout, p.stderr


def run_json(*args):
    code, out, err = run(*args, "--format", "json")
    return code, json.loads(out), err


def run_csv(*args):
    code, out, err = run(*args, "--format", "csv")
    return code, list(csv.reader(io.StringIO(out))), err


def lines(text):
    return [l.rstrip("\r") for l in text.strip("\n").split("\n")]


class Base(unittest.TestCase):
    def assertMoney(self, actual, expected):
        self.assertIsInstance(actual, (int, float))
        self.assertAlmostEqual(float(actual), expected, places=2)

    def assertFatal(self, *args, needles=()):
        code, out, err = run(*args)
        self.assertEqual(code, 2, err)
        self.assertEqual(out.strip(), "")
        for n in needles:
            self.assertIn(n, err)
        return err


class InputTests(Base):
    def test_input_header_any_order_case_and_extra_columns(self):
        code, doc, _ = run_json("categories", MAIN)
        self.assertEqual(code, 0)
        self.assertEqual(doc["total"]["count"], 15)

    def test_input_category_lowercased_and_empty_uncategorized(self):
        _, doc, _ = run_json("categories", MAIN)
        names = [c["category"] for c in doc["categories"]]
        self.assertIn("uncategorized", names)
        self.assertIn("groceries", names)
        self.assertNotIn("Groceries", names)
        groc = next(c for c in doc["categories"] if c["category"] == "groceries")
        self.assertEqual(groc["count"], 5)

    def test_input_merchant_trimmed_and_quoted_comma(self):
        _, doc, _ = run_json("merchants", MAIN)
        names = [m["merchant"] for m in doc["merchants"]]
        self.assertIn("Cafe Lune, Downtown", names)
        gg = next(m for m in doc["merchants"] if m["merchant"] == "Green Grocer")
        self.assertEqual(gg["count"], 4)

    def test_input_bom_tolerated(self):
        code, doc, err = run_json("categories", FX + "bom.csv")
        self.assertEqual(code, 0, err)
        self.assertEqual([c["category"] for c in doc["categories"]], ["misc"])
        self.assertMoney(doc["categories"][0]["expenses"], 10.00)

    def test_input_multiple_files_combined(self):
        code, doc, _ = run_json("monthly", MAIN, APRIL)
        self.assertEqual(code, 0)
        self.assertEqual([m["month"] for m in doc["months"]],
                         ["2026-01", "2026-02", "2026-03", "2026-04"])
        self.assertEqual(doc["months"][3]["count"], 2)
        self.assertMoney(doc["months"][3]["expenses"], 1045.25)
        self.assertEqual(doc["total"]["count"], 17)


class CategoriesTests(Base):
    def test_categories_table_exact(self):
        code, out, err = run("categories", MAIN)
        self.assertEqual(code, 0, err)
        self.assertEqual(lines(out), [
            "category       count   income  expenses       net",
            "-------------  -----  -------  --------  --------",
            "housing            2     0.00   1900.00  -1900.00",
            "groceries          5    15.00    439.30   -424.30",
            "dining             3     0.00     96.25    -96.25",
            "books              1     0.00     30.00    -30.00",
            "uncategorized      1     0.00     30.00    -30.00",
            "fees               1     0.00      0.00      0.00",
            "salary             2  5000.00      0.00   5000.00",
            "-------------  -----  -------  --------  --------",
            "TOTAL             15  5015.00   2495.55   2519.45",
        ])

    def test_categories_json_values(self):
        _, doc, _ = run_json("categories", MAIN)
        self.assertEqual(set(doc), {"categories", "total"})
        self.assertEqual([c["category"] for c in doc["categories"]],
                         ["housing", "groceries", "dining", "books", "uncategorized", "fees", "salary"])
        g = doc["categories"][1]
        self.assertEqual(set(g), {"category", "count", "income", "expenses", "net"})
        self.assertMoney(g["income"], 15.00)
        self.assertMoney(g["expenses"], 439.30)
        self.assertMoney(g["net"], -424.30)
        t = doc["total"]
        self.assertEqual(set(t), {"count", "income", "expenses", "net"})
        self.assertEqual(t["count"], 15)
        self.assertMoney(t["income"], 5015.00)
        self.assertMoney(t["expenses"], 2495.55)
        self.assertMoney(t["net"], 2519.45)

    def test_categories_csv(self):
        code, rows, _ = run_csv("categories", MAIN)
        self.assertEqual(code, 0)
        self.assertEqual(rows[0], ["category", "count", "income", "expenses", "net"])
        self.assertEqual(rows[1], ["housing", "2", "0.00", "1900.00", "-1900.00"])
        self.assertEqual(rows[-1], ["salary", "2", "5000.00", "0.00", "5000.00"])
        self.assertEqual(len(rows), 8)


class MonthlyTests(Base):
    def test_monthly_table_exact(self):
        code, out, _ = run("monthly", MAIN)
        self.assertEqual(code, 0)
        self.assertEqual(lines(out), [
            "month    count   income  expenses       net",
            "-------  -----  -------  --------  --------",
            "2026-01      6  2500.00    176.70   2323.30",
            "2026-02      5  2515.00   1017.50   1497.50",
            "2026-03      4     0.00   1301.35  -1301.35",
            "-------  -----  -------  --------  --------",
            "TOTAL       15  5015.00   2495.55   2519.45",
        ])

    def test_monthly_json(self):
        _, doc, _ = run_json("monthly", MAIN)
        self.assertEqual(set(doc), {"months", "total"})
        m = doc["months"][1]
        self.assertEqual(m["month"], "2026-02")
        self.assertEqual(m["count"], 5)
        self.assertMoney(m["income"], 2515.00)
        self.assertMoney(m["expenses"], 1017.50)
        self.assertMoney(m["net"], 1497.50)
        self.assertMoney(doc["total"]["net"], 2519.45)

    def test_monthly_csv(self):
        _, rows, _ = run_csv("monthly", MAIN)
        self.assertEqual(rows, [
            ["month", "count", "income", "expenses", "net"],
            ["2026-01", "6", "2500.00", "176.70", "2323.30"],
            ["2026-02", "5", "2515.00", "1017.50", "1497.50"],
            ["2026-03", "4", "0.00", "1301.35", "-1301.35"],
        ])


class MerchantsTests(Base):
    def test_merchants_table_exact_default_top(self):
        code, out, _ = run("merchants", MAIN)
        self.assertEqual(code, 0)
        self.assertEqual(lines(out), [
            "rank  merchant             count  expenses",
            "----  -------------------  -----  --------",
            "   1  City Rent                2   1900.00",
            "   2  Green Grocer             4    439.30",
            "   3  Cafe Lune, Downtown      2     73.85",
            "   4  Bookshop                 2     60.00",
            "   5  Cafe Lune                1     22.40",
        ])

    def test_merchants_top_n(self):
        _, doc, _ = run_json("merchants", MAIN, "--top", "2")
        self.assertEqual(set(doc), {"merchants"})
        self.assertEqual([(m["rank"], m["merchant"]) for m in doc["merchants"]],
                         [(1, "City Rent"), (2, "Green Grocer")])
        self.assertMoney(doc["merchants"][1]["expenses"], 439.30)

    def test_merchants_excludes_income_only(self):
        _, doc, _ = run_json("merchants", MAIN, "--top", "50")
        names = [m["merchant"] for m in doc["merchants"]]
        self.assertEqual(len(names), 5)
        self.assertNotIn("ACME Corp", names)
        self.assertNotIn("Bank", names)

    def test_merchants_multi_file_csv(self):
        _, rows, _ = run_csv("merchants", MAIN, APRIL, "--top", "2")
        self.assertEqual(rows, [["rank", "merchant", "count", "expenses"],
                                ["1", "City Rent", "3", "2875.00"],
                                ["2", "Green Grocer", "5", "509.55"]])


class BudgetTests(Base):
    def test_budget_all_rows_json(self):
        code, doc, _ = run_json("budget", MAIN, "--config", BUDGETS)
        self.assertEqual(code, 3)
        rows = doc["budgets"]
        self.assertEqual(len(rows), 12)
        self.assertEqual([(r["month"], r["category"]) for r in rows[:4]],
                         [("2026-01", "dining"), ("2026-01", "groceries"),
                          ("2026-01", "housing"), ("2026-01", "travel")])
        jan_g = rows[1]
        self.assertEqual(set(jan_g), {"month", "category", "budget", "spent", "remaining", "status"})
        self.assertMoney(jan_g["budget"], 300.00)
        self.assertMoney(jan_g["spent"], 134.20)
        self.assertMoney(jan_g["remaining"], 165.80)
        self.assertEqual(jan_g["status"], "ok")
        self.assertEqual([r["status"] for r in rows],
                         ["ok", "ok", "ok", "ok",
                          "ok", "ok", "warning", "ok",
                          "over", "warning", "warning", "ok"])

    def test_budget_refund_not_subtracted(self):
        _, doc, _ = run_json("budget", MAIN, "--config", BUDGETS)
        feb_g = doc["budgets"][5]
        self.assertEqual((feb_g["month"], feb_g["category"]), ("2026-02", "groceries"))
        self.assertMoney(feb_g["spent"], 45.10)

    def test_budget_alerts_only_table_exact(self):
        code, out, _ = run("budget", MAIN, "--config", BUDGETS, "--alerts-only")
        self.assertEqual(code, 3)
        self.assertEqual(lines(out), [
            "month    category   budget   spent  remaining  status",
            "-------  ---------  ------  ------  ---------  -------",
            "2026-02  housing    950.00  950.00       0.00  warning",
            "2026-03  dining      50.50   61.35     -10.85  over",
            "2026-03  groceries  300.00  260.00      40.00  warning",
            "2026-03  housing    950.00  950.00       0.00  warning",
        ])

    def test_budget_no_over_exit_zero(self):
        code, rows, _ = run_csv("budget", MAIN, "--config", BUDGETS, "--to", "2026-02-28",
                                "--alerts-only")
        self.assertEqual(code, 0)
        self.assertEqual(rows, [["month", "category", "budget", "spent", "remaining", "status"],
                                ["2026-02", "housing", "950.00", "950.00", "0.00", "warning"]])

    def test_budget_default_warn_ratio(self):
        code, doc, _ = run_json("budget", MAIN, "--config", FX + "budgets_default_ratio.toml")
        self.assertEqual(code, 0)
        self.assertEqual([r["status"] for r in doc["budgets"]], ["ok", "ok", "warning"])

    def test_budget_over_exit_three(self):
        code, doc, _ = run_json("budget", MAIN, "--config", FX + "budgets_tight.toml")
        self.assertEqual(code, 3)
        self.assertEqual(doc["budgets"][2]["status"], "over")
        self.assertMoney(doc["budgets"][2]["remaining"], -10.00)

    def test_budget_missing_config_is_usage_error(self):
        self.assertFatal("budget", MAIN)


class FilterTests(Base):
    def test_filter_range_inclusive(self):
        _, doc, _ = run_json("categories", MAIN, "--from", "2026-02-01", "--to", "2026-02-12")
        self.assertEqual(doc["total"]["count"], 5)
        self.assertMoney(doc["total"]["income"], 2515.00)
        self.assertMoney(doc["total"]["expenses"], 1017.50)

    def test_filter_from_only(self):
        _, doc, _ = run_json("monthly", MAIN, "--from", "2026-03-04")
        self.assertEqual([m["month"] for m in doc["months"]], ["2026-03"])
        self.assertEqual(doc["months"][0]["count"], 3)

    def test_filter_to_only(self):
        _, doc, _ = run_json("merchants", MAIN, "--to", "2026-01-09")
        self.assertEqual([m["merchant"] for m in doc["merchants"]],
                         ["Green Grocer", "Cafe Lune, Downtown"])

    def test_filter_budget_months_follow_filter(self):
        _, doc, _ = run_json("budget", MAIN, "--config", BUDGETS, "--from", "2026-03-01")
        self.assertEqual({r["month"] for r in doc["budgets"]}, {"2026-03"})


class FormatTests(Base):
    def test_format_empty_table(self):
        code, out, _ = run("categories", MAIN, "--from", "2025-01-01", "--to", "2025-12-31")
        self.assertEqual(code, 0)
        self.assertEqual(lines(out), ["No transactions."])

    def test_format_empty_json(self):
        code, doc, _ = run_json("monthly", MAIN, "--to", "2025-12-31")
        self.assertEqual(code, 0)
        self.assertEqual(doc["months"], [])
        self.assertEqual(doc["total"]["count"], 0)
        self.assertMoney(doc["total"]["net"], 0.0)

    def test_format_empty_csv(self):
        _, rows, _ = run_csv("merchants", MAIN, "--from", "2027-01-01")
        self.assertEqual(rows, [["rank", "merchant", "count", "expenses"]])

    def test_format_empty_json_merchants_and_budget(self):
        _, doc, _ = run_json("merchants", MAIN, "--from", "2027-01-01")
        self.assertEqual(doc, {"merchants": []})
        code, doc, _ = run_json("budget", MAIN, "--config", BUDGETS, "--from", "2027-01-01")
        self.assertEqual((code, doc), (0, {"budgets": []}))

    def test_format_money_two_decimals_csv(self):
        _, rows, _ = run_csv("categories", FX + "bom.csv")
        self.assertEqual(rows[1], ["misc", "2", "0.00", "10.00", "-10.00"])

    def test_format_invalid_choice(self):
        self.assertFatal("categories", MAIN, "--format", "xml")


class BadRowTests(Base):
    BAD_LINES = [3, 4, 5, 6, 9, 10, 11, 12]

    def test_badrows_reported_with_line_numbers(self):
        code, out, err = run("categories", BAD)
        self.assertEqual(code, 1)
        for n in self.BAD_LINES:
            self.assertIn(f"ledgerstat: {BAD}:{n}: ", err)
        for n in (1, 2, 7, 8, 13):
            self.assertNotIn(f"{BAD}:{n}:", err)

    def test_badrows_summary_line(self):
        _, _, err = run("monthly", BAD)
        self.assertIn("ledgerstat: skipped 8 invalid row(s)", err)

    def test_badrows_report_still_printed(self):
        code, rows, _ = run_csv("categories", BAD)
        self.assertEqual(code, 1)
        self.assertEqual(rows, [["category", "count", "income", "expenses", "net"],
                                ["uncategorized", "1", "0.00", "20.00", "-20.00"],
                                ["misc", "2", "0.00", "17.50", "-17.50"]])

    def test_badrows_strict(self):
        code, out, err = run("categories", BAD, "--strict")
        self.assertEqual(code, 1)
        self.assertEqual(out.strip(), "")
        self.assertIn(f"{BAD}:3:", err)

    def test_badrows_strict_clean_file_ok(self):
        code, out, _ = run("categories", MAIN, "--strict", "--format", "json")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["total"]["count"], 15)

    def test_badrows_take_priority_over_budget_exit(self):
        code, out, _ = run("budget", MAIN, BAD, "--config", BUDGETS, "--format", "json")
        self.assertEqual(code, 1)
        self.assertTrue(json.loads(out)["budgets"])

    def test_badrows_not_affected_by_filter(self):
        code, _, err = run("categories", BAD, "--from", "2030-01-01")
        self.assertEqual(code, 1)
        self.assertIn(f"{BAD}:3:", err)


class ErrorTests(Base):
    def test_errors_missing_file(self):
        err = self.assertFatal("categories", MAIN, FX + "nope.csv", needles=[FX + "nope.csv"])
        self.assertIn("ledgerstat: error:", err)

    def test_errors_missing_column(self):
        err = self.assertFatal("monthly", FX + "missing_col.csv", needles=["missing_col.csv", "amount"])
        self.assertIn("ledgerstat: error:", err)

    def test_errors_empty_file(self):
        self.assertFatal("monthly", FX + "empty.csv", needles=["empty.csv"])

    def test_errors_bad_dates(self):
        self.assertFatal("categories", MAIN, "--from", "2026-13-01")
        self.assertFatal("categories", MAIN, "--to", "yesterday")
        self.assertFatal("categories", MAIN, "--from", "2026-03-01", "--to", "2026-02-01")

    def test_errors_bad_top(self):
        self.assertFatal("merchants", MAIN, "--top", "0")
        self.assertFatal("merchants", MAIN, "--top", "abc")

    def test_errors_unknown_command(self):
        self.assertFatal("summary", MAIN)


class ConfigTests(Base):
    def check(self, name):
        err = self.assertFatal("budget", MAIN, "--config", FX + name)
        self.assertIn("ledgerstat: error: config:", err)

    def test_config_missing_file(self):
        self.check("does_not_exist.toml")

    def test_config_invalid_toml(self):
        self.check("cfg_invalid_toml.toml")

    def test_config_no_budgets_table(self):
        self.check("cfg_no_budgets.toml")

    def test_config_invalid_values(self):
        for name in ("cfg_bool.toml", "cfg_negative.toml", "cfg_string.toml"):
            self.check(name)

    def test_config_invalid_warn_ratio(self):
        self.check("cfg_ratio_high.toml")
        self.check("cfg_ratio_zero.toml")


class CliTests(Base):
    def test_cli_help(self):
        code, out, _ = run("--help")
        self.assertEqual(code, 0)
        for cmd in ("categories", "monthly", "merchants", "budget"):
            self.assertIn(cmd, out)

    def test_cli_subcommand_help(self):
        code, out, _ = run("budget", "--help")
        self.assertEqual(code, 0)
        self.assertIn("--config", out)
        self.assertIn("--alerts-only", out)


if __name__ == "__main__":
    unittest.main()
