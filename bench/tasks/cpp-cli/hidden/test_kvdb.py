#!/usr/bin/env python3
"""Black-box tests for kvdb. Usage: test_kvdb.py /path/to/kvdb
Prints one line per test: `PASS <name>` or `FAIL <name>: <reason>`."""
import os
import shutil
import subprocess
import sys
import tempfile
import traceback

BIN = os.path.abspath(sys.argv[1])
TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


class R:
    def __init__(self, p):
        self.code, self.out, self.err = p.returncode, p.stdout, p.stderr


def run(*args):
    p = subprocess.run([BIN, *args], capture_output=True, timeout=15)
    return R(p)


class DB:
    def __init__(self, root):
        self.dir = os.path.join(root, "db")
        self.log = os.path.join(self.dir, "data.log")

    def __call__(self, *args):
        return run("--db", self.dir, *args)

    def ok(self, *args):
        r = self(*args)
        assert r.code == 0, f"{args}: exit {r.code}, stderr {r.err!r}"
        return r

    def get(self, key):
        return self("get", key)

    def stats(self):
        r = self.ok("stats")
        lines = r.out.decode().split("\n")
        assert lines[-1] == "" and len(lines) == 4, f"stats output {r.out!r}"
        out = {}
        for line, name in zip(lines, ("keys", "records", "log_bytes")):
            k, _, v = line.partition(": ")
            assert k == name and v.isdigit(), f"stats line {line!r}"
            out[k] = int(v)
        return out

    def size(self):
        return os.path.getsize(self.log)


def eq(a, b, msg=""):
    assert a == b, f"{msg} expected {b!r}, got {a!r}"


def not_found(r, key):
    eq(r.code, 1, "exit code")
    eq(r.out, b"", "stdout")
    eq(r.err.rstrip(b"\n"), b"error: key not found: " + key.encode(), "stderr")


def usage(r):
    eq(r.code, 2, "exit code")
    eq(r.out, b"", "stdout")
    assert r.err.startswith(b"error: "), f"stderr {r.err!r}"


# ---------------- basic set/get ----------------

@test
def basic_set_get(db):
    eq(db.ok("set", "alpha", "1").out, b"OK\n")
    eq(db.ok("get", "alpha").out, b"1\n")


@test
def basic_overwrite(db):
    db.ok("set", "k", "first")
    db.ok("set", "k", "second")
    eq(db.ok("get", "k").out, b"second\n")


@test
def basic_get_missing(db):
    db.ok("set", "a", "1")
    not_found(db.get("zzz"), "zzz")


@test
def basic_get_on_fresh_db(db):
    not_found(db.get("nothing"), "nothing")


@test
def basic_values_literal(db):
    vals = {"sp": "hello big world", "eq": "a=b=c", "tab": "x\ty", "utf": "héllo wörld ✓",
            "dash": "--x", "neg": "-5", "empty": ""}
    for k, v in vals.items():
        db.ok("set", k, v)
    for k, v in vals.items():
        eq(db.ok("get", k).out, v.encode() + b"\n", k)


@test
def basic_key_limits(db):
    db.ok("set", "k" * 256, "v")
    eq(db.ok("get", "k" * 256).out, b"v\n")
    db.ok("set", "ключ/é:1", "u")
    eq(db.ok("get", "ключ/é:1").out, b"u\n")


@test
def basic_large_value(db):
    v = "x" * 65536
    db.ok("set", "big", v)
    eq(db.ok("get", "big").out, v.encode() + b"\n")


# ---------------- delete ----------------

@test
def del_removes_key(db):
    db.ok("set", "a", "1")
    db.ok("set", "b", "2")
    eq(db.ok("del", "a").out, b"OK\n")
    not_found(db.get("a"), "a")
    eq(db.ok("get", "b").out, b"2\n")


@test
def del_missing_writes_nothing(db):
    db.ok("set", "a", "1")
    before = db.size()
    not_found(db("del", "ghost"), "ghost")
    eq(db.size(), before, "log size")
    eq(db.stats()["records"], 1, "records")


@test
def del_twice(db):
    db.ok("set", "a", "1")
    db.ok("del", "a")
    not_found(db("del", "a"), "a")


@test
def del_then_set_again(db):
    db.ok("set", "a", "1")
    db.ok("del", "a")
    db.ok("set", "a", "2")
    eq(db.ok("get", "a").out, b"2\n")


