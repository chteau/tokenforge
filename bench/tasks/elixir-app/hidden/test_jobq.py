#!/usr/bin/env python3
"""Black-box tests for jobq. Usage: test_jobq.py /path/to/jobq
Prints one line per test: `PASS <name>` or `FAIL <name>: <reason>`."""
import os
import shutil
import subprocess
import sys
import tempfile
import traceback
from concurrent.futures import ThreadPoolExecutor

BIN = os.path.abspath(sys.argv[1])
TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


class R:
    def __init__(self, p):
        self.code, self.out, self.err = p.returncode, p.stdout.decode(errors="replace"), p.stderr.decode(errors="replace")


class Q:
    """One queue: a state file in its own directory, a settable clock."""

    def __init__(self, root):
        self.dir = root
        self.state = os.path.join(root, "queue.state")
        self.now = 1000

    def __call__(self, *args, now=None, env=None):
        e = dict(os.environ)
        e.pop("JOBQ_NOW", None)
        e["JOBQ_STATE"] = self.state
        e["JOBQ_NOW"] = str(self.now if now is None else now)
        if env:
            e.update(env)
        p = subprocess.run([BIN, *args], capture_output=True, timeout=60, env=e, cwd=self.dir)
        return R(p)

    def ok(self, *args, now=None):
        r = self(*args, now=now)
        assert r.code == 0, f"{args}: exit {r.code}, stderr {r.err!r}"
        assert r.err == "", f"{args}: stderr {r.err!r}"
        return r.out

    def add(self, *args, now=None):
        out = self.ok("add", *args, now=now)
        assert out.endswith("\n") and out.strip().isdigit(), f"add output {out!r}"
        return int(out)

    def take(self, *args, now=None):
        out = self.ok("take", *args, now=now)
        assert out.endswith("\n"), f"take output {out!r}"
        return out[:-1].split("\t")

    def show(self, job_id, now=None):
        out = self.ok("show", str(job_id), now=now)
        lines = out.split("\n")
        assert lines[-1] == "", f"show output {out!r}"
        res = {}
        for line in lines[:-1]:
            k, sep, v = line.partition(": ")
            assert sep, f"show line {line!r}"
            res[k] = v
        return res

    def stats(self, now=None):
        out = self.ok("stats", now=now)
        lines = out.split("\n")
        keys = ["ready", "scheduled", "running", "done", "dead", "total", "next_run_at", "oldest_ready_age"]
        assert lines[-1] == "" and len(lines) == len(keys) + 1, f"stats output {out!r}"
        res = {}
        for line, key in zip(lines, keys):
            k, _, v = line.partition(": ")
            assert k == key, f"stats line {line!r}, expected key {key}"
            res[k] = v if v == "-" else int(v)
        return res

    def list(self, *args, now=None):
        out = self.ok("list", *args, now=now)
        return [l.split("\t") for l in out.split("\n")[:-1]]


def eq(a, b, msg=""):
    assert a == b, f"{msg} expected {b!r}, got {a!r}"


def err(r, code, message=None):
    eq(r.code, code, "exit code")
    eq(r.out, "", "stdout")
    if message is None:
        assert r.err.startswith("error: "), f"stderr {r.err!r}"
    else:
        eq(r.err.rstrip("\n"), message, "stderr")


# ---------------- add ----------------

@test
def add_assigns_sequential_ids(q):
    eq([q.add("a"), q.add("b"), q.add("c")], [1, 2, 3])
    eq(q.list(), [["1", "ready", "0", "0/3", "1000", "a"], ["2", "ready", "0", "0/3", "1000", "b"],
                  ["3", "ready", "0", "0/3", "1000", "c"]])


@test
def add_with_options(q):
    q.add("email.send", "--payload", "to=ann@example.com x", "--priority", "7", "--max-attempts", "5",
          "--backoff", "30", "--delay", "45")
    eq(q.show(1), {"id": "1", "name": "email.send", "state": "scheduled", "priority": "7",
                   "attempts": "0/5", "backoff": "30", "run_at": "1045", "lease_until": "-",
                   "last_error": "-", "payload": "to=ann@example.com x"})


@test
def add_at_and_option_order(q):
    q.add("--at", "900", "past:job", "--payload", "--literal")
    q.add("--priority", "9", "future-job", "--at", "5000")
    eq(q.list(), [["1", "ready", "0", "0/3", "900", "past:job"], ["2", "scheduled", "9", "0/3", "5000", "future-job"]])
    eq(q.show(1)["payload"], "--literal")


