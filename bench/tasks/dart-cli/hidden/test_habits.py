#!/usr/bin/env python3
"""Black-box tests for habits. Usage: test_habits.py /path/to/habits
Prints one line per test: `PASS <name>` or `FAIL <name>: <reason>`."""
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import tempfile
import traceback

BIN = os.path.abspath(sys.argv[1])
TESTS = []
TODAY = "2026-10-08"  # a Thursday


def test(fn):
    TESTS.append(fn)
    return fn


class R:
    def __init__(self, p):
        self.code, self.out, self.err = p.returncode, p.stdout.decode(), p.stderr.decode()


def run(args, today=TODAY, cwd=None):
    env = {k: v for k, v in os.environ.items() if k != "HABITS_TODAY"}
    if today is not None:
        env["HABITS_TODAY"] = today
    p = subprocess.run([BIN, *args], capture_output=True, timeout=20, env=env, cwd=cwd)
    return R(p)


class H:
    def __init__(self, root):
        self.root = root
        self.file = os.path.join(root, "data", "habits.json")

    def __call__(self, *args, today=TODAY):
        return run(["--file", self.file, *args], today=today)

    def ok(self, *args, today=TODAY):
        r = self(*args, today=today)
        assert r.code == 0, f"{args}: exit {r.code}, stderr {r.err!r}"
        assert r.err == "", f"{args}: unexpected stderr {r.err!r}"
        return r.out

    def seed(self, habits):
        os.makedirs(os.path.dirname(self.file), exist_ok=True)
        with open(self.file, "w") as f:
            json.dump({"habits": habits}, f)

    def data(self):
        with open(self.file) as f:
            return json.load(f)

    def raw(self):
        with open(self.file, "rb") as f:
            return f.read()

    def streak(self, name, today=TODAY):
        out = self.ok("streak", name, today=today)
        lines = out.split("\n")
        assert lines[-1] == "" and len(lines) == 6, f"streak output {out!r}"
        res = {}
        for line, key in zip(lines, ("current", "best", "total", "weekly", "last")):
            k, _, v = line.partition(": ")
            assert k == key, f"streak line {line!r}"
            res[k] = v if key == "last" else int(v)
        return res


def eq(a, b, msg=""):
    assert a == b, f"{msg} expected {b!r}, got {a!r}"


def err(r, code, msg=None):
    eq(r.code, code, f"exit code (stderr {r.err!r})")
    eq(r.out, "", "stdout")
    assert r.err.startswith("error: "), f"stderr {r.err!r}"
    if msg is not None:
        eq(r.err.rstrip("\n"), "error: " + msg, "stderr")


def days(start, n, step=1):
    d = dt.date.fromisoformat(start)
    return [(d + dt.timedelta(days=i * step)).isoformat() for i in range(n)]


# ---------------- habits: add / remove / list ----------------

@test
def habits_add_and_list(h):
    eq(h.ok("add", "read", "--goal", "5"), "added read\n")
    eq(h.ok("add", "--goal", "3", "run"), "added run\n")
    eq(h.ok("add", "a-1"), "added a-1\n")
    eq(h.ok("list"), "a-1\tgoal 7\tcurrent 0\tbest 0\ttotal 0\n"
                     "read\tgoal 5\tcurrent 0\tbest 0\ttotal 0\n"
                     "run\tgoal 3\tcurrent 0\tbest 0\ttotal 0\n")


@test
def habits_duplicate(h):
    h.ok("add", "read")
    before = h.raw()
    err(h("add", "read", "--goal", "2"), 1, "habit already exists: read")
    eq(h.raw(), before, "file changed")


@test
def habits_invalid_name(h):
    for name in ("Read", "1abc", "-x", "a b", "", "x" * 33, "é", "a_b"):
        r = h("add", name)
        err(r, 2)
    h.ok("add", "x" * 32)
    assert not os.path.exists(h.file + ".tmp")


@test
def habits_invalid_goal(h):
    for g in ("0", "8", "-1", "x", "2.5", ""):
        err(h("add", "read", "--goal", g), 2)
    err(h("add", "read", "--goal"), 2)
    assert not os.path.exists(h.file), "file created on usage error"


