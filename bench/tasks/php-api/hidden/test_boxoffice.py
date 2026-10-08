#!/usr/bin/env python3
"""Black-box HTTP tests for boxoffice. Usage: test_boxoffice.py PHP_BIN REPO SERVER_LOG
Starts `php -S` with the repository's front controller (fresh database per test) and prints
one line per test: `PASS <name>` or `FAIL <name>: <reason>`."""
import calendar
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.error
import urllib.request

PHP, REPO, LOG = sys.argv[1], os.path.abspath(sys.argv[2]), sys.argv[3]
TESTS = []
NOW = "2026-05-01T10:00:00Z"
EVENT = {"name": "Night Show", "venue": "Main Hall", "starts_at": "2026-06-01T20:00:00Z",
         "capacity": 10, "price_cents": 2500}


def test(fn):
    TESTS.append(fn)
    return fn


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Resp:
    def __init__(self, status, headers, raw):
        self.status, self.headers, self.raw = status, headers, raw
        try:
            self.json = json.loads(raw.decode() or "null")
        except ValueError:
            self.json = None

    def header(self, name):
        return self.headers.get(name)

    @property
    def code(self):
        try:
            return self.json["error"]["code"]
        except (TypeError, KeyError):
            return None


class Server:
    def __init__(self, db):
        self.db = db
        self.proc = None

    def start(self):
        self.port = free_port()
        env = dict(os.environ, BOXOFFICE_DB=self.db)
        log = open(LOG, "ab")
        self.proc = subprocess.Popen(
            [PHP, "-d", "display_errors=0", "-d", "log_errors=1", "-d", "error_reporting=E_ALL",
             "-S", f"127.0.0.1:{self.port}", "-t", "public", "public/index.php"],
            cwd=REPO, env=env, stdout=log, stderr=log)
        deadline = time.time() + 10
        while time.time() < deadline:
            try:
                socket.create_connection(("127.0.0.1", self.port), timeout=0.2).close()
                return self
            except OSError:
                time.sleep(0.05)
        raise RuntimeError("server did not start")

    def stop(self):
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
            self.proc = None

    def req(self, method, path, body=None, headers=None, raw=None, clock=NOW):
        h = {"Content-Type": "application/json"}
        if clock is not None:
            h["X-Clock"] = clock
        h.update(headers or {})
        data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
        r = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method,
                                   headers=h)
        try:
            with urllib.request.urlopen(r, timeout=10) as resp:
                return Resp(resp.status, resp.headers, resp.read())
        except urllib.error.HTTPError as e:
            return Resp(e.code, e.headers, e.read())

    # helpers
    def event(self, **over):
        r = self.req("POST", "/events", {**EVENT, **over})
        eq(r.status, 201, f"create event {r.raw!r}")
        return r.json

    def hold(self, event_id, quantity, clock=NOW, **extra):
        r = self.req("POST", f"/events/{event_id}/holds", {"quantity": quantity, **extra}, clock=clock)
        eq(r.status, 201, f"create hold {r.raw!r}")
        return r.json

    def purchase(self, hold_id, email="fan@example.com", clock=NOW, headers=None):
        return self.req("POST", "/purchases", {"hold_id": hold_id, "email": email}, clock=clock,
                        headers=headers)

    def get(self, path, clock=NOW):
        r = self.req("GET", path, clock=clock)
        eq(r.status, 200, f"GET {path} {r.raw!r}")
        return r.json


def eq(a, b, msg=""):
    assert a == b, f"{msg} expected {b!r}, got {a!r}"


def err(r, status, code):
    eq(r.status, status, f"status ({r.raw[:200]!r})")
    eq(r.code, code, "error code")
    assert isinstance(r.json["error"].get("message"), str), "error.message missing"


def fields(r):
    err(r, 422, "validation_failed")
    return set(r.json["error"].get("fields", {}))


# ---------------- events ----------------

@test
def events_create_and_get(s):
    r = s.req("POST", "/events", {**EVENT, "name": "  Night Show  ", "extra": 1})
    eq(r.status, 201)
    eq(r.json, {"id": 1, "name": "Night Show", "venue": "Main Hall",
                "starts_at": "2026-06-01T20:00:00Z", "capacity": 10, "price_cents": 2500,
                "available": 10, "held": 0, "sold": 0})
    eq(s.get("/events/1"), r.json)
    eq(s.event()["id"], 2)


