#!/usr/bin/env python3
"""Black-box tests for csvq. Usage: test_csvq.py /path/to/csvq
Prints one line per test: `PASS <name>` or `FAIL <name>: <reason>`.
With CSVQ_SANITIZE=1 every run also fails on AddressSanitizer/UBSan reports."""
import os
import shutil
import subprocess
import sys
import tempfile
import traceback

BIN = os.path.abspath(sys.argv[1])
SANITIZE = os.environ.get("CSVQ_SANITIZE") == "1"
TESTS = []
TMP = None


def test(fn):
    TESTS.append(fn)
    return fn


class R:
    def __init__(self, p):
        self.code, self.out, self.err = p.returncode, p.stdout.decode(errors="replace"), \
            p.stderr.decode(errors="replace")


def run(*args, stdin=None):
    data = stdin.encode() if isinstance(stdin, str) else stdin
    p = subprocess.run([BIN, *args], input=data if data is not None else b"",
                       capture_output=True, timeout=20)
    r = R(p)
    if SANITIZE:
        for marker in ("AddressSanitizer", "runtime error:", "LeakSanitizer", "UndefinedBehavior"):
            assert marker not in r.err, f"sanitizer report: {r.err[:400]!r}"
    return r


def write(name, text, mode="w"):
    path = os.path.join(TMP, name)
    with open(path, mode, newline="" if mode == "w" else None) as f:
        f.write(text)
    return path


def q(text, *args):
    """Run csvq with `text` as a file argument and expect success; return stdout."""
    path = write("in.csv", text)
    r = run(path, *args)
    assert r.code == 0, f"{args}: exit {r.code}, stderr {r.err!r}"
    assert r.err == "", f"unexpected stderr {r.err!r}"
    return r.out


def eq(a, b, msg=""):
    assert a == b, f"{msg} expected {b!r}, got {a!r}"


def usage(r, msg=None):
    eq(r.code, 2, f"exit code (stderr {r.err!r})")
    eq(r.out, "", "stdout")
    assert r.err.startswith("error: "), f"stderr {r.err!r}"
    if msg is not None:
        eq(r.err.rstrip("\n"), msg, "stderr")


def input_error(r, msg=None, prefix=None):
    eq(r.code, 3, f"exit code (stderr {r.err!r})")
    eq(r.out, "", "stdout")
    assert r.err.startswith("error: "), f"stderr {r.err!r}"
    if msg is not None:
        eq(r.err.rstrip("\n"), msg, "stderr")
    if prefix is not None:
        assert r.err.startswith(prefix), f"stderr {r.err!r} should start with {prefix!r}"


SALES = ("region,rep,amount,note\n"
         "north,ann,120.5,\n"
         "south,bob,80,repeat\n"
         "north,cid,40,new\n"
         "east,dee,n/a,\n"
         "south,eve,200,new customer\n")

PEOPLE = ("name,age,city\n"
          "ann,31,Paris\n"
          "bob,9,Berlin\n"
          "cid,100,Paris\n"
          "dan,25,Rome\n")


# ---------------- parsing (RFC 4180) ----------------

@test
def parse_passthrough():
    eq(q(PEOPLE), PEOPLE)


@test
def parse_quoted_fields():
    text = 'a,b\n"x, y","he said ""hi"""\n"multi\nline",plain\n'
    eq(q(text, "--select", "b,a"), 'b,a\n"he said ""hi""","x, y"\nplain,"multi\nline"\n')


@test
def parse_crlf_and_no_final_newline():
    eq(q("a,b\r\n1,2\r\n3,4"), "a,b\n1,2\n3,4\n")


@test
def parse_empty_lines_and_bom():
    eq(q("\ufeffid,v\n\n1,x\n\n\n2,y\n"), "id,v\n1,x\n2,y\n")


@test
def parse_empty_fields():
    eq(q('a,b,c\n,,\n"",x,\n'), "a,b,c\n,,\n,x,\n")