@test
def add_validation(q):
    bad = [["add"], ["add", "has space"], ["add", "x" * 65], ["add", "a/b"], ["add", "a", "b"],
           ["add", "a", "--priority", "10"], ["add", "a", "--priority", "-1"], ["add", "a", "--priority", "1.5"],
           ["add", "a", "--delay", "5", "--at", "9"], ["add", "a", "--max-attempts", "0"],
           ["add", "a", "--max-attempts", "101"], ["add", "a", "--backoff", "0"], ["add", "a", "--backoff", "3601"],
           ["add", "a", "--payload", "x" * 1025], ["add", "a", "--payload", "two\nlines"],
           ["add", "a", "--priority", "1", "--priority", "2"], ["add", "a", "--lease", "5"], ["add", "a", "--delay"]]
    for args in bad:
        err(q(*args), 2)
    q.add("x" * 64, "--payload", "y" * 1024, "--max-attempts", "100", "--backoff", "3600", "--priority", "9")
    eq(len(q.list()), 1)
    assert not os.path.exists(q.state + ".tmp")


# ---------------- take ----------------

@test
def take_priority_order(q):
    q.add("low")
    q.add("high", "--priority", "9")
    q.add("mid", "--priority", "4", "--payload", "p")
    eq(q.take(), ["2", "high", ""])
    eq(q.take(), ["3", "mid", "p"])
    eq(q.take(), ["1", "low", ""])


@test
def take_ties_by_run_at_then_id(q):
    q.add("b", "--at", "950", "--priority", "3")
    q.add("a", "--at", "900", "--priority", "3")
    q.add("c", "--at", "950", "--priority", "3")
    q.add("d", "--at", "100", "--priority", "2")
    eq([q.take()[1] for _ in range(4)], ["a", "b", "c", "d"])


@test
def take_skips_scheduled_jobs(q):
    q.add("later", "--delay", "60", "--priority", "9")
    q.add("now")
    eq(q.take()[1], "now")
    err(q("take"), 4, "error: no job ready")
    eq(q.take(now=1060)[1], "later")


@test
def take_marks_running(q):
    q.add("job")
    q.take("--lease", "120", now=1010)
    s = q.show(1, now=1011)
    eq((s["state"], s["attempts"], s["lease_until"], s["run_at"]), ("running", "1/3", "1130", "1000"))
    s = q.show(1, now=1129)
    eq(s["state"], "running")


@test
def take_empty_queue(q):
    err(q("take"), 4, "error: no job ready")
    assert not os.path.exists(q.state), "take on empty queue created the state file"


# ---------------- fail / retry / dead ----------------

@test
def retry_exponential_backoff(q):
    q.add("job", "--max-attempts", "4", "--backoff", "10")
    q.take(now=1000)
    eq(q.ok("fail", "1", "--error", "boom", now=1005), "retry 1 at 1015\n")
    err(q("take", now=1014), 4)
    q.take(now=1015)
    eq(q.ok("fail", "1", now=1020), "retry 1 at 1040\n")
    q.take(now=1040)
    eq(q.ok("fail", "1", now=1041), "retry 1 at 1081\n")
    s = q.show(1, now=1041)
    eq((s["state"], s["attempts"], s["last_error"], s["lease_until"]), ("scheduled", "3/4", "failed", "-"))


@test
def retry_backoff_capped(q):
    q.add("job", "--max-attempts", "10", "--backoff", "3000")
    q.take(now=1000)
    eq(q.ok("fail", "1", now=1000), "retry 1 at 4000\n")
    q.take(now=4000)
    eq(q.ok("fail", "1", now=4001), "retry 1 at 7601\n")


@test
def retry_dead_after_max_attempts(q):
    q.add("job", "--max-attempts", "2", "--backoff", "5")
    q.take(now=1000)
    q.ok("fail", "1", now=1000)
    q.take(now=1005)
    eq(q.ok("fail", "1", "--error", "disk full", now=1006), "dead 1\n")
    s = q.show(1, now=1006)
    eq((s["state"], s["attempts"], s["last_error"], s["run_at"]), ("dead", "2/2", "disk full", "1005"))
    eq(q.list("--state", "dead", now=1006), [["1", "dead", "0", "2/2", "1005", "job"]])
    err(q("take", now=9999), 4)


@test
def retry_requeues_dead_job(q):
    q.add("job", "--max-attempts", "1")
    q.take()
    eq(q.ok("fail", "1"), "dead 1\n")
    eq(q.ok("retry", "1", now=2000), "requeued 1\n")
    s = q.show(1, now=2000)
    eq((s["state"], s["attempts"], s["run_at"]), ("ready", "0/1", "2000"))
    eq(q.take(now=2000)[0], "1")