@test
def events_list_ordered(s):
    s.event(name="C", starts_at="2026-07-01T10:00:00Z")
    s.event(name="A", starts_at="2026-06-01T10:00:00Z")
    s.event(name="B", starts_at="2026-07-01T10:00:00Z")
    eq([e["name"] for e in s.get("/events")["events"]], ["A", "C", "B"])
    eq(s.get("/events/2")["name"], "A")


@test
def events_upcoming_filter(s):
    s.event(name="past", starts_at="2026-04-01T10:00:00Z")
    s.event(name="exact", starts_at=NOW)
    s.event(name="future", starts_at="2026-05-01T10:00:01Z")
    eq([e["name"] for e in s.get("/events?upcoming=1")["events"]], ["future"])
    eq(len(s.get("/events")["events"]), 3)


@test
def events_unknown_404(s):
    err(s.req("GET", "/events/42"), 404, "event_not_found")


@test
def events_validation_all_fields(s):
    r = s.req("POST", "/events", {"name": "   ", "capacity": "5"})
    eq(fields(r), {"name", "venue", "starts_at", "capacity", "price_cents"})


@test
def events_validation_types_and_ranges(s):
    bad = [("capacity", 0), ("capacity", 100001), ("capacity", 5.0), ("capacity", True),
           ("price_cents", -1), ("price_cents", 1000001), ("price_cents", "100"),
           ("starts_at", "2026-02-30T10:00:00Z"), ("starts_at", "2026-06-01 20:00:00"),
           ("starts_at", "2026-06-01T20:00:00+00:00"), ("name", "x" * 201), ("venue", 7)]
    for field, value in bad:
        eq(fields(s.req("POST", "/events", {**EVENT, field: value})), {field}, f"{field}={value!r}")
    eq(s.req("POST", "/events", {**EVENT, "capacity": 100000, "price_cents": 0,
                                 "name": "é" * 200}).status, 201)
    eq(len(s.get("/events")["events"]), 1)


# ---------------- holds ----------------

@test
def holds_create_counts(s):
    s.event(capacity=5)
    h = s.hold(1, 3)
    eq(h, {"id": 1, "event_id": 1, "quantity": 3, "status": "active",
           "expires_at": "2026-05-01T10:10:00Z", "created_at": NOW})
    e = s.get("/events/1")
    eq((e["available"], e["held"], e["sold"]), (2, 3, 0))
    eq(s.get("/holds/1"), h)


@test
def holds_insufficient_seats(s):
    s.event(capacity=5)
    s.hold(1, 4)
    err(s.req("POST", "/events/1/holds", {"quantity": 2}), 409, "insufficient_seats")
    s.hold(1, 1)
    err(s.req("POST", "/events/1/holds", {"quantity": 1}), 409, "insufficient_seats")


@test
def holds_validation(s):
    s.event()
    for q in (0, 11, "2", 2.5, None):
        eq(fields(s.req("POST", "/events/1/holds", {"quantity": q})), {"quantity"}, f"q={q!r}")
    for ttl in (59, 3601, "600"):
        eq(fields(s.req("POST", "/events/1/holds", {"quantity": 1, "ttl_seconds": ttl})),
           {"ttl_seconds"}, f"ttl={ttl!r}")
    eq(s.hold(1, 10, ttl_seconds=60)["expires_at"], "2026-05-01T10:01:00Z")


@test
def holds_expiry_frees_seats(s):
    s.event(capacity=4)
    s.hold(1, 3, ttl_seconds=120)
    eq(s.get("/holds/1", clock="2026-05-01T10:01:59Z")["status"], "active")
    eq(s.get("/holds/1", clock="2026-05-01T10:02:00Z")["status"], "expired")
    e = s.get("/events/1", clock="2026-05-01T10:02:00Z")
    eq((e["available"], e["held"]), (4, 0))
    eq(s.hold(1, 4, clock="2026-05-01T10:02:00Z")["id"], 2)