@test
def parse_stdin_and_dash():
    r = run("--select", "name", stdin=PEOPLE)
    eq((r.code, r.out), (0, "name\nann\nbob\ncid\ndan\n"))
    r = run("-", "--limit", "1", stdin=PEOPLE)
    eq((r.code, r.out), (0, "name,age,city\nann,31,Paris\n"))


# ---------------- where ----------------

@test
def where_numeric_vs_string():
    eq(q(PEOPLE, "--where", "age > 30", "--select", "name"), "name\nann\ncid\n")
    eq(q(PEOPLE, "--where", "city<Q", "--select", "name"), "name\nann\nbob\ncid\n")


@test
def where_all_operators():
    sel = ("--select", "name")
    eq(q(PEOPLE, "--where", "age=25.0", *sel), "name\ndan\n")
    eq(q(PEOPLE, "--where", "city!=Paris", *sel), "name\nbob\ndan\n")
    eq(q(PEOPLE, "--where", "age<=25", *sel), "name\nbob\ndan\n")
    eq(q(PEOPLE, "--where", "age>=31", *sel), "name\nann\ncid\n")
    eq(q(PEOPLE, "--where", "age<10", *sel), "name\nbob\n")


@test
def where_contains():
    eq(q(SALES, "--where", "note contains new", "--select", "rep"), "rep\ncid\neve\n")
    eq(q(SALES, "--where", "note contains New", "--select", "rep"), "rep\n")


@test
def where_multiple_are_anded():
    eq(q(PEOPLE, "--where", "city = Paris", "--where", "age < 50", "--select", "name"),
       "name\nann\n")


@test
def where_empty_value_and_mixed_types():
    eq(q(SALES, "--where", "note=", "--select", "rep"), "rep\nann\ndee\n")
    # "n/a" is not a number, so it is compared as a string with "100": "n/a" > "100"
    eq(q(SALES, "--where", "amount > 100", "--select", "rep"), "rep\nann\ndee\neve\n")


@test
def where_leftmost_operator():
    text = "k,v\na,x=y\nb,z\n"
    eq(q(text, "--where", "v=x=y"), "k,v\na,x=y\n")


# ---------------- select ----------------

@test
def select_order_and_duplicates():
    eq(q(PEOPLE, "--select", "city, name,city", "--limit", "2"),
       "city,name,city\nParis,ann,Paris\nBerlin,bob,Berlin\n")


@test
def select_duplicate_header_uses_first():
    eq(q("x,x\n1,2\n", "--select", "x"), "x\n1\n")


@test
def select_with_sort_on_unselected():
    eq(q(PEOPLE, "--select", "name", "--sort", "age:desc"), "name\ncid\nann\ndan\nbob\n")


# ---------------- sort ----------------

@test
def sort_numeric_ascending():
    eq(q(PEOPLE, "--sort", "age", "--select", "age"), "age\n9\n25\n31\n100\n")


@test
def sort_strings_bytewise():
    text = "w\nbeta\nAlpha\nalpha\n_x\n"
    eq(q(text, "--sort", "w"), "w\nAlpha\n_x\nalpha\nbeta\n")


@test
def sort_numbers_before_strings():
    text = "v\nzz\n10\n\n-2.5\nabc\n3\n"
    # the empty line is skipped; numbers first, then strings
    eq(q(text, "--sort", "v"), "v\n-2.5\n3\n10\nabc\nzz\n")
    eq(q(text, "--sort", "v:desc"), "v\nzz\nabc\n10\n3\n-2.5\n")


@test
def sort_stable_multi_key():
    text = "g,n,id\nb,2,1\na,2,2\nb,1,3\na,2,4\nb,2,5\n"
    eq(q(text, "--sort", "n:desc, g", "--select", "id"), "id\n2\n4\n1\n5\n3\n")


@test
def sort_then_limit():
    eq(q(PEOPLE, "--sort", "age:desc", "--limit", "2", "--select", "name"), "name\ncid\nann\n")
    eq(q(PEOPLE, "--limit", "0"), "name,age,city\n")


