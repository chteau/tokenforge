#!/usr/bin/env python3
"""Black-box tests for surveystat. Usage: test_surveystat.py RSCRIPT_BIN REPO
Runs `Rscript REPO/bin/surveystat ...` from a temporary working directory and prints one line
per test: `PASS <name>` or `FAIL <name>: <reason>`."""
import json
import os
import shutil
import statistics
import subprocess
import sys
import tempfile
import traceback
from fractions import Fraction

RSCRIPT, REPO = sys.argv[1], os.path.abspath(sys.argv[2])
BIN = os.path.join(REPO, "bin", "surveystat")
TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


class R:
    def __init__(self, p):
        self.code, self.out, self.err = p.returncode, p.stdout, p.stderr

    @property
    def text(self):
        return self.out.decode("utf-8")

    @property
    def json(self):
        assert self.out.endswith(b"\n") and self.out.count(b"\n") == 1, \
            f"JSON output must be one line ending in a newline: {self.out[-80:]!r}"
        return json.loads(self.out.decode("utf-8"))

    @property
    def errline(self):
        return self.err.decode("utf-8", "replace").rstrip("\n")


SCHEMA = """question,type,levels
sat,likert,
age,numeric,
region,single,north;south;east
tools,multi,email;chat;phone
"""

# id, wave, sat, age, region, tools
ROWS = [
    ("1", "1", "4", "23", "north", "email;chat"),
    ("2", "2", "5", "61", "north", "email"),
    ("3", "2", "2", "34", "north", ""),
    ("4", "2", "3", "44", "south", "chat"),
    ("5", "2", "4", "38", "south", "phone; email"),
    ("6", "2", "NA", "41", "south", "email"),
    ("7", "2", "4", "52", "south", "phone"),
    ("8", "2", "3", "30", "south", "chat;chat"),
    ("9", "2", "4", "36.5", "south", "NA"),
    ("10", "1", "", "", "", ""),
]


def csv_text(rows, header=("id", "wave", "sat", "age", "region", "tools")):
    return ",".join(header) + "\n" + "".join(",".join(r) + "\n" for r in rows)


class Env:
    def __init__(self, tmp):
        self.tmp = tmp

    def run(self, *args, cwd=None):
        p = subprocess.run([RSCRIPT, BIN, *args], capture_output=True, cwd=cwd or self.tmp, timeout=60)
        return R(p)

    def ok(self, *args):
        r = self.run(*args)
        assert r.code == 0, f"{args}: exit {r.code}, stderr {r.err[:300]!r}"
        return r

    def write(self, name, data):
        if isinstance(data, str):
            data = data.encode()
        with open(os.path.join(self.tmp, name), "wb") as f:
            f.write(data)
        return name

    def setup(self, schema=SCHEMA, data=None):
        self.write("schema.csv", schema)
        self.write("data.csv", csv_text(ROWS) if data is None else data)

    def summary(self, *args):
        return self.ok("summary", "--schema", "schema.csv", "data.csv", *args)


def eq(a, b, msg=""):
    assert a == b, f"{msg} expected {b!r}, got {a!r}"


def error(r, code, message=None):
    eq(r.code, code, "exit code")
    eq(r.out, b"", "stdout")
    assert r.errline.startswith("error: "), f"stderr {r.errline!r}"
    assert "\n" not in r.errline, f"stderr must be one line: {r.errline!r}"
    if message is not None:
        eq(r.errline, "error: " + message, "stderr")


# ---------------- independent oracle for summaries ----------------

def pct(count, base, digits):
    if base == 0:
        return None
    x = Fraction(count * 100, base) * 10 ** digits
    q = int(x)
    if x - q >= Fraction(1, 2):
        q += 1
    s = str(q).rjust(digits + 1, "0")
    return s if digits == 0 else s[:-digits] + "." + s[-digits:]


def f2(x):
    return None if x is None else "%.2f" % x


def stats(values, with_range):
    n = len(values)
    out = {"mean": f2(statistics.fmean(values) if n else None),
           "median": f2(statistics.median(values) if n else None),
           "sd": f2(statistics.stdev(values) if n > 1 else None)}
    if with_range:
        out["min"] = f2(min(values) if n else None)
        out["max"] = f2(max(values) if n else None)
    return out