@test
def holds_event_closed_and_unknown(s):
    s.event(starts_at="2026-05-01T12:00:00Z")
    err(s.req("POST", "/events/1/holds", {"quantity": 1}, clock="2026-05-01T12:00:00Z"),
        409, "event_closed")
    err(s.req("POST", "/events/9/holds", {"quantity": 1}), 404, "event_not_found")
    err(s.req("GET", "/holds/9"), 404, "hold_not_found")


@test
def holds_release(s):
    s.event(capacity=3)
    s.hold(1, 2)
    r = s.req("DELETE", "/holds/1")
    eq(r.status, 200)
    eq(r.json["status"], "released")
    eq(s.get("/events/1")["available"], 3)
    err(s.req("DELETE", "/holds/1"), 409, "hold_not_active")
    err(s.req("DELETE", "/holds/7"), 404, "hold_not_found")
    s.hold(1, 1, ttl_seconds=60)
    err(s.req("DELETE", "/holds/2", clock="2026-05-01T10:05:00Z"), 409, "hold_not_active")


# ---------------- purchases ----------------

@test
def purchase_success(s):
    s.event(capacity=10, price_cents=1250)
    s.hold(1, 4)
    r = s.purchase(1, clock="2026-05-01T10:05:00Z")
    eq(r.status, 201, r.raw)
    eq(r.json, {"id": 1, "event_id": 1, "hold_id": 1, "email": "fan@example.com", "quantity": 4,
                "amount_cents": 5000, "refunded_quantity": 0, "refunded_cents": 0, "status": "paid",
                "created_at": "2026-05-01T10:05:00Z", "refunds": []})
    eq(s.get("/purchases/1"), r.json)
    eq(s.get("/holds/1")["status"], "purchased")
    e = s.get("/events/1", clock="2026-05-01T11:00:00Z")
    eq((e["available"], e["held"], e["sold"]), (6, 0, 4))


@test
def purchase_hold_states(s):
    s.event()
    s.hold(1, 1, ttl_seconds=60)
    err(s.purchase(1, clock="2026-05-01T10:01:00Z"), 409, "hold_expired")
    s.hold(1, 1)
    s.req("DELETE", "/holds/2")
    err(s.purchase(2), 409, "hold_not_active")
    s.hold(1, 1)
    eq(s.purchase(3).status, 201)
    err(s.purchase(3), 409, "hold_not_active")
    err(s.purchase(99), 404, "hold_not_found")
    err(s.req("GET", "/purchases/5"), 404, "purchase_not_found")


@test
def purchase_validation(s):
    s.event()
    s.hold(1, 1)
    for email in ("nope", "a@b", "@b.co", "a@.co", "a@co.", "a b@c.de", "a@b@c.de", "x" * 250 + "@b.co", 5):
        eq(fields(s.purchase(1, email=email)), {"email"}, f"email={email!r}")
    eq(fields(s.req("POST", "/purchases", {})), {"hold_id", "email"})
    eq(fields(s.req("POST", "/purchases", {"hold_id": "1", "email": "a@b.co"})), {"hold_id"})
    eq(s.purchase(1, email="a.b+c@x.y.co").status, 201)


# ---------------- refunds ----------------

@test
def refund_partial_then_rest(s):
    s.event(capacity=10, price_cents=1500)
    s.hold(1, 3)
    s.purchase(1)
    r = s.req("POST", "/purchases/1/refunds", {"quantity": 1}, clock="2026-05-02T09:00:00Z")
    eq(r.status, 201, r.raw)
    eq(r.json, {"id": 1, "purchase_id": 1, "quantity": 1, "amount_cents": 1500,
                "created_at": "2026-05-02T09:00:00Z"})
    p = s.get("/purchases/1")
    eq((p["status"], p["refunded_quantity"], p["refunded_cents"]), ("partially_refunded", 1, 1500))
    eq(s.get("/events/1")["available"], 8)
    r = s.req("POST", "/purchases/1/refunds", raw=b"")
    eq(r.status, 201, r.raw)
    eq((r.json["id"], r.json["quantity"], r.json["amount_cents"]), (2, 2, 3000))
    p = s.get("/purchases/1")
    eq((p["status"], p["refunded_quantity"], p["refunded_cents"]), ("refunded", 3, 4500))
    eq([x["id"] for x in p["refunds"]], [1, 2])
    e = s.get("/events/1")
    eq((e["available"], e["sold"]), (10, 0))