# ---------------- aggregation ----------------

@test
def agg_group_by_basic():
    eq(q(SALES, "--group-by", "region", "--agg", "count,sum(amount),avg(amount)"),
       "region,count,sum(amount),avg(amount)\n"
       "north,2,160.5,80.25\nsouth,2,280,140\neast,1,0,\n")


@test
def agg_min_max_skip_non_numeric():
    eq(q(SALES, "--group-by", "region", "--agg", "min(amount),max(amount)"),
       "region,min(amount),max(amount)\nnorth,40,120.5\nsouth,80,200\neast,,\n")


@test
def agg_without_group_by():
    eq(q(SALES, "--agg", "count, avg(amount)"), "count,avg(amount)\n5,110.125\n")
    eq(q(SALES, "--agg", "count,sum(amount),min(amount)", "--where", "region=west"),
       "count,sum(amount),min(amount)\n0,0,\n")


@test
def agg_group_by_distinct_multi():
    text = "a,b,c\nx,1,p\ny,1,q\nx,1,r\nx,2,s\n"
    eq(q(text, "--group-by", "a,b"), "a,b\nx,1\ny,1\nx,2\n")


@test
def agg_sort_by_output_column():
    eq(q(SALES, "--group-by", "region", "--agg", "sum(amount)", "--sort", "sum(amount):desc"),
       "region,sum(amount)\nsouth,280\nnorth,160.5\neast,0\n")
    eq(q(SALES, "--group-by", "region", "--agg", "count", "--sort", "count:desc,region",
         "--limit", "2"), "region,count\nnorth,2\nsouth,2\n")


@test
def agg_number_formatting():
    text = "v\n0.1\n0.2\n1\n-1.3\n"
    eq(q(text, "--agg", "sum(v),avg(v)"), "sum(v),avg(v)\n0,0\n")
    eq(q("v\n1\n1\n2\n", "--agg", "avg(v),sum(v),max(v)"), "avg(v),sum(v),max(v)\n1.333333,4,2\n")
    eq(q("v\n2.50\n+3\n", "--agg", "sum(v),min(v)"), "sum(v),min(v)\n5.5,2.5\n")


@test
def agg_where_applies_before_grouping():
    eq(q(SALES, "--where", "amount>=80", "--where", "amount<1000", "--group-by", "region",
         "--agg", "count"), "region,count\nnorth,1\nsouth,2\n")


# ---------------- output quoting ----------------

@test
def out_quotes_only_when_needed():
    text = 'a,b,c\n"plain",  spaced  ,"has ""q"""\n"cr\r\nlf",x,"com,ma"\n'
    eq(q(text), 'a,b,c\nplain,  spaced  ,"has ""q"""\n"cr\r\nlf",x,"com,ma"\n')


@test
def out_header_quoting():
    text = '"total, eur",k\n5,a\n7,a\n'
    eq(q(text, "--select", "k"), "k\na\na\n")
    eq(q(text), '"total, eur",k\n5,a\n7,a\n')
    eq(q('"he said ""x""",k\n1,a\n', "--group-by", "k", "--agg", "count"), "k,count\na,1\n")


@test
def out_unicode_preserved():
    text = "name,city\nZoë,Kraków\nŁukasz,Zürich\n"
    eq(q(text, "--sort", "name"), "name,city\nZoë,Kraków\nŁukasz,Zürich\n")


# ---------------- errors ----------------

@test
def err_unknown_column_everywhere():
    for args, name in ((["--select", "name,zip"], "zip"), (["--where", "zip=1"], "zip"),
                       (["--sort", "zip:desc"], "zip"), (["--group-by", "zip"], "zip"),
                       (["--agg", "sum(zip)"], "zip"),
                       (["--group-by", "city", "--sort", "age"], "age")):
        r = run(write("p.csv", PEOPLE), *args)
        usage(r, f"error: unknown column: {name}")


@test
def err_unterminated_quote():
    r = run(write("u.csv", 'a,b\n1,2\n3,"open\nmore\n'))
    input_error(r, "error: line 3: unterminated quoted field")