@test
def retry_wrong_states(q):
    q.add("job")
    err(q("ack", "1"), 5, "error: job 1 is ready")
    err(q("fail", "1"), 5, "error: job 1 is ready")
    err(q("retry", "1"), 5, "error: job 1 is ready")
    q.take()
    err(q("retry", "1"), 5, "error: job 1 is running")
    err(q("cancel", "1"), 5, "error: job 1 is running")
    eq(q.ok("ack", "1"), "done 1\n")
    err(q("ack", "1"), 5, "error: job 1 is done")
    q.add("later", "--delay", "10")
    err(q("ack", "2"), 5, "error: job 2 is scheduled")


# ---------------- leases ----------------

@test
def lease_expiry_requeues(q):
    q.add("job", "--backoff", "7")
    q.take("--lease", "30", now=1000)
    s = q.show(1, now=1030)
    eq((s["state"], s["last_error"], s["run_at"], s["lease_until"]), ("scheduled", "lease expired", "1037", "-"))
    eq(q.take(now=1037)[0], "1")
    eq(q.show(1, now=1037)["attempts"], "2/3")


@test
def lease_expiry_before_command(q):
    q.add("job")
    q.take("--lease", "10", now=1000)
    err(q("ack", "1", now=1010), 5, "error: job 1 is scheduled")
    eq(q.ok("ack", "1", now=1009), "done 1\n")


@test
def lease_expiry_to_dead(q):
    q.add("job", "--max-attempts", "1")
    q.take("--lease", "5", now=1000)
    eq(q.list(now=2000), [["1", "dead", "0", "1/1", "1000", "job"]])
    eq(q.show(1, now=2000)["last_error"], "lease expired")


@test
def lease_expiry_order_and_takeover(q):
    q.add("a", "--priority", "1")
    q.add("b", "--priority", "2")
    q.take("--lease", "50", now=1000)   # b
    q.take("--lease", "20", now=1000)   # a
    # both expired at 1100: a fails at 1020 (retry 1030), b at 1050 (retry 1060)
    eq(q.list(now=1100), [["1", "ready", "1", "1/3", "1030", "a"], ["2", "ready", "2", "1/3", "1060", "b"]])
    eq(q.take(now=1100)[1], "b")


# ---------------- persistence ----------------

@test
def persist_state_survives_invocations(q):
    q.add("a", "--payload", "tab\there é")
    q.add("b")
    q.take()
    eq(q.take(), ["2", "b", ""])
    eq(q.show(1)["payload"], "tab\there é")
    eq(q.ok("ack", "2"), "done 2\n")
    eq(sorted(os.listdir(q.dir)), ["queue.state"])


@test
def persist_ids_not_reused(q):
    q.add("a")
    q.add("b")
    eq(q.ok("cancel", "2"), "cancelled 2\n")
    q.take()
    q.ok("ack", "1")
    eq(q.ok("purge"), "purged 1\n")
    eq(q.list(), [])
    eq(q.add("c"), 3)


@test
def persist_reads_do_not_write(q):
    for args in (["list"], ["stats"], ["show", "1"]):
        q(*args)
    assert not os.path.exists(q.state), "read-only command created the state file"
    q.add("a")
    before = open(q.state, "rb").read()
    mtime = os.stat(q.state).st_mtime_ns
    q.ok("list")
    q.ok("stats")
    q.ok("show", "1")
    err(q("take", "--lease", "0"), 2)
    err(q("ack", "1"), 5)
    eq(open(q.state, "rb").read(), before, "state bytes")
    eq(os.stat(q.state).st_mtime_ns, mtime, "state mtime")


@test
def persist_failed_command_discards_expiry(q):
    q.add("job")
    q.take("--lease", "10", now=1000)
    before = open(q.state, "rb").read()
    err(q("show", "99", now=5000), 1)
    eq(open(q.state, "rb").read(), before, "state bytes after failing command")
    eq(q.show(1, now=1005)["state"], "running")


@test
def persist_corrupt_state(q):
    with open(q.state, "wb") as f:
        f.write(b"\x00not a queue\xff")
    for args in (["list"], ["add", "a"], ["take"]):
        err(q(*args), 3, f"error: cannot load state: {q.state}")
    eq(open(q.state, "rb").read(), b"\x00not a queue\xff")


@test
def persist_unwritable_location(q):
    r = q("add", "a", env={"JOBQ_STATE": os.path.join(q.dir, "missing", "s")})
    err(r, 3, f"error: cannot save state: {os.path.join(q.dir, 'missing', 's')}")
    r = q("stats", env={"JOBQ_STATE": q.dir})
    err(r, 3, f"error: cannot load state: {q.dir}")


@test
def persist_default_state_path(q):
    e = dict(os.environ)
    e.pop("JOBQ_STATE", None)
    e["JOBQ_NOW"] = "1000"
    p = subprocess.run([BIN, "add", "a"], capture_output=True, timeout=60, env=e, cwd=q.dir)
    eq(p.returncode, 0, "exit code")
    assert os.path.exists(os.path.join(q.dir, "jobq.state")), "jobq.state not created in cwd"


