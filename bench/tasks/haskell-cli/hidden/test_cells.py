#!/usr/bin/env python3
"""Black-box tests for cells. Usage: test_cells.py /path/to/cells
Prints one line per test: `PASS <name>` or `FAIL <name>: <reason>`."""
import os
import shutil
import subprocess
import sys
import tempfile
import traceback

BIN = os.path.abspath(sys.argv[1])
TESTS = []
TMP = None
# Run under the C locale: the program must use UTF-8 regardless.
ENV = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C", "LC_ALL": "C"}


def test(fn):
    TESTS.append(fn)
    return fn


class R:
    def __init__(self, p):
        self.code, self.out, self.err = p.returncode, p.stdout.decode("utf-8", "replace"), p.stderr.decode("utf-8", "replace")


def run(*args, stdin=None):
    p = subprocess.run([BIN, *args], input=stdin, capture_output=True, timeout=20, env=ENV)
    return R(p)


def sheet(text, name="sheet.csv"):
    path = os.path.join(TMP, name)
    with open(path, "wb") as f:
        f.write(text.encode("utf-8") if isinstance(text, str) else text)
    return path


def eq(a, b, msg=""):
    assert a == b, f"{msg} expected {b!r}, got {a!r}"


def ev(text):
    r = run("eval", sheet(text))
    assert r.code == 0, f"eval exit {r.code}, stderr {r.err!r}"
    return r.out


def get(text, cell):
    """Value of one cell via `get` (exit code ignored)."""
    r = run("get", sheet(text), cell)
    assert r.code in (0, 1), f"get exit {r.code}, stderr {r.err!r}"
    assert r.out.endswith("\n") and r.out.count("\n") == 1, f"get output {r.out!r}"
    return r.out[:-1]


def gets(text, cells):
    return [get(text, c) for c in cells]


# ---------------- grid input ----------------

@test
def grid_example_budget():
    text = ("item,qty,price,total\napple,3,0.5,=B2*C2\npear,2,1.25,=B3*C3\n"
            ",,sum,=SUM(D2:D3)\n,,avg,=AVG(D2:D3)&\" each\"\n")
    eq(ev(text), "item,qty,price,total\napple,3,0.5,1.5\npear,2,1.25,2.5\n,,sum,4\n,,avg,2 each\n")


@test
def grid_split_quotes_and_parens():
    text = '1,=SUM(A1, 2),"a,b",x(y,z),=IF(A1>0,"p,q","r")\n'
    eq(ev(text), '1,3,"a,b","x(y,z)","p,q"\n')


@test
def grid_ragged_rows_padded():
    eq(ev("1\n2,3,4\n\n5,6\n"), "1,,\n2,3,4\n,,\n5,6,\n")


@test
def grid_crlf_and_no_final_newline():
    eq(ev("1,2\r\n=A1+B1,x\r\n=A2*2"), "1,2\n3,x\n6,\n")


@test
def grid_number_literals():
    text = "007,-3.50,+1,.5,1.,1e3,-0,  12  ,4.25\n=A1+B1,=E1&\"|\",=COUNT(A1:I1)\n"
    eq(ev(text), '7,-3.5,+1,.5,1.,1e3,0,12,4.25\n3.5,1.|,5,,,,,,\n')


@test
def grid_quoted_fields():
    text = '"42","say ""hi""","",=A1&"!",=LEN\n=A1+1,=C1="",=COUNT(A1:C1)\n'
    eq(gets(text, ["A1", "B1", "C1", "D1", "A2", "B2", "C2"]),
       ["42", 'say "hi"', "", "42!", "#VALUE!", "1", "0"])


@test
def grid_empty_file():
    r = run("eval", sheet(""))
    eq(r.code, 0)
    eq(r.out, "")
    r = run("get", sheet(""), "A1")
    eq(r.code, 2, "get on empty grid")


# ---------------- arithmetic and operators ----------------

@test
def arith_precedence():
    text = "=1+2*3-4/2,=-2*-3,=(1+2)*3,=2-3-4,=8/2/2,=1+2&3*4,=1+1=2,=-B1+10\n"
    eq(gets(text, ["A1", "B1", "C1", "D1", "E1", "F1", "G1", "H1"]),
       ["5", "6", "9", "-5", "2", "312", "1", "4"])


