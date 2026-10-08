#!/usr/bin/env python3
"""Black-box tests for the kanban binary. Usage: test_kanban.py PATH/TO/kanban

Prints one `test <name> ... ok|FAILED` line per test (cargo-style)."""
import json
import os
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path

BIN = None
TESTS = []
HELP = "a:add e:edit d:delete H/L:move q:quit"


def test(fn):
    TESTS.append(fn)
    return fn


class Run:
    def __init__(self, p, data):
        self.rc, self.out, self.err, self.data = p.returncode, p.stdout, p.stderr, data

    def json(self):
        return json.loads(self.out)

    def lines(self):
        return self.out.split("\n")[:-1] if self.out.endswith("\n") else self.out.split("\n")

    def saved(self):
        return json.loads(Path(self.data).read_text())


def run(keys=None, *, args=None, data=None, board=None, dump=True, render=None, raw=None):
    """Replay `keys` (list of key lines) against `board` (dict) or an existing data file."""
    d = Path(tempfile.mkdtemp(prefix="kb-"))
    datap = Path(data) if data else d / "board.json"
    if board is not None:
        datap.write_text(json.dumps(board))
    cmd = [BIN]
    if args is not None:
        cmd += args
    else:
        sp = d / "keys.txt"
        sp.write_bytes(raw if raw is not None else ("\n".join(keys) + "\n").encode())
        cmd += ["--data", str(datap), "--script", str(sp)]
        if render:
            cmd += ["--render", render]
        elif dump:
            cmd += ["--dump"]
    env = {k: v for k, v in os.environ.items() if k != "TERM"}
    p = subprocess.run(cmd, cwd=d, capture_output=True, text=True, timeout=20,
                       stdin=subprocess.DEVNULL, env=env)
    return Run(p, datap)


def cols(state):
    return [[c["title"] for c in col["cards"]] for col in state["columns"]]


def mk(todo=(), doing=(), done=()):
    n = 1
    columns = []
    for name, titles in (("Todo", todo), ("Doing", doing), ("Done", done)):
        cards = []
        for t in titles:
            cards.append({"id": n, "title": t})
            n += 1
        columns.append({"name": name, "cards": cards})
    return {"next_id": n, "columns": columns}


def add(*titles):
    out = []
    for t in titles:
        out += ["a", "text:" + t, "Enter"]
    return out


def ok(r):
    assert r.rc == 0, f"exit {r.rc}: {r.err}"
    return r


def eq(a, b):
    assert a == b, f"{a!r} != {b!r}"


def err(r, code):
    assert r.rc == code, f"expected exit {code}, got {r.rc} (stderr {r.err!r})"
    assert r.err.startswith("error: "), f"stderr should start with 'error: ': {r.err!r}"
    eq(r.out, "")


# ---------------- script format ----------------

@test
def script_text_keeps_spaces_verbatim():
    s = ok(run(["a", "text:Buy  milk  now", "Esc", "a", "text:x y", "Space", "text:z"])).json()
    eq(s["mode"], "add")
    eq(s["input"], "x y z")


@test
def script_crlf_and_blank_lines():
    r = ok(run(raw=b"a\r\ntext:Milk\r\n\r\nEnter\r\n\n"))
    s = r.json()
    eq(cols(s)[0], ["Milk"])


@test
def script_quit_ignores_remaining_keys():
    s = ok(run(add("one") + ["q"] + add("two"))).json()
    eq(cols(s)[0], ["one"])


@test
def script_q_in_input_mode_is_text():
    s = ok(run(["a", "q", "j", "Enter"])).json()
    eq(cols(s)[0], ["qj"])


@test
def script_empty_script_dumps_initial_state():
    s = ok(run([], raw=b"")).json()
    eq(s, {"next_id": 1, "columns": mk()["columns"], "focus": 0, "selected": None,
           "mode": "normal", "input": "", "message": None})


# ---------------- navigation ----------------

@test
def nav_initial_selection_from_file():
    s = ok(run([], board=mk(["a", "b"]))).json()
    eq((s["focus"], s["selected"]), (0, 0))