# ---------------- scan ----------------

def fill(db, keys):
    for k in keys:
        db.ok("set", k, "v-" + k)


@test
def scan_all_sorted(db):
    fill(db, ["pear", "apple", "fig", "banana"])
    eq(db.ok("scan").out, b"apple\tv-apple\nbanana\tv-banana\nfig\tv-fig\npear\tv-pear\n")


@test
def scan_byte_order(db):
    fill(db, ["é", "a", "Z", "aa", "_", "1"])
    keys = [l.split(b"\t")[0] for l in db.ok("scan").out.splitlines()]
    eq(keys, [k.encode() for k in ["1", "Z", "_", "a", "aa", "é"]])


@test
def scan_prefix(db):
    fill(db, ["user:2", "user:1", "users", "uses", "admin:1"])
    eq(db.ok("scan", "--prefix", "user:").out, b"user:1\tv-user:1\nuser:2\tv-user:2\n")


@test
def scan_limit(db):
    fill(db, ["c", "a", "b", "d"])
    eq(db.ok("scan", "--limit", "2").out, b"a\tv-a\nb\tv-b\n")
    eq(db.ok("scan", "--limit", "10").out.count(b"\n"), 4)


@test
def scan_prefix_and_limit_any_order(db):
    fill(db, ["x1", "x2", "x3", "y1"])
    exp = b"x1\tv-x1\nx2\tv-x2\n"
    eq(db.ok("scan", "--prefix", "x", "--limit", "2").out, exp)
    eq(db.ok("scan", "--limit", "2", "--prefix", "x").out, exp)


@test
def scan_no_match_and_empty(db):
    eq(db.ok("scan").out, b"")
    fill(db, ["a"])
    eq(db.ok("scan", "--prefix", "zz").out, b"")


@test
def scan_excludes_deleted_and_shows_latest(db):
    fill(db, ["a", "b", "c"])
    db.ok("del", "b")
    db.ok("set", "c", "new")
    eq(db.ok("scan").out, b"a\tv-a\nc\tnew\n")


@test
def scan_value_with_tab(db):
    db.ok("set", "k", "x\ty")
    eq(db.ok("scan").out, b"k\tx\ty\n")


# ---------------- persistence / log format ----------------

@test
def persist_creates_nested_dir(tmp):
    d = os.path.join(tmp, "a", "b", "c")
    r = run("--db", d, "set", "k", "v")
    eq(r.code, 0, "exit")
    assert os.path.isfile(os.path.join(d, "data.log")), "data.log missing"
    eq(run("--db", d, "get", "k").out, b"v\n")


@test
def persist_only_data_log(db):
    fill(db, ["a", "b"])
    db.ok("del", "a")
    eq(sorted(os.listdir(db.dir)), ["data.log"])


@test
def persist_append_only(db):
    db.ok("set", "a", "1")
    first = open(db.log, "rb").read()
    db.ok("set", "b", "2")
    db.ok("del", "a")
    after = open(db.log, "rb").read()
    assert len(after) > len(first) and after.startswith(first), "earlier bytes were modified"


@test
def persist_reads_dont_modify(db):
    fill(db, ["a", "b"])
    before = open(db.log, "rb").read()
    db.ok("get", "a")
    db.ok("scan")
    db.stats()
    db.get("missing")
    eq(open(db.log, "rb").read(), before, "log content")


@test
def persist_many_keys(db):
    keys = [f"key{i:03d}" for i in range(120)]
    for i, k in enumerate(keys):
        db.ok("set", k, str(i))
    eq(db.ok("get", "key077").out, b"77\n")
    eq(db.ok("scan", "--prefix", "key1").out.count(b"\n"), 20)
    eq(db.stats()["keys"], 120)


# ---------------- stats ----------------

@test
def stats_empty(db):
    eq(db.ok("stats").out, b"keys: 0\nrecords: 0\nlog_bytes: 0\n")


@test
def stats_counts(db):
    db.ok("set", "a", "1")
    db.ok("set", "b", "2")
    db.ok("set", "a", "3")
    db.ok("del", "b")
    s = db.stats()
    eq(s["keys"], 1, "keys")
    eq(s["records"], 4, "records")
    eq(s["log_bytes"], db.size(), "log_bytes")