@test
def refund_errors(s):
    s.event(capacity=10, starts_at="2026-05-10T20:00:00Z")
    s.hold(1, 2)
    s.purchase(1)
    err(s.req("POST", "/purchases/1/refunds", {"quantity": 3}), 409, "refund_exceeds_purchase")
    eq(fields(s.req("POST", "/purchases/1/refunds", {"quantity": 0})), {"quantity"})
    err(s.req("POST", "/purchases/9/refunds", {}), 404, "purchase_not_found")
    err(s.req("POST", "/purchases/1/refunds", {}, clock="2026-05-10T20:00:00Z"), 409, "event_closed")
    eq(s.req("POST", "/purchases/1/refunds", {}).status, 201)
    err(s.req("POST", "/purchases/1/refunds", {"quantity": 1}), 409, "already_refunded")


@test
def refund_frees_seats_for_new_holds(s):
    s.event(capacity=2)
    s.hold(1, 2)
    s.purchase(1)
    err(s.req("POST", "/events/1/holds", {"quantity": 1}), 409, "insufficient_seats")
    s.req("POST", "/purchases/1/refunds", {"quantity": 1})
    eq(s.hold(1, 1)["id"], 2)


# ---------------- idempotency ----------------

@test
def idem_purchase_replay(s):
    s.event(capacity=5)
    s.hold(1, 2)
    k = {"Idempotency-Key": "order-123"}
    a = s.purchase(1, headers=k)
    eq(a.status, 201)
    b = s.req("POST", "/purchases", raw=b'{ "email" : "fan@example.com", "hold_id": 1 }',
              headers=k, clock="2026-05-01T11:00:00Z")
    eq(b.status, 201, b.raw)
    eq(b.json, a.json)
    eq(b.header("Idempotent-Replayed"), "true")
    assert a.header("Idempotent-Replayed") is None, "first response must not be marked replayed"
    eq(s.get("/events/1")["sold"], 2)


@test
def idem_replay_ignores_state_changes(s):
    s.event(capacity=5)
    s.hold(1, 2)
    k = {"Idempotency-Key": "p1"}
    first = s.purchase(1, headers=k)
    s.req("POST", "/purchases/1/refunds", {})
    again = s.purchase(1, headers=k)
    eq(again.status, 201)
    eq(again.json, first.json)
    eq(s.get("/purchases/1")["status"], "refunded")


@test
def idem_error_responses_are_stored(s):
    s.event()
    s.hold(1, 1, ttl_seconds=60)
    k = {"Idempotency-Key": "late"}
    err(s.purchase(1, clock="2026-05-01T10:05:00Z", headers=k), 409, "hold_expired")
    r = s.purchase(1, headers=k)  # the hold would be active at this clock, but the key replays
    err(r, 409, "hold_expired")
    eq(r.header("Idempotent-Replayed"), "true")


@test
def idem_key_reuse_rejected(s):
    s.event()
    s.hold(1, 1)
    s.hold(1, 1)
    k = {"Idempotency-Key": "same"}
    eq(s.purchase(1, headers=k).status, 201)
    err(s.purchase(2, headers=k), 422, "idempotency_key_reused")
    err(s.req("POST", "/events", EVENT, headers=k), 422, "idempotency_key_reused")
    eq(s.get("/holds/2")["status"], "active")
    eq(len(s.get("/events")["events"]), 1)


@test
def idem_events_and_refunds(s):
    k = {"Idempotency-Key": "ev-1"}
    a = s.req("POST", "/events", EVENT, headers=k)
    b = s.req("POST", "/events", EVENT, headers=k)
    eq((a.status, b.status, b.json), (201, 201, a.json))
    eq(len(s.get("/events")["events"]), 1)
    s.req("POST", "/events", EVENT)
    s.req("POST", "/events", EVENT)
    eq(len(s.get("/events")["events"]), 3, "requests without a key are never deduplicated")
    s.hold(1, 4)
    s.purchase(1)
    rk = {"Idempotency-Key": "rf-1"}
    r1 = s.req("POST", "/purchases/1/refunds", {"quantity": 1}, headers=rk)
    r2 = s.req("POST", "/purchases/1/refunds", {"quantity": 1}, headers=rk)
    eq((r1.status, r2.status, r2.json), (201, 201, r1.json))
    eq(s.get("/purchases/1")["refunded_quantity"], 1)