@test
def arith_references_and_case():
    text = "2,3,=a1*B1+b2\n10,=A2/4,=SUM(a1:b2)\n"
    eq(ev(text), "2,3,8.5\n10,2.5,17.5\n")


@test
def arith_spaces_between_tokens():
    eq(gets("= 1 +  2 * A2 , = SUM ( A2 : A2 ) \n4\n", ["A1", "B1"]), ["9", "4"])


@test
def arith_number_format():
    text = "=1/3,=2/3,=10/4,=0.1+0.2,=1000000*1000000*100000000,=-1/3,=7/8,=0-0.0000001,=1/1000000\n"
    eq(ev(text), "0.333333,0.666667,2.5,0.3,100000000000000000000,-0.333333,0.875,0,0.000001\n")


@test
def arith_comparisons():
    text = ('=1<2,=2<=2,=3>4,=3>=4,=1<>1,=2=2,="abc"<"abd",="B"<"a",="a"="a",'
            '=C2=0,=C2="",=C2=C3,="x">C2,=1<2<3\n\n\n')
    eq(ev(text), "1,1,0,0,0,1,1,1,1,1,1,1,1,1\n,,,,,,,,,,,,,\n,,,,,,,,,,,,,\n")


@test
def arith_concat_and_empty():
    text = '=A2&"-"&B2&"-"&C2,=C2,=C2+1,=C2&""\n1.50,x,\n'
    eq(ev(text), '1.5-x-,0,1,""\n1.5,x,,\n')


# ---------------- functions ----------------

@test
def func_sum_avg_min_max():
    text = "4,-2,9,x,\n=SUM(A1:E1),=AVG(A1:E1),=MIN(A1:E1),=MAX(A1:E1),=SUM(A1:A1,B1,10)\n"
    eq(ev(text), "4,-2,9,x,\n11,3.666667,-2,9,12\n")


@test
def func_direct_args_converted():
    text = "x,,3\n=SUM(B1,C1),=AVG(B1,C1),=SUM(A1),=MIN(B1,5),=MAX(-1,-5)\n"
    eq(gets(text, ["A2", "B2", "C2", "D2", "E2"]), ["3", "1.5", "#VALUE!", "0", "-1"])


@test
def func_empty_aggregates():
    text = "a,,b\n=SUM(A1:C1),=MIN(A1:C1),=MAX(A1:C1),=AVG(A1:C1),=COUNT(A1:C1)\n"
    eq(gets(text, ["A2", "B2", "C2", "D2", "E2"]), ["0", "0", "0", "#DIV/0!", "0"])


@test
def func_count():
    text = '1,a,,=2*2\n=COUNT(A1:D1,5,"t",C1,B1),=COUNT(A1:D1)\n'
    eq(gets(text, ["A2", "B2"]), ["3", "2"])


@test
def func_if_lazy_and_values():
    text = '=IF(1,"yes",1/0),=IF(0,1/0,A2),=IF(D1,1,2),,=if(2>1,10,20)\n=Z9*0\n'
    eq(gets(text, ["A1", "B1", "C1", "E1"]), ["yes", "#REF!", "2", "10"])
    eq(gets('=IF("t",1,2),=IF(A1:A1,1,2),=IF(1,A1:A1,2)\n', ["A1", "B1", "C1"]),
       ["#VALUE!", "#VALUE!", "#VALUE!"])


@test
def func_reversed_range():
    eq(get("1,2\n3,4\n=SUM(B2:A1),=MAX(B1:A2)\n", "A3"), "10")
    eq(get("1,2\n3,4\n=SUM(B2:A1),=MAX(B1:A2)\n", "B3"), "4")


@test
def func_nested_calls():
    text = "1,2,3\n=SUM(A1,MAX(A1:C1)*2,IF(COUNT(A1:C1)=3,100,0)),=AVG(MIN(A1:C1),MAX(A1:C1))\n"
    eq(gets(text, ["A2", "B2"]), ["107", "2"])


# ---------------- errors ----------------