def block(qid, qtype, answers, levels=None, missing_mode="exclude", digits=1, respondents=None):
    """Expected text block for a question given trimmed raw answers."""
    miss = [a in ("", "NA") for a in answers]
    vals = [a for a, m in zip(answers, miss) if not m]
    n, m = len(vals), sum(miss)
    lines = [f"{qid} ({qtype})", f"  n: {n}, missing: {m}"]
    base = len(answers) if missing_mode == "include" else n
    if qtype != "numeric":
        levels = levels or ["1", "2", "3", "4", "5"]
        for lv in levels:
            if qtype == "multi":
                c = sum(lv in [i.strip() for i in v.split(";")] for v in vals)
            else:
                c = sum(v == lv for v in vals)
            p = pct(c, base, digits)
            lines.append(f"  {lv}: {c} ({'n/a' if p is None else p + '%'})")
        if missing_mode == "include":
            p = pct(m, base, digits)
            lines.append(f"  (missing): {m} ({'n/a' if p is None else p + '%'})")
    if qtype in ("likert", "numeric"):
        for k, v in stats([float(x) for x in vals], qtype == "numeric").items():
            lines.append(f"  {k}: {'n/a' if v is None else v}")
    return lines


def col(rows, i):
    return [r[i] for r in rows]


def expected_summary(rows, header_lines, missing_mode="exclude", digits=1):
    lines = list(header_lines)
    for qid, qtype, idx, levels in [("sat", "likert", 2, None), ("age", "numeric", 3, None),
                                    ("region", "single", 4, ["north", "south", "east"]),
                                    ("tools", "multi", 5, ["email", "chat", "phone"])]:
        lines += [""] + block(qid, qtype, [v.strip() for v in col(rows, idx)], levels, missing_mode, digits)
    return "\n".join(lines) + "\n"


# ---------------- schema ----------------

@test
def schema_whitespace_and_blank_lines(env):
    env.setup(schema="question , type , levels\n\n sat , likert ,  \nregion,single, north ; south;east \n")
    out = env.summary("--question", "region").text
    assert "  north: 3 (33.3%)\n  south: 6 (66.7%)\n  east: 0 (0.0%)\n" in out, out


@test
def schema_line_errors(env):
    cases = [
        ("q,type,levels\nsat,likert,\n", "schema line 1: invalid header"),
        ("question,type,levels\nsat,likert\n", "schema line 2: expected 3 fields"),
        ("question,type,levels\n\nsat,likert,,\n", "schema line 3: expected 3 fields"),
        ("question,type,levels\n1sat,likert,\n", "schema line 2: invalid question id '1sat'"),
        ("question,type,levels\nsat,likert,\nage,numeric,\nsat,numeric,\n", "schema line 4: duplicate question 'sat'"),
        ("question,type,levels\nsat,rating,\n", "schema line 2: unknown type 'rating'"),
        ("question,type,levels\nregion,single,\n", "schema line 2: levels required for single"),
        ("question,type,levels\nsat,likert,1;2\n", "schema line 2: levels not allowed for likert"),
        ("question,type,levels\nregion,multi,a;b;a\n", "schema line 2: duplicate level 'a'"),
        ("question,type,levels\nregion,single,a;;b\n", "schema line 2: empty level"),
        ("question,type,levels\n\n", "schema has no questions"),
    ]
    for schema, msg in cases:
        env.setup(schema=schema)
        error(env.run("summary", "--schema", "schema.csv", "data.csv"), 3, msg)


@test
def schema_unreadable(env):
    env.setup()
    error(env.run("summary", "--schema", "nope.csv", "data.csv"), 3, "cannot read nope.csv")


@test
def schema_errors_before_data_errors(env):
    env.setup(schema="question,type,levels\nsat,bogus,\n", data="")
    error(env.run("summary", "--schema", "schema.csv", "data.csv"), 3, "schema line 2: unknown type 'bogus'")


# ---------------- responses file ----------------

@test
def data_csv_quoting_crlf_and_blank_lines(env):
    data = ('id,note,region,sat,age,tools\r\n\r\n'
            '1,"hello, ""world""", north ,"4", 30 ," email ; chat"\r\n'
            '2,plain,"south",5,40,phone\r\n\r\n')
    env.setup(schema=SCHEMA, data=data)
    out = env.summary().text
    eq(out, "\n".join(["Respondents: 2", ""] + block("sat", "likert", ["4", "5"]) + [""]
                      + block("age", "numeric", ["30", "40"]) + [""]
                      + block("region", "single", ["north", "south"], ["north", "south", "east"]) + [""]
                      + block("tools", "multi", ["email ; chat", "phone"], ["email", "chat", "phone"])) + "\n")


