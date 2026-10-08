#!/usr/bin/env python3
"""Black-box tests for cronx. Usage: test_cronx.py /path/to/cronx
Prints one line per test: `PASS <name>` or `FAIL <name>: <reason>`."""
import os
import subprocess
import sys
import time
import traceback

BIN = os.path.abspath(sys.argv[1])
TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


class R:
    def __init__(self, p):
        self.code, self.out, self.err = p.returncode, p.stdout.decode("utf-8", "replace"), p.stderr.decode("utf-8", "replace")


def run(*args):
    return R(subprocess.run([BIN, *args], capture_output=True, timeout=15))


def eq(a, b, msg=""):
    assert a == b, f"{msg} expected {b!r}, got {a!r}"


def ok(*args):
    r = run(*args)
    assert r.code == 0, f"{args}: exit {r.code}, stderr {r.err!r}"
    eq(r.err, "", "stderr")
    return r.out


def err(r, code, text=None):
    eq(r.code, code, "exit code")
    eq(r.out, "", "stdout")
    assert r.err.startswith("error: "), f"stderr {r.err!r}"
    assert r.err.count("\n") <= 1, f"stderr should be one line: {r.err!r}"
    if text is not None:
        eq(r.err.rstrip("\n"), "error: " + text, "stderr")


def invalid(expr, text):
    err(run("validate", expr), 1, text)


def nxt(expr, frm, count, offset=None):
    args = ["next", expr, "--from", frm, "--count", str(count)]
    if offset:
        args += ["--offset", offset]
    return ok(*args).splitlines()


def lines(out):
    assert out.endswith("\n"), f"output must end with newline: {out!r}"
    return out


# ---------------- command line ----------------

@test
def cli_help():
    r = run("--help")
    eq(r.code, 0)
    assert r.out.startswith("usage: cronx"), r.out


@test
def cli_usage_errors():
    err(run(), 2)
    err(run("frobnicate", "* * * * *"), 2)
    err(run("validate"), 2)
    err(run("validate", "* * * * *", "extra"), 2)
    err(run("explain", "* * * * *", "--count", "3"), 2)


@test
def cli_next_option_errors():
    e = "0 0 * * *"
    err(run("next", e), 2)                                             # --from missing
    err(run("next", e, "--from"), 2)                                   # value missing
    err(run("next", e, "--from", "2026-01-01T00:00Z", "--bogus", "1"), 2)
    err(run("next", e, "--from", "2026-01-01T00:00Z", "--from", "2026-01-01T00:00Z"), 2)


@test
def cli_invalid_option_values():
    e = "0 0 * * *"
    for frm in ["2026-02-30T00:00Z", "2026-01-01T24:00Z", "2026-01-01 00:00Z", "2026-01-01T00:00",
                "2026-1-01T00:00Z", "2026-01-01T00:00+5:00", "2026-13-01T00:00Z"]:
        err(run("next", e, "--from", frm), 2)
    for cnt in ["0", "1001", "x", "-1"]:
        err(run("next", e, "--from", "2026-01-01T00:00Z", "--count", cnt), 2)
    for off in ["+14:30", "+15:00", "05:00", "+5:00", "+05:60", "Z"]:
        err(run("next", e, "--from", "2026-01-01T00:00Z", "--offset", off), 2)


@test
def cli_option_order_and_output_format():
    out = ok("next", "0 9 * * *", "--count", "2", "--offset", "+00:00", "--from", "2026-10-08T09:00Z")
    eq(lines(out), "2026-10-09T09:00+00:00\n2026-10-10T09:00+00:00\n")
    eq(lines(ok("validate", "* * * * *")), "valid\n")


# ---------------- parsing ----------------

@test
def parse_valid_forms():
    for e in ["* * * * *", "0,15,30,45 */2 1-15 1-12/3 1-5", "5/10 0 1 * *", "  0   0\t*  * *  ",
              "00 07 01 01 0", "59 23 31 12 7", "0 0 * jan-DEC Mon-fri", "0 0 * * sun,SAT,3-4"]:
        eq(ok("validate", e), "valid\n", e)


@test
def parse_macros():
    for m in ["@yearly", "@annually", "@monthly", "@weekly", "@daily", "@midnight", "@hourly", "@DAILY"]:
        eq(ok("validate", m), "valid\n", m)
    eq(ok("explain", "@weekly"), "At 00:00, on Sunday.\n")
    eq(ok("explain", "@annually"), "At 00:00, on day 1 of the month, in January.\n")


@test
def parse_names_and_sunday_seven():
    eq(nxt("0 12 * * 7", "2026-03-01T12:00Z", 2), ["2026-03-08T12:00+00:00", "2026-03-15T12:00+00:00"])
    eq(nxt("0 6 * jan-mar/2 sun", "2026-01-20T00:00Z", 3),
       ["2026-01-25T06:00+00:00", "2026-03-01T06:00+00:00", "2026-03-08T06:00+00:00"])


# ---------------- validation errors ----------------