@test
def stats_log_bytes_grow(db):
    db.ok("set", "a", "1")
    s1 = db.stats()["log_bytes"]
    db.ok("set", "a", "1" * 100)
    s2 = db.stats()["log_bytes"]
    assert s2 - s1 >= 100, f"log_bytes {s1} -> {s2}"
    eq(s2, db.size(), "log_bytes vs file size")


# ---------------- compaction ----------------

def churn(db):
    for i in range(10):
        db.ok("set", "hot", f"value-{i}")
    db.ok("set", "keep", "kept value")
    db.ok("set", "gone", "x")
    db.ok("del", "gone")


@test
def compact_shrinks_and_preserves(db):
    churn(db)
    before = db.stats()
    r = db.ok("compact")
    after = db.size()
    eq(r.out, f"compacted {before['log_bytes']} -> {after} bytes\n".encode())
    assert after < before["log_bytes"], "log did not shrink"
    eq(db.ok("get", "hot").out, b"value-9\n")
    eq(db.ok("get", "keep").out, b"kept value\n")
    not_found(db.get("gone"), "gone")


@test
def compact_stats_after(db):
    churn(db)
    db.ok("compact")
    s = db.stats()
    eq(s["keys"], 2, "keys")
    eq(s["records"], 2, "records")
    eq(s["log_bytes"], db.size(), "log_bytes")


@test
def compact_no_leftover_files(db):
    churn(db)
    db.ok("compact")
    eq(sorted(os.listdir(db.dir)), ["data.log"])


@test
def compact_idempotent(db):
    churn(db)
    db.ok("compact")
    size = db.size()
    eq(db.ok("compact").out, f"compacted {size} -> {size} bytes\n".encode())
    eq(db.size(), size)


@test
def compact_then_write(db):
    churn(db)
    db.ok("compact")
    db.ok("set", "new", "n")
    db.ok("del", "keep")
    eq(db.ok("scan").out, b"hot\tvalue-9\nnew\tn\n")
    eq(db.stats()["records"], 4)


@test
def compact_empty(db):
    eq(db.ok("compact").out, b"compacted 0 -> 0 bytes\n")
    db.ok("set", "a", "1")
    db.ok("del", "a")
    db.ok("compact")
    eq(db.stats(), {"keys": 0, "records": 0, "log_bytes": 0})


# ---------------- crash recovery ----------------

def three_records(db):
    """Write a, b, c; return file sizes after each set."""
    sizes = []
    for k, v in (("a", "1"), ("b", "2"), ("c", "33333")):
        db.ok("set", k, v)
        sizes.append(db.size())
    return sizes


def truncate(path, n):
    with open(path, "r+b") as f:
        f.truncate(n)


@test
def recovery_truncated_tail_ignored(db):
    s = three_records(db)
    truncate(db.log, s[2] - 1)
    not_found(db.get("c"), "c")
    eq(db.ok("get", "b").out, b"2\n")
    st = db.stats()
    eq((st["keys"], st["records"], st["log_bytes"]), (2, 2, s[1]))


@test
def recovery_truncated_mid_header(db):
    s = three_records(db)
    truncate(db.log, s[1] + 2)
    eq(db.ok("scan").out, b"a\t1\nb\t2\n")


@test
def recovery_garbage_appended(db):
    s = three_records(db)
    with open(db.log, "ab") as f:
        f.write(b"\x07garbage\xff\xfe\x00\x01 not a record at all \x00" * 3)
    eq(db.ok("scan").out, b"a\t1\nb\t2\nc\t33333\n")
    eq(db.stats()["log_bytes"], s[2])


@test
def recovery_corrupt_last_record(db):
    s = three_records(db)
    data = bytearray(open(db.log, "rb").read())
    data[s[2] - 2] ^= 0x5A  # damage a byte inside the last record (same length)
    open(db.log, "wb").write(bytes(data))
    not_found(db.get("c"), "c")
    eq(db.stats()["records"], 2)


@test
def recovery_corrupt_middle_stops_reading(db):
    s = three_records(db)
    data = bytearray(open(db.log, "rb").read())
    data[s[1] - 1] ^= 0x01  # damage the end of record b
    open(db.log, "wb").write(bytes(data))
    eq(db.ok("scan").out, b"a\t1\n")
    eq(db.stats()["log_bytes"], s[0])


@test
def recovery_reads_leave_tail(db):
    s = three_records(db)
    truncate(db.log, s[2] - 1)
    db.get("a")
    db.ok("scan")
    db.stats()
    eq(db.size(), s[2] - 1, "read-only commands must not modify data.log")


