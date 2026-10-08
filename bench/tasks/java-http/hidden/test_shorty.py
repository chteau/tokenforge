#!/usr/bin/env python3
"""Black-box tests for the shorty URL shortener. Usage: test_shorty.py /path/to/shorty.jar
Prints one line per test: `PASS <name>` or `FAIL <name>: <reason>`."""
import calendar
import http.client
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback

JAR = os.path.abspath(sys.argv[1])
JAVA = os.environ.get("JAVA", "java")
TESTS = []
TS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
LINK_KEYS = {"code", "url", "short_url", "created_at", "expires_at", "hits", "expired"}


def test(fn):
    TESTS.append(fn)
    return fn


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Resp:
    def __init__(self, r):
        self.status = r.status
        self.headers = {k.lower(): v for k, v in r.getheaders()}
        self.raw = r.read()

    @property
    def json(self):
        ctype = self.headers.get("content-type", "")
        assert ctype.lower().replace(" ", "") == "application/json;charset=utf-8", \
            f"content-type {ctype!r}"
        return json.loads(self.raw.decode("utf-8"))


class Server:
    def __init__(self, root, data=None, extra=()):
        self.root = root
        self.data = data or os.path.join(root, "links.json")
        self.port = free_port()
        self.extra = list(extra)
        self.proc = None

    def start(self):
        self.proc = subprocess.Popen(
            [JAVA, "-jar", JAR, "--port", str(self.port), "--data", self.data, *self.extra],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        deadline = time.time() + 20
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise AssertionError(f"server exited {self.proc.returncode}: "
                                     f"{self.proc.stderr.read()[:300]!r}")
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.5):
                    return self
            except OSError:
                time.sleep(0.05)
        raise AssertionError("server did not start listening")

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        if self.proc:
            self.proc.stdout.close()
            self.proc.stderr.close()

    def restart(self):
        self.stop()
        self.port = free_port()
        return self.start()

    def req(self, method, path, body=None, headers=None, raw=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = dict(headers or {})
        data = raw
        if body is not None:
            data = json.dumps(body).encode()
            h.setdefault("Content-Type", "application/json")
        try:
            conn.request(method, path, body=data, headers=h)
            return Resp(conn.getresponse())
        finally:
            conn.close()

    def create(self, url, expect=201, **fields):
        r = self.req("POST", "/api/links", {"url": url, **fields})
        assert r.status == expect, f"create {url!r} {fields}: {r.status} {r.raw[:200]!r}"
        return r.json

    def error(self, r, status, message):
        assert r.status == status, f"expected {status}, got {r.status} {r.raw[:200]!r}"
        eq(r.json, {"error": message}, "error body")


def eq(a, b, msg=""):
    assert a == b, f"{msg} expected {b!r}, got {a!r}"


def check_link(link, url=None):
    eq(set(link), LINK_KEYS, "link keys")
    assert TS.match(link["created_at"]), link["created_at"]
    assert link["expires_at"] is None or TS.match(link["expires_at"]), link["expires_at"]
    if url is not None:
        eq(link["url"], url, "url")


# ---------------- creating links ----------------

@test
def create_generated_code(s):
    link = s.create("https://example.com/some/page?x=1")
    check_link(link, "https://example.com/some/page?x=1")
    assert re.fullmatch(r"[A-Za-z0-9]{7}", link["code"]), link["code"]
    eq(link["short_url"], f"http://localhost:{s.port}/{link['code']}")
    eq((link["hits"], link["expired"], link["expires_at"]), (0, False, None))


@test
def create_custom_code(s):
    link = s.create("http://a.example", code="My_code-1")
    eq(link["code"], "My_code-1")
    s.error(s.req("POST", "/api/links", {"url": "http://b.example", "code": "My_code-1"}),
            409, "code already exists")


@test
def create_dedupes_same_url(s):
    a = s.create("https://dup.example/x")
    b = s.create("https://dup.example/x", expect=200)
    eq(b["code"], a["code"])
    c = s.create("https://dup.example/x", code="other")  # custom code: always new
    eq(c["code"], "other")
    d = s.create("https://dup.example/x", ttl_seconds=100)  # with ttl: always new
    assert d["code"] not in (a["code"], "other")
    e = s.create("https://dup.example/X")  # different url
    assert e["code"] != a["code"]


@test
def create_with_ttl(s):
    link = s.create("https://ttl.example", ttl_seconds=3600)
    created = time.strptime(link["created_at"], "%Y-%m-%dT%H:%M:%SZ")
    expires = time.strptime(link["expires_at"], "%Y-%m-%dT%H:%M:%SZ")
    eq(calendar.timegm(expires) - calendar.timegm(created), 3600, "ttl")
    assert abs(calendar.timegm(created) - time.time()) < 30, "created_at should be now"
    eq(link["expired"], False)


@test
def create_unique_codes_and_unicode(s):
    codes = {s.create(f"https://u.example/{i}")["code"] for i in range(20)}
    eq(len(codes), 20, "distinct codes")
    url = "https://例え.jp/パス?q=\"quoted\"&e=é"
    link = s.create(url)
    eq(link["url"], url)


@test
def create_base_url_option(tmp):
    s = Server(tmp, extra=["--base-url", "https://sho.rt/"]).start()
    try:
        link = s.create("https://x.example", code="abc")
        eq(link["short_url"], "https://sho.rt/abc")
    finally:
        s.stop()


# ---------------- validation ----------------

@test
def validate_bad_urls(s):
    for url in ["ftp://x.example", "example.com", "https://", "http:///path", "https://a b",
                "https://x\n", "", "https://x/" + "a" * 2040, 42, None, ["https://x"]]:
        s.error(s.req("POST", "/api/links", {"url": url}), 400, "invalid url")
    s.error(s.req("POST", "/api/links", {"code": "abc"}), 400, "invalid url")
    s.create("HTTPS://UPPER.example")
    s.create("https://x/" + "a" * 2038)  # exactly 2048 characters


@test
def validate_bad_codes(s):
    for code in ["ab", "a" * 33, "has space", "sl/ash", "api", "healthz", "émoji", 123, True]:
        s.error(s.req("POST", "/api/links", {"url": "https://x.example", "code": code}),
                400, "invalid code")
    s.create("https://x.example", code="a" * 32)
    s.create("https://y.example", code=None)


@test
def validate_bad_ttl(s):
    for ttl in [0, -5, 1.5, "60", 315360001, True]:
        s.error(s.req("POST", "/api/links", {"url": "https://x.example", "ttl_seconds": ttl}),
                400, "invalid ttl_seconds")
    s.create("https://x.example", ttl_seconds=315360000)


@test
def validate_bad_json(s):
    h = {"Content-Type": "application/json"}
    for raw in [b"", b"{", b"[1,2]", b'"str"', b"{'url': 'x'}", b'{"url": "https://x"} extra',
                b'{"url": "https://x",}']:
        s.error(s.req("POST", "/api/links", raw=raw, headers=h), 400, "invalid json")


@test
def validate_check_order(s):
    # url is checked before code, code before ttl
    s.error(s.req("POST", "/api/links", {"url": "nope", "code": "x", "ttl_seconds": 0}),
            400, "invalid url")
    s.error(s.req("POST", "/api/links", {"url": "https://x", "code": "x", "ttl_seconds": 0}),
            400, "invalid code")
    s.create("https://taken.example", code="taken")
    s.error(s.req("POST", "/api/links", {"url": "https://x", "code": "taken", "ttl_seconds": 0}),
            400, "invalid ttl_seconds")


@test
def validate_content_type_and_size(s):
    body = json.dumps({"url": "https://x.example"}).encode()
    s.error(s.req("POST", "/api/links", raw=body, headers={"Content-Type": "text/plain"}),
            415, "unsupported media type")
    s.error(s.req("POST", "/api/links", raw=body), 415, "unsupported media type")
    r = s.req("POST", "/api/links", raw=body,
              headers={"Content-Type": "Application/JSON; charset=utf-8"})
    eq(r.status, 201)
    big = json.dumps({"url": "https://x.example", "pad": "p" * 9000}).encode()
    s.error(s.req("POST", "/api/links", raw=big, headers={"Content-Type": "application/json"}),
            413, "payload too large")


@test
def validate_unknown_fields_ignored(s):
    link = s.create("https://x.example", note="hello", nested={"a": [1, 2, {"b": None}]})
    check_link(link, "https://x.example")


# ---------------- redirects ----------------

@test
def redirect_basic_and_hits(s):
    link = s.create("https://target.example/p?q=1", code="go1")
    for _ in range(3):
        r = s.req("GET", "/go1")
        eq(r.status, 302, "status")
        eq(r.headers.get("location"), "https://target.example/p?q=1", "Location")
    eq(s.req("GET", "/api/links/go1").json["hits"], 3, "hits")


@test
def redirect_unknown(s):
    s.error(s.req("GET", "/nosuchcode"), 404, "not found")
    s.error(s.req("GET", "/api/links/nosuchcode"), 404, "not found")


@test
def redirect_expired(s):
    s.create("https://soon.example", code="soon", ttl_seconds=1)
    s.create("https://later.example", code="later", ttl_seconds=600)
    time.sleep(2.2)
    s.error(s.req("GET", "/soon"), 410, "link expired")
    meta = s.req("GET", "/api/links/soon").json
    eq((meta["expired"], meta["hits"]), (True, 0))
    eq(s.req("GET", "/later").status, 302)
    eq(s.req("GET", "/api/links/later").json["expired"], False)
    # expired codes stay taken
    s.error(s.req("POST", "/api/links", {"url": "https://x", "code": "soon"}),
            409, "code already exists")


@test
def redirect_concurrent_hits(s):
    s.create("https://busy.example", code="busy")
    errors = []

    def worker():
        for _ in range(10):
            try:
                if s.req("GET", "/busy").status != 302:
                    errors.append("status")
            except Exception as e:  # noqa: BLE001
                errors.append(repr(e))
    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    eq(errors, [], "errors")
    eq(s.req("GET", "/api/links/busy").json["hits"], 80, "hits")


# ---------------- get / list / delete ----------------

@test
def manage_get_link(s):
    created = s.create("https://g.example", code="getme")
    got = s.req("GET", "/api/links/getme").json
    eq(got, created)


@test
def manage_list_pagination(s):
    codes = [s.create(f"https://l.example/{i}", code=f"code{i:02d}")["code"] for i in range(12)]
    r = s.req("GET", "/api/links").json
    eq(r["total"], 12)
    eq([l["code"] for l in r["links"]], codes)
    for l in r["links"]:
        check_link(l)
    r = s.req("GET", "/api/links?limit=5&offset=10").json
    eq((r["total"], [l["code"] for l in r["links"]]), (12, codes[10:]))
    r = s.req("GET", "/api/links?offset=50").json
    eq((r["total"], r["links"]), (12, []))


@test
def manage_list_limits(s):
    for i in range(3):
        s.create(f"https://m.example/{i}")
    eq(len(s.req("GET", "/api/links?limit=100").json["links"]), 3)
    for q in ["limit=0", "limit=101", "limit=abc", "limit=-1", "limit="]:
        s.error(s.req("GET", f"/api/links?{q}"), 400, "invalid limit")
    for q in ["offset=-1", "offset=x"]:
        s.error(s.req("GET", f"/api/links?{q}"), 400, "invalid offset")


@test
def manage_delete(s):
    s.create("https://d.example", code="delme")
    r = s.req("DELETE", "/api/links/delme")
    eq((r.status, r.raw), (204, b""))
    s.error(s.req("GET", "/delme"), 404, "not found")
    s.error(s.req("DELETE", "/api/links/delme"), 404, "not found")
    eq(s.req("GET", "/api/links").json["total"], 0)
    s.create("https://d2.example", code="delme")  # code is free again


# ---------------- stats ----------------

@test
def stats_empty(s):
    eq(s.req("GET", "/api/stats").json, {"total_links": 0, "total_hits": 0, "top": []})


@test
def stats_top_ordering(s):
    hits = {"aaa": 2, "bbb": 5, "ccc": 2, "ddd": 1, "eee": 3, "fff": 4, "ggg": 0}
    for code, n in hits.items():
        s.create(f"https://{code}.example", code=code)
        for _ in range(n):
            eq(s.req("GET", f"/{code}").status, 302)
    st = s.req("GET", "/api/stats").json
    eq((st["total_links"], st["total_hits"]), (7, 17))
    eq(st["top"], [{"code": c, "url": f"https://{c}.example", "hits": hits[c]}
                   for c in ["bbb", "fff", "eee", "aaa", "ccc"]])


@test
def stats_after_delete_and_expiry(s):
    s.create("https://a.example", code="one")
    s.create("https://b.example", code="two", ttl_seconds=2)
    eq(s.req("GET", "/one").status, 302)
    eq(s.req("GET", "/two").status, 302)
    s.req("DELETE", "/api/links/one")
    time.sleep(2.2)
    st = s.req("GET", "/api/stats").json
    eq((st["total_links"], st["total_hits"]), (1, 1))
    eq(st["top"], [{"code": "two", "url": "https://b.example", "hits": 1}])


# ---------------- persistence ----------------

@test
def persist_restart_keeps_links_and_hits(s):
    a = s.create("https://p.example/1", code="keep")
    b = s.create("https://p.example/2", ttl_seconds=999)
    for _ in range(4):
        s.req("GET", "/keep")
    s.req("DELETE", "/api/links/" + s.create("https://p.example/3")["code"])
    s.restart()
    got = s.req("GET", "/api/links").json
    eq([l["code"] for l in got["links"]], ["keep", b["code"]])
    k = got["links"][0]
    eq((k["hits"], k["created_at"], k["url"]), (4, a["created_at"], a["url"]))
    eq(got["links"][1]["expires_at"], b["expires_at"])
    eq(s.req("GET", "/keep").status, 302)


@test
def persist_file_format(s):
    s.create("https://f.example/ü\"q", code="fmt")
    s.req("GET", "/fmt")
    with open(s.data, encoding="utf-8") as f:
        doc = json.load(f)
    eq(len(doc["links"]), 1)
    e = doc["links"][0]
    eq((e["code"], e["url"], e["hits"], e["expires_at"]), ("fmt", "https://f.example/ü\"q", 1, None))
    assert TS.match(e["created_at"]), e
    leftovers = [n for n in os.listdir(os.path.dirname(s.data)) if n != os.path.basename(s.data)]
    eq(leftovers, [], "temporary files left behind")


@test
def persist_loads_handwritten_file(tmp):
    data = os.path.join(tmp, "nested", "dir", "seed.json")
    os.makedirs(os.path.dirname(data))
    with open(data, "w", encoding="utf-8") as f:
        f.write('{\n  "version": 1,\n  "links" : [\n'
                '    {"hits": 7, "expires_at": null, "url": "https://seed.example/\\u00e9\\/x",'
                ' "code": "seed", "created_at": "2026-01-02T03:04:05Z", "extra": [true, {}]},\n'
                '    {"code": "old", "url": "https://old.example", "created_at": "2020-01-01T00:00:00Z",'
                ' "expires_at": "2020-01-02T00:00:00Z", "hits": 0}\n  ]\n}\n')
    s = Server(tmp, data=data).start()
    try:
        r = s.req("GET", "/seed")
        eq((r.status, r.headers.get("location")), (302, "https://seed.example/é/x"))
        got = s.req("GET", "/api/links/seed").json
        eq((got["hits"], got["created_at"]), (8, "2026-01-02T03:04:05Z"))
        s.error(s.req("GET", "/old"), 410, "link expired")
        eq(s.create("https://seed.example/é/x", expect=200)["code"], "seed")
    finally:
        s.stop()


@test
def persist_missing_dir_created(tmp):
    data = os.path.join(tmp, "a", "b", "links.json")
    s = Server(tmp, data=data).start()
    try:
        s.create("https://x.example", code="mkd")
        assert os.path.isfile(data), "data file not created"
    finally:
        s.stop()


@test
def persist_corrupt_file_exits_1(tmp):
    for content in ['{"links": [', '{"nolinks": []}', '{"links": [{"code": "x"}]}', "garbage"]:
        data = os.path.join(tmp, "bad.json")
        with open(data, "w") as f:
            f.write(content)
        p = subprocess.run([JAVA, "-jar", JAR, "--port", str(free_port()), "--data", data],
                           capture_output=True, timeout=20)
        eq(p.returncode, 1, f"exit code for {content!r}")
        assert p.stderr.startswith(b"error: "), p.stderr[:200]


# ---------------- rate limiting ----------------

@test
def limit_rejects_over_quota(tmp):
    s = Server(tmp, extra=["--rate-limit", "3"]).start()
    try:
        s.create("https://r.example/1")
        s.error(s.req("POST", "/api/links", {"url": "bad"}), 400, "invalid url")  # counts too
        s.create("https://r.example/2")
        r = s.req("POST", "/api/links", {"url": "https://r.example/3"})
        s.error(r, 429, "rate limit exceeded")
        ra = r.headers.get("retry-after", "")
        assert ra.isdigit() and 1 <= int(ra) <= 60, f"Retry-After {ra!r}"
        # other endpoints are not limited
        eq(s.req("GET", "/api/links").status, 200)
    finally:
        s.stop()


@test
def limit_default_is_30(s):
    for i in range(30):
        s.create(f"https://q.example/{i}")
    s.error(s.req("POST", "/api/links", {"url": "https://q.example/x"}), 429,
            "rate limit exceeded")


@test
def limit_checked_first(tmp):
    s = Server(tmp, extra=["--rate-limit", "1"]).start()
    try:
        s.error(s.req("POST", "/api/links", raw=b"x", headers={"Content-Type": "text/plain"}),
                415, "unsupported media type")
        s.error(s.req("POST", "/api/links", raw=b"x", headers={"Content-Type": "text/plain"}),
                429, "rate limit exceeded")
    finally:
        s.stop()


# ---------------- HTTP basics and command line ----------------

@test
def http_health_and_unknown_paths(s):
    r = s.req("GET", "/healthz")
    eq((r.status, r.json), (200, {"status": "ok"}))
    for path in ["/", "/api", "/api/nothing", "/api/links/a/b", "/a/b"]:
        s.error(s.req("GET", path), 404, "not found")


@test
def http_method_not_allowed(s):
    s.create("https://x.example", code="mna")
    for method, path in [("PUT", "/api/links"), ("DELETE", "/api/links"), ("POST", "/api/stats"),
                         ("PUT", "/api/links/mna"), ("POST", "/healthz")]:
        s.error(s.req(method, path, raw=b""), 405, "method not allowed")


@test
def http_cli_errors(tmp):
    data = os.path.join(tmp, "d.json")
    for args in [[], ["--port", "8080"], ["--data", data], ["--port", "abc", "--data", data],
                 ["--port", "70000", "--data", data], ["--port", "8080", "--data", data, "--bogus", "1"]]:
        p = subprocess.run([JAVA, "-jar", JAR, *args], capture_output=True, timeout=20)
        eq(p.returncode, 2, f"exit code for {args}")
        assert p.stderr.startswith(b"error: "), p.stderr[:200]


@test
def http_listening_line(tmp):
    s = Server(tmp).start()
    try:
        line = s.proc.stdout.readline().decode().strip()
        eq(line, f"listening on http://127.0.0.1:{s.port}")
    finally:
        s.stop()


NEEDS_TMP = {"create_base_url_option", "persist_loads_handwritten_file", "persist_missing_dir_created",
             "persist_corrupt_file_exits_1", "limit_rejects_over_quota", "limit_checked_first",
             "http_cli_errors", "http_listening_line"}


def main():
    for fn in TESTS:
        tmp = tempfile.mkdtemp(prefix="shorty-hidden-")
        server = None
        try:
            if fn.__name__ in NEEDS_TMP:
                fn(tmp)
            else:
                server = Server(tmp).start()
                fn(server)
            print(f"PASS {fn.__name__}", flush=True)
        except Exception as e:  # noqa: BLE001
            msg = str(e) or traceback.format_exc(limit=1)
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {msg[:300]!r}", flush=True)
        finally:
            if server:
                server.stop()
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