@test
def nav_j_wraps_to_first():
    s = ok(run(["j", "j", "j"], board=mk(["a", "b", "c"]))).json()
    eq(s["selected"], 0)
    s = ok(run(["j", "Down"], board=mk(["a", "b", "c"]))).json()
    eq(s["selected"], 2)


@test
def nav_k_wraps_to_last():
    s = ok(run(["k"], board=mk(["a", "b", "c"]))).json()
    eq(s["selected"], 2)
    s = ok(run(["k", "Up", "k"], board=mk(["a", "b", "c"]))).json()
    eq(s["selected"], 0)


@test
def nav_jk_on_empty_column():
    s = ok(run(["j", "k"])).json()
    eq(s["selected"], None)


@test
def nav_l_h_no_wrap():
    b = mk(["a"], ["b"], ["c"])
    eq(ok(run(["l", "l", "l"], board=b)).json()["focus"], 2)
    eq(ok(run(["h"], board=b)).json()["focus"], 0)
    eq(ok(run(["Right", "Right", "Left"], board=b)).json()["focus"], 1)


@test
def nav_tab_wraps():
    b = mk(["a"], ["b"], ["c"])
    eq(ok(run(["Tab", "Tab"], board=b)).json()["focus"], 2)
    eq(ok(run(["Tab", "Tab", "Tab"], board=b)).json()["focus"], 0)


@test
def nav_focus_change_resets_selection():
    b = mk(["a", "b", "c"], ["d", "e"], [])
    s = ok(run(["j", "j", "l"], board=b)).json()
    eq((s["focus"], s["selected"]), (1, 0))
    s = ok(run(["l", "j", "h"], board=b)).json()
    eq((s["focus"], s["selected"]), (0, 0))
    s = ok(run(["Tab", "Tab"], board=b)).json()
    eq((s["focus"], s["selected"]), (2, None))


# ---------------- add ----------------

@test
def add_appends_and_selects():
    s = ok(run(add("one", "two", "three"))).json()
    eq(cols(s)[0], ["one", "two", "three"])
    eq(s["selected"], 2)
    eq(s["message"], 'Added "three"')
    eq(s["mode"], "normal")
    eq(s["input"], "")


@test
def add_ids_increment():
    s = ok(run(add("one", "two"))).json()
    eq([c["id"] for c in s["columns"][0]["cards"]], [1, 2])
    eq(s["next_id"], 3)


@test
def add_into_focused_column():
    s = ok(run(["l"] + add("x") + ["Tab"] + add("y"), board=mk(["a"]))).json()
    eq(cols(s), [["a"], ["x"], ["y"]])
    eq(s["columns"][1]["cards"][0]["id"], 2)
    eq((s["focus"], s["selected"]), (2, 0))


@test
def add_trims_title():
    s = ok(run(["a", "text:   Buy milk  ", "Enter"])).json()
    eq(cols(s)[0], ["Buy milk"])
    eq(s["message"], 'Added "Buy milk"')


@test
def add_empty_title_rejected():
    s = ok(run(["a", "Space", "text:   ", "Enter"], board=mk(["a"]))).json()
    eq(cols(s)[0], ["a"])
    eq(s["next_id"], 2)
    eq(s["message"], "Title cannot be empty")
    eq(s["mode"], "normal")


@test
def add_esc_cancels():
    s = ok(run(["a", "text:nope", "Esc"])).json()
    eq(cols(s)[0], [])
    eq((s["mode"], s["input"], s["message"], s["next_id"]), ("normal", "", None, 1))


@test
def add_backspace_and_mode_in_dump():
    s = ok(run(["a", "text:abc", "Backspace", "Backspace", "text:Z", "Tab", "Left"])).json()
    eq((s["mode"], s["input"]), ("add", "aZ"))
    s = ok(run(["a", "Backspace", "text:x", "Enter"])).json()
    eq(cols(s)[0], ["x"])


@test
def add_message_cleared_by_next_key():
    s = ok(run(add("one") + ["j"])).json()
    eq(s["message"], None)


# ---------------- edit ----------------

