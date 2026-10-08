#!/usr/bin/env python3
"""Black-box tests for tally. Usage: test_tally.py /path/to/tally.dll
Prints one line per test: `PASS <name>` or `FAIL <name>: <reason>`."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import traceback

DLL = os.path.abspath(sys.argv[1])
DOTNET = shutil.which("dotnet") or "dotnet"
TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


class R:
    def __init__(self, p):
        self.code, self.out, self.err = p.returncode, p.stdout.decode(), p.stderr.decode()

    @property
    def lines(self):
        return self.out.split("\n")[:-1] if self.out else []


def raw(args, cwd, env=None):
    e = {k: v for k, v in os.environ.items() if k != "TALLY_DATA"}
    e.update(env or {})
    return R(subprocess.run([DOTNET, DLL, *args], cwd=cwd, env=e, capture_output=True, timeout=30))


def eq(a, b, msg=""):
    assert a == b, f"{msg} expected {b!r}, got {a!r}"


class T:
    def __init__(self, root):
        self.root = root
        self.data = os.path.join(root, "data.json")

    def __call__(self, *args):
        return raw(["--data", self.data, *args], self.root)

    def ok(self, *args):
        r = self(*args)
        assert r.code == 0, f"{args}: exit {r.code}, stderr {r.err!r}"
        assert r.err == "", f"{args}: stderr {r.err!r}"
        return r.lines

    def fails(self, code, *args, msg=None):
        r = self(*args)
        eq(r.code, code, f"{args} exit")
        eq(r.out, "", f"{args} stdout")
        assert r.err.startswith("error: "), f"{args} stderr {r.err!r}"
        if msg is not None:
            eq(r.err.rstrip("\n"), msg, f"{args} stderr")
        return r

    def trip(self, *members, currency="EUR"):
        self.ok("group", "add", "trip", currency)
        for m in members or ("alice", "bob", "carol"):
            self.ok("member", "add", "trip", m)

    def shares(self, entry_id):
        return [l.strip() for l in self.ok("show", "trip", str(entry_id))[1:]]


# ---------------- command line ----------------

@test
def cli_help(tmp):
    r = raw(["--help"], tmp)
    eq(r.code, 0, "exit")
    assert r.out.startswith("usage: tally"), r.out[:80]
    r = raw(["-h"], tmp)
    eq(r.code, 0, "-h exit")


@test
def cli_usage_errors(t):
    t.fails(2)
    t.fails(2, "frobnicate", "x")
    t.fails(2, "group", "add", "trip")
    t.fails(2, "balances")
    t.fails(2, "member", "add", "trip", "a", "b")
    assert not os.path.exists(t.data), "data file created by a failed command"


@test
def cli_data_env_and_default(tmp):
    other = os.path.join(tmp, "env.json")
    r = raw(["group", "add", "g", "EUR"], tmp, {"TALLY_DATA": other})
    eq(r.code, 0, "exit")
    assert os.path.isfile(other), "TALLY_DATA not used"
    r = raw(["group", "add", "h", "USD"], tmp)
    eq(r.code, 0, "exit")
    assert os.path.isfile(os.path.join(tmp, "tally.json")), "default tally.json not used"
    r = raw(["--data", other, "group", "list"], tmp, {"TALLY_DATA": os.path.join(tmp, "nope.json")})
    eq(r.out, "g EUR members=0 entries=0\n", "--data wins over TALLY_DATA")


@test
def cli_option_usage_errors(t):
    t.trip()
    t.fails(2, "expense", "trip", "alice", "10", "x", "--bogus", "1")
    t.fails(2, "expense", "trip", "alice", "10", "x", "--currency")
    t.fails(2, "expense", "trip", "alice", "10", "x", "--split", "equal", "--split", "equal")
    t.fails(2, "expense", "trip", "alice", "10", "x", "--split", "thirds")
    t.fails(2, "expense", "trip", "alice", "10", "x", "--shares", "alice=10")
    t.fails(2, "expense", "trip", "alice", "10", "x", "--split", "exact")
    t.fails(2, "expense", "trip", "alice", "10", "x", "--split", "exact", "--among", "alice", "--shares", "alice=10")
    t.fails(2, "expense", "trip", "alice", "10", "x", "--split", "percent", "--shares", "alice:100")
    t.fails(2, "pay", "trip", "alice", "bob")
    eq(t.ok("list", "trip"), [], "nothing recorded")


# ---------------- groups and members ----------------

@test
def group_add_and_list(t):
    eq(t.ok("group", "add", "trip", "EUR"), ["created group trip (EUR)"])
    eq(t.ok("group", "add", "Flat-2", "USD"), ["created group Flat-2 (USD)"])
    eq(t.ok("group", "add", "apt_9", "GBP"), ["created group apt_9 (GBP)"])
    eq(t.ok("member", "add", "trip", "alice"), ["added member alice to trip"])
    t.ok("member", "add", "trip", "bob")
    t.ok("expense", "trip", "alice", "5", "Coffee")
    eq(t.ok("group", "list"), ["Flat-2 USD members=0 entries=0", "apt_9 GBP members=0 entries=0",
                               "trip EUR members=2 entries=1"])


@test
def group_duplicates(t):
    t.trip()
    t.fails(1, "group", "add", "trip", "USD", msg="error: group already exists: trip")
    t.fails(1, "member", "add", "trip", "bob", msg="error: member already exists: bob")
    t.ok("member", "add", "trip", "Bob")


@test
def group_unknown(t):
    t.fails(1, "member", "add", "nope", "alice", msg="error: unknown group: nope")
    t.fails(1, "balances", "nope", msg="error: unknown group: nope")
    t.fails(1, "list", "nope", msg="error: unknown group: nope")


@test
def group_invalid_values(t):
    t.fails(1, "group", "add", "trip", "eur")
    t.fails(1, "group", "add", "trip", "EURO")
    t.fails(1, "group", "add", "9trip", "EUR")
    t.fails(1, "group", "add", "a" * 33, "EUR")
    t.ok("group", "add", "a" * 32, "EUR")
    t.ok("group", "add", "trip", "EUR")
    t.fails(1, "member", "add", "trip", "al ice")
    t.fails(1, "member", "add", "trip", "-x")


# ---------------- expenses ----------------

@test
def expense_add_list_show(t):
    t.trip()
    eq(t.ok("expense", "trip", "alice", "30", "Dinner at Luigi's"), ["added expense #1: 30.00 EUR"])
    eq(t.ok("pay", "trip", "bob", "alice", "4.5"), ["added payment #2: 4.50 EUR"])
    eq(t.ok("list", "trip"), ['#1 expense alice 30.00 EUR "Dinner at Luigi\'s"', "#2 payment bob -> alice 4.50 EUR"])
    eq(t.ok("show", "trip", "1"), ['#1 expense alice 30.00 EUR "Dinner at Luigi\'s"', "  alice 10.00",
                                   "  bob 10.00", "  carol 10.00"])
    eq(t.ok("show", "trip", "2"), ["#2 payment bob -> alice 4.50 EUR"])


@test
def expense_rm_ids_not_reused(t):
    t.trip()
    t.ok("expense", "trip", "alice", "3", "A")
    t.ok("expense", "trip", "bob", "6", "B")
    eq(t.ok("rm", "trip", "2"), ["removed #2"])
    eq(t.ok("expense", "trip", "carol", "9", "C"), ["added expense #3: 9.00 EUR"])
    eq(t.ok("list", "trip"), ['#1 expense alice 3.00 EUR "A"', '#3 expense carol 9.00 EUR "C"'])
    t.fails(1, "rm", "trip", "2", msg="error: unknown entry: 2")
    t.fails(1, "show", "trip", "7", msg="error: unknown entry: 7")


@test
def expense_ids_per_group(t):
    t.trip()
    t.ok("group", "add", "flat", "EUR")
    t.ok("member", "add", "flat", "zoe")
    t.ok("expense", "trip", "alice", "3", "A")
    eq(t.ok("expense", "flat", "zoe", "3", "B"), ["added expense #1: 3.00 EUR"])


@test
def expense_invalid_amounts(t):
    t.trip()
    for bad in ("0", "0.00", "-3", "1.234", "1e3", ".5", "abc", "1000000.01", "12,50"):
        t.fails(1, "expense", "trip", "alice", bad, "x")
    eq(t.ok("expense", "trip", "alice", "1000000", "big"), ["added expense #1: 1000000.00 EUR"])
    eq(t.ok("expense", "trip", "alice", "12.5", "x"), ["added expense #2: 12.50 EUR"])


@test
def expense_rejections(t):
    t.trip()
    t.fails(1, "expense", "trip", "dave", "10", "x", msg="error: unknown member: dave")
    t.fails(1, "expense", "trip", "alice", "10", "x", "--among", "alice,dave", msg="error: unknown member: dave")
    t.fails(1, "expense", "trip", "alice", "10", "")
    t.fails(1, "pay", "trip", "alice", "alice", "10")
    t.fails(1, "pay", "trip", "alice", "zed", "10", msg="error: unknown member: zed")
    eq(t.ok("list", "trip"), [])


# ---------------- splitting ----------------

@test
def split_equal_remainder_order(t):
    t.trip()
    t.ok("expense", "trip", "alice", "10", "x")
    eq(t.shares(1), ["alice 3.34", "bob 3.33", "carol 3.33"])
    t.ok("expense", "trip", "alice", "0.05", "x", "--among", "carol,bob,alice")
    eq(t.shares(2), ["carol 0.02", "bob 0.02", "alice 0.01"])


@test
def split_equal_subset_payer_not_included(t):
    t.trip()
    t.ok("expense", "trip", "alice", "7", "x", "--among", "bob,carol")
    eq(t.shares(1), ["bob 3.50", "carol 3.50"])
    eq(t.ok("balances", "trip"), ["alice +7.00 EUR", "bob -3.50 EUR", "carol -3.50 EUR"])


@test
def split_default_is_current_members(t):
    t.trip("alice", "bob")
    t.ok("expense", "trip", "alice", "10", "x")
    t.ok("member", "add", "trip", "carol")
    t.ok("expense", "trip", "alice", "10", "y")
    eq(t.shares(1), ["alice 5.00", "bob 5.00"])
    eq(t.shares(2), ["alice 3.34", "bob 3.33", "carol 3.33"])


@test
def split_exact(t):
    t.trip()
    t.ok("expense", "trip", "alice", "20", "x", "--split", "exact", "--shares", "carol=12.5,alice=7.50")
    eq(t.shares(1), ["carol 12.50", "alice 7.50"])
    t.fails(1, "expense", "trip", "alice", "20", "x", "--split", "exact", "--shares", "carol=12.5,alice=7.49")
    t.fails(1, "expense", "trip", "alice", "20", "x", "--split", "exact", "--shares", "carol=20,alice=0")


@test
def split_percent_largest_remainder(t):
    t.trip()
    t.ok("expense", "trip", "alice", "10", "x", "--split", "percent", "--shares", "alice=33.33,bob=33.33,carol=33.34")
    eq(t.shares(1), ["alice 3.33", "bob 3.33", "carol 3.34"])
    t.ok("expense", "trip", "alice", "0.10", "x", "--split", "percent", "--shares", "bob=12.5,carol=37.5,alice=50")
    eq(t.shares(2), ["bob 0.01", "carol 0.04", "alice 0.05"])
    t.ok("expense", "trip", "alice", "1", "x", "--split", "percent", "--shares", "alice=0.5,bob=0.5,carol=99")
    eq(t.shares(3), ["alice 0.01", "bob 0.00", "carol 0.99"])


@test
def split_percent_must_total_100(t):
    t.trip()
    t.fails(1, "expense", "trip", "alice", "10", "x", "--split", "percent", "--shares", "alice=50,bob=49.99")
    t.fails(1, "expense", "trip", "alice", "10", "x", "--split", "percent", "--shares", "alice=50,bob=50.001")
    t.fails(1, "expense", "trip", "alice", "10", "x", "--split", "percent", "--shares", "alice=150,bob=-50")
    eq(t.ok("list", "trip"), [])


@test
def split_duplicate_participant(t):
    t.trip()
    t.fails(1, "expense", "trip", "alice", "10", "x", "--among", "bob,bob",
            msg="error: duplicate participant: bob")
    t.fails(1, "expense", "trip", "alice", "10", "x", "--split", "exact", "--shares", "bob=5,bob=5",
            msg="error: duplicate participant: bob")


@test
def split_sums_to_total(t):
    names = [f"m{i}" for i in range(7)]
    t.trip(*names)
    amounts = ["0.01", "0.06", "100", "33.33", "999.99", "1.07"]
    for i, a in enumerate(amounts, 1):
        t.ok("expense", "trip", "m0", a, "x")
        total = sum(int(round(float(s.split()[1]) * 100)) for s in t.shares(i))
        eq(total, int(round(float(a) * 100)), f"shares of {a}")
    t.ok("expense", "trip", "m0", "1", "x", "--split", "percent", "--shares", ",".join(f"{n}=14.28" for n in names[:6]) + ",m6=14.32")
    eq(t.shares(7), ["m0 0.15", "m1 0.14", "m2 0.14", "m3 0.14", "m4 0.14", "m5 0.14", "m6 0.15"])


# ---------------- currencies ----------------

@test
def fx_bankers_rounding(t):
    t.trip()
    eq(t.ok("rate", "set", "trip", "USD", "0.5"), ["rate USD->EUR 0.5"])
    eq(t.ok("expense", "trip", "alice", "10.25", "x", "--currency", "USD"), ["added expense #1: 5.12 EUR"])
    eq(t.ok("expense", "trip", "alice", "10.35", "x", "--currency", "USD"), ["added expense #2: 5.18 EUR"])
    t.ok("rate", "set", "trip", "JPY", "0.006125")
    eq(t.ok("expense", "trip", "alice", "1000", "x", "--currency", "JPY"), ["added expense #3: 6.12 EUR"])
    eq(t.ok("list", "trip")[0], '#1 expense alice 10.25 USD = 5.12 EUR "x"')


@test
def fx_missing_rate(t):
    t.trip()
    t.fails(1, "expense", "trip", "alice", "10", "x", "--currency", "USD", msg="error: no rate for currency: USD")
    t.fails(1, "pay", "trip", "alice", "bob", "10", "--currency", "GBP", msg="error: no rate for currency: GBP")
    t.fails(1, "rate", "set", "trip", "EUR", "1")
    t.fails(1, "rate", "set", "trip", "USD", "0")
    t.fails(1, "rate", "set", "trip", "USD", "1.1234567")
    t.fails(1, "rate", "set", "trip", "usd", "1.1")


@test
def fx_rate_change_keeps_history(t):
    t.trip()
    t.ok("rate", "set", "trip", "USD", "0.9")
    t.ok("expense", "trip", "alice", "30", "x", "--currency", "USD")
    eq(t.ok("rate", "set", "trip", "USD", "2.000"), ["rate USD->EUR 2.000"])
    t.ok("expense", "trip", "bob", "1", "y", "--currency", "USD")
    eq(t.ok("list", "trip"), ['#1 expense alice 30.00 USD = 27.00 EUR "x"', '#2 expense bob 1.00 USD = 2.00 EUR "y"'])


@test
def fx_exact_split_in_foreign_currency(t):
    t.trip()
    t.ok("rate", "set", "trip", "USD", "0.92")
    t.ok("expense", "trip", "alice", "30", "x", "--currency", "USD", "--split", "exact", "--shares", "alice=10,bob=20")
    eq(t.shares(1), ["alice 9.20", "bob 18.40"])
    t.ok("rate", "set", "trip", "CHF", "1.07")
    t.ok("expense", "trip", "alice", "10", "x", "--currency", "CHF", "--split", "exact", "--shares", "alice=3.33,bob=3.33,carol=3.34")
    eq(t.shares(2), ["alice 3.56", "bob 3.56", "carol 3.58"])


@test
def fx_payment_conversion(t):
    t.trip()
    t.ok("rate", "set", "trip", "USD", "0.5")
    eq(t.ok("pay", "trip", "bob", "alice", "0.25", "--currency", "USD"), ["added payment #1: 0.12 EUR"])
    eq(t.ok("list", "trip"), ["#1 payment bob -> alice 0.25 USD = 0.12 EUR"])
    eq(t.ok("balances", "trip"), ["alice -0.12 EUR", "bob +0.12 EUR", "carol 0.00 EUR"])


# ---------------- balances ----------------

@test
def balance_basic(t):
    t.trip()
    t.ok("expense", "trip", "alice", "30", "x")
    eq(t.ok("balances", "trip"), ["alice +20.00 EUR", "bob -10.00 EUR", "carol -10.00 EUR"])


@test
def balance_payments_and_rm(t):
    t.trip()
    t.ok("expense", "trip", "alice", "30", "x")
    t.ok("pay", "trip", "bob", "alice", "10")
    eq(t.ok("balances", "trip"), ["alice +10.00 EUR", "bob 0.00 EUR", "carol -10.00 EUR"])
    t.ok("rm", "trip", "1")
    eq(t.ok("balances", "trip"), ["alice -10.00 EUR", "bob +10.00 EUR", "carol 0.00 EUR"])


@test
def balance_sum_zero_and_member_order(t):
    t.trip("zed", "amy", "Kim")
    t.ok("expense", "trip", "amy", "10", "x")
    t.ok("expense", "trip", "Kim", "0.07", "y", "--among", "zed,amy")
    out = t.ok("balances", "trip")
    eq([l.split()[0] for l in out], ["zed", "amy", "Kim"])
    eq(out, ["zed -3.38 EUR", "amy +6.64 EUR", "Kim -3.26 EUR"])


# ---------------- settle ----------------

@test
def settle_all_settled(t):
    t.trip()
    eq(t.ok("settle", "trip"), ["all settled"])
    t.ok("expense", "trip", "alice", "9", "x")
    t.ok("pay", "trip", "bob", "alice", "3")
    t.ok("pay", "trip", "carol", "alice", "3")
    eq(t.ok("settle", "trip"), ["all settled"])


@test
def settle_exact_matches_first(t):
    t.trip("a", "b", "c", "d")
    t.ok("expense", "trip", "a", "10", "x", "--split", "exact", "--shares", "d=10")
    t.ok("expense", "trip", "b", "5", "x", "--split", "exact", "--shares", "c=5")
    eq(t.ok("settle", "trip"), ["c -> b 5.00 EUR", "d -> a 10.00 EUR"])


@test
def settle_greedy(t):
    t.trip("a", "b", "c", "d")
    t.ok("expense", "trip", "a", "30", "x", "--split", "exact", "--shares", "c=25,d=5")
    t.ok("expense", "trip", "b", "10", "x", "--split", "exact", "--shares", "d=10")
    eq(t.ok("settle", "trip"), ["c -> a 25.00 EUR", "d -> b 10.00 EUR", "d -> a 5.00 EUR"])


@test
def settle_ties_member_order(t):
    t.trip("a", "b", "c")
    t.ok("expense", "trip", "c", "30", "x", "--among", "a,b")
    eq(t.ok("settle", "trip"), ["a -> c 15.00 EUR", "b -> c 15.00 EUR"])
    t.ok("group", "add", "g2", "USD")
    for m in ("p", "q", "r", "s"):
        t.ok("member", "add", "g2", m)
    t.ok("expense", "g2", "q", "12", "x", "--split", "exact", "--shares", "p=7,s=5")
    t.ok("expense", "g2", "r", "7", "x", "--split", "exact", "--shares", "s=7")
    # balances p -7, q +12, r +7, s -12: exact matches p->r, s->q
    eq(t.ok("settle", "g2"), ["p -> r 7.00 USD", "s -> q 12.00 USD"])


@test
def settle_then_pay_clears(t):
    t.trip("a", "b", "c", "d", "e")
    t.ok("expense", "trip", "a", "100", "x")
    t.ok("expense", "trip", "b", "33.33", "y", "--among", "c,d,e")
    t.ok("expense", "trip", "e", "17", "z", "--split", "percent", "--shares", "a=10,b=90")
    lines = t.ok("settle", "trip")
    assert 1 <= len(lines) <= 4, lines
    for line in lines:
        debtor, arrow, creditor, amount, cur = line.split()
        eq((arrow, cur), ("->", "EUR"), line)
        t.ok("pay", "trip", debtor, creditor, amount)
    eq(t.ok("settle", "trip"), ["all settled"])
    eq(set(l.split()[1] for l in t.ok("balances", "trip")), {"0.00"})


# ---------------- persistence ----------------

@test
def persist_json_and_atomic(t):
    t.trip()
    t.ok("expense", "trip", "alice", "30", "x")
    with open(t.data, encoding="utf-8") as f:
        json.load(f)
    eq(sorted(os.listdir(t.root)), ["data.json"], "files in data directory")


@test
def persist_missing_file_reads(t):
    eq(t.ok("group", "list"), [])
    assert not os.path.exists(t.data), "read-only command created the data file"


@test
def persist_unchanged_on_error(t):
    t.trip()
    t.ok("expense", "trip", "alice", "30", "x")
    before = open(t.data, "rb").read()
    t.fails(1, "expense", "trip", "alice", "30", "x", "--among", "alice,nobody")
    t.fails(1, "group", "add", "trip", "EUR")
    t.fails(2, "expense", "trip", "alice", "30", "x", "--weird", "1")
    eq(open(t.data, "rb").read(), before, "data file bytes")


@test
def persist_corrupt_file(t):
    with open(t.data, "w") as f:
        f.write("{ this is not json")
    r = t.fails(3, "group", "list")
    t.fails(3, "group", "add", "trip", "EUR")
    eq(open(t.data).read(), "{ this is not json", "corrupt file left alone")


@test
def persist_unicode_description(t):
    t.trip()
    t.ok("expense", "trip", "alice", "12", "Café \"Zürich\" 🍕")
    eq(t.ok("list", "trip"), ['#1 expense alice 12.00 EUR "Café "Zürich" 🍕"'])


NEEDS_TMP = {"cli_help", "cli_data_env_and_default"}


def main():
    for fn in TESTS:
        tmp = tempfile.mkdtemp(prefix="tally-hidden-")
        try:
            fn(tmp if fn.__name__ in NEEDS_TMP else T(tmp))
            print(f"PASS {fn.__name__}", flush=True)
        except Exception as e:  # noqa: BLE001
            msg = str(e) or traceback.format_exc(limit=1)
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {msg[:300]!r}", flush=True)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
