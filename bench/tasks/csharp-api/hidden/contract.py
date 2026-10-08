#!/usr/bin/env python3
"""Black-box HTTP contract tests for the library-loans API.

Usage: contract.py --dll PATH/LibraryApi.dll --out results.json
Every group runs against a freshly started server (same hidden seed, frozen clock),
so groups are independent. Writes {test_name: passed} to --out.
"""
from __future__ import annotations

import argparse
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
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SEED = HERE / "seed.json"
NOW = "2026-05-20T12:00:00Z"
NOW_DT = datetime(2026, 5, 20, 12, 0, 0, tzinfo=timezone.utc)
KEY = "dev-key"
BOOK_KEYS = {"id", "isbn", "title", "author", "year", "copies", "availableCopies"}
MEMBER_KEYS = {"id", "name", "email", "activeLoans", "totalFinesCents"}
LOAN_KEYS = {"id", "bookId", "memberId", "loanedAt", "dueAt", "returnedAt", "status", "daysOverdue", "fineCents"}
PAGE_KEYS = {"items", "page", "pageSize", "totalItems", "totalPages"}
VALIDATION_TITLE = "One or more validation errors occurred."

ARGS = None
WORK: Path


# ---------------------------------------------------------------- server control

def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    def __init__(self, extra_args=None, env=None, default_args=True):
        self.port = free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        args = ["dotnet", ARGS.dll, "--urls", self.base]
        if default_args:
            args += ["--seed", str(SEED), "--now", NOW]
        args += extra_args or []
        e = {k: v for k, v in os.environ.items() if not k.startswith("LIBRARY_")}
        e["ASPNETCORE_ENVIRONMENT"] = "Production"
        e.update(env or {})
        self.log = open(WORK / f"server-{self.port}.log", "w")
        self.proc = subprocess.Popen(args, cwd=WORK, env=e, stdout=self.log, stderr=subprocess.STDOUT)

    def wait_ready(self, timeout=40.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise AssertionError(f"server exited early with status {self.proc.returncode}")
            try:
                with urllib.request.urlopen(self.base + "/health", timeout=2) as r:
                    if r.status == 200:
                        return self
            except Exception:
                time.sleep(0.2)
        raise AssertionError("server did not become healthy")

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(5)
        self.log.close()


class Resp:
    def __init__(self, status, headers, body: bytes):
        self.status, self.headers, self.raw = status, headers, body

    @property
    def ctype(self) -> str:
        return (self.headers.get("Content-Type") or "").lower()

    def json(self):
        return json.loads(self.raw.decode("utf-8"))


SRV: Server


def req(method, path, body=None, key=None, raw: bytes | None = None, server=None) -> Resp:
    s = server or SRV
    data = raw
    headers = {}
    if body is not None:
        data = json.dumps(body).encode()
    if data is not None:
        headers["Content-Type"] = "application/json"
    if key is not None:
        headers["X-Api-Key"] = key
    if method in ("POST", "PUT") and data is None:
        data = b""
    r = urllib.request.Request(s.base + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return Resp(resp.status, resp.headers, resp.read())
    except urllib.error.HTTPError as e:
        return Resp(e.code, e.headers, e.read())


def get(path, **kw):
    return req("GET", path, **kw)


def post(path, body=None, key=KEY, **kw):
    return req("POST", path, body=body, key=key, **kw)


def delete(path, key=KEY, **kw):
    return req("DELETE", path, key=key, **kw)


# ---------------------------------------------------------------- assertions

def check(cond, msg="check failed"):
    if not cond:
        raise AssertionError(msg)


def ok_json(r: Resp, status=200):
    check(r.status == status, f"expected {status}, got {r.status}: {r.raw[:300]!r}")
    check(r.ctype.startswith("application/json"), f"content-type {r.ctype!r}")
    return r.json()


def problem(r: Resp, status: int, title: str | None = None, detail=False):
    check(r.status == status, f"expected {status}, got {r.status}: {r.raw[:300]!r}")
    check(r.ctype.startswith("application/problem+json"), f"content-type {r.ctype!r}")
    p = r.json()
    check(isinstance(p, dict), "problem body is not an object")
    check(p.get("status") == status, f"problem status {p.get('status')!r}")
    check(isinstance(p.get("type"), str) and p["type"], "problem type missing")
    check(isinstance(p.get("title"), str) and p["title"], "problem title missing")
    if title is not None:
        check(p["title"] == title, f"title {p['title']!r} != {title!r}")
    if detail:
        check(isinstance(p.get("detail"), str) and p["detail"].strip(), "problem detail missing")
    return p


def validation(r: Resp, keys: set[str] | None = None, contains: set[str] | None = None):
    p = problem(r, 400, VALIDATION_TITLE)
    errs = p.get("errors")
    check(isinstance(errs, dict), "errors object missing")
    for k, v in errs.items():
        check(isinstance(v, list) and v and all(isinstance(m, str) for m in v), f"errors[{k}] not a string array")
    if keys is not None:
        check(set(errs) == keys, f"error keys {sorted(errs)} != {sorted(keys)}")
    if contains is not None:
        check(contains <= set(errs), f"error keys {sorted(errs)} missing {sorted(contains - set(errs))}")
    return errs


def ts(value) -> datetime:
    check(isinstance(value, str), f"timestamp {value!r} is not a string")
    d = datetime.fromisoformat(value.replace("Z", "+00:00"))
    check(d.tzinfo is not None, f"timestamp {value!r} has no UTC designator")
    return d.astimezone(timezone.utc)


def ids(page) -> list[int]:
    return [x["id"] for x in page["items"]]


def location_is(r: Resp, path: str):
    loc = r.headers.get("Location") or ""
    check(loc == path or loc.endswith(path) and "://" in loc, f"Location {loc!r} != {path!r}")


def valid_book(**over):
    b = {"isbn": "9782222222222", "title": "New Arrivals", "author": "Lee Moran", "year": 2021, "copies": 2}
    b.update(over)
    return b


# ---------------------------------------------------------------- tests: health

def test_health_ok_and_frozen_clock():
    body = ok_json(get("/health"))
    check(body.get("status") == "ok", f"status {body.get('status')!r}")
    check(ts(body.get("now")) == NOW_DT, f"now {body.get('now')!r}")


# ---------------------------------------------------------------- tests: books list

def test_booklist_default_envelope():
    page = ok_json(get("/books"))
    check(set(page) >= PAGE_KEYS, f"keys {sorted(page)}")
    check((page["page"], page["pageSize"], page["totalItems"], page["totalPages"]) == (1, 10, 6, 1), str(page))
    check(ids(page) == [1, 2, 3, 4, 5, 6], str(ids(page)))
    b1 = page["items"][0]
    check(set(b1) == BOOK_KEYS, f"book keys {sorted(b1)}")
    check(b1 == {"id": 1, "isbn": "9781111111111", "title": "Moss and Stone", "author": "Petra Lind",
                 "year": 2004, "copies": 2, "availableCopies": 2}, str(b1))


def test_booklist_available_copies_from_unreturned_loans():
    by_id = {b["id"]: b["availableCopies"] for b in ok_json(get("/books"))["items"]}
    check(by_id == {1: 2, 2: 0, 3: 0, 4: 2, 5: 1, 6: 1}, str(by_id))


def test_booklist_pagination():
    page = ok_json(get("/books?pageSize=4&page=2"))
    check(ids(page) == [5, 6], str(ids(page)))
    check((page["page"], page["pageSize"], page["totalItems"], page["totalPages"]) == (2, 4, 6, 2), str(page))


def test_booklist_page_past_end():
    page = ok_json(get("/books?pageSize=4&page=3"))
    check(page["items"] == [], str(page["items"]))
    check((page["totalItems"], page["totalPages"]) == (6, 2), str(page))


def test_booklist_filter_author_case_insensitive():
    page = ok_json(get("/books?author=PETRA"))
    check(ids(page) == [1, 3] and page["totalItems"] == 2 and page["totalPages"] == 1, str(page))


def test_booklist_filter_available():
    check(ids(ok_json(get("/books?available=false"))) == [2, 3], "available=false")
    check(ids(ok_json(get("/books?available=true"))) == [1, 4, 5, 6], "available=true")
    check(ids(ok_json(get("/books?available=true&author=petra"))) == [1], "combined")


def test_booklist_empty_filters_ignored():
    page = ok_json(get("/books?author=&sort=&available=&page=&pageSize="))
    check(ids(page) == [1, 2, 3, 4, 5, 6] and page["pageSize"] == 10, str(page))


def test_booklist_no_match_zero_pages():
    page = ok_json(get("/books?author=nobody-at-all"))
    check(page["items"] == [] and page["totalItems"] == 0 and page["totalPages"] == 0, str(page))


def test_booklist_sort_title_ordinal_with_ties():
    check(ids(ok_json(get("/books?sort=title"))) == [3, 4, 1, 6, 5, 2], "sort=title")
    check(ids(ok_json(get("/books?sort=-title"))) == [2, 5, 1, 6, 4, 3], "sort=-title")


def test_booklist_sort_year_with_ties():
    check(ids(ok_json(get("/books?sort=year"))) == [2, 5, 1, 6, 3, 4], "sort=year")
    check(ids(ok_json(get("/books?sort=-year"))) == [3, 4, 6, 1, 5, 2], "sort=-year")
    check(ids(ok_json(get("/books?sort=-id&pageSize=2"))) == [6, 5], "sort=-id")


# ---------------------------------------------------------------- tests: query validation

def test_query_page_size_bounds():
    validation(get("/books?pageSize=0"), keys={"pageSize"})
    validation(get("/books?pageSize=51"), keys={"pageSize"})
    ok_json(get("/books?pageSize=50"))


def test_query_page_invalid():
    validation(get("/books?page=0"), keys={"page"})
    validation(get("/books?page=abc"), keys={"page"})


def test_query_sort_and_available_invalid():
    validation(get("/books?sort=price"), keys={"sort"})
    validation(get("/books?available=yes"), keys={"available"})


def test_query_multiple_errors_listed():
    validation(get("/books?page=-1&pageSize=x&sort=isbn"), keys={"page", "pageSize", "sort"})


def test_query_loans_params_invalid():
    validation(get("/loans?status=late"), keys={"status"})
    validation(get("/loans?memberId=abc"), keys={"memberId"})
    validation(get("/loans?bookId=0"), keys={"bookId"})


def test_query_unknown_params_ignored():
    check(ok_json(get("/books?colour=red"))["totalItems"] == 6, "unknown param")


# ---------------------------------------------------------------- tests: get by id

def test_get_book_by_id():
    b = ok_json(get("/books/3"))
    check(b == {"id": 3, "isbn": "9781111111135", "title": "Beacon Street", "author": "petra lindqvist",
                "year": 2015, "copies": 1, "availableCopies": 0}, str(b))


def test_get_loan_by_id():
    loan = ok_json(get("/loans/2"))
    check(set(loan) == LOAN_KEYS, f"loan keys {sorted(loan)}")
    check((loan["id"], loan["bookId"], loan["memberId"]) == (2, 2, 1), str(loan))
    check(ts(loan["loanedAt"]) == datetime(2026, 5, 1, 12, tzinfo=timezone.utc), "loanedAt")
    check(ts(loan["dueAt"]) == datetime(2026, 5, 15, 12, tzinfo=timezone.utc), "dueAt")
    check(loan["returnedAt"] is None, "returnedAt should be null")


def test_get_missing_ids_404():
    for path in ("/books/99", "/members/99", "/loans/99"):
        problem(get(path), 404, "Not Found", detail=True)


def test_get_non_numeric_ids_404():
    for path in ("/books/abc", "/loans/0", "/members/-1"):
        check(get(path).status == 404, path)


# ---------------------------------------------------------------- tests: problem details shape

def test_problem_not_found_shape():
    problem(get("/books/12345"), 404, "Not Found", detail=True)


def test_problem_conflict_shape():
    problem(post("/books", valid_book(isbn="9781111111111")), 409, "Conflict", detail=True)


def test_problem_validation_shape():
    validation(post("/books", valid_book(year=3000)), keys={"year"})


def test_problem_unauthorized_shape():
    problem(post("/members", {"name": "X", "email": "x@example.org"}, key=None), 401, "Unauthorized")


# ---------------------------------------------------------------- tests: authentication

def test_auth_missing_or_wrong_key():
    problem(post("/books", valid_book(), key=None), 401, "Unauthorized")
    problem(post("/books", valid_book(), key="wrong-key"), 401, "Unauthorized")
    problem(post("/loans", {"bookId": 5, "memberId": 4}, key="DEV-KEY"), 401, "Unauthorized")
    check(ok_json(get("/books"))["totalItems"] == 6, "nothing created")


def test_auth_checked_before_body():
    problem(post("/books", raw=b"{not json", key=None), 401, "Unauthorized")
    problem(post("/members", {}, key=None), 401, "Unauthorized")


def test_auth_checked_before_lookup():
    problem(delete("/books/999", key=None), 401, "Unauthorized")
    problem(post("/loans/999/return", key=None), 401, "Unauthorized")


def test_auth_write_routes_have_no_effect_without_key():
    problem(delete("/books/5", key=None), 401, "Unauthorized")
    ok_json(get("/books/5"))
    problem(post("/loans/2/return", key="nope"), 401, "Unauthorized")
    check(ok_json(get("/loans/2"))["returnedAt"] is None, "loan was returned without a key")


def test_auth_reads_need_no_key():
    for path in ("/health", "/books", "/books/1", "/members/1", "/loans", "/loans/1"):
        check(get(path).status == 200, path)


# ---------------------------------------------------------------- tests: book create

def test_bookcreate_created_with_location():
    r = post("/books", valid_book())
    b = ok_json(r, 201)
    check(b == {"id": 7, "isbn": "9782222222222", "title": "New Arrivals", "author": "Lee Moran",
                "year": 2021, "copies": 2, "availableCopies": 2}, str(b))
    location_is(r, "/books/7")
    check(ok_json(get("/books/7")) == b, "GET after create differs")
    check(ok_json(get("/books"))["totalItems"] == 7, "list total")


def test_bookcreate_ids_increment_and_strings_kept():
    a = ok_json(post("/books", valid_book(isbn="9783333333333", title="  Spaced Title ")), 201)
    b = ok_json(post("/books", valid_book(isbn="9784444444444", extra="ignored", id=99)), 201)
    check((a["id"], b["id"]) == (7, 8), f"ids {a['id']}, {b['id']}")
    check(a["title"] == "  Spaced Title ", repr(a["title"]))


def test_bookcreate_boundaries_accepted():
    b = ok_json(post("/books", valid_book(isbn="0000000000000", title="T" * 200, author="A" * 100,
                                         year=1450, copies=100)), 201)
    check(b["copies"] == 100 and b["year"] == 1450, str(b))
    ok_json(post("/books", valid_book(isbn="9785555555555", year=2100, copies=1)), 201)


def test_bookcreate_duplicate_isbn_conflict():
    problem(post("/books", valid_book(isbn="9781111111128")), 409, "Conflict", detail=True)
    ok_json(post("/books", valid_book()), 201)
    problem(post("/books", valid_book(title="Other")), 409, "Conflict", detail=True)
    check(ok_json(get("/books"))["totalItems"] == 7, "conflicting books stored")


# ---------------------------------------------------------------- tests: body validation

def test_validation_empty_object_lists_every_field():
    validation(post("/books", {}), keys={"isbn", "title", "author", "year", "copies"})
    validation(post("/members", {}), keys={"name", "email"})
    validation(post("/loans", {}), keys={"bookId", "memberId"})


def test_validation_only_failing_fields():
    validation(post("/books", valid_book(isbn="978-11111", copies=101)), keys={"isbn", "copies"})
    validation(post("/books", valid_book(title="T" * 201, year=1449)), keys={"title", "year"})
    validation(post("/books", valid_book(title="   ", author="A" * 101, copies=0)), keys={"title", "author", "copies"})
    validation(post("/books", valid_book(isbn="978222222222x", year=2101)), keys={"isbn", "year"})
    check(ok_json(get("/books"))["totalItems"] == 6, "invalid books stored")


def test_validation_member_fields():
    for email in ("no-at.example.org", "a@b@example.org", "@example.org", "a@example", "a@example.",
                  "a@.org", "a b@example.org", "x" * 250 + "@example.org"):
        validation(post("/members", {"name": "Valid Name", "email": email}), keys={"email"})
    validation(post("/members", {"name": " ", "email": "ok@example.org"}), keys={"name"})
    validation(post("/members", {"name": "N" * 101, "email": "ok@example.org"}), keys={"name"})
    ok_json(post("/members", {"name": "N" * 100, "email": "first.last@mail.example.org"}), 201)


def test_validation_loan_ids():
    validation(post("/loans", {"bookId": 0, "memberId": -1}), keys={"bookId", "memberId"})
    validation(post("/loans", {"bookId": 1}), keys={"memberId"})
    validation(post("/loans", {"bookId": -5, "memberId": 99}), keys={"bookId"})


def test_validation_malformed_body():
    for raw in (b"{not json", b"", b"[]", b"\"text\"", b"null"):
        problem(post("/books", raw=raw), 400)
    problem(post("/members", raw=b"{\"name\": "), 400)
    problem(post("/loans", raw=b"[1, 2]"), 400)


def test_validation_wrong_json_types():
    problem(post("/books", valid_book(year="2001")), 400)
    problem(post("/loans", {"bookId": "5", "memberId": 4}), 400)
    check(ok_json(get("/books"))["totalItems"] == 6, "book stored despite wrong type")


# ---------------------------------------------------------------- tests: members

def test_member_get_with_loan_summary():
    m = ok_json(get("/members/3"))
    check(m == {"id": 3, "name": "Cara Diaz", "email": "cara@example.org", "activeLoans": 1,
                "totalFinesCents": 75}, str(m))


def test_member_create():
    r = post("/members", {"name": "Eli Stone", "email": "Eli@Example.org"})
    m = ok_json(r, 201)
    check(m == {"id": 5, "name": "Eli Stone", "email": "Eli@Example.org", "activeLoans": 0,
                "totalFinesCents": 0}, str(m))
    location_is(r, "/members/5")
    check(ok_json(get("/members/5")) == m, "GET after create differs")


def test_member_duplicate_email_case_insensitive():
    problem(post("/members", {"name": "Other Ada", "email": "ADA@Example.ORG"}), 409, "Conflict", detail=True)
    ok_json(post("/members", {"name": "Fay", "email": "fay@example.org"}), 201)
    problem(post("/members", {"name": "Fay Two", "email": "Fay@example.org"}), 409, "Conflict", detail=True)


# ---------------------------------------------------------------- tests: book delete

def test_bookdelete_no_content_then_gone():
    r = delete("/books/5")
    check(r.status == 204, f"status {r.status}")
    check(r.raw == b"", f"body {r.raw[:100]!r}")
    problem(get("/books/5"), 404, "Not Found")
    check(5 not in ids(ok_json(get("/books"))), "still listed")
    problem(delete("/books/5"), 404, "Not Found", detail=True)


def test_bookdelete_missing_404():
    problem(delete("/books/77"), 404, "Not Found", detail=True)
    check(delete("/books/abc").status == 404, "non-numeric id")


def test_bookdelete_unreturned_loans_conflict():
    problem(delete("/books/3"), 409, "Conflict", detail=True)
    ok_json(get("/books/3"))


def test_bookdelete_keeps_returned_loans():
    check(delete("/books/1").status == 204, "delete book with only returned loans")
    loans = ok_json(get("/loans?bookId=1"))
    check(ids(loans) == [1, 5], str(ids(loans)))
    ok_json(get("/loans/5"))


# ---------------------------------------------------------------- tests: loan create

def test_loancreate_dates_from_clock():
    r = post("/loans", {"bookId": 5, "memberId": 4})
    loan = ok_json(r, 201)
    check(set(loan) == LOAN_KEYS, f"keys {sorted(loan)}")
    check((loan["id"], loan["bookId"], loan["memberId"]) == (6, 5, 4), str(loan))
    check(ts(loan["loanedAt"]) == NOW_DT, f"loanedAt {loan['loanedAt']}")
    check(ts(loan["dueAt"]) == NOW_DT + timedelta(days=14), f"dueAt {loan['dueAt']}")
    check(loan["returnedAt"] is None and loan["status"] == "active", str(loan))
    check(loan["daysOverdue"] == 0 and loan["fineCents"] == 0, str(loan))
    location_is(r, "/loans/6")
    check(ok_json(get("/loans/6")) == loan, "GET after create differs")


def test_loancreate_updates_counts():
    ok_json(post("/loans", {"bookId": 4, "memberId": 4}), 201)
    check(ok_json(get("/books/4"))["availableCopies"] == 1, "availableCopies not decremented")
    check(ok_json(get("/members/4"))["activeLoans"] == 1, "activeLoans not incremented")
    check(ok_json(get("/loans?memberId=4"))["totalItems"] == 1, "not listed")


# ---------------------------------------------------------------- tests: loan rules

def test_loanrules_unknown_member_or_book_404():
    problem(post("/loans", {"bookId": 1, "memberId": 99}), 404, "Not Found", detail=True)
    problem(post("/loans", {"bookId": 99, "memberId": 4}), 404, "Not Found", detail=True)


def test_loanrules_validation_before_lookup():
    validation(post("/loans", {"bookId": 0, "memberId": 99}), keys={"bookId"})


def test_loanrules_member_with_overdue_loan_blocked():
    problem(post("/loans", {"bookId": 5, "memberId": 1}), 409, "Conflict", detail=True)
    problem(post("/loans", {"bookId": 4, "memberId": 2}), 409, "Conflict", detail=True)
    check(ok_json(get("/books/5"))["availableCopies"] == 1, "copy consumed")


def test_loanrules_due_today_is_not_blocking():
    ok_json(post("/loans", {"bookId": 6, "memberId": 3}), 201)


def test_loanrules_three_unreturned_loans_limit():
    ok_json(post("/loans", {"bookId": 1, "memberId": 3}), 201)
    ok_json(post("/loans", {"bookId": 6, "memberId": 3}), 201)
    problem(post("/loans", {"bookId": 5, "memberId": 3}), 409, "Conflict", detail=True)
    check(ok_json(get("/members/3"))["activeLoans"] == 3, "activeLoans")
    check(ok_json(get("/books/5"))["availableCopies"] == 1, "copy consumed")


def test_loanrules_no_available_copy():
    problem(post("/loans", {"bookId": 2, "memberId": 4}), 409, "Conflict", detail=True)
    ok_json(post("/loans", {"bookId": 5, "memberId": 4}), 201)
    problem(post("/loans", {"bookId": 5, "memberId": 4}), 409, "Conflict", detail=True)


# ---------------------------------------------------------------- tests: return

def test_return_sets_returned_at_and_fine():
    loan = ok_json(post("/loans/2/return"))
    check(set(loan) == LOAN_KEYS, f"keys {sorted(loan)}")
    check(ts(loan["returnedAt"]) == NOW_DT, f"returnedAt {loan['returnedAt']}")
    check(loan["status"] == "returned", loan["status"])
    check(loan["daysOverdue"] == 5 and loan["fineCents"] == 125, str(loan))
    check(ok_json(get("/loans/2")) == loan, "GET after return differs")


def test_return_frees_copy_and_unblocks_member():
    ok_json(post("/loans/2/return"))
    check(ok_json(get("/books/2"))["availableCopies"] == 1, "copy not freed")
    m = ok_json(get("/members/1"))
    check(m["activeLoans"] == 0 and m["totalFinesCents"] == 125, str(m))
    ok_json(post("/loans", {"bookId": 2, "memberId": 1}), 201)


def test_return_twice_conflict():
    ok_json(post("/loans/4/return"))
    problem(post("/loans/4/return"), 409, "Conflict", detail=True)
    problem(post("/loans/1/return"), 409, "Conflict", detail=True)


def test_return_missing_404():
    problem(post("/loans/99/return"), 404, "Not Found", detail=True)


# ---------------------------------------------------------------- tests: fines

def loan_summary(i):
    loan = ok_json(get(f"/loans/{i}"))
    return loan["status"], loan["daysOverdue"], loan["fineCents"]


def test_fines_overdue_loan():
    check(loan_summary(2) == ("overdue", 5, 125), str(loan_summary(2)))


def test_fines_capped():
    check(loan_summary(3) == ("overdue", 130, 1000), str(loan_summary(3)))


def test_fines_due_today_not_overdue():
    check(loan_summary(4) == ("active", 0, 0), str(loan_summary(4)))


def test_fines_returned_loans_fixed():
    check(loan_summary(1) == ("returned", 3, 75), str(loan_summary(1)))
    check(loan_summary(5) == ("returned", 0, 0), str(loan_summary(5)))


def test_fines_member_totals():
    totals = {i: ok_json(get(f"/members/{i}"))["totalFinesCents"] for i in (1, 2, 3, 4)}
    check(totals == {1: 125, 2: 1000, 3: 75, 4: 0}, str(totals))


def test_fines_follow_calendar_days_of_clock():
    s = Server(["--seed", str(SEED), "--now", "2026-05-21T00:00:01Z"], default_args=False).wait_ready()
    try:
        g = lambda i: (lambda l: (l["status"], l["daysOverdue"], l["fineCents"]))(ok_json(get(f"/loans/{i}", server=s)))
        check(g(4) == ("overdue", 1, 25), f"loan 4 {g(4)}")
        check(g(2) == ("overdue", 6, 150), f"loan 2 {g(2)}")
        check(g(1) == ("returned", 3, 75), f"loan 1 {g(1)}")
    finally:
        s.stop()


# ---------------------------------------------------------------- tests: loans list

def test_loanlist_default():
    page = ok_json(get("/loans"))
    check(set(page) >= PAGE_KEYS, f"keys {sorted(page)}")
    check(ids(page) == [1, 2, 3, 4, 5] and page["totalItems"] == 5 and page["totalPages"] == 1, str(page))
    check(all(set(x) == LOAN_KEYS for x in page["items"]), "loan keys")


def test_loanlist_filters():
    check(ids(ok_json(get("/loans?memberId=3"))) == [1, 4], "memberId")
    check(ids(ok_json(get("/loans?bookId=1"))) == [1, 5], "bookId")
    check(ids(ok_json(get("/loans?memberId=1&status=returned"))) == [5], "member+status")
    check(ok_json(get("/loans?memberId=42"))["items"] == [], "unknown member")


def test_loanlist_status_filter_uses_computed_status():
    check(ids(ok_json(get("/loans?status=overdue"))) == [2, 3], "overdue")
    check(ids(ok_json(get("/loans?status=active"))) == [4], "active")
    check(ids(ok_json(get("/loans?status=returned"))) == [1, 5], "returned")


def test_loanlist_pagination():
    page = ok_json(get("/loans?pageSize=2&page=3"))
    check(ids(page) == [5] and (page["totalItems"], page["totalPages"], page["page"], page["pageSize"]) == (5, 3, 3, 2),
          str(page))


# ---------------------------------------------------------------- tests: configuration

def test_config_environment_variables():
    s = Server(default_args=False, env={"LIBRARY_SEED": str(SEED), "LIBRARY_NOW": "2026-05-21T00:00:01Z",
                                        "LIBRARY_API_KEY": "s3cret-key"}).wait_ready()
    try:
        check(ts(ok_json(get("/health", server=s))["now"]) == datetime(2026, 5, 21, 0, 0, 1, tzinfo=timezone.utc), "now")
        check(ok_json(get("/books", server=s))["totalItems"] == 6, "seed from LIBRARY_SEED")
        problem(post("/members", {"name": "A", "email": "a1@example.org"}, key="dev-key", server=s), 401)
        ok_json(post("/members", {"name": "A", "email": "a1@example.org"}, key="s3cret-key", server=s), 201)
    finally:
        s.stop()


def test_config_command_line_wins():
    s = Server(["--seed", str(SEED), "--now", NOW], default_args=False,
               env={"LIBRARY_SEED": str(WORK / "missing.json"), "LIBRARY_NOW": "2020-01-01T00:00:00Z",
                    "LIBRARY_API_KEY": ""}).wait_ready()
    try:
        check(ts(ok_json(get("/health", server=s))["now"]) == NOW_DT, "cli --now did not win")
        check(ok_json(get("/books", server=s))["totalItems"] == 6, "cli --seed did not win")
        ok_json(post("/members", {"name": "A", "email": "a2@example.org"}, key="dev-key", server=s), 201)
    finally:
        s.stop()


def _expect_exit(extra):
    s = Server(extra, default_args=False)
    try:
        try:
            rc = s.proc.wait(30)
        except subprocess.TimeoutExpired:
            raise AssertionError("server kept running with a bad seed file")
        check(rc != 0, "exit status 0")
    finally:
        s.stop()


def test_config_missing_seed_exits_nonzero():
    _expect_exit(["--seed", str(WORK / "does-not-exist.json"), "--now", NOW])


def test_config_invalid_seed_exits_nonzero():
    bad = WORK / "bad-seed.json"
    bad.write_text("{ this is not json")
    _expect_exit(["--seed", str(bad), "--now", NOW])


# ---------------------------------------------------------------- runner

# Test-name prefix per requirement group. Each group (or each test, for mutating groups) gets a fresh server.
GROUPS = [
    ["test_health_"],
    ["test_booklist_"],
    ["test_query_"],
    ["test_get_"],
    ["test_problem_"],
    ["test_auth_"],
    ["test_bookcreate_"],
    ["test_validation_"],
    ["test_member_"],
    ["test_bookdelete_"],
    ["test_loancreate_"],
    ["test_loanrules_"],
    ["test_return_"],
    ["test_fines_"],
    ["test_loanlist_"],
]
FRESH_PER_TEST = {"test_bookcreate_", "test_validation_", "test_member_", "test_bookdelete_", "test_loancreate_",
                  "test_loanrules_", "test_return_"}
STANDALONE = "test_config_"


def all_tests():
    return [(n, f) for n, f in globals().items() if n.startswith("test_") and callable(f)]


def run_one(name, fn, results):
    try:
        fn()
        results[name] = True
    except Exception as e:  # noqa: BLE001
        results[name] = False
        print(f"FAIL {name}: {e}", file=sys.stderr)
        if not isinstance(e, AssertionError):
            traceback.print_exc(limit=2)


def main():
    global ARGS, WORK, SRV
    ap = argparse.ArgumentParser()
    ap.add_argument("--dll", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", default="")
    ARGS = ap.parse_args()
    ARGS.dll = str(Path(ARGS.dll).resolve())
    WORK = Path(tempfile.mkdtemp(prefix="library-contract-"))
    tests = all_tests()
    if ARGS.only:
        tests = [t for t in tests if t[0].startswith(ARGS.only)]
    results: dict[str, bool] = {}
    for (prefix,) in GROUPS:
        members = [t for t in tests if t[0].startswith(prefix)]
        if not members:
            continue
        units = [[t] for t in members] if prefix in FRESH_PER_TEST else [members]
        for unit in units:
            try:
                SRV = Server().wait_ready()
            except Exception as e:  # noqa: BLE001
                print(f"server start failed for {prefix}: {e}", file=sys.stderr)
                for n, _ in unit:
                    results[n] = False
                continue
            try:
                for n, f in unit:
                    run_one(n, f, results)
            finally:
                SRV.stop()
    for n, f in tests:
        if n.startswith(STANDALONE):
            run_one(n, f, results)
    Path(ARGS.out).write_text(json.dumps(results, indent=2))
    shutil.rmtree(WORK, ignore_errors=True)
    print(f"{sum(results.values())}/{len(results)} passed", file=sys.stderr)


if __name__ == "__main__":
    main()
