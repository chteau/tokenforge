#!/usr/bin/env python3
"""Black-box tests for logtally. Usage: test_logtally.py RUBY_BIN REPO
Runs `ruby REPO/bin/logtally ...` from a temporary working directory and prints one line per
test: `PASS <name>` or `FAIL <name>: <reason>`."""
import gzip
import json
import os
import shutil
import subprocess
import sys
import tempfile
import traceback

RUBY, REPO = sys.argv[1], os.path.abspath(sys.argv[2])
BIN = os.path.join(REPO, "bin", "logtally")
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
        assert self.out.endswith(b"\n"), f"JSON output must end with a newline: {self.out[-50:]!r}"
        return json.loads(self.out.decode("utf-8"))


class Env:
    def __init__(self, tmp):
        self.tmp = tmp

    def run(self, *args, stdin=b""):
        p = subprocess.run([RUBY, BIN, *args], input=stdin, capture_output=True, cwd=self.tmp,
                           timeout=30)
        return R(p)

    def ok(self, *args, stdin=b""):
        r = self.run(*args, stdin=stdin)
        assert r.code == 0, f"{args}: exit {r.code}, stderr {r.err[:300]!r}"
        return r

    def write(self, name, data):
        if isinstance(data, str):
            data = data.encode()
        with open(os.path.join(self.tmp, name), "wb") as f:
            f.write(data)
        return name


def line(path="/", status=200, time="10/Oct/2026:12:00:00 +0000", nbytes="100", rt="0.010",
         method="GET", ua="test-agent/1.0", proto="HTTP/1.1"):
    tail = "" if rt is None else f" {rt}"
    return f'192.0.2.1 - - [{time}] "{method} {path} {proto}" {status} {nbytes} "-" "{ua}"{tail}\n'


# Six valid requests (one without a request time) and one malformed line.
SAMPLE = "".join([
    line("/api/items?page=2", 200, "10/Oct/2026:13:55:36 +0200", "2326", "0.042"),
    line("/", 200, "10/Oct/2026:12:00:00 +0000", "512", "0.120"),
    line("/api/items", 404, "10/Oct/2026:12:01:00 +0000", "0", "0.300"),
    line("/api/items", 201, "10/Oct/2026:07:02:00 -0500", "-", "0.250", method="POST"),
    line("/health", 200, "10/Oct/2026:12:10:00 +0000", "2", None, proto="HTTP/1.0"),
    "this is not a log line\n",
    line("/", 500, "10/Oct/2026:12:05:00 +0000", "100", "1.500"),
])

SAMPLE_TEXT = """Requests: 6
Malformed lines: 1
Bytes: 2940
Time range: 2026-10-10T11:55:36Z .. 2026-10-10T12:10:00Z

Status codes:
  200 3 (50.0%)
  201 1 (16.7%)
  404 1 (16.7%)
  500 1 (16.7%)

Top paths:
  3 /api/items
  2 /
  1 /health

Latency (5 samples):
  p50 0.250
  p95 1.500
  p99 1.500
"""

EMPTY_TEXT = """Requests: 0
Malformed lines: 0
Bytes: 0
Time range: n/a

Status codes:
  (none)

Top paths:
  (none)

Latency: n/a
"""


def eq(a, b, msg=""):
    assert a == b, f"{msg} expected {b!r}, got {a!r}"


def close(a, b, msg=""):
    assert abs(a - b) < 1e-9, f"{msg} expected {b!r}, got {a!r}"


def usage(r, what=""):
    eq(r.code, 2, f"{what} exit code (stderr {r.err[:200]!r})")
    eq(r.out, b"", f"{what} stdout")
    assert r.err.startswith(b"error: "), f"{what} stderr {r.err!r}"


def requests(env, *args, stdin=None):
    return env.ok("--format", "json", *args, stdin=stdin if stdin is not None else b"").json["requests"]


# ---------------- parsing ----------------

@test
def parse_fields_and_timezones(env):
    env.write("a.log", SAMPLE)
    d = env.ok("--format", "json", "a.log").json
    eq((d["requests"], d["malformed"], d["bytes"]), (6, 1, 2940))
    eq(d["time_range"], {"first": "2026-10-10T11:55:36Z", "last": "2026-10-10T12:10:00Z"})