@test
def error_field_count():
    invalid("* * * *", "expected 5 fields, got 4")
    invalid("* * * * * *", "expected 5 fields, got 6")
    invalid("", "expected 5 fields, got 0")


@test
def error_unknown_macro():
    invalid("@reboot", 'unknown macro "@reboot"')
    invalid("@every", 'unknown macro "@every"')


@test
def error_out_of_range():
    invalid("60 * * * *", "minute: value 60 out of range 0-59")
    invalid("0 24 * * *", "hour: value 24 out of range 0-23")
    invalid("0 0 0 * *", "day-of-month: value 0 out of range 1-31")
    invalid("0 0 * 13 *", "month: value 13 out of range 1-12")
    invalid("0 0 * * 8", "day-of-week: value 8 out of range 0-7")
    invalid("0 0 * * 1-08", "day-of-week: value 8 out of range 0-7")


@test
def error_invalid_values_and_names():
    invalid("0 MON * * *", 'hour: invalid value "MON"')
    invalid("0 0 * JANUARY *", 'month: invalid value "JANUARY"')
    invalid("0 0 * * FRI-XYZ", 'day-of-week: invalid value "XYZ"')
    invalid("1-2-3 * * * *", 'minute: invalid value "1-2-3"')
    invalid("*/5/2 * * * *", 'minute: invalid value "*/5/2"')


@test
def error_ranges_steps_and_empty_items():
    invalid("0 0 * * FRI-MON", "day-of-week: invalid range FRI-MON")
    invalid("30-10 * * * *", "minute: invalid range 30-10")
    invalid("*/0 * * * *", 'minute: invalid step "0"')
    invalid("0 */x * * *", 'hour: invalid step "x"')
    invalid("0 1-5/ * * *", 'hour: invalid step ""')
    invalid("1,,2 * * * *", "minute: empty item")
    invalid("0 0 5, * *", "day-of-month: empty item")


@test
def error_order_of_checks():
    invalid("60 24 * * *", "minute: value 60 out of range 0-59")       # leftmost field first
    invalid("5,99,x * * * *", "minute: value 99 out of range 0-59")    # leftmost item first
    invalid("70-5 * * * *", "minute: value 70 out of range 0-59")      # start before range order
    invalid("5-3/0 * * * *", "minute: invalid range 5-3")              # range order before step
    err(run("explain", "61 * * * *"), 1, "minute: value 61 out of range 0-59")
    err(run("next", "x * * * *", "--from", "2026-01-01T00:00Z"), 1, 'minute: invalid value "x"')


# ---------------- next runs ----------------

@test
def next_steps_and_strictly_after():
    eq(nxt("*/20 * * * *", "2026-10-08T10:15Z", 4),
       ["2026-10-08T10:20+00:00", "2026-10-08T10:40+00:00", "2026-10-08T11:00+00:00", "2026-10-08T11:20+00:00"])
    eq(nxt("15 10 * * *", "2026-10-08T10:15Z", 1), ["2026-10-09T10:15+00:00"])


@test
def next_default_count_and_rollover():
    out = ok("next", "5 4 * * *", "--from", "2026-12-31T04:05Z")
    eq(out.splitlines(), ["2027-01-01T04:05+00:00", "2027-01-02T04:05+00:00", "2027-01-03T04:05+00:00",
                          "2027-01-04T04:05+00:00", "2027-01-05T04:05+00:00"])
    eq(nxt("@hourly", "2026-10-08T22:30Z", 3),
       ["2026-10-08T23:00+00:00", "2026-10-09T00:00+00:00", "2026-10-09T01:00+00:00"])


@test
def next_monthly_and_yearly():
    eq(nxt("0 0 1 * *", "2026-01-15T00:00Z", 3),
       ["2026-02-01T00:00+00:00", "2026-03-01T00:00+00:00", "2026-04-01T00:00+00:00"])
    eq(nxt("@yearly", "2026-10-08T00:00Z", 3),
       ["2027-01-01T00:00+00:00", "2028-01-01T00:00+00:00", "2029-01-01T00:00+00:00"])


@test
def next_window_and_never():
    t = time.time()
    r = run("next", "0 0 30 2 *", "--from", "2026-01-01T00:00Z")
    err(r, 1, "no run within 100 years")
    err(run("next", "0 0 31 4,6,9,11 *", "--from", "2026-01-01T00:00Z", "--count", "1"), 1,
        "no run within 100 years")
    out = ok("next", "0 0 1 1 *", "--from", "2026-06-01T00:00Z", "--count", "150").splitlines()
    eq(len(out), 100, "runs within 100 years")
    eq(out[-1], "2126-01-01T00:00+00:00")
    assert time.time() - t < 10, "next is too slow"


# ---------------- day-of-month / day-of-week rule ----------------

@test
def dayrule_both_restricted_is_or():
    eq(nxt("0 0 13 * FRI", "2026-02-01T00:00Z", 4),
       ["2026-02-06T00:00+00:00", "2026-02-13T00:00+00:00", "2026-02-20T00:00+00:00", "2026-02-27T00:00+00:00"])