@test
def edit_prefills_input():
    s = ok(run(["j", "e"], board=mk(["a", "Buy milk"]))).json()
    eq((s["mode"], s["input"]), ("edit", "Buy milk"))


@test
def edit_replaces_title():
    s = ok(run(["j", "e", "Backspace", "Backspace", "Backspace", "Backspace", "text:eggs ", "Enter"],
               board=mk(["a", "Buy milk"]))).json()
    eq(cols(s)[0], ["a", "Buy eggs"])
    eq(s["columns"][0]["cards"][1]["id"], 2)
    eq(s["message"], 'Updated "Buy eggs"')
    eq((s["selected"], s["next_id"]), (1, 3))


@test
def edit_empty_keeps_title():
    s = ok(run(["e"] + ["Backspace"] * 3 + ["Enter"], board=mk(["abc"]))).json()
    eq(cols(s)[0], ["abc"])
    eq(s["message"], "Title cannot be empty")


@test
def edit_esc_and_empty_column():
    s = ok(run(["e", "text:zzz", "Esc"], board=mk(["abc"]))).json()
    eq(cols(s)[0], ["abc"])
    eq(s["mode"], "normal")
    s = ok(run(["l", "e"], board=mk(["abc"]))).json()
    eq(s["mode"], "normal")


# ---------------- delete ----------------

@test
def delete_middle_keeps_index():
    s = ok(run(["j", "d"], board=mk(["a", "b", "c"]))).json()
    eq(cols(s)[0], ["a", "c"])
    eq(s["selected"], 1)
    eq(s["message"], 'Deleted "b"')


@test
def delete_last_moves_up():
    s = ok(run(["k", "d"], board=mk(["a", "b", "c"]))).json()
    eq(cols(s)[0], ["a", "b"])
    eq(s["selected"], 1)


@test
def delete_only_card_and_empty():
    s = ok(run(["d"], board=mk(["a"]))).json()
    eq((cols(s)[0], s["selected"]), ([], None))
    s = ok(run(["d", "d"], board=mk(["a"]))).json()
    eq(s["message"], None)


@test
def delete_ids_not_reused():
    s = ok(run(add("a", "b") + ["d"] + add("c"))).json()
    eq([c["id"] for c in s["columns"][0]["cards"]], [1, 3])
    eq(s["next_id"], 4)


# ---------------- moving cards ----------------

@test
def move_right_focus_follows():
    s = ok(run(["j", "L"], board=mk(["a", "b"], ["c"]))).json()
    eq(cols(s), [["a"], ["c", "b"], []])
    eq((s["focus"], s["selected"]), (1, 1))
    eq(s["columns"][1]["cards"][1], {"id": 2, "title": "b"})


@test
def move_right_through_to_done_then_stop():
    s = ok(run(["L", "L", "L"], board=mk(["a"]))).json()
    eq(cols(s), [[], [], ["a"]])
    eq((s["focus"], s["selected"]), (2, 0))


@test
def move_left():
    s = ok(run(["l", "H"], board=mk(["a"], ["b"]))).json()
    eq(cols(s), [["a", "b"], [], []])
    eq((s["focus"], s["selected"]), (0, 1))
    s = ok(run(["H"], board=mk(["a"]))).json()
    eq((cols(s)[0], s["focus"]), (["a"], 0))


@test
def move_on_empty_column_noop():
    s = ok(run(["l", "L", "H"], board=mk(["a"]))).json()
    eq(cols(s), [["a"], [], []])
    eq((s["focus"], s["selected"]), (1, None))


@test
def move_reorder_down_up():
    s = ok(run(["J"], board=mk(["a", "b", "c"]))).json()
    eq((cols(s)[0], s["selected"]), (["b", "a", "c"], 1))
    s = ok(run(["k", "K", "K"], board=mk(["a", "b", "c"]))).json()
    eq((cols(s)[0], s["selected"]), (["c", "a", "b"], 0))


@test
def move_reorder_edges_noop():
    s = ok(run(["K"], board=mk(["a", "b"]))).json()
    eq((cols(s)[0], s["selected"]), (["a", "b"], 0))
    s = ok(run(["j", "J"], board=mk(["a", "b"]))).json()
    eq((cols(s)[0], s["selected"]), (["a", "b"], 1))