@test
def data_structure_errors(env):
    env.setup(data="")
    error(env.run("summary", "--schema", "schema.csv", "data.csv"), 4, "data file is empty")
    env.setup(data="id,sat,age,region\n1,2,3,north\n")
    error(env.run("summary", "--schema", "schema.csv", "data.csv"), 4, "missing column 'tools'")
    env.setup(data="id,sat,age,region,tools,sat\n")
    error(env.run("summary", "--schema", "schema.csv", "data.csv"), 4, "duplicate column 'sat'")
    env.setup(data="id,sat,age,region,tools\n1,2,3,north,email\n\n2,3,4,\"south,x\"\n")
    error(env.run("summary", "--schema", "schema.csv", "data.csv"), 4, "row 2: expected 5 fields, got 4")
    error(env.run("summary", "--schema", "schema.csv", "missing.csv"), 4, "cannot read missing.csv")


@test
def data_invalid_values_reported_in_order(env):
    hdr = "id,tools,region,age,sat\n"
    cases = [
        ("1,email,north,30,4\n2,email,north,30,6\n", "row 2: invalid value for 'sat': '6'"),
        ("1,email,north,30,4\n2,email,West,3x, 2.0 \n", "row 2: invalid value for 'sat': '2.0'"),
        ("1,email,North,30,4.5\n", "row 1: invalid value for 'sat': '4.5'"),
        ("1,email,North,30,4\n", "row 1: invalid value for 'region': 'North'"),
        ("1,email;;chat,north,30,4\n", "row 1: invalid value for 'tools': 'email;;chat'"),
        ("1,email;fax,north,30,4\n", "row 1: invalid value for 'tools': 'email;fax'"),
        ("1,email,north,1e3,4\n", "row 1: invalid value for 'age': '1e3'"),
        ("1,email,north,.5,4\n", "row 1: invalid value for 'age': '.5'"),
    ]
    for data, msg in cases:
        env.setup(data=hdr + data)
        error(env.run("summary", "--schema", "schema.csv", "data.csv"), 4, msg)


@test
def data_lenient_treats_invalid_as_missing(env):
    rows = [r for r in ROWS]
    rows[0] = ("1", "1", "9", "x", "west", "fax")
    rows[3] = ("4", "2", "3", "44", "south", "chat;;")
    env.setup(data=csv_text(rows))
    r = env.ok("summary", "--schema", "schema.csv", "data.csv", "--lenient", "--filter", "wave=2")
    eq(r.errline, "warning: 5 invalid value(s) treated as missing")
    fixed = [r for r in rows]
    fixed[3] = ("4", "2", "3", "44", "south", "")
    wave2 = [x for x in fixed if x[1] == "2"]
    eq(r.text, expected_summary(wave2, ["Respondents: 8", "Filter: wave=2"]))
    r = env.ok("summary", "--schema", "schema.csv", "data.csv", "--lenient")
    assert "  n: 8, missing: 2\n" in r.text, r.text
    env.setup()
    eq(env.ok("summary", "--schema", "schema.csv", "data.csv", "--lenient").err, b"")


@test
def data_negative_and_decimal_numbers(env):
    env.setup(schema="question,type,levels\ntemp,numeric,\n", data="temp\n-2.5\n0\n10.25\n-0.75\nNA\n")
    eq(env.summary().text, "\n".join(["Respondents: 5", ""]
                                     + block("temp", "numeric", ["-2.5", "0", "10.25", "-0.75", "NA"])) + "\n")


# ---------------- summary ----------------

@test
def summary_full_text_report(env):
    env.setup()
    eq(env.summary().text, expected_summary(ROWS, ["Respondents: 10"]))


@test
def summary_known_values(env):
    env.setup()
    out = env.summary("--filter", "wave=2", "--question", "sat").text
    eq(out, "Respondents: 8\nFilter: wave=2\n\nsat (likert)\n  n: 7, missing: 1\n  1: 0 (0.0%)\n"
            "  2: 1 (14.3%)\n  3: 2 (28.6%)\n  4: 3 (42.9%)\n  5: 1 (14.3%)\n  mean: 3.57\n"
            "  median: 4.00\n  sd: 0.98\n")