@test
def err_field_count():
    r = run(write("f.csv", 'a,b\n1,2\n\n"x\ny",2,3\n'))
    input_error(r, "error: line 4: expected 2 fields, got 3")
    r = run(write("f2.csv", "a,b,c\n1,2\n"))
    input_error(r, "error: line 2: expected 3 fields, got 2")


@test
def err_stray_quotes():
    input_error(run(write("s.csv", 'a,b\n1,x"y\n')), prefix="error: line 2: ")
    input_error(run(write("s2.csv", 'a,b\n1,2\n"q"x,3\n')), prefix="error: line 3: ")


@test
def err_empty_and_missing_input():
    input_error(run(write("e.csv", "")), "error: empty input")
    input_error(run(write("e2.csv", "\n\r\n\n")), "error: empty input")
    input_error(run(os.path.join(TMP, "does-not-exist.csv")))


@test
def err_malformed_reported_before_unknown_column():
    input_error(run(write("m.csv", 'a\n"x\n'), "--select", "zzz"))


@test
def err_no_partial_output():
    text = "a,b\n" + "".join(f"{i},{i}\n" for i in range(2000)) + "1,2,3\n"
    r = run(write("big.csv", text))
    input_error(r, "error: line 2002: expected 2 fields, got 3")


# ---------------- command line ----------------

@test
def cli_help():
    for flag in ("--help", "-h"):
        r = run(flag)
        eq(r.code, 0, flag)
        assert r.out.startswith("usage: csvq"), r.out[:80]


@test
def cli_bad_options():
    p = write("p.csv", PEOPLE)
    usage(run(p, "--frobnicate", "1"))
    usage(run(p, "--select"))
    usage(run(p, "--limit", "1", "--limit", "2"))
    usage(run(p, p))
    usage(run(p, "--select", "name,,age"))
    usage(run(p, "--select", "name", "--agg", "count"))
    usage(run(p, "--select", "name", "--group-by", "city"))


@test
def cli_invalid_values():
    p = write("p.csv", PEOPLE)
    for v in ("-1", "x", "1.5", ""):
        usage(run(p, "--limit", v), f"error: invalid limit: {v}")
    usage(run(p, "--where", "age"), "error: invalid expression: age")
    usage(run(p, "--where", "=5"), "error: invalid expression: =5")
    for v in ("count(age)", "median(age)", "sum()", "SUM(age)"):
        usage(run(p, "--agg", v), f"error: invalid aggregate: {v}")


@test
def cli_option_errors_before_input():
    usage(run(os.path.join(TMP, "missing.csv"), "--limit", "x"), "error: invalid limit: x")


@test
def cli_options_after_file():
    p = write("p.csv", PEOPLE)
    r = run("--where", "city=Paris", p, "--select", "name")
    eq((r.code, r.out), (0, "name\nann\ncid\n"))


@test
def cli_large_input():
    rows = "".join(f"r{i},{i % 97},{'g' + str(i % 13)}\n" for i in range(60000))
    out = q("id,v,g\n" + rows, "--group-by", "g", "--agg", "count,sum(v)", "--sort", "g",
            "--limit", "2")
    exp_sum = {g: sum(i % 97 for i in range(60000) if i % 13 == g) for g in (0, 1)}
    cnt = {g: len([i for i in range(60000) if i % 13 == g]) for g in (0, 1)}
    eq(out, f"g,count,sum(v)\ng0,{cnt[0]},{exp_sum[0]}\ng1,{cnt[1]},{exp_sum[1]}\n")


def main():
    global TMP
    for fn in TESTS:
        TMP = tempfile.mkdtemp(prefix="csvq-hidden-")
        try:
            fn()
            print(f"PASS {fn.__name__}", flush=True)
        except Exception as e:  # noqa: BLE001
            msg = str(e) or traceback.format_exc(limit=1)
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {msg[:300]!r}", flush=True)
        finally:
            shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    main()