@test
def dayrule_step_counts_as_restricted():
    eq(nxt("0 0 */10 * MON", "2026-03-01T00:00Z", 4),
       ["2026-03-02T00:00+00:00", "2026-03-09T00:00+00:00", "2026-03-11T00:00+00:00", "2026-03-16T00:00+00:00"])
    eq(nxt("0 0 1 * MON-FRI", "2026-08-01T00:00Z", 1), ["2026-08-03T00:00+00:00"])


@test
def dayrule_only_weekday():
    eq(nxt("30 8 * * 1-5", "2026-10-09T09:00Z", 3),
       ["2026-10-12T08:30+00:00", "2026-10-13T08:30+00:00", "2026-10-14T08:30+00:00"])


# ---------------- offsets ----------------

@test
def offset_schedule_in_local_time():
    eq(nxt("0 12 * * *", "2026-03-01T05:00Z", 2, "+05:30"), ["2026-03-01T12:00+05:30", "2026-03-02T12:00+05:30"])


@test
def offset_from_with_its_own_offset():
    eq(nxt("0 0 * * *", "2026-03-01T10:00-08:00", 2), ["2026-03-02T00:00+00:00", "2026-03-03T00:00+00:00"])
    eq(nxt("0 0 * * *", "2026-03-01T10:00+02:00", 2, "-03:45"), ["2026-03-02T00:00-03:45", "2026-03-03T00:00-03:45"])


@test
def offset_crosses_year_boundary():
    eq(nxt("0 23 31 12 *", "2026-12-31T22:00Z", 1, "+14:00"), ["2027-12-31T23:00+14:00"])
    eq(nxt("0 * * * *", "2026-01-01T00:30Z", 2, "-14:00"), ["2025-12-31T11:00-14:00", "2025-12-31T12:00-14:00"])


# ---------------- calendar ----------------

@test
def calendar_leap_years_and_2100():
    eq(nxt("0 0 29 2 *", "2097-01-01T00:00Z", 2), ["2104-02-29T00:00+00:00", "2108-02-29T00:00+00:00"])
    eq(nxt("0 0 28-31 2 *", "2028-02-27T00:00Z", 3),
       ["2028-02-28T00:00+00:00", "2028-02-29T00:00+00:00", "2029-02-28T00:00+00:00"])


@test
def calendar_month_lengths():
    eq(nxt("0 0 31 * *", "2026-01-31T00:00Z", 4),
       ["2026-03-31T00:00+00:00", "2026-05-31T00:00+00:00", "2026-07-31T00:00+00:00", "2026-08-31T00:00+00:00"])
    eq(nxt("59 23 31 12 *", "2026-12-31T23:59Z", 1), ["2027-12-31T23:59+00:00"])


# ---------------- explain ----------------

def explain(expr):
    return lines(ok("explain", expr)).rstrip("\n")


@test
def explain_fixed_times():
    eq(explain("30 9 * * MON-FRI"), "At 09:30, on Monday through Friday.")
    eq(explain("@daily"), "At 00:00.")
    eq(explain("0 0 * JAN,jul 0"), "At 00:00, on Sunday, in January and July.")
    eq(explain("5 14 * * 7"), "At 14:05, on Sunday.")


@test
def explain_minute_and_hour_phrases():
    eq(explain("* * * * *"), "Every minute.")
    eq(explain("*/15 9-17 1,15 * *"), "Every 15 minutes past hour 9 through 17, on day 1 and 15 of the month.")
    eq(explain("@hourly"), "At minute 0.")
    eq(explain("0,30 */3 * * *"), "At minute 0 and 30 past every 3 hours.")
    eq(explain("* 22 * * *"), "Every minute past hour 22.")


@test
def explain_lists_and_steps():
    eq(explain("1,2,3 05-08/2,20 * * *"), "At minute 1, 2 and 3 past hour every 2 from 5 through 8 and 20.")
    eq(explain("10/20,*/7 * * * *"), "At minute every 20 from 10 through 59 and every 7.")


@test
def explain_days_and_months():
    eq(explain("0 0 1 * MON"), "At 00:00, on day 1 of the month or Monday.")
    eq(explain("0 8 */2 * *"), "At 08:00, on every 2 days.")
    eq(explain("0 8 * * */2"), "At 08:00, on every 2 days of the week.")
    eq(explain("0 8 * */3 *"), "At 08:00, every 3 months.")
    eq(explain("15 6 10-20 3-5,DEC sat,sun"),
       "At 06:15, on day 10 through 20 of the month or Saturday and Sunday, in March through May and December.")


def main():
    for fn in TESTS:
        try:
            fn()
            print(f"PASS {fn.__name__}", flush=True)
        except Exception as e:  # noqa: BLE001
            msg = str(e) or traceback.format_exc(limit=1)
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {msg[:400]!r}", flush=True)


if __name__ == "__main__":
    main()