@test
def err_div_value_num():
    text = '=1/0,=1/(2-2),="a"+1,=A2*2,=-A2,=1000000000000000000000000000000*1000000000000000000000000000000*1000000000000000000000000000000*1000000000000000000000000000000*1000000000000000000000000000000*1000000000000000000000000000000*1000000000000000000000000000000*1000000000000000000000000000000*1000000000000000000000000000000*1000000000000000000000000000000*1000000000000000000000000000000*1000000000000000000000000000000\nabc,=1<"a",=A2=1\n'
    eq(gets(text, ["A1", "B1", "C1", "D1", "E1", "F1", "B2", "C2"]),
       ["#DIV/0!", "#DIV/0!", "#VALUE!", "#VALUE!", "#VALUE!", "#NUM!", "#VALUE!", "#VALUE!"])


@test
def err_ref_out_of_grid():
    text = "=G1,=A3,=SUM(A2:G2),=A0,=SUM(A2:B2),=SUM(A1:B2)\n1,2\n"
    eq(gets(text, ["A1", "B1", "C1", "D1", "E1", "F1"]), ["#REF!", "#REF!", "#REF!", "#REF!", "3", "#REF!"])


@test
def err_parse():
    text = '=1+,=1),=A1:B1,=1.,=IF(1,2),=SUM(),=1 2,=$A$1,=+1,="abc\n'
    eq(gets(text, ["A1", "B1", "C1", "D1", "E1", "F1", "G1", "H1", "I1", "J1"]), ["#PARSE!"] * 10)


@test
def err_name():
    text = "=FOO(1),=sum(1)+bar(2),=MAX(1)\n"
    eq(gets(text, ["A1", "B1", "C1"]), ["#NAME?", "#NAME?", "1"])
    eq(get("=FOO(1)+\n", "A1"), "#PARSE!")


@test
def err_propagation_order():
    text = "=1/0,=Z1,=A1+B1,=B1+A1,=SUM(A2:C2),=MAX(B1,A1)\n1,=1/0,=0+Z9\n"
    eq(gets(text, ["C1", "D1", "E1", "F1"]), ["#DIV/0!", "#REF!", "#DIV/0!", "#REF!"])
    eq(get('="a"+(1/0)\n', "A1"), "#DIV/0!")


@test
def err_reference_to_error_cell():
    text = '=1/0,=A1&"x",=IF(1,5,A1),=IF(A1,1,2),=COUNT(A1,1)\n'
    eq(gets(text, ["B1", "C1", "D1", "E1"]), ["#DIV/0!", "5", "#DIV/0!", "#DIV/0!"])


# ---------------- cycles ----------------

@test
def cycle_self_and_pair():
    text = "=A1+1,=C1,=B1,=B1*2,5\n"
    eq(ev(text), "#CYCLE!,#CYCLE!,#CYCLE!,#CYCLE!,5\n")


@test
def cycle_through_range():
    text = "1,2,=SUM(A1:C1)\n=SUM(A1:B1),=A2*2,=C1+1\n"
    eq(ev(text), "1,2,#CYCLE!\n3,6,#CYCLE!\n")


@test
def cycle_in_unused_if_branch():
    # The dependency exists statically even though the branch is never taken.
    text = "=IF(1,7,B1),=A1+1,=IF(0,A1,3)\n"
    eq(ev(text), "#CYCLE!,#CYCLE!,3\n")


@test
def cycle_long_chain_and_dependents():
    rows = ["=A%d+1" % (i + 2) for i in range(299)] + ["=A1"]
    rows += ["=A1*0", "=IF(0,A1,42)"]
    out = ev("\n".join(rows) + "\n").splitlines()
    eq(out[:300], ["#CYCLE!"] * 300)
    eq(out[300:], ["#CYCLE!", "42"])


@test
def cycle_none_in_deep_chain():
    n = 3000
    rows = ["1"] + ["=A%d+1" % i for i in range(1, n)]
    out = ev("\n".join(rows) + "\n").splitlines()
    eq(len(out), n)
    eq(out[-1], str(n))
    eq(out[1234], "1235")