@test
def summary_question_selection_keeps_schema_order(env):
    env.setup()
    out = env.summary("--question", "tools", "--question", "sat").text
    heads = [l for l in out.splitlines() if l and not l.startswith(" ") and not l.startswith("Respondents")]
    eq(heads, ["sat (likert)", "tools (multi)"])


@test
def summary_multi_counts_respondents_once(env):
    env.setup(schema="question,type,levels\nt,multi,a;b;c\n", data="t\na;a;b\nb\n\"c;b\"\nNA\n")
    eq(env.summary().text, "Respondents: 4\n\nt (multi)\n  n: 3, missing: 1\n  a: 1 (33.3%)\n"
                           "  b: 3 (100.0%)\n  c: 1 (33.3%)\n")


@test
def summary_not_available_values(env):
    env.setup(schema="question,type,levels\nx,numeric,\ns,likert,\nc,single,a;b\n",
              data="x,s,c\n5,,\n,,\n")
    eq(env.summary().text, "Respondents: 2\n\nx (numeric)\n  n: 1, missing: 1\n  mean: 5.00\n  median: 5.00\n"
                           "  sd: n/a\n  min: 5.00\n  max: 5.00\n\ns (likert)\n  n: 0, missing: 2\n"
                           "  1: 0 (n/a)\n  2: 0 (n/a)\n  3: 0 (n/a)\n  4: 0 (n/a)\n  5: 0 (n/a)\n"
                           "  mean: n/a\n  median: n/a\n  sd: n/a\n\nc (single)\n  n: 0, missing: 2\n"
                           "  a: 0 (n/a)\n  b: 0 (n/a)\n")


@test
def summary_even_median_and_sd(env):
    env.setup(schema="question,type,levels\nv,numeric,\n", data="v\n1\n2\n3\n4\n10\n100\n")
    eq(env.summary().text, "Respondents: 6\n\nv (numeric)\n  n: 6, missing: 0\n  mean: 20.00\n"
                           "  median: 3.50\n  sd: 39.32\n  min: 1.00\n  max: 100.00\n")


# ---------------- percentages ----------------

@test
def percent_half_up_rounding(env):
    data = "c\n" + "a\n" + "b\n" * 7
    env.setup(schema="question,type,levels\nc,single,a;b\n", data=data)
    eq(env.summary().text.splitlines()[-2:], ["  a: 1 (12.5%)", "  b: 7 (87.5%)"])
    eq(env.summary("--digits", "0").text.splitlines()[-2:], ["  a: 1 (13%)", "  b: 7 (88%)"])
    env.setup(schema="question,type,levels\nc,single,a;b\n", data="c\n" + "a\n" + "b\n" * 15)
    eq(env.summary().text.splitlines()[-2:], ["  a: 1 (6.3%)", "  b: 15 (93.8%)"])
    eq(env.summary("--digits", "2").text.splitlines()[-2:], ["  a: 1 (6.25%)", "  b: 15 (93.75%)"])


@test
def percent_digits_range(env):
    env.setup(schema="question,type,levels\nc,single,a;b\n", data="c\na\nb\nb\n")
    eq(env.summary("--digits", "4").text.splitlines()[-2:], ["  a: 1 (33.3333%)", "  b: 2 (66.6667%)"])
    eq(env.summary("--digits", "3").text.splitlines()[-2:], ["  a: 1 (33.333%)", "  b: 2 (66.667%)"])
    eq(env.summary("--digits", "0").text.splitlines()[-2:], ["  a: 1 (33%)", "  b: 2 (67%)"])


@test
def percent_missing_include(env):
    env.setup()
    eq(env.summary("--missing", "include").text,
       expected_summary(ROWS, ["Respondents: 10"], missing_mode="include"))
    eq(env.summary("--missing", "include", "--digits", "2", "--filter", "wave=2").text,
       expected_summary([r for r in ROWS if r[1] == "2"], ["Respondents: 8", "Filter: wave=2"],
                        missing_mode="include", digits=2))


@test
def percent_oracle_many_digits(env):
    env.setup()
    for d in ("0", "3"):
        eq(env.summary("--digits", d).text, expected_summary(ROWS, ["Respondents: 10"], digits=int(d)))


# ---------------- filters ----------------

@test
def filter_and_or_semantics(env):
    env.setup()
    r = env.summary("--filter", "region=north", "--filter", "wave=2", "--filter", "region=east")
    rows = [x for x in ROWS if x[4] in ("north", "east") and x[1] == "2"]
    eq(r.text, expected_summary(rows, ["Respondents: 2",
                                       "Filter: region=north, wave=2, region=east"]))