@test
def recovery_write_after_torn_tail(db):
    s = three_records(db)
    truncate(db.log, s[2] - 3)
    db.ok("set", "d", "4")
    eq(db.ok("scan").out, b"a\t1\nb\t2\nd\t4\n")
    st = db.stats()
    eq(st["records"], 3, "records")
    eq(db.size(), st["log_bytes"], "file size vs log_bytes")


@test
def recovery_del_after_garbage(db):
    three_records(db)
    with open(db.log, "ab") as f:
        f.write(b"\xde\xad\xbe\xef" * 5)
    db.ok("del", "a")
    db.ok("set", "e", "5")
    eq(db.ok("scan").out, b"b\t2\nc\t33333\ne\t5\n")
    eq(db.size(), db.stats()["log_bytes"])


@test
def recovery_compact_after_torn_tail(db):
    s = three_records(db)
    truncate(db.log, s[2] - 1)
    eq(db.ok("compact").out, f"compacted {s[1]} -> {db.size()} bytes\n".encode())
    eq(db.ok("scan").out, b"a\t1\nb\t2\n")
    eq(db.stats()["records"], 2)


# ---------------- command line ----------------

@test
def cli_help(tmp):
    for flag in ("--help", "-h"):
        r = run(flag)
        eq(r.code, 0, flag)
        assert r.out.startswith(b"usage: kvdb"), r.out[:40]


@test
def cli_usage_errors(db):
    cases = [
        [],
        ["get", "a"],
        ["--db"],
        ["--db", db.dir],
        ["--db", db.dir, "frobnicate"],
        ["--db", db.dir, "set", "k"],
        ["--db", db.dir, "set", "k", "v", "extra"],
        ["--db", db.dir, "get"],
        ["--db", db.dir, "get", "a", "b"],
        ["--db", db.dir, "del"],
        ["--db", db.dir, "compact", "now"],
        ["--db", db.dir, "stats", "x"],
    ]
    for c in cases:
        r = run(*c)
        try:
            usage(r)
        except AssertionError as e:
            raise AssertionError(f"{c}: {e}")


@test
def cli_invalid_keys_and_values(db):
    for key in ["", "has space", "tab\there", "nl\nx", "del\x7f", "k" * 257]:
        r = db("set", key, "v")
        try:
            usage(r)
        except AssertionError as e:
            raise AssertionError(f"key {key!r}: {e}")
    for val in ["line1\nline2", "cr\rx", "x" * 65537]:
        usage(db("set", "k", val))
    usage(db("get", "bad key"))
    assert not os.path.exists(db.log) or db.stats()["records"] == 0, "invalid set was written"


@test
def cli_scan_option_errors(db):
    for c in [["--limit", "0"], ["--limit", "-1"], ["--limit", "x"], ["--limit", "3x"],
              ["--limit"], ["--prefix"], ["--bogus", "1"], ["--prefix", "a", "--prefix", "b"],
              ["--limit", "1", "--limit", "2"], ["extra"]]:
        try:
            usage(db("scan", *c))
        except AssertionError as e:
            raise AssertionError(f"scan {c}: {e}")


@test
def cli_db_is_file(tmp):
    f = os.path.join(tmp, "plainfile")
    open(f, "w").write("x")
    for args in (["set", "k", "v"], ["get", "k"], ["stats"]):
        r = run("--db", f, *args)
        eq(r.code, 3, f"{args} exit")
        eq(r.out, b"", "stdout")
        assert r.err.startswith(b"error: "), r.err


@test
def cli_errors_go_to_stderr(db):
    db.ok("set", "a", "1")
    r = db("get", "b")
    eq(r.out, b"")
    r = db("scan", "--limit", "0")
    eq(r.out, b"")


NEEDS_DB = {"cli_help", "persist_creates_nested_dir", "cli_db_is_file"}


def main():
    for fn in TESTS:
        tmp = tempfile.mkdtemp(prefix="kvdb-hidden-")
        try:
            fn(tmp if fn.__name__ in NEEDS_DB else DB(tmp))
            print(f"PASS {fn.__name__}", flush=True)
        except Exception as e:  # noqa: BLE001
            msg = str(e) or traceback.format_exc(limit=1)
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {msg[:300]!r}", flush=True)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