@test
def habits_remove(h):
    h.ok("add", "read")
    h.ok("add", "run")
    eq(h.ok("remove", "read"), "removed read\n")
    eq(h.ok("list"), "run\tgoal 7\tcurrent 0\tbest 0\ttotal 0\n")
    err(h("remove", "read"), 1, "no such habit: read")


@test
def habits_list_empty(h):
    eq(h.ok("list"), "")
    assert not os.path.exists(h.file), "list created the file"


# ---------------- marking days: done / undo ----------------

@test
def mark_done_today_and_date(h):
    h.ok("add", "read")
    eq(h.ok("done", "read"), f"done read {TODAY}\n")
    eq(h.ok("done", "read", "2026-10-01"), "done read 2026-10-01\n")
    eq(h.data()["habits"][0]["done"], ["2026-10-01", TODAY])


@test
def mark_already_done(h):
    h.ok("add", "read")
    h.ok("done", "read", "2026-10-02")
    st = os.stat(h.file)
    before = h.raw()
    eq(h.ok("done", "read", "2026-10-02"), "already done read 2026-10-02\n")
    eq(h.raw(), before)
    eq(os.stat(h.file).st_ino, st.st_ino, "file was rewritten")


@test
def mark_future_rejected(h):
    h.ok("add", "read")
    before = h.raw()
    err(h("done", "read", "2026-10-09"), 2, "date is in the future: 2026-10-09")
    eq(h.raw(), before)
    h.ok("done", "read", "2026-10-09", today="2026-10-09")


@test
def mark_undo(h):
    h.ok("add", "read")
    h.ok("done", "read")
    h.ok("done", "read", "2026-10-07")
    eq(h.ok("undo", "read"), f"undone read {TODAY}\n")
    eq(h.data()["habits"][0]["done"], ["2026-10-07"])
    err(h("undo", "read", "2026-10-01"), 1, "not done: read 2026-10-01")
    eq(h.ok("undo", "read", "2026-10-07"), "undone read 2026-10-07\n")


@test
def mark_unknown_habit(h):
    h.ok("add", "read")
    err(h("done", "nope"), 1, "no such habit: nope")
    err(h("undo", "nope"), 1, "no such habit: nope")
    err(h("streak", "nope"), 1, "no such habit: nope")


# ---------------- dates ----------------

@test
def date_invalid_formats(h):
    h.ok("add", "read")
    for d in ("2026-1-05", "20260105", "2026-02-30", "2023-02-29", "2026-04-31",
              "2026-13-01", "2026-00-10", "26-10-01", "yesterday", "2026-10-01x"):
        err(h("done", "read", d), 2)
        err(h("report", d), 2)
    eq(h.data()["habits"][0]["done"], [])


@test
def date_leap_day(h):
    h.ok("add", "read")
    eq(h.ok("done", "read", "2024-02-29"), "done read 2024-02-29\n")
    eq(h.ok("done", "read", "2000-02-29"), "done read 2000-02-29\n")
    err(h("done", "read", "1900-02-29"), 2)


@test
def date_today_env(h):
    h.ok("add", "read")
    for bad in ("2026-02-30", "tomorrow", "2026/10/08"):
        err(h("list", today=bad), 2)
    eq(h.ok("done", "read", today="2025-03-04"), "done read 2025-03-04\n")


# ---------------- day streaks ----------------

@test
def streak_basic(h):
    h.ok("add", "read")
    for d in days("2026-10-04", 5):
        h.ok("done", "read", d)
    eq(h.streak("read"), {"current": 5, "best": 5, "total": 5, "weekly": 0, "last": TODAY})


@test
def streak_grace_yesterday(h):
    h.seed([{"name": "read", "goal": 7, "done": days("2026-10-03", 5)}])  # ends 10-07
    eq(h.streak("read")["current"], 5)
    eq(h.streak("read", today="2026-10-09")["current"], 0)
    eq(h.streak("read", today="2026-10-09")["best"], 5)