@test
def parse_optional_and_dash_request_time(env):
    data = line(rt=None) + line(rt="-") + line(rt="3") + line(rt="0.5")
    d = env.ok("--format", "json", stdin=data.encode()).json
    eq((d["requests"], d["malformed"], d["latency"]["samples"]), (4, 0, 2))
    close(d["latency"]["p99"], 3.0)


@test
def parse_escapes_and_invalid_utf8(env):
    data = (line(ua='Mozilla \\"quoted\\" agent').encode()
            + line(ua="bytes \xff\xfe here").encode("latin-1")
            + line(ua="back\\\\slash \\x22hex").encode()
            + line(path="/café").encode())
    d = env.ok("--format", "json", stdin=data).json
    eq((d["requests"], d["malformed"]), (4, 0))


@test
def parse_blank_lines_and_crlf(env):
    data = "\n" + line(path="/a").replace("\n", "\r\n") + "   \n\t\n" + line(path="/b", rt=None).replace("\n", "\r\n")
    d = env.ok("--format", "json", stdin=data.encode()).json
    eq((d["requests"], d["malformed"]), (2, 0))
    eq(sorted(p["path"] for p in d["top_paths"]), ["/a", "/b"])
    eq(d["latency"]["samples"], 1)


@test
def parse_malformed_variants(env):
    good = line()
    bad = [
        good.replace("Oct", "Okt"), good.replace("10/Oct", "31/Sep"), good.replace("12:00:00", "24:00:00"),
        good.replace(" 200 ", " 600 "), good.replace(" 200 ", " 099 "), good.replace(" 200 ", " 20 "),
        good.replace('"GET ', '"get '), good.replace(" HTTP/1.1", " FTP/1.1"), good.replace(" HTTP/1.1", ""),
        good.replace(" 100 ", " 1k "), good.replace(" 0.010", " fast"), good.replace(" 0.010", " 0.010 extra"),
        good.replace("192.0.2.1 - -", "192.0.2.1 -"), good.replace(" [", "  ["), good.replace("+0000", "UTC"),
        good.replace('"test-agent/1.0"', '"unterminated'), "-\n",
    ]
    env.write("bad.log", "".join(bad) + good)
    d = env.ok("--format", "json", "bad.log").json
    eq((d["requests"], d["malformed"]), (1, len(bad)))


@test
def parse_path_strips_query(env):
    data = line("/search?q=a?b") + line("/search") + line("/search/?x") + line("/a%20b?z")
    d = env.ok("--format", "json", stdin=data.encode()).json
    eq(d["top_paths"], [{"path": "/search", "count": 2}, {"path": "/a%20b", "count": 1},
                        {"path": "/search/", "count": 1}])


# ---------------- gzip ----------------

@test
def gzip_file_detected_by_magic(env):
    env.write("access.log.gz", gzip.compress(SAMPLE.encode(), mtime=0))
    env.write("rotated.1", gzip.compress(SAMPLE.encode(), mtime=0))
    env.write("plain.gz", SAMPLE)
    for name in ("access.log.gz", "rotated.1", "plain.gz"):
        eq(env.ok(name).text, SAMPLE_TEXT, name)


@test
def gzip_multi_member(env):
    a, b = SAMPLE.encode(), line("/extra").encode() * 3
    env.write("multi.gz", gzip.compress(a, mtime=0) + gzip.compress(b, mtime=0))
    d = env.ok("--format", "json", "multi.gz").json
    eq((d["requests"], d["malformed"]), (9, 1))
    eq(d["top_paths"][0], {"path": "/api/items", "count": 3})
    eq(d["top_paths"][1], {"path": "/extra", "count": 3})


@test
def gzip_on_stdin(env):
    r = env.ok(stdin=gzip.compress(SAMPLE.encode(), mtime=0))
    eq(r.text, SAMPLE_TEXT)
    r = env.ok("--format", "json", "-", stdin=gzip.compress(SAMPLE.encode(), mtime=0) + gzip.compress(line().encode(), mtime=0))
    eq(r.json["requests"], 7)