# ---------------- list / show ----------------

@test
def query_list_filters(q):
    q.add("r1")
    q.add("s1", "--delay", "100")
    q.add("r2", "--priority", "1")
    q.take()
    eq(q.list("--state", "ready"), [["1", "ready", "0", "0/3", "1000", "r1"]])
    eq(q.list("--state", "scheduled"), [["2", "scheduled", "0", "0/3", "1100", "s1"]])
    eq(q.list("--state", "running"), [["3", "running", "1", "1/3", "1000", "r2"]])
    eq(q.list("--state", "done"), [])
    # at 1100 the lease of r2 (until 1060) has expired: it failed at 1060 and is retried at 1070
    eq(q.list("--state", "ready", now=1100), [["1", "ready", "0", "0/3", "1000", "r1"],
                                              ["2", "ready", "0", "0/3", "1100", "s1"],
                                              ["3", "ready", "1", "1/3", "1070", "r2"]])
    err(q("list", "--state", "queued"), 2)


@test
def query_show_errors(q):
    err(q("show", "1"), 1, "error: job not found: 1")
    q.add("a")
    for args in (["show"], ["show", "0"], ["show", "abc"], ["show", "1", "2"], ["show", "-1"]):
        err(q(*args), 2)
    for cmd in ("ack", "fail", "retry", "cancel"):
        err(q(cmd, "42"), 1, "error: job not found: 42")


# ---------------- stats / purge ----------------

@test
def stats_empty(q):
    eq(q.stats(), {"ready": 0, "scheduled": 0, "running": 0, "done": 0, "dead": 0, "total": 0,
                   "next_run_at": "-", "oldest_ready_age": "-"})


@test
def stats_counts(q):
    q.add("old", "--at", "400")
    q.add("new")
    q.add("later", "--delay", "500")
    q.add("soon", "--delay", "20")
    q.add("dies", "--max-attempts", "1", "--priority", "9")
    q.add("runs", "--priority", "8")
    q.add("finished", "--priority", "7")
    q.take()
    q.ok("fail", "5")
    q.take()
    q.take()
    q.ok("ack", "7")
    eq(q.stats(), {"ready": 2, "scheduled": 2, "running": 1, "done": 1, "dead": 1, "total": 7,
                   "next_run_at": 1020, "oldest_ready_age": 600})


@test
def stats_purge(q):
    for name in ("a", "b", "c"):
        q.add(name)
    q.take()
    q.take()
    q.ok("ack", "1")
    q.ok("ack", "2")
    eq(q.ok("purge"), "purged 2\n")
    eq(q.ok("purge"), "purged 0\n")
    eq(q.stats()["total"], 1)
    eq([row[0] for row in q.list()], ["3"])


# ---------------- command line ----------------

@test
def cli_help(q):
    for flag in ("--help", "-h"):
        r = q(flag)
        eq(r.code, 0, "exit code")
        assert r.out.startswith("usage: jobq"), f"stdout {r.out[:60]!r}"


@test
def cli_usage_errors(q):
    for args in ([], ["frobnicate"], ["take", "extra"], ["take", "--lease", "86401"], ["stats", "--state", "dead"],
                 ["purge", "now"], ["ack"], ["fail", "1", "--error"], ["list", "--bogus"], ["--help", "add"]):
        err(q(*args), 2)
    assert not os.path.exists(q.state)


@test
def cli_invalid_now(q):
    for value in ("abc", "-5", "1.5", ""):
        err(q("stats", env={"JOBQ_NOW": value}), 2, "error: invalid JOBQ_NOW")


@test
def cli_system_clock(q):
    import time
    e = dict(os.environ)
    e.pop("JOBQ_NOW", None)
    e["JOBQ_STATE"] = q.state
    t0 = int(time.time())
    p = subprocess.run([BIN, "add", "a"], capture_output=True, timeout=60, env=e)
    eq(p.returncode, 0, "exit code")
    run_at = int(q.show(1, now=t0 + 100)["run_at"])
    assert t0 - 1 <= run_at <= int(time.time()) + 1, f"run_at {run_at} not near {t0}"


def run_one(fn):
    tmp = tempfile.mkdtemp(prefix="jobq-hidden-")
    try:
        fn(Q(tmp))
        return f"PASS {fn.__name__}"
    except Exception as e:  # noqa: BLE001
        msg = str(e) or traceback.format_exc(limit=1)
        return f"FAIL {fn.__name__}: {type(e).__name__}: {msg[:300]!r}"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    with ThreadPoolExecutor(max_workers=4) as pool:
        for line in pool.map(run_one, TESTS):
            print(line, flush=True)


if __name__ == "__main__":
    main()