@test
def streak_broken_and_best(h):
    h.seed([{"name": "read", "goal": 7,
             "done": days("2026-09-01", 10) + days("2026-10-06", 3)}])
    s = h.streak("read")
    eq((s["current"], s["best"], s["total"]), (3, 10, 13))


@test
def streak_month_boundary(h):
    h.seed([{"name": "read", "goal": 7, "done": days("2026-04-28", 6)}])  # 04-28..05-03
    s = h.streak("read", today="2026-05-03")
    eq((s["current"], s["best"]), (6, 6))
    h.seed([{"name": "read", "goal": 7, "done": ["2026-04-30", "2026-05-02"]}])
    eq(h.streak("read", today="2026-05-02")["current"], 1)


@test
def streak_year_boundary(h):
    h.seed([{"name": "read", "goal": 7, "done": days("2025-12-29", 6)}])  # ..2026-01-03
    s = h.streak("read", today="2026-01-03")
    eq((s["current"], s["best"], s["last"]), (6, 6, "2026-01-03"))


@test
def streak_leap_february(h):
    h.seed([{"name": "read", "goal": 7, "done": ["2024-02-27", "2024-02-28", "2024-02-29",
                                                    "2024-03-01", "2023-02-27", "2023-02-28",
                                                    "2023-03-01"]}])
    s = h.streak("read", today="2024-03-01")
    eq((s["current"], s["best"]), (4, 4))
    eq(h.streak("read", today="2023-03-01")["current"], 3)


@test
def streak_never(h):
    h.ok("add", "read")
    eq(h.streak("read"), {"current": 0, "best": 0, "total": 0, "weekly": 0, "last": "never"})


@test
def streak_future_dates_ignored(h):
    h.seed([{"name": "read", "goal": 7, "done": days("2026-10-01", 10)}])  # ..10-10
    s = h.streak("read")
    eq((s["current"], s["best"], s["total"], s["last"]), (8, 8, 8, TODAY))
    eq(h.ok("list"), "read\tgoal 7\tcurrent 8\tbest 8\ttotal 8\n")


@test
def streak_long_history(h):
    h.seed([{"name": "read", "goal": 7, "done": days("2025-01-01", 600)}])  # ..2026-08-23
    s = h.streak("read", today="2026-08-23")
    eq((s["current"], s["best"], s["total"]), (600, 600, 600))


# ---------------- weekly goal streaks ----------------

@test
def weekly_basic(h):
    # goal 3; weeks starting 09-14, 09-21, 09-28 each have 3 days; current week (10-05) has 1.
    done = ["2026-09-14", "2026-09-16", "2026-09-18", "2026-09-21", "2026-09-22",
            "2026-09-27", "2026-09-28", "2026-10-01", "2026-10-04", "2026-10-06"]
    h.seed([{"name": "gym", "goal": 3, "done": done}])
    eq(h.streak("gym")["weekly"], 3)


@test
def weekly_current_week_counts_once_met(h):
    done = ["2026-09-29", "2026-10-01", "2026-10-05", "2026-10-07"]
    h.seed([{"name": "gym", "goal": 2, "done": done}])
    eq(h.streak("gym")["weekly"], 2)
    eq(h.streak("gym", today="2026-10-06")["weekly"], 1)  # current week not met yet


@test
def weekly_broken(h):
    done = ["2026-09-14", "2026-09-15", "2026-09-28", "2026-09-29"]  # week of 09-21 empty
    h.seed([{"name": "gym", "goal": 2, "done": done}])
    eq(h.streak("gym")["weekly"], 1)
    eq(h.streak("gym", today="2026-10-20")["weekly"], 0)


@test
def weekly_across_year(h):
    # ISO weeks 2020-W52, 2020-W53 (2020-12-28..2021-01-03), 2021-W01.
    done = ["2020-12-21", "2020-12-24", "2020-12-31", "2021-01-02", "2021-01-04", "2021-01-05"]
    h.seed([{"name": "gym", "goal": 2, "done": done}])
    eq(h.streak("gym", today="2021-01-06")["weekly"], 3)
    eq(h.streak("gym", today="2021-01-04")["weekly"], 2)