# ---------------- persistence ----------------

@test
def persist_creates_file_with_shape():
    r = ok(run(add("one") + ["L"] + add("two")))
    eq(r.saved(), {"next_id": 3, "columns": [
        {"name": "Todo", "cards": []},
        {"name": "Doing", "cards": [{"id": 1, "title": "one"}, {"id": 2, "title": "two"}]},
        {"name": "Done", "cards": []}]})


@test
def persist_saved_without_changes_and_without_q():
    r = ok(run(["j"], dump=False))
    eq(r.saved(), mk())
    eq(r.out, "")


@test
def persist_round_trip_between_runs():
    r1 = ok(run(add("one", "two")))
    r2 = ok(run(["d"] + add("three"), data=r1.data))
    eq(cols(r2.json())[0], ["two", "three"])
    eq(r2.saved()["next_id"], 4)
    eq(r2.saved(), {k: r2.json()[k] for k in ("next_id", "columns")})


@test
def persist_saves_on_q_ignoring_ui_state():
    r = ok(run(add("one") + ["q"]))
    eq(set(r.saved()), {"next_id", "columns"})


@test
def persist_loads_extra_whitespace_and_key_order():
    d = Path(tempfile.mkdtemp(prefix="kb-")) / "b.json"
    d.write_text('{\n  "columns": [ {"cards": [ {"title": "x", "id": 7} ], "name": "Todo"},\n'
                 '{"name":"Doing","cards":[]},{"name":"Done","cards":[]}],\n "next_id": 9 }\n')
    s = ok(run(add("y"), data=d)).json()
    eq([c["id"] for c in s["columns"][0]["cards"]], [7, 9])


@test
def persist_invalid_json_rejected():
    d = Path(tempfile.mkdtemp(prefix="kb-")) / "bad.json"
    d.write_text("{not json")
    r = run(add("y"), data=d)
    err(r, 1)
    assert "bad.json" in r.err, r.err
    eq(d.read_text(), "{not json")


@test
def persist_wrong_shape_rejected():
    d = Path(tempfile.mkdtemp(prefix="kb-")) / "shape.json"
    b = mk(["a"])
    b["columns"] = b["columns"][:2]
    d.write_text(json.dumps(b))
    r = run([], data=d)
    err(r, 1)
    assert "shape.json" in r.err, r.err
    b = mk(["a"])
    b["columns"][1]["name"] = "Review"
    d.write_text(json.dumps(b))
    err(run([], data=d), 1)


@test
def persist_no_leftover_files():
    r = ok(run(add("a")))
    eq(sorted(p.name for p in Path(r.data).parent.iterdir()), ["board.json", "keys.txt"])


# ---------------- render ----------------

def screen(keys, size="60x7", board=None):
    r = ok(run(keys, board=board, render=size))
    return r.lines()


@test
def render_prompt_example_exact():
    lines = screen(add("Buy milk", "Call mom") + ["l"] + add("Write report") + ["h"])
    eq(lines, [
        "KANBAN - 3 total",
        "[Todo (2)]          Doing (1)           Done (0)",
        "-" * 60,
        "> Buy milk            Write report        (empty)",
        "  Call mom",
        "",
        HELP,
    ])


@test
def render_line_count_and_width():
    lines = screen([], "31x9", board=mk(["a" * 50], ["b"], ["c" * 50]))
    eq(len(lines), 9)
    assert all(len(l) <= 31 for l in lines), lines
    eq(lines[2], "-" * 31)
    for l in lines:
        eq(l, l.rstrip())


@test
def render_title_and_headers():
    lines = screen(["Tab"], "45x6", board=mk(["a", "b"], ["c"], []))
    eq(lines[0], "KANBAN - 3 total")
    eq(lines[1], "Todo (2)       [Doing (1)]    Done (0)")


@test
def render_selected_marker():
    lines = screen(["j"], "60x8", board=mk(["a", "b", "c"], ["x"]))
    eq(lines[3], "  a                   x                   (empty)")
    eq(lines[4], "> b")
    eq(lines[5], "  c")