@test
def gzip_corrupt_or_truncated(env):
    blob = gzip.compress((line() * 2000).encode(), mtime=0)
    env.write("trunc.gz", blob[: len(blob) // 2])
    mid = len(blob) // 2
    env.write("corrupt.gz", blob[:mid] + bytes(b ^ 0xFF for b in blob[mid:mid + 64]) + blob[mid + 64:])
    for name in ("trunc.gz", "corrupt.gz"):
        r = env.run(name)
        eq(r.code, 4, f"{name} exit")
        eq(r.out, b"", f"{name} stdout")
        assert r.err.startswith(f"error: cannot read {name}".encode()), r.err


# ---------------- filters ----------------

@test
def filter_time_window(env):
    env.write("a.log", SAMPLE)
    d = env.ok("--format", "json", "--since", "2026-10-10T12:01:00Z", "--until", "2026-10-10T14:05:00+02:00",
               "a.log").json
    eq((d["requests"], d["malformed"]), (2, 1))
    eq(d["time_range"], {"first": "2026-10-10T12:01:00Z", "last": "2026-10-10T12:02:00Z"})
    eq(requests(env, "--since", "2026-10-10T13:55:36+02:00", "a.log"), 6)
    eq(requests(env, "--since", "2026-10-10T07:05:00-05:00", "a.log"), 2)
    eq(requests(env, "--since", "2026-10-11", "a.log"), 0)
    eq(requests(env, "--until", "2026-10-11", "a.log"), 6)
    eq(requests(env, "--until", "2026-10-10T11:55:36Z", "a.log"), 0)


@test
def filter_status(env):
    env.write("a.log", SAMPLE)
    eq(requests(env, "--status", "2xx,404", "a.log"), 5)
    eq(requests(env, "--status", "500", "a.log"), 1)
    eq(requests(env, "--status", "3xx", "a.log"), 0)
    d = env.ok("--format", "json", "--status", "1xx,201,5xx", "a.log").json
    eq(d["status"], {"201": 1, "500": 1})
    eq(d["malformed"], 1, "malformed lines are counted regardless of filters")


@test
def filter_path_globs(env):
    data = "".join(line(p) for p in ("/api/v1/users/42", "/api/v2", "/health", "/", "/img/a.png",
                                     "/img/b.PNG", "/x/.env"))
    env.write("p.log", data)
    eq(requests(env, "--path", "/api/*", "p.log"), 2)
    eq(requests(env, "--path", "/api/*/42", "p.log"), 1)
    eq(requests(env, "--path", "*", "p.log"), 7)
    eq(requests(env, "--path", "/*.png", "p.log"), 1)
    eq(requests(env, "--path", "/api/v?", "p.log"), 1)
    eq(requests(env, "--path", "/[a-h]*", "p.log"), 3)
    eq(requests(env, "--path", "/health", "--path", "/", "p.log"), 2)
    eq(requests(env, "--path", "/x/*", "p.log"), 1)
    eq(requests(env, "--path", "/api", "p.log"), 0)


@test
def filter_combined(env):
    env.write("a.log", SAMPLE)
    d = env.ok("--format", "json", "--path", "/api/*", "--status", "2xx", "--since", "2026-10-10", "a.log").json
    eq((d["requests"], d["bytes"]), (2, 2326))
    eq(d["status"], {"200": 1, "201": 1})


# ---------------- text report ----------------

@test
def report_text_exact(env):
    env.write("a.log", SAMPLE)
    r = env.ok("a.log")
    eq(r.text, SAMPLE_TEXT)
    eq(r.err, b"warning: skipped 1 malformed line(s)\n")


@test
def report_empty_exact(env):
    r = env.ok(stdin=b"")
    eq(r.text, EMPTY_TEXT)
    eq(r.err, b"", "no warning without malformed lines")
    env.write("a.log", SAMPLE)
    r = env.ok("--status", "3xx", "a.log")
    eq(r.text, EMPTY_TEXT.replace("Malformed lines: 0", "Malformed lines: 1"))


@test
def report_top_paths_order_and_limit(env):
    counts = {"/b": 3, "/a": 3, "/c": 1, "/Z": 1, "/d": 2}
    data = "".join(line(p) * n for p, n in counts.items())
    r = env.ok("--top", "4", stdin=data.encode())
    section = r.text.split("Top paths:\n")[1].split("\n\n")[0]
    eq(section, "  3 /a\n  3 /b\n  2 /d\n  1 /Z")
    d = env.ok("--format", "json", "--top", "1", stdin=data.encode()).json
    eq(d["top_paths"], [{"path": "/a", "count": 3}])
    eq(len(env.ok("--format", "json", stdin=("".join(line(f"/p{i}") for i in range(15))).encode())
           .json["top_paths"]), 10)


@test
def report_percentages_and_multiple_files(env):
    env.write("one.log", line(status=200) * 2)
    env.write("two.log", line(status=404) + line(status=301, nbytes="7"))
    r = env.ok("one.log", "two.log")
    assert "Status codes:\n  200 2 (50.0%)\n  301 1 (25.0%)\n  404 1 (25.0%)\n" in r.text, r.text
    assert "Requests: 4\n" in r.text and "Bytes: 307\n" in r.text, r.text
    r = env.ok(stdin=(line(status=200) * 2 + line(status=500)).encode())
    assert "  200 2 (66.7%)\n  500 1 (33.3%)\n" in r.text, r.text


# ---------------- latency ----------------

@test
def latency_nearest_rank(env):
    def lat(values):
        data = "".join(line(rt=v) for v in values)
        return env.ok("--format", "json", stdin=data.encode()).json["latency"]

    l20 = lat([f"0.{i:03d}" for i in range(20, 0, -1)])
    eq(l20["samples"], 20)
    for k, v in (("p50", 0.010), ("p95", 0.019), ("p99", 0.020)):
        close(l20[k], v, k)
    l200 = lat([f"{i / 1000:.3f}" for i in range(1, 201)])
    for k, v in (("p50", 0.100), ("p95", 0.190), ("p99", 0.198)):
        close(l200[k], v, k)
    l7 = lat(["7", "1", "6", "2", "5", "3", "4"])
    for k, v in (("p50", 4.0), ("p95", 7.0), ("p99", 7.0)):
        close(l7[k], v, k)
    l1 = lat(["0.5"])
    eq((l1["samples"], l1["p50"], l1["p99"]), (1, 0.5, 0.5))


@test
def latency_text_format(env):
    data = line(rt="2") + line(rt="0.0005") + line(rt=None)
    r = env.ok(stdin=data.encode())
    assert r.text.endswith("Latency (2 samples):\n  p50 0.001\n  p95 2.000\n  p99 2.000\n") or \
        r.text.endswith("Latency (2 samples):\n  p50 0.000\n  p95 2.000\n  p99 2.000\n"), r.text
    r = env.ok(stdin=line(rt=None).encode())
    assert r.text.endswith("\n\nLatency: n/a\n"), r.text


@test
def latency_respects_filters(env):
    data = line("/fast", rt="0.010") * 5 + line("/slow", rt="9.000", status=500)
    d = env.ok("--format", "json", "--status", "2xx", stdin=data.encode()).json
    eq(d["latency"]["samples"], 5)
    close(d["latency"]["p99"], 0.010)


# ---------------- JSON ----------------

@test
def json_exact_document(env):
    env.write("a.log", SAMPLE)
    r = env.ok("--format", "json", "a.log")
    d = r.json
    eq(d, {"requests": 6, "malformed": 1, "bytes": 2940,
           "time_range": {"first": "2026-10-10T11:55:36Z", "last": "2026-10-10T12:10:00Z"},
           "status": {"200": 3, "201": 1, "404": 1, "500": 1},
           "top_paths": [{"path": "/api/items", "count": 3}, {"path": "/", "count": 2},
                         {"path": "/health", "count": 1}],
           "latency": {"samples": 5, "p50": 0.25, "p95": 1.5, "p99": 1.5}})
    pairs = json.loads(r.out, object_pairs_hook=lambda kv: kv)
    status = dict(pairs)["status"]
    eq([k for k, _ in status], ["200", "201", "404", "500"], "status key order")


@test
def json_empty_document(env):
    d = env.ok("--format", "json", stdin=b"\n\n").json
    eq(d, {"requests": 0, "malformed": 0, "bytes": 0, "time_range": None, "status": {},
           "top_paths": [], "latency": None})


@test
def json_invalid_utf8_path(env):
    data = line("/caf\xe9").encode("latin-1") + line("/ok✓").encode()
    d = env.ok("--format", "json", stdin=data).json
    eq(sorted(p["path"] for p in d["top_paths"]), ["/caf�", "/ok✓"])
    t = env.ok(stdin=data).text
    assert "  1 /caf�\n" in t, t


# ---------------- errors ----------------

@test
def errors_strict_mode(env):
    env.write("good.log", line() * 2)
    env.write("bad.log", line() + "\n" + "broken\n" + line())
    r = env.run("--strict", "good.log", "bad.log")
    eq(r.code, 3)
    eq(r.out, b"")
    eq(r.err, b"error: bad.log:3: malformed line\n")
    r = env.run("--strict", stdin=("\n" * 4 + "nope\n").encode())
    eq((r.code, r.err), (3, b"error: -:5: malformed line\n"))
    eq(env.ok("--strict", "good.log").text.splitlines()[0], "Requests: 2")


@test
def errors_skip_warning(env):
    data = "junk\n" + line() + "more junk\n"
    r = env.ok(stdin=data.encode())
    eq(r.err, b"warning: skipped 2 malformed line(s)\n")
    assert r.text.startswith("Requests: 1\nMalformed lines: 2\n"), r.text


@test
def errors_usage(env):
    cases = [["--bogus"], ["--format"], ["--format", "xml"], ["--top", "0"], ["--top", "-3"], ["--top", "ten"],
             ["--status", "6xx"], ["--status", "20"], ["--status", "200,"], ["--status", "2xx3"],
             ["--since", "2026-13-01"], ["--since", "2026-10-10T25:00:00Z"], ["--until", "yesterday"],
             ["--since", "2026-10-10T12:00:00Z", "--until", "2026-10-10T12:00:00Z"],
             ["--since", "2026-10-11", "--until", "2026-10-10"]]
    for args in cases:
        usage(env.run(*args, stdin=line().encode()), " ".join(args))


@test
def errors_io(env):
    env.write("ok.log", line())
    os.mkdir(os.path.join(env.tmp, "adir"))
    for args, name in ((["missing.log"], "missing.log"), (["ok.log", "missing.log"], "missing.log"),
                       (["adir"], "adir")):
        r = env.run(*args)
        eq(r.code, 4, f"{args} exit")
        eq(r.out, b"", f"{args} stdout")
        assert r.err.startswith(f"error: cannot read {name}".encode()), r.err


# ---------------- command line ----------------

@test
def cli_help(env):
    for flag in ("--help", "-h"):
        r = env.ok(flag)
        assert r.out.startswith(b"Usage: logtally"), r.out[:80]


@test
def cli_stdin_and_dash(env):
    env.write("a.log", SAMPLE)
    eq(env.ok(stdin=SAMPLE.encode()).text, SAMPLE_TEXT)
    d = env.ok("--format", "json", "a.log", "-", stdin=line("/from-stdin").encode()).json
    eq(d["requests"], 7)
    assert {"path": "/from-stdin", "count": 1} in d["top_paths"]


@test
def cli_last_option_wins_and_absolute_paths(env):
    p = os.path.join(env.tmp, "a.log")
    env.write("a.log", SAMPLE)
    d = json.loads(env.ok("--format", "text", "--format", "json", "--top", "5", "--top", "1", p).out)
    eq(len(d["top_paths"]), 1)
    r = subprocess.run([RUBY, BIN, p], capture_output=True, cwd="/", timeout=30)
    eq(r.stdout.decode(), SAMPLE_TEXT)


def main():
    for fn in TESTS:
        tmp = tempfile.mkdtemp(prefix="logtally-hidden-")
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