@test
def filter_on_any_column_and_values(env):
    env.setup(data=csv_text([("1", "a=b", "4", "1", "north", ""), ("2", "x", "5", "2", "south", ""),
                             ("3", "", "3", "3", "south", "")]))
    out = env.summary("--filter", "wave=a=b", "--question", "age").text
    assert out.startswith("Respondents: 1\nFilter: wave=a=b\n"), out
    out = env.summary("--filter", "wave=", "--question", "age").text
    assert out.startswith("Respondents: 1\nFilter: wave=\n"), out
    out = env.summary("--filter", "sat=5", "--question", "sat").text
    assert "  5: 1 (100.0%)" in out, out


@test
def filter_no_match(env):
    env.setup()
    out = env.summary("--filter", "region=nowhere", "--question", "region").text
    eq(out, "Respondents: 0\nFilter: region=nowhere\n\nregion (single)\n  n: 0, missing: 0\n"
            "  north: 0 (n/a)\n  south: 0 (n/a)\n  east: 0 (n/a)\n")


@test
def filter_errors(env):
    env.setup()
    error(env.run("summary", "--schema", "schema.csv", "data.csv", "--filter", "colour=red"), 2,
          "unknown filter column 'colour'")
    error(env.run("summary", "--schema", "schema.csv", "data.csv", "--filter", "regionnorth"), 2)
    error(env.run("summary", "--schema", "schema.csv", "data.csv", "--filter", "=north"), 2)


# ---------------- crosstab ----------------

CT_SCHEMA = """question,type,levels
grp,single,a;b;c
sat,likert,
plan,single,basic;pro
"""


def ct_data(cells, rows, cols, row_q="grp", col_q="sat", extra=()):
    """Responses holding cells[i][j] respondents with row level i and column level j."""
    lines = []
    for i, rl in enumerate(rows):
        for j, cl in enumerate(cols):
            for _ in range(cells[i][j]):
                lines.append({row_q: rl, col_q: cl})
    lines += list(extra)
    hdr = ["grp", "sat", "plan"]
    return ",".join(hdr) + "\n" + "".join(",".join(d.get(h, "") for h in hdr) + "\n" for d in lines)


@test
def crosstab_text_layout_and_test(env):
    env.setup(schema=CT_SCHEMA, data=ct_data([[12, 5, 7], [3, 9, 14], [6, 8, 10]], ["a", "b", "c"],
                                             ["1", "2", "3"], extra=[{"grp": "a"}, {"sat": "5"}]))
    r = env.ok("crosstab", "--schema", "schema.csv", "data.csv", "grp", "sat")
    eq(r.text, "Respondents: 76\n\nCrosstab: grp x sat (n = 74)\n\n"
               "        1   2   3  4  5  Total\n"
               "a      12   5   7  0  0     24\n"
               "b       3   9  14  0  0     26\n"
               "c       6   8  10  0  0     24\n"
               "Total  21  22  31  0  0     74\n\n"
               "chi-square: 9.4158, df: 4, p: 0.0515\n")


@test
def crosstab_two_by_two_continuity_correction(env):
    env.setup(schema=CT_SCHEMA, data=ct_data([[30, 2], [3, 25]], ["a", "b"], ["basic", "pro"], col_q="plan"))
    r = env.ok("crosstab", "--schema", "schema.csv", "data.csv", "grp", "plan")
    lines = r.text.splitlines()
    eq(lines[4:9], ["       basic  pro  Total", "a         30    2     32", "b          3   25     28",
                    "c          0    0      0", "Total     33   27     60"])
    eq(lines[-1], "chi-square: 38.3144, df: 1, p: <0.0001")


@test
def crosstab_low_expected_note_and_dropped_rows(env):
    env.setup(schema=CT_SCHEMA, data=ct_data([[4, 6], [5, 5]], ["a", "b"], ["basic", "pro"], col_q="plan"))
    r = env.ok("crosstab", "--schema", "schema.csv", "data.csv", "grp", "plan")
    eq(r.text.splitlines()[-2:], ["chi-square: 0.0000, df: 1, p: 1.0000", "note: some expected counts are below 5"])
    env.setup(schema=CT_SCHEMA, data=ct_data([[3, 1], [1, 4]], ["b", "c"], ["basic", "pro"], col_q="plan"))
    r = env.ok("crosstab", "--schema", "schema.csv", "data.csv", "grp", "plan")
    eq(r.text, "Respondents: 9\n\nCrosstab: grp x plan (n = 9)\n\n       basic  pro  Total\n"
               "a          0    0      0\nb          3    1      4\nc          1    4      5\n"
               "Total      4    5      9\n\nchi-square: 0.9506, df: 1, p: 0.3296\n"
               "note: some expected counts are below 5\n")