@test
def weekly_goal_seven(h):
    h.seed([{"name": "read", "goal": 7, "done": days("2026-09-21", 17)}])  # Mon 09-21 .. 10-07
    eq(h.streak("read")["weekly"], 2)


# ---------------- weekly report ----------------

REPORT_SEED = [
    {"name": "stretch", "goal": 3, "done": ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]},
    {"name": "read", "goal": 5, "done": ["2026-10-05", "2026-10-06", "2026-10-08"]},
    {"name": "run", "goal": 6, "done": ["2026-10-06"]},
]


@test
def report_layout_exact(h):
    h.seed(REPORT_SEED)
    eq(h.ok("report"), "Week 2026-W41 (2026-10-05 to 2026-10-11)\n"
                       "read     x x . x - - -  3/5  need 2\n"
                       "run      . x . . - - -  1/6  missed\n"
                       "stretch  x x x x - - -  4/3  met\n"
                       "1 of 3 goals met\n")


@test
def report_remaining_counts_today(h):
    h.seed([{"name": "yoga", "goal": 4, "done": ["2026-10-06"]},
            {"name": "ab", "goal": 5, "done": ["2026-10-06"]}])
    # remaining = 3 days after today + today (not done) = 4
    eq(h.ok("report"), "Week 2026-W41 (2026-10-05 to 2026-10-11)\n"
                       "ab    . x . . - - -  1/5  need 4\n"
                       "yoga  . x . . - - -  1/4  need 3\n"
                       "0 of 2 goals met\n")


@test
def report_past_week(h):
    h.seed(REPORT_SEED)
    eq(h.ok("report", "2026-09-30"), "Week 2026-W40 (2026-09-28 to 2026-10-04)\n"
                                     "read     . . . . . . .  0/5  missed\n"
                                     "run      . . . . . . .  0/6  missed\n"
                                     "stretch  . . . . . . .  0/3  missed\n"
                                     "0 of 3 goals met\n")


@test
def report_iso_year_boundary(h):
    h.seed([{"name": "read", "goal": 2, "done": ["2026-12-29", "2027-01-01"]}])
    eq(h.ok("report", "2027-01-01", today="2027-01-02"),
       "Week 2026-W53 (2026-12-28 to 2027-01-03)\n"
       "read  . x . . x . -  2/2  met\n"
       "1 of 1 goals met\n")
    out = h.ok("report", "2024-12-31", today="2027-01-02")
    eq(out.split("\n")[0], "Week 2025-W01 (2024-12-30 to 2025-01-05)")
    out = h.ok("report", "2021-01-03", today="2027-01-02")
    eq(out.split("\n")[0], "Week 2020-W53 (2020-12-28 to 2021-01-03)")


@test
def report_future_week(h):
    h.seed([{"name": "read", "goal": 1, "done": []}])
    eq(h.ok("report", "2026-10-14"), "Week 2026-W42 (2026-10-12 to 2026-10-18)\n"
                                     "read  - - - - - - -  0/1  need 1\n"
                                     "0 of 1 goals met\n")


@test
def report_no_habits(h):
    eq(h.ok("report"), "Week 2026-W41 (2026-10-05 to 2026-10-11)\nno habits\n")
    assert not os.path.exists(h.file)


# ---------------- data file ----------------

@test
def store_json_shape(h):
    h.ok("add", "zeta", "--goal", "2")
    h.ok("add", "alpha")
    h.ok("done", "zeta", "2026-10-07")
    h.ok("done", "zeta", "2026-09-01")
    eq(h.data(), {"habits": [{"name": "alpha", "goal": 7, "done": []},
                             {"name": "zeta", "goal": 2, "done": ["2026-09-01", "2026-10-07"]}]})


