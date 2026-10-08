#!/usr/bin/env python3
"""Black-box tests for rotate. Usage: test_rotate.py /path/to/rotate
Prints one line per test: `PASS <name>` or `FAIL <name>: <reason>`."""
import datetime as dt
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import traceback

BIN = os.path.abspath(sys.argv[1])
TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


class R:
    def __init__(self, p):
        self.code, self.out, self.err = p.returncode, p.stdout.decode(), p.stderr.decode()


def run(args, now=None, cwd=None):
    env = {k: v for k, v in os.environ.items() if k != "ROTATE_NOW"}
    if now is not None:
        env["ROTATE_NOW"] = now
    p = subprocess.run([BIN, *args], capture_output=True, timeout=60, env=env, cwd=cwd)
    return R(p)


def eq(a, b, msg=""):
    assert a == b, f"{msg} expected {b!r}, got {a!r}"


def err(r, code, msg=None):
    eq(r.code, code, f"exit code (stderr {r.err!r})")
    eq(r.out, "", "stdout")
    assert r.err.startswith("error: "), f"stderr {r.err!r}"
    if msg is not None:
        eq(r.err.rstrip("\n"), "error: " + msg, "stderr")


class Env:
    def __init__(self, root):
        self.root = root
        self.src = os.path.join(root, "src")
        self.repo = os.path.join(root, "backups", "repo")
        os.makedirs(os.path.join(self.src, "sub", "empty"))
        self.write("a.txt", "hello\n")
        self.write("with space.txt", "spaces ok\n")
        self.write(".hidden", "dot\n")
        self.write("sub/app.log", "log line\n")
        self.write("sub/cache/tmp.bin", "cache\n")
        self.write("sub/run.sh", "#!/bin/sh\necho hi\n")
        os.chmod(os.path.join(self.src, "sub", "run.sh"), 0o755)
        os.symlink("a.txt", os.path.join(self.src, "link"))

    def write(self, rel, text):
        p = os.path.join(self.src, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write(text)

    def __call__(self, cmd, *args, now=None):
        return run([cmd, "--repo", self.repo, *args], now=now)

    def ok(self, cmd, *args, now=None):
        r = self(cmd, *args, now=now)
        assert r.code == 0, f"{cmd} {args}: exit {r.code}, stderr {r.err!r}"
        return r

    def snap(self, now, *extra):
        return self.ok("snapshot", *extra, self.src, now=now)

    def archive(self, sid):
        return os.path.join(self.repo, f"snap-{sid}.tar.gz")

    def fake(self, *ids):
        os.makedirs(self.repo, exist_ok=True)
        for sid in ids:
            open(self.archive(sid), "w").close()

    def snaps(self):
        if not os.path.isdir(self.repo):
            return []
        return sorted(n for n in os.listdir(self.repo) if n.startswith("snap-"))

    def lock(self):
        return os.path.join(self.repo, ".rotate.lock")


def members(path):
    with tarfile.open(path, "r:gz") as t:
        res = {}
        for m in t.getmembers():
            name = m.name[2:] if m.name.startswith("./") else m.name
            if name in ("", "."):
                continue
            res[name] = m
        return res


def sid(d):
    return d.strftime("%Y%m%dT%H%M%SZ")


def gfs_oracle(ids, daily, weekly, monthly):
    """Reference retention: ids newest first -> {id: [rules]}."""
    def key(rule, i):
        d = dt.datetime.strptime(i, "%Y%m%dT%H%M%SZ")
        if rule == "daily":
            return d.date()
        if rule == "weekly":
            return d.isocalendar()[:2]
        return (d.year, d.month)
    res = {i: [] for i in ids}
    for rule, n in (("daily", daily), ("weekly", weekly), ("monthly", monthly)):
        last, kept = None, 0
        for i in ids:
            if kept >= n:
                break
            k = key(rule, i)
            if k != last:
                res[i].append(rule)
                last, kept = k, kept + 1
    return res


def plan_text(ids, plan, dry):
    lines = [f"keep {i} {','.join(plan[i])}" if plan[i] else f"delete {i}" for i in ids]
    d = sum(1 for i in ids if not plan[i])
    lines.append(f"{'would delete' if dry else 'deleted'} {d} of {len(ids)} snapshots")
    return "\n".join(lines) + "\n"


# ---------------- snapshot ----------------

@test
def snap_creates_archive(e):
    r = e.snap("2026-03-01T14:30:05Z")
    eq(r.out, "created 20260301T143005Z\n")
    eq(e.snaps(), ["snap-20260301T143005Z.tar.gz"])
    m = members(e.archive("20260301T143005Z"))
    for name in ("a.txt", "with space.txt", ".hidden", "sub/app.log", "sub/empty", "link",
                 "sub/run.sh"):
        assert name in m, f"{name} missing from archive: {sorted(m)}"
    assert m["link"].issym(), "symlink not stored as symlink"
    assert m["sub/empty"].isdir()
    assert not any(n.startswith(("src/", "/")) or e.src.strip("/") in n for n in m), sorted(m)


@test
def snap_duplicate_id(e):
    e.snap("2026-03-01T12:00:00Z")
    before = os.path.getsize(e.archive("20260301T120000Z"))
    err(e("snapshot", e.src, now="2026-03-01T12:00:00Z"), 1,
        "snapshot already exists: 20260301T120000Z")
    eq(os.path.getsize(e.archive("20260301T120000Z")), before)
    assert not os.path.exists(e.lock()), "lock left behind"


@test
def snap_excludes(e):
    e.snap("2026-03-01T12:00:00Z", "--exclude", "*.log", "--exclude", "cache")
    m = members(e.archive("20260301T120000Z"))
    assert "sub/app.log" not in m and not any("cache" in n for n in m), sorted(m)
    assert "a.txt" in m and "sub/run.sh" in m


@test
def snap_source_errors(e):
    err(e("snapshot", os.path.join(e.root, "nope"), now="2026-03-01T12:00:00Z"), 3,
        f"source is not a directory: {os.path.join(e.root, 'nope')}")
    err(e("snapshot", os.path.join(e.src, "a.txt"), now="2026-03-01T12:00:00Z"), 3)
    eq(e.snaps(), [])


@test
def snap_invalid_now(e):
    for bad in ("2026-02-30T00:00:00Z", "2026-03-01 12:00:00", "2026-03-01T12:00:00",
                "2026-03-01T25:00:00Z", "1700000000", "now"):
        r = e("snapshot", e.src, now=bad)
        err(r, 2, f"invalid ROTATE_NOW: {bad}")
    eq(e.snaps(), [])


@test
def snap_system_clock(e):
    before = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    r = e.ok("snapshot", e.src)
    after = dt.datetime.now(dt.timezone.utc)
    got = dt.datetime.strptime(r.out.split()[1], "%Y%m%dT%H%M%SZ").replace(tzinfo=dt.timezone.utc)
    assert before - dt.timedelta(seconds=2) <= got <= after + dt.timedelta(seconds=2), r.out


@test
def snap_no_temp_files_and_repo_created(e):
    assert not os.path.exists(e.repo)
    e.snap("2026-03-01T12:00:00Z")
    e.snap("2026-03-02T12:00:00Z")
    eq(sorted(os.listdir(e.repo)), ["snap-20260301T120000Z.tar.gz", "snap-20260302T120000Z.tar.gz"])


@test
def snap_tar_failure_cleans_up(e):
    if os.geteuid() == 0:
        return  # root can read everything
    p = os.path.join(e.src, "locked.txt")
    with open(p, "w") as f:
        f.write("x")
    os.chmod(p, 0)
    try:
        r = e("snapshot", e.src, now="2026-03-01T12:00:00Z")
        err(r, 3)
        eq(os.listdir(e.repo) if os.path.isdir(e.repo) else [], [], "repo contents")
    finally:
        os.chmod(p, 0o644)


# ---------------- list ----------------

@test
def list_format(e):
    e.snap("2026-03-02T08:00:00Z")
    e.write("more.txt", "x" * 5000)
    e.snap("2026-03-01T23:59:59Z")
    lines = []
    for s, human in (("20260301T235959Z", "2026-03-01 23:59:59"),
                     ("20260302T080000Z", "2026-03-02 08:00:00")):
        lines.append(f"{s}\t{human}\t{os.path.getsize(e.archive(s))}")
    eq(e.ok("list").out, "\n".join(lines) + "\n")


@test
def list_ignores_other_files(e):
    e.fake("20260101T000000Z", "20251231T235959Z")
    for name in ("snap-bad.tar.gz", "snap-20260101T000000Z.tar", "notes.txt",
                 ".snap-20260102T000000Z.tar.gz.partial", "snap-20260101T000000Z.tar.gz.bak"):
        open(os.path.join(e.repo, name), "w").close()
    os.mkdir(os.path.join(e.repo, "snap-20260103T000000Z.tar.gz.d"))
    eq(e.ok("list").out, "20251231T235959Z\t2025-12-31 23:59:59\t0\n"
                         "20260101T000000Z\t2026-01-01 00:00:00\t0\n")


@test
def list_empty_and_missing(e):
    os.makedirs(e.repo)
    eq(e.ok("list").out, "")
    shutil.rmtree(e.repo)
    err(e("list"), 3, f"repository not found: {e.repo}")


# ---------------- prune ----------------

SMALL = ["20260301T120000Z", "20260301T060000Z", "20260228T120000Z", "20260222T120000Z",
         "20260215T120000Z", "20260131T120000Z", "20251231T120000Z"]


@test
def prune_small_plan_exact(e):
    e.fake(*SMALL)
    r = e.ok("prune", "--keep-daily", "2", "--keep-weekly", "2", "--keep-monthly", "2", "--dry-run")
    eq(r.out, "keep 20260301T120000Z daily,weekly,monthly\n"
              "delete 20260301T060000Z\n"
              "keep 20260228T120000Z daily,monthly\n"
              "keep 20260222T120000Z weekly\n"
              "delete 20260215T120000Z\n"
              "delete 20260131T120000Z\n"
              "delete 20251231T120000Z\n"
              "would delete 4 of 7 snapshots\n")
    eq(len(e.snaps()), 7, "dry run deleted files")


@test
def prune_deletes(e):
    e.fake(*SMALL)
    r = e.ok("prune", "--keep-monthly", "3", "--keep-daily", "1", "--keep-weekly", "0")
    eq(r.out, "keep 20260301T120000Z daily,monthly\n"
              "delete 20260301T060000Z\n"
              "keep 20260228T120000Z monthly\n"
              "delete 20260222T120000Z\n"
              "delete 20260215T120000Z\n"
              "keep 20260131T120000Z monthly\n"
              "delete 20251231T120000Z\n"
              "deleted 4 of 7 snapshots\n")
    eq(e.snaps(), ["snap-20260131T120000Z.tar.gz", "snap-20260228T120000Z.tar.gz",
                   "snap-20260301T120000Z.tar.gz"])
    assert not os.path.exists(e.lock())


@test
def prune_defaults_long_history(e):
    start = dt.datetime(2025, 6, 1, 3, 0, 0)
    ids = []
    for i in range(300):  # daily at 03:00, plus a second one every 5th day
        d = start + dt.timedelta(days=i)
        ids.append(sid(d))
        if i % 5 == 0:
            ids.append(sid(d + dt.timedelta(hours=15, minutes=30)))
    e.fake(*ids)
    ids.sort(reverse=True)
    expected = plan_text(ids, gfs_oracle(ids, 7, 4, 6), dry=False)
    r = e.ok("prune")
    eq(r.out, expected)
    kept = sorted(f"snap-{i}.tar.gz" for i, rules in gfs_oracle(ids, 7, 4, 6).items() if rules)
    eq(e.snaps(), kept)


@test
def prune_sparse_days_counted_by_snapshot(e):
    # Gaps between snapshots: "3 days" means 3 days that have snapshots.
    ids = ["20260310T100000Z", "20260301T100000Z", "20260215T100000Z", "20260101T100000Z"]
    e.fake(*ids)
    r = e.ok("prune", "--keep-daily", "3", "--keep-weekly", "0", "--keep-monthly", "0")
    eq(r.out, "keep 20260310T100000Z daily\nkeep 20260301T100000Z daily\n"
              "keep 20260215T100000Z daily\ndelete 20260101T100000Z\ndeleted 1 of 4 snapshots\n")


@test
def prune_iso_week_year_boundary(e):
    # 2020-12-31 (Thu) and 2021-01-03 (Sun) are both in ISO week 2020-W53;
    # 2019-12-30 (Mon) is in 2020-W01, as is 2020-01-05.
    ids = ["20210103T000000Z", "20201231T000000Z", "20200105T000000Z", "20191230T000000Z"]
    e.fake(*ids)
    r = e.ok("prune", "--keep-daily", "0", "--keep-weekly", "4", "--keep-monthly", "0", "--dry-run")
    eq(r.out, "keep 20210103T000000Z weekly\ndelete 20201231T000000Z\n"
              "keep 20200105T000000Z weekly\ndelete 20191230T000000Z\n"
              "would delete 2 of 4 snapshots\n")


@test
def prune_other_files_untouched(e):
    e.fake("20260101T000000Z", "20260102T000000Z")
    keep = ["notes.txt", "snap-x.tar.gz"]
    for n in keep:
        open(os.path.join(e.repo, n), "w").close()
    r = e.ok("prune", "--keep-daily", "1", "--keep-weekly", "0", "--keep-monthly", "0")
    eq(r.out.splitlines()[-1], "deleted 1 of 2 snapshots")
    eq(sorted(os.listdir(e.repo)), ["notes.txt", "snap-20260102T000000Z.tar.gz", "snap-x.tar.gz"])


@test
def prune_usage_errors(e):
    e.fake(*SMALL)
    err(e("prune", "--keep-daily", "0", "--keep-weekly", "0", "--keep-monthly", "0"), 2,
        "nothing to keep")
    for args in (["--keep-daily", "-1"], ["--keep-weekly", "x"], ["--keep-monthly", "1.5"],
                 ["--keep-daily", ""], ["--keep-daily"], ["--dry-run", "--dry-run"],
                 ["--keep-daily", "1", "--keep-daily", "2"], ["extra"]):
        err(e("prune", *args), 2)
    eq(len(e.snaps()), 7)


@test
def prune_empty_and_missing(e):
    os.makedirs(e.repo)
    eq(e.ok("prune").out, "deleted 0 of 0 snapshots\n")
    eq(e.ok("prune", "--dry-run").out, "would delete 0 of 0 snapshots\n")
    shutil.rmtree(e.repo)
    err(e("prune"), 3, f"repository not found: {e.repo}")


# ---------------- restore ----------------

def same_tree(a, b):
    for dirpath, dirnames, filenames in os.walk(a):
        rel = os.path.relpath(dirpath, a)
        other = os.path.join(b, rel)
        assert os.path.isdir(other), f"missing dir {rel}"
        for n in filenames:
            pa, pb = os.path.join(dirpath, n), os.path.join(other, n)
            if os.path.islink(pa):
                assert os.path.islink(pb) and os.readlink(pb) == os.readlink(pa), f"link {n}"
                continue
            with open(pa, "rb") as fa, open(pb, "rb") as fb:
                assert fa.read() == fb.read(), f"content of {rel}/{n}"
            eq(os.stat(pb).st_mode & 0o777, os.stat(pa).st_mode & 0o777, f"mode of {n}")
        for n in dirnames:
            if os.path.islink(os.path.join(dirpath, n)):
                assert os.path.islink(os.path.join(other, n))


@test
def restore_roundtrip(e):
    e.snap("2026-03-01T12:00:00Z")
    target = os.path.join(e.root, "out", "deep", "restored")
    r = e.ok("restore", "20260301T120000Z", target)
    eq(r.out, f"restored 20260301T120000Z to {target}\n")
    same_tree(e.src, target)
    same_tree(target, e.src)


@test
def restore_latest(e):
    e.snap("2026-03-01T12:00:00Z")
    e.write("new.txt", "newer\n")
    e.snap("2026-03-02T12:00:00Z")
    target = os.path.join(e.root, "out")
    eq(e.ok("restore", "latest", target).out, f"restored 20260302T120000Z to {target}\n")
    assert os.path.isfile(os.path.join(target, "new.txt"))
    t2 = os.path.join(e.root, "old")
    e.ok("restore", "20260301T120000Z", t2)
    assert not os.path.exists(os.path.join(t2, "new.txt"))


@test
def restore_into_empty_dir(e):
    e.snap("2026-03-01T12:00:00Z")
    target = os.path.join(e.root, "empty-target")
    os.mkdir(target)
    e.ok("restore", "latest", target)
    assert os.path.isfile(os.path.join(target, "a.txt"))
    eq(sorted(os.listdir(e.root)), ["backups", "empty-target", "src"], "leftovers")


@test
def restore_target_not_empty(e):
    e.snap("2026-03-01T12:00:00Z")
    target = os.path.join(e.root, "busy")
    os.mkdir(target)
    open(os.path.join(target, ".keep"), "w").close()
    err(e("restore", "latest", target), 1, f"target not empty: {target}")
    eq(os.listdir(target), [".keep"])
    f = os.path.join(e.root, "afile")
    open(f, "w").close()
    err(e("restore", "latest", f), 1, f"target not empty: {f}")


@test
def restore_not_found_and_invalid(e):
    e.snap("2026-03-01T12:00:00Z")
    t = os.path.join(e.root, "t")
    err(e("restore", "20260301T120001Z", t), 1, "snapshot not found: 20260301T120001Z")
    for bad in ("2026-03-01", "20260301T120000", "snap-20260301T120000Z.tar.gz", "LATEST"):
        err(e("restore", bad, t), 2, f"invalid snapshot id: {bad}")
    assert not os.path.exists(t)


@test
def restore_latest_empty_and_missing_repo(e):
    os.makedirs(e.repo)
    t = os.path.join(e.root, "t")
    err(e("restore", "latest", t), 1, "snapshot not found: latest")
    shutil.rmtree(e.repo)
    err(e("restore", "latest", t), 3, f"repository not found: {e.repo}")
    assert not os.path.exists(t)


@test
def restore_damaged_archive(e):
    e.fake("20260301T120000Z")
    with open(e.archive("20260301T120000Z"), "wb") as f:
        f.write(b"\x1f\x8b\x08\x00garbage-that-is-not-a-gzip-stream" * 10)
    outdir = os.path.join(e.root, "outs")
    os.mkdir(outdir)
    t = os.path.join(outdir, "t")
    err(e("restore", "latest", t), 3)
    eq(os.listdir(outdir), [], "leftover files")


# ---------------- locking ----------------

def dead_pid():
    p = subprocess.Popen(["true"])
    p.wait()
    return p.pid


@test
def lock_live_blocks_snapshot(e):
    os.makedirs(e.repo)
    with open(e.lock(), "w") as f:
        f.write(f"{os.getpid()}\n")
    err(e("snapshot", e.src, now="2026-03-01T12:00:00Z"), 4,
        f"repository is locked by pid {os.getpid()}")
    eq(e.snaps(), [])
    with open(e.lock()) as f:
        eq(f.read(), f"{os.getpid()}\n", "lock file changed")


@test
def lock_live_blocks_prune(e):
    e.fake(*SMALL)
    with open(e.lock(), "w") as f:
        f.write(f"{os.getpid()}\n")
    err(e("prune", "--keep-daily", "1"), 4)
    err(e("prune", "--dry-run"), 4)
    eq(len(e.snaps()), 7)


@test
def lock_stale_replaced(e):
    for content in (f"{dead_pid()}\n", "garbage\n", ""):
        os.makedirs(e.repo, exist_ok=True)
        with open(e.lock(), "w") as f:
            f.write(content)
        r = e("prune", "--dry-run")
        eq(r.code, 0, f"exit with stale lock {content!r} (stderr {r.err!r})")
        assert "warning: removing stale lock" in r.err, r.err
        assert not os.path.exists(e.lock()), "lock not removed"
    e.fake()
    with open(e.lock(), "w") as f:
        f.write("12345678901\n")
    r = e("snapshot", e.src, now="2026-03-01T12:00:00Z")
    eq(r.out, "created 20260301T120000Z\n")
    assert not os.path.exists(e.lock())


@test
def lock_held_while_running(e):
    # The lock file holds the PID of the running process; observe it with a slow source.
    fifo_dir = os.path.join(e.root, "slow")
    os.makedirs(fifo_dir)
    big = os.path.join(fifo_dir, "big.bin")
    with open(big, "wb") as f:
        f.write(os.urandom(1024 * 1024) * 16)
    env = dict(os.environ, ROTATE_NOW="2026-03-01T12:00:00Z")
    p = subprocess.Popen([BIN, "snapshot", "--repo", e.repo, fifo_dir], env=env,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    seen = None
    for _ in range(2000):
        if os.path.exists(e.lock()):
            try:
                with open(e.lock()) as f:
                    seen = f.read()
            except FileNotFoundError:
                pass
            if seen:
                break
        if p.poll() is not None:
            break
        time.sleep(0.002)
    p.communicate(timeout=60)
    eq(p.returncode, 0)
    if seen:  # may finish before we look on a fast machine
        eq(seen.strip(), str(p.pid), "lock content")
    assert not os.path.exists(e.lock())


@test
def lock_not_used_by_list_and_restore(e):
    e.snap("2026-03-01T12:00:00Z")
    with open(e.lock(), "w") as f:
        f.write(f"{os.getpid()}\n")
    e.ok("list")
    e.ok("restore", "latest", os.path.join(e.root, "t"))
    assert os.path.exists(e.lock()), "lock of another process removed"


@test
def lock_released_on_error(e):
    e.snap("2026-03-01T12:00:00Z")
    err(e("snapshot", e.src, now="2026-03-01T12:00:00Z"), 1)
    assert not os.path.exists(e.lock())
    eq(sorted(os.listdir(e.repo)), ["snap-20260301T120000Z.tar.gz"])


# ---------------- command line ----------------

@test
def cli_help(e):
    for flag in ("--help", "-h"):
        r = run([flag])
        eq(r.code, 0)
        assert r.out.startswith("usage: rotate"), r.out[:80]


@test
def cli_usage_errors(e):
    err(run([]), 2)
    err(run(["frobnicate"]), 2)
    err(run(["list"]), 2)                                   # missing --repo
    err(run(["snapshot", e.src]), 2)
    err(e("list", "extra"), 2)
    err(e("snapshot"), 2)
    err(e("snapshot", e.src, e.src), 2)
    err(e("restore", "latest"), 2)
    err(e("list", "--bogus"), 2)
    err(e("list", "--exclude", "x"), 2)                      # option of another command
    err(run(["list", "--repo", e.repo, "--repo", e.repo]), 2)
    err(run(["list", "--repo"]), 2)
    assert not os.path.exists(e.repo), "repo created on usage error"


@test
def cli_option_order(e):
    r = run(["snapshot", e.src, "--exclude", "*.log", "--repo", e.repo], now="2026-03-01T12:00:00Z")
    eq((r.code, r.out), (0, "created 20260301T120000Z\n"))
    assert "sub/app.log" not in members(e.archive("20260301T120000Z"))
    t = os.path.join(e.root, "t")
    r = run(["restore", "latest", t, "--repo", e.repo])
    eq(r.code, 0, r.err)
    r = run(["prune", "--dry-run", "--repo", e.repo, "--keep-daily", "1"])
    eq(r.out, "keep 20260301T120000Z daily,weekly,monthly\nwould delete 0 of 1 snapshots\n")


@test
def cli_runs_from_any_directory(e):
    r = run(["snapshot", "--repo", "rel-repo", "src"], now="2026-03-01T12:00:00Z", cwd=e.root)
    eq((r.code, r.out), (0, "created 20260301T120000Z\n"), r.err)
    assert os.path.isfile(os.path.join(e.root, "rel-repo", "snap-20260301T120000Z.tar.gz"))
    r = run(["list", "--repo", "rel-repo"], cwd=e.root)
    assert r.out.startswith("20260301T120000Z\t"), r.out


def main():
    for fn in TESTS:
        tmp = tempfile.mkdtemp(prefix="rotate-hidden-")
        try:
            fn(Env(tmp))
            print(f"PASS {fn.__name__}", flush=True)
        except Exception as ex:  # noqa: BLE001
            msg = str(ex) or traceback.format_exc(limit=1)
            print(f"FAIL {fn.__name__}: {type(ex).__name__}: {msg[:300]!r}", flush=True)
        finally:
            for dirpath, dirnames, _ in os.walk(tmp):
                for d in dirnames:
                    try:
                        os.chmod(os.path.join(dirpath, d), 0o755)
                    except OSError:
                        pass
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