@test
def idem_invalid_keys(s):
    s.event()
    for key in ("has space", "x" * 256, "tab\tkey"):
        err(s.req("POST", "/events", EVENT, headers={"Idempotency-Key": key}), 400,
            "invalid_idempotency_key")
    eq(s.req("POST", "/events", EVENT, headers={"Idempotency-Key": "~" * 255}).status, 201)
    eq(len(s.get("/events")["events"]), 2)


# ---------------- HTTP behaviour ----------------

@test
def http_not_found_and_bad_ids(s):
    s.event()
    for path in ("/", "/nope", "/events/abc", "/events/0", "/events/-1", "/events/1/holds/2",
                 "/holds/1.5"):
        err(s.req("GET", path), 404, "not_found")
    eq(s.get("/events/1?verbose=1")["id"], 1)


@test
def http_method_not_allowed(s):
    for method, path, allowed in (("DELETE", "/events", {"GET", "POST"}), ("PUT", "/events/1", {"GET"}),
                                  ("GET", "/purchases", {"POST"}), ("PATCH", "/holds/1", {"GET", "DELETE"})):
        r = s.req(method, path, {})
        err(r, 405, "method_not_allowed")
        got = {m.strip() for m in (r.header("Allow") or "").split(",") if m.strip()}
        eq(got, allowed, f"Allow for {method} {path}")


@test
def http_invalid_json(s):
    s.event()
    for raw in (b"{not json", b"[1,2]", b"42", b"", b'"str"'):
        err(s.req("POST", "/events", raw=raw), 400, "invalid_json")
    err(s.req("POST", "/events/1/holds", raw=b"[]"), 400, "invalid_json")


@test
def http_content_type_and_clock(s):
    for r in (s.req("GET", "/events"), s.req("GET", "/missing"), s.req("POST", "/events", raw=b"x")):
        assert (r.header("Content-Type") or "").startswith("application/json"), r.header("Content-Type")
        assert r.json is not None, f"body is not JSON: {r.raw[:100]!r}"
    for bad in ("2026-05-01", "2026-13-01T00:00:00Z", "yesterday", "2026-05-01T10:00:00.000Z"):
        err(s.req("GET", "/events", clock=bad), 400, "invalid_clock")


@test
def http_real_clock_without_header(s):
    r = s.req("POST", "/events", {**EVENT, "starts_at": "2099-01-01T00:00:00Z"}, clock=None)
    eq(r.status, 201)
    h = s.req("POST", "/events/1/holds", {"quantity": 1}, clock=None)
    eq(h.status, 201, h.raw)
    created = time.strptime(h.json["created_at"], "%Y-%m-%dT%H:%M:%SZ")

    assert abs(calendar.timegm(created) - time.time()) < 120, h.json["created_at"]


# ---------------- persistence ----------------

@test
def persist_across_restart(s):
    s.event(capacity=6)
    s.hold(1, 2)
    s.purchase(1, headers={"Idempotency-Key": "keep"})
    assert os.path.isfile(s.db), "database file not created at BOXOFFICE_DB"
    s.stop()
    s.start()
    e = s.get("/events/1")
    eq((e["sold"], e["available"]), (2, 4))
    r = s.purchase(1, headers={"Idempotency-Key": "keep"})
    eq((r.status, r.header("Idempotent-Replayed")), (201, "true"))
    eq(s.event()["id"], 2)


@test
def persist_separate_databases(s):
    s.event()
    other = Server(s.db + ".other.sqlite").start()
    try:
        eq(other.get("/events")["events"], [])
    finally:
        other.stop()


def main():
    for fn in TESTS:
        tmp = tempfile.mkdtemp(prefix="boxoffice-hidden-")
        s = Server(os.path.join(tmp, "db.sqlite"))
        try:
            s.start()
            fn(s)
            print(f"PASS {fn.__name__}", flush=True)
        except Exception as e:  # noqa: BLE001
            msg = str(e) or traceback.format_exc(limit=1)
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {msg[:300]!r}", flush=True)
        finally:
            s.stop()
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