@test
def store_reads_unsorted_input(h):
    h.seed([{"name": "zz", "goal": 7, "done": ["2026-10-08", "2026-10-06", "2026-10-07", "2026-10-07"]},
            {"name": "aa", "goal": 1, "done": []}])
    eq(h.ok("list"), "aa\tgoal 1\tcurrent 0\tbest 0\ttotal 0\n"
                     "zz\tgoal 7\tcurrent 3\tbest 3\ttotal 3\n")
    h.ok("done", "aa")
    d = h.data()["habits"]
    eq([x["name"] for x in d], ["aa", "zz"])
    eq(d[1]["done"], ["2026-10-06", "2026-10-07", "2026-10-08"])


@test
def store_corrupt(h):
    os.makedirs(os.path.dirname(h.file), exist_ok=True)
    bad = ["{not json", "[]", '{"x": []}', '{"habits": {}}',
           '{"habits": [{"name": "Bad", "goal": 1, "done": []}]}',
           '{"habits": [{"name": "a", "goal": 9, "done": []}]}',
           '{"habits": [{"name": "a", "goal": 1, "done": ["2026-02-30"]}]}',
           '{"habits": [{"name": "a", "goal": 1, "done": []}, {"name": "a", "goal": 2, "done": []}]}']
    for text in bad:
        with open(h.file, "w") as f:
            f.write(text)
        for args in (["list"], ["done", "a"], ["add", "b"]):
            err(h(*args), 3, f"corrupt data file: {h.file}")
        with open(h.file) as f:
            eq(f.read(), text, "corrupt file modified")


@test
def store_path_is_directory(h):
    os.makedirs(h.file)
    err(h("list"), 3)
    err(h("add", "read"), 3)


@test
def store_no_temp_files_and_parents(h):
    h.file = os.path.join(h.root, "a", "b", "c", "h.json")
    h.ok("add", "read")
    for d in days("2026-10-01", 5):
        h.ok("done", "read", d)
    h.ok("undo", "read", "2026-10-02")
    h.ok("remove", "read")
    eq(os.listdir(os.path.dirname(h.file)), ["h.json"])


@test
def store_readonly_commands_do_not_write(h):
    h.seed(REPORT_SEED)
    before = h.raw()
    mtime = os.stat(h.file).st_mtime_ns
    h.ok("list")
    h.ok("report")
    h.ok("streak", "read")
    eq(h.raw(), before)
    eq(os.stat(h.file).st_mtime_ns, mtime)


# ---------------- command line ----------------

@test
def cli_help(h):
    for flag in ("--help", "-h"):
        r = run([flag])
        eq(r.code, 0)
        assert r.out.startswith("usage: habits"), r.out[:80]


@test
def cli_usage_errors(h):
    h.ok("add", "read")
    cases = [[], ["frobnicate"], ["list", "extra"], ["add"], ["remove"], ["remove", "a", "b"],
             ["done"], ["done", "read", TODAY, "x"], ["streak"], ["report", TODAY, "x"],
             ["add", "read", "--goal", "2", "--goal", "3"], ["add", "a", "b"]]
    for args in cases:
        err(h(*args), 2)
    err(run(["--file"]), 2)
    err(run([]), 2)


@test
def cli_default_file_in_cwd(h):
    r = run(["add", "read"], cwd=h.root)
    eq((r.code, r.out), (0, "added read\n"))
    assert os.path.isfile(os.path.join(h.root, "habits.json"))
    r = run(["list"], cwd=h.root)
    eq(r.out, "read\tgoal 7\tcurrent 0\tbest 0\ttotal 0\n")


@test
def cli_args_validated_before_reading(h):
    os.makedirs(os.path.dirname(h.file), exist_ok=True)
    with open(h.file, "w") as f:
        f.write("garbage")
    err(h("done", "read", "2026-02-30"), 2)
    err(h("add", "Bad"), 2)


def main():
    for fn in TESTS:
        tmp = tempfile.mkdtemp(prefix="habits-hidden-")
        try:
            fn(H(tmp))
            print(f"PASS {fn.__name__}", flush=True)
        except Exception as e:  # noqa: BLE001
            msg = str(e) or traceback.format_exc(limit=1)
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {msg[:300]!r}", flush=True)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