@test
def cycle_parse_error_breaks_cycle():
    text = "=B1+,=A1+1,=FOO(B1)+C1\n"
    eq(ev(text), "#PARSE!,#PARSE!,#NAME?\n")


# ---------------- output ----------------

@test
def out_text_quoting():
    text = ('plain,"a,b","say ""x""",=" pad",="tab\t",="=no",#x,"12","-3.5",="",'
            '"(p)",x y,é ünï\n')
    eq(ev(text), 'plain,"a,b","say ""x"""," pad","tab\t","=no","#x","12","-3.5","","(p)",x y,é ünï\n')


@test
def out_roundtrip():
    text = '1.50,"a,b",=A1*2,="#z",=B1&"!",x,"42",=-0.5\n'
    first = ev(text)
    second = ev(first)
    eq(second, first)


@test
def out_get_formats():
    text = '"a,b",,=1/4,=1/0,=" q "\n'
    r = run("get", sheet(text), "a1")
    eq((r.code, r.out), (0, "a,b\n"))
    r = run("get", sheet(text), "B1")
    eq((r.code, r.out), (0, "\n"))
    r = run("get", sheet(text), "C1")
    eq((r.code, r.out), (0, "0.25\n"))
    r = run("get", sheet(text), "D1")
    eq((r.code, r.out), (1, "#DIV/0!\n"))
    r = run("get", sheet(text), "E1")
    eq((r.code, r.out), (0, " q \n"))


@test
def out_errors_command():
    text = "1,=1/0,x\n=FOO(1),2,=A1\n=C1+1,=AA1,=ZZ(\n"
    r = run("errors", sheet(text))
    eq(r.code, 1)
    eq(r.out, "B1 #DIV/0!\nA2 #NAME?\nA3 #VALUE!\nB3 #REF!\nC3 #PARSE!\n")
    r = run("errors", sheet("1,=A1*2\n"))
    eq((r.code, r.out), (0, ""))


@test
def out_wide_columns():
    cells = [str(i) for i in range(1, 29)] + ["=AB1+AA1+Z1", "=SUM(A1:AB1)"]
    text = ",".join(cells) + "\n"
    eq(gets(text, ["AC1", "AD1", "AB1", "ac1"]), ["81", "406", "28", "81"])


# ---------------- command line ----------------

@test
def cli_help():
    for flag in ("--help", "-h"):
        r = run(flag)
        eq(r.code, 0, flag)
        assert r.out.startswith("usage: cells"), r.out


@test
def cli_usage_errors():
    path = sheet("1\n")
    for args in ([], ["frobnicate", path], ["eval"], ["eval", path, "x"], ["get", path],
                 ["get", path, "1A"], ["get", path, "A"], ["get", path, "$A$1"], ["errors"],
                 ["get", path, "B1"], ["get", path, "A2"]):
        r = run(*args)
        eq(r.code, 2, f"args {args}")
        eq(r.out, "", f"stdout for {args}")
        assert r.err.startswith("error: "), f"stderr for {args}: {r.err!r}"


@test
def cli_bad_ref_checked_before_reading():
    r = run("get", os.path.join(TMP, "missing.csv"), "A-1")
    eq(r.code, 2)


@test
def cli_unreadable_file():
    missing = os.path.join(TMP, "nope.csv")
    for args in (["eval", missing], ["errors", missing], ["get", missing, "A1"], ["eval", TMP]):
        r = run(*args)
        eq(r.code, 3, f"args {args}")
        eq(r.out, "")
        eq(r.err.strip(), f"error: cannot read {args[1]}")


@test
def cli_stdin():
    r = run("eval", "-", stdin=b"2,=A1*21\n")
    eq((r.code, r.out), (0, "2,42\n"))
    r = run("get", "-", "B1", stdin=b"2,=A1*21\n")
    eq((r.code, r.out), (0, "42\n"))


@test
def cli_utf8_under_c_locale():
    r = run("eval", sheet("naïve,=A1&\" café ✓\",日本\n"))
    eq(r.code, 0, f"stderr {r.err!r}")
    eq(r.out, "naïve,naïve café ✓,日本\n")


def main():
    global TMP
    for fn in TESTS:
        TMP = tempfile.mkdtemp(prefix="cells-hidden-")
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