@test
def crosstab_not_available(env):
    env.setup(schema=CT_SCHEMA, data=ct_data([[3, 4]], ["a"], ["basic", "pro"], col_q="plan"))
    r = env.ok("crosstab", "--schema", "schema.csv", "data.csv", "grp", "plan")
    eq(r.text.splitlines()[-1], "chi-square: n/a")
    assert "note:" not in r.text
    d = env.ok("crosstab", "--schema", "schema.csv", "data.csv", "grp", "plan", "--format", "json").json
    eq(d["chi_square"], None)


@test
def crosstab_json(env):
    env.setup(schema=CT_SCHEMA, data=ct_data([[40, 5, 5], [40, 2, 38]], ["a", "b"], ["1", "2", "3"]))
    d = env.ok("crosstab", "--schema", "schema.csv", "data.csv", "grp", "sat", "--format", "json",
               "--filter", "plan=").json
    eq(d, {"respondents": 130, "filters": [{"column": "plan", "value": ""}], "row": "grp", "column": "sat",
           "n": 130, "row_levels": ["a", "b", "c"], "column_levels": ["1", "2", "3", "4", "5"],
           "counts": [[40, 5, 5, 0, 0], [40, 2, 38, 0, 0], [0, 0, 0, 0, 0]],
           "chi_square": {"statistic": 20.7957, "df": 2, "p_value": "<0.0001", "low_expected": True}})
    env.setup(schema=CT_SCHEMA, data=ct_data([[12, 5, 7], [3, 9, 14], [6, 8, 10]], ["a", "b", "c"], ["1", "2", "3"]))
    d = env.ok("crosstab", "--schema", "schema.csv", "data.csv", "grp", "sat", "--format", "json").json
    eq(d["chi_square"], {"statistic": 9.4158, "df": 4, "p_value": 0.0515, "low_expected": False})


@test
def crosstab_question_errors(env):
    env.setup()
    base = ["crosstab", "--schema", "schema.csv", "data.csv"]
    error(env.run(*base, "region", "nope"), 2, "unknown question 'nope'")
    error(env.run(*base, "region", "age"), 2)
    error(env.run(*base, "tools", "sat"), 2)
    error(env.run(*base, "region", "region"), 2)
    error(env.run(*base, "region"), 2)
    error(env.run(*base, "region", "sat", "--digits", "2"), 2)


# ---------------- JSON summary ----------------

@test
def json_summary_structure(env):
    env.setup()
    d = env.summary("--format", "json", "--filter", "wave=2", "--question", "sat", "--question", "age").json
    eq(d, {"respondents": 8, "filters": [{"column": "wave", "value": "2"}], "questions": [
        {"id": "sat", "type": "likert", "n": 7, "missing": 1,
         "counts": [{"level": "1", "count": 0, "percent": 0.0}, {"level": "2", "count": 1, "percent": 14.3},
                    {"level": "3", "count": 2, "percent": 28.6}, {"level": "4", "count": 3, "percent": 42.9},
                    {"level": "5", "count": 1, "percent": 14.3}],
         "mean": 3.57, "median": 4.0, "sd": 0.98},
        {"id": "age", "type": "numeric", "n": 8, "missing": 0, "mean": 42.06, "median": 39.5, "sd": 10.14,
         "min": 30.0, "max": 61.0}]})


@test
def json_numbers_match_text_digits(env):
    env.setup()
    raw = env.summary("--format", "json", "--question", "region", "--digits", "2").out.decode()
    assert '"percent":33.33' in raw and '"percent":66.67' in raw and '"percent":0.00' in raw, raw
    raw = env.summary("--format", "json", "--question", "age").out.decode()
    assert '"median":38.00' in raw and '"min":23.00' in raw, raw