@test
def render_truncates_titles():
    lines = screen([], "30x5", board=mk(["abcdefghijklmnop"], ["0123456789abcdef"], ["XYZXYZXYZXYZXYZ"]))
    eq(lines[3], "> abcdefg   0123456   XYZXYZX")


@test
def render_empty_columns():
    lines = screen([], "60x6")
    eq(lines[0], "KANBAN - 0 total")
    eq(lines[1], "[Todo (0)]          Doing (0)           Done (0)")
    eq(lines[3], "  (empty)             (empty)             (empty)")
    eq(lines[4], "")


@test
def render_status_line():
    eq(screen(add("one"))[-1], 'Added "one"')
    eq(screen(add("one") + ["j"])[-1], HELP)
    eq(screen(["a", "text:Buy mi"])[-1], "New card: Buy mi_")
    eq(screen(["e", "Backspace"], board=mk(["abc"]))[-1], "Edit card: ab_")
    eq(screen(["a", "text:" + "x" * 80], "40x5")[-1], ("New card: " + "x" * 80)[:40])


@test
def render_scrolls_to_selected():
    b = mk([f"t{i}" for i in range(6)], [f"d{i}" for i in range(6)])
    lines = screen(["k"], "60x7", board=b)  # 3 card rows, select t5
    eq([l[:10].rstrip() for l in lines[3:6]], ["  t3", "  t4", "> t5"])
    eq([l[20:40].rstrip() for l in lines[3:6]], ["  d0", "  d1", "  d2"])
    lines = screen(["j"], "60x7", board=b)
    eq([l[:10].rstrip() for l in lines[3:6]], ["  t0", "> t1", "  t2"])


@test
def render_does_not_touch_terminal():
    r = ok(run(add("a"), render="40x6"))
    assert "\x1b" not in r.out, repr(r.out)


# ---------------- command line ----------------

@test
def cli_help():
    r = run(args=["--help"])
    eq(r.rc, 0)
    assert "--script" in r.out, r.out


@test
def cli_unknown_option():
    err(run(args=["--frobnicate"]), 2)


@test
def cli_missing_value():
    err(run(args=["--data"]), 2)


@test
def cli_dump_render_need_script():
    err(run(args=["--dump"]), 2)
    err(run(args=["--render", "40x10"]), 2)


@test
def cli_dump_and_render_exclusive():
    d = Path(tempfile.mkdtemp(prefix="kb-"))
    (d / "k").write_text("j\n")
    r = run(args=["--data", str(d / "b.json"), "--script", str(d / "k"), "--dump", "--render", "40x10"])
    err(r, 2)
    assert not (d / "b.json").exists()


@test
def cli_bad_render_size():
    for size in ["40", "40x", "x10", "axb", "29x10", "40x4", "40X10", "-40x10"]:
        r = run(["j"], render=size)
        err(r, 2)
        assert not Path(r.data).exists(), size


@test
def cli_missing_script_file():
    d = Path(tempfile.mkdtemp(prefix="kb-"))
    r = run(args=["--data", str(d / "b.json"), "--script", str(d / "nope.txt"), "--dump"])
    err(r, 1)
    assert not (d / "b.json").exists()


@test
def cli_unknown_key_reports_line():
    r = run(["j", "", "Foo", "k"], raw=b"j\n\nFoo\nk\n")
    err(r, 2)
    assert "'Foo'" in r.err and "line 3" in r.err, r.err
    assert not Path(r.data).exists()


@test
def cli_unknown_key_after_quit_still_error():
    r = run(None, raw=b"q\nenter\n")
    err(r, 2)
    assert "'enter'" in r.err and "line 2" in r.err, r.err


def main():
    global BIN
    BIN = os.path.abspath(sys.argv[1])
    failed = 0
    for fn in TESTS:
        try:
            fn()
            print(f"test {fn.__name__} ... ok")
        except Exception:
            failed += 1
            print(f"test {fn.__name__} ... FAILED")
            traceback.print_exc(limit=1, file=sys.stdout)
    print(f"{len(TESTS) - failed} passed, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