@test
def json_missing_include_and_nulls(env):
    env.setup(schema="question,type,levels\nx,numeric,\nc,single,a;b\n", data="x,c\n,\n7,a\n")
    d = env.summary("--format", "json", "--missing", "include").json
    eq(d["questions"], [
        {"id": "x", "type": "numeric", "n": 1, "missing": 1, "mean": 7.0, "median": 7.0, "sd": None,
         "min": 7.0, "max": 7.0},
        {"id": "c", "type": "single", "n": 1, "missing": 1,
         "counts": [{"level": "a", "count": 1, "percent": 50.0}, {"level": "b", "count": 0, "percent": 0.0}],
         "missing_percent": 50.0}])
    env.setup(schema="question,type,levels\nc,single,a;b\n", data="c\n")
    d = env.summary("--format", "json").json
    eq(d["questions"][0]["counts"][0]["percent"], None)
    eq(d["respondents"], 0)


@test
def json_string_escaping(env):
    env.setup(schema='question,type,levels\nc,single,say "hi";back\\slash;café\n',
              data='c,tag\n"say ""hi""",x\\y\nback\\slash,"t""q"\n')
    d = env.summary("--format", "json", "--filter", 'tag=t"q', "--filter", "tag=x\\y").json
    eq([c["level"] for c in d["questions"][0]["counts"]], ['say "hi"', "back\\slash", "café"])
    eq(d["filters"], [{"column": "tag", "value": 't"q'}, {"column": "tag", "value": "x\\y"}])
    eq([c["count"] for c in d["questions"][0]["counts"]], [1, 1, 0])


# ---------------- command line ----------------

@test
def cli_help(env):
    for args in (["--help"], ["-h"], ["summary", "--help"]):
        r = env.run(*args)
        eq(r.code, 0, "exit code")
        assert r.text.startswith("Usage: surveystat"), r.out[:80]


@test
def cli_usage_errors(env):
    env.setup()
    for args in [[], ["report", "--schema", "schema.csv", "data.csv"], ["summary", "data.csv"],
                 ["summary", "--schema", "schema.csv"], ["summary", "--schema", "schema.csv", "data.csv", "x.csv"],
                 ["summary", "--schema", "schema.csv", "data.csv", "--bogus"],
                 ["summary", "--schema", "schema.csv", "data.csv", "--format", "xml"],
                 ["summary", "--schema", "schema.csv", "data.csv", "--missing", "drop"],
                 ["summary", "--schema", "schema.csv", "data.csv", "--digits", "5"],
                 ["summary", "--schema", "schema.csv", "data.csv", "--digits", "x"],
                 ["summary", "--schema", "schema.csv", "data.csv", "--digits"]]:
        error(env.run(*args), 2)
    error(env.run("summary", "--schema", "schema.csv", "data.csv", "--question", "nope"), 2,
          "unknown question 'nope'")


@test
def cli_error_order(env):
    env.setup(data="id,sat,age,region,tools\n1,9,1,north,\n")
    error(env.run("summary", "--schema", "schema.csv", "data.csv", "--format", "yaml"), 2)
    error(env.run("summary", "--schema", "schema.csv", "data.csv", "--question", "nope"), 4,
          "row 1: invalid value for 'sat': '9'")
    env.setup(schema="question,type,levels\nsat,likert,x\n")
    error(env.run("summary", "--schema", "schema.csv", "nothere.csv"), 3, "schema line 2: levels not allowed for likert")


@test
def cli_option_order_and_last_wins(env):
    env.setup()
    a = env.ok("summary", "data.csv", "--format", "json", "--schema", "nope.csv", "--schema", "schema.csv",
               "--format", "text", "--digits", "3", "--digits", "1").text
    eq(a, expected_summary(ROWS, ["Respondents: 10"]))


@test
def cli_other_working_directory(env):
    env.setup()
    r = subprocess.run([RSCRIPT, BIN, "summary", "--schema", os.path.join(env.tmp, "schema.csv"),
                        os.path.join(env.tmp, "data.csv")], capture_output=True, cwd="/", timeout=60)
    eq(r.returncode, 0)
    eq(r.stdout.decode(), expected_summary(ROWS, ["Respondents: 10"]))


def main():
    for fn in TESTS:
        tmp = tempfile.mkdtemp(prefix="surveystat-hidden-")
        try:
            fn(Env(tmp))
            print(f"PASS {fn.__name__}", flush=True)
        except Exception as e:  # noqa: BLE001
            msg = str(e) or traceback.format_exc(limit=1)
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {msg[:300]!r}", flush=True)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
