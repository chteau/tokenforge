#!/usr/bin/env python3
"""Black-box tests for zj. Usage: test_zj.py /path/to/zj
Prints one line per test: `PASS <name>` or `FAIL <name>: <reason>`."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import traceback

BIN = os.path.abspath(sys.argv[1])
TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


class R:
    def __init__(self, p):
        self.code, self.out, self.err = p.returncode, p.stdout, p.stderr


def run(*args, stdin=b"", cwd=None):
    if isinstance(stdin, str):
        stdin = stdin.encode()
    p = subprocess.run([BIN, *args], input=stdin, capture_output=True, timeout=30, cwd=cwd)
    return R(p)


def eq(a, b, msg=""):
    assert a == b, f"{msg} expected {b!r}, got {a!r}"


def ok(r, out):
    eq(r.err, b"", "stderr")
    eq(r.code, 0, "exit code")
    if isinstance(out, str):
        out = out.encode()
    eq(r.out, out, "stdout")


def bad_json(r, where, message, source="<stdin>"):
    eq(r.code, 1, "exit code")
    eq(r.out, b"", "stdout")
    eq(r.err.decode(errors="replace").rstrip("\n"), f"error: {source}:{where}: {message}", "stderr")


def usage(r):
    eq(r.code, 2, "exit code")
    eq(r.out, b"", "stdout")
    assert r.err.startswith(b"error: "), f"stderr {r.err!r}"


def validate_err(text, where, message):
    bad_json(run("validate", stdin=text), where, message)


# ---------------- validate ----------------

@test
def validate_accepts_documents(tmp):
    for doc in ['{}', '[]', ' \t\r\n 0 \n', '"x"', 'true', 'null', '-0.5e-3',
                '{"a":[1,2,{"b":null}],"c":"d"}', '[1E5, 2e+0, 0.0, -12]', '"\\u00E9\\uD83D\\uDE00"']:
        ok(run("validate", stdin=doc), "valid\n")


@test
def validate_rejects_lenient_syntax(tmp):
    for doc in ['[1,]', '{"a":1,}', "{'a':1}", '// c\n1', '[NaN]', '\ufeff[]', '{a:1}', '+1', '.5']:
        r = run("validate", stdin=doc)
        eq(r.code, 1, f"{doc!r} exit code")
        eq(r.out, b"", f"{doc!r} stdout")


@test
def validate_file_source_name(tmp):
    path = os.path.join(tmp, "in.json")
    with open(path, "w") as f:
        f.write('{"k": [1, 2,]}')
    bad_json(run("validate", "in.json", cwd=tmp), "1:13", "unexpected character", "in.json")
    with open(path, "w") as f:
        f.write('[1]')
    ok(run("validate", path), "valid\n")
    ok(run("validate", "-", stdin="[2]"), "valid\n")


@test
def validate_duplicate_keys(tmp):
    validate_err('{"a":1,"b":{"a":2},"a":3}', "1:20", "duplicate key")
    validate_err('{"é":1,\n"\\u00e9":2}', "2:1", "duplicate key")
    ok(run("validate", stdin='[{"a":1},{"a":2}]'), "valid\n")


# ---------------- error positions ----------------

@test
def errpos_end_of_input(tmp):
    validate_err("", "1:1", "unexpected end of input")
    validate_err("   \n  ", "2:3", "unexpected end of input")
    validate_err('{"a": [1,\n  2', "2:4", "unexpected end of input")
    validate_err('"abc', "1:5", "unexpected end of input")
    validate_err('tr', "1:3", "unexpected end of input")
    validate_err('{"a"', "1:5", "unexpected end of input")


@test
def errpos_unexpected_character(tmp):
    validate_err('[1 2]', "1:4", "unexpected character")
    validate_err('{\n  "a": tru\n}', "2:11", "unexpected character")
    validate_err('{"a" 1}', "1:6", "unexpected character")
    validate_err('{1:2}', "1:2", "unexpected character")
    validate_err('[nul]', "1:5", "unexpected character")
    validate_err('[1}', "1:3", "unexpected character")


@test
def errpos_numbers(tmp):
    validate_err('[01]', "1:2", "invalid number")
    validate_err('[1, 1.]', "1:5", "invalid number")
    validate_err('-', "1:1", "invalid number")
    validate_err('{"n": 1e5.0}', "1:7", "invalid number")
    validate_err('[2.5e]', "1:2", "invalid number")
    validate_err('[1-2]', "1:2", "invalid number")


@test
def errpos_strings(tmp):
    validate_err('["ok", "a\\x"]', "1:10", "invalid escape")
    validate_err('"a\tb"', "1:3", "control character in string")
    validate_err('"line\nbreak"', "1:6", "control character in string")
    validate_err('"\\u12G4"', "1:2", "invalid unicode escape")
    validate_err('"ab\\u12"', "1:4", "invalid unicode escape")


@test
def errpos_counts_bytes_not_chars(tmp):
    validate_err('{"é😀": tru }', "1:15", "unexpected character")
    validate_err('["日本", 1,]', "1:14", "unexpected character")


@test
def errpos_trailing_characters(tmp):
    validate_err('{} {}', "1:4", "trailing characters")
    validate_err('[1]\n\n  x', "3:3", "trailing characters")
    validate_err('truex', "1:5", "trailing characters")


# ---------------- unicode ----------------

@test
def unicode_surrogate_pairs(tmp):
    ok(run("min", stdin='"\\ud83d\\ude00 \\uD834\\uDD1E"'), '"😀 𝄞"\n')
    validate_err('"x\\ud83d"', "1:3", "invalid unicode escape")
    validate_err('"\\ud83d\\u0041"', "1:2", "invalid unicode escape")
    validate_err('["\\ude00"]', "1:3", "invalid unicode escape")
    validate_err('"\\ud83d\\n"', "1:2", "invalid unicode escape")


@test
def unicode_invalid_utf8(tmp):
    bad_json(run("validate", stdin=b'["ok", "\xff"]'), "1:9", "invalid utf-8")
    bad_json(run("validate", stdin=b'"ab\xc3"'), "1:4", "invalid utf-8")
    bad_json(run("validate", stdin=b'"\xed\xa0\x80"'), "1:2", "invalid utf-8")  # encoded surrogate
    bad_json(run("validate", stdin=b'"\xc0\xaf"'), "1:2", "invalid utf-8")  # overlong
    ok(run("validate", stdin='"é€😀"'.encode()), "valid\n")


@test
def unicode_output_escaping(tmp):
    ok(run("min", stdin='"\\u0041\\u00e9\\/\\"\\\\\\b\\f\\n\\r\\t\\u0001\\u001F\\u007f"'),
       '"Aé/\\"\\\\\\b\\f\\n\\r\\t\\u0001\\u001f\x7f"\n')


@test
def unicode_ascii_mode(tmp):
    ok(run("min", "--ascii", stdin='{"clé":"日本 😀","n":"plain"}'),
       '{"cl\\u00e9":"\\u65e5\\u672c \\ud83d\\ude00","n":"plain"}\n')
    ok(run("fmt", "--ascii", stdin='["\\uFFFF\\u0080"]'), '[\n  "\\uffff\\u0080"\n]\n')


# ---------------- fmt / min ----------------

DOC = '{ "name" : "zj", "tags": ["a", [], {}], "n": {"x": 1.50, "y": [true, false, null]}, "e": -0 }'


@test
def fmt_default_indent(tmp):
    expected = ('{\n  "name": "zj",\n  "tags": [\n    "a",\n    [],\n    {}\n  ],\n'
                '  "n": {\n    "x": 1.50,\n    "y": [\n      true,\n      false,\n      null\n'
                '    ]\n  },\n  "e": -0\n}\n')
    ok(run("fmt", stdin=DOC), expected)


@test
def fmt_custom_indent(tmp):
    ok(run("fmt", "--indent", "4", stdin='[1,{"a":[]}]'), '[\n    1,\n    {\n        "a": []\n    }\n]\n')
    ok(run("fmt", "--indent", "1", stdin='{"a":{"b":2}}'), '{\n "a": {\n  "b": 2\n }\n}\n')
    ok(run("fmt", stdin='"s"'), '"s"\n')
    ok(run("fmt", stdin=' [ ] '), '[]\n')


@test
def fmt_file_and_options_anywhere(tmp):
    path = os.path.join(tmp, "doc.json")
    with open(path, "w") as f:
        f.write('{"b":1,"a":2}')
    ok(run("fmt", path, "--indent", "3", "--sort-keys"), '{\n   "a": 2,\n   "b": 1\n}\n')
    ok(run("fmt", "--sort-keys", "-", stdin='{"b":1,"a":2}'), '{\n  "a": 2,\n  "b": 1\n}\n')


@test
def fmt_min_numbers_verbatim(tmp):
    ok(run("min", stdin='[1.0E+2, -0, 0.10, 1e-07, 123456789012345678901234567890]'),
       '[1.0E+2,-0,0.10,1e-07,123456789012345678901234567890]\n')


@test
def min_strips_whitespace(tmp):
    ok(run("min", stdin=DOC),
       '{"name":"zj","tags":["a",[],{}],"n":{"x":1.50,"y":[true,false,null]},"e":-0}\n')
    ok(run("min", stdin='"a b\\u0020c"'), '"a b c"\n')


@test
def min_roundtrip_large(tmp):
    data = [{"id": i, "name": f"item {i} é", "tags": ["x", "y"], "v": i * 0.5} for i in range(20000)]
    text = json.dumps(data, indent=1, ensure_ascii=True)
    r = run("min", stdin=text)
    eq(r.code, 0, "exit code")
    eq(json.loads(r.out), data, "round trip")
    eq(r.out, (json.dumps(data, separators=(",", ":"), ensure_ascii=False) + "\n").encode(), "bytes")


# ---------------- sort keys ----------------

@test
def sort_keys_recursive(tmp):
    ok(run("min", "--sort-keys", stdin='{"b":{"d":1,"c":[{"z":1,"y":2}]},"a":0}'),
       '{"a":0,"b":{"c":[{"y":2,"z":1}],"d":1}}\n')


@test
def sort_keys_byte_order(tmp):
    ok(run("min", "--sort-keys", stdin='{"é":1,"a":2,"Z":3,"😀":4,"\\uffff":5,"ab":6,"":7,"_":8,"1":9}'),
       '{"":7,"1":9,"Z":3,"_":8,"a":2,"ab":6,"é":1,"\uffff":5,"😀":4}\n')


@test
def sort_keys_uses_decoded_keys(tmp):
    ok(run("min", "--sort-keys", stdin='{"\\u0062":1,"a\\"":2,"a":3}'), '{"a":3,"a\\"":2,"b":1}\n')
    ok(run("min", stdin='{"b":1,"a":2}'), '{"b":1,"a":2}\n')


@test
def sort_keys_with_ascii(tmp):
    ok(run("min", "--ascii", "--sort-keys", stdin='{"é":1,"e":2}'), '{"e":2,"\\u00e9":1}\n')


# ---------------- query ----------------

QDOC = ('{"users":[{"name":"ann","emails":["a@x","a@y"],"age":31},'
        '{"name":"bob","emails":[]},{"name":"cé","emails":["c@z"],"meta":{"k":"v"}}],'
        '"a key":{"b c":[1,2,3]},"n":null,"s":"line\\nnext"}')


@test
def query_basic_paths(tmp):
    ok(run("query", ".users[0].name", stdin=QDOC), '"ann"\n')
    ok(run("query", ".users[0].age", stdin=QDOC), '31\n')
    ok(run("query", ".n", stdin=QDOC), 'null\n')
    ok(run("query", ".users[2].meta", stdin=QDOC), '{"k":"v"}\n')
    ok(run("query", ".", stdin='[1, 2]'), '[1,2]\n')
    ok(run("query", ".[1]", stdin='[1, 2]'), '2\n')
    ok(run("query", "[0][0]", stdin='[[7]]'), '7\n')


@test
def query_negative_and_quoted(tmp):
    ok(run("query", ".users[-1].name", stdin=QDOC), '"cé"\n')
    ok(run("query", '.["a key"]["b c"][-3]', stdin=QDOC), '1\n')
    ok(run("query", '["a key"]["b c"]', stdin=QDOC), '[1,2,3]\n')
    ok(run("query", '["\\u00e9"]', stdin='{"é":true}'), 'true\n')
    ok(run("query", '[""]', stdin='{"":0}'), '0\n')


@test
def query_wildcards(tmp):
    ok(run("query", ".users[*].name", stdin=QDOC), '"ann"\n"bob"\n"cé"\n')
    ok(run("query", ".users[*].emails[*]", stdin=QDOC), '"a@x"\n"a@y"\n"c@z"\n')
    ok(run("query", ".users[*].emails[0]", stdin=QDOC), '"a@x"\n"c@z"\n')
    ok(run("query", "[*]", stdin='{"b":1,"a":[2]}'), '1\n[2]\n')
    ok(run("query", ".users[*].meta.k", stdin=QDOC), '"v"\n')


@test
def query_raw_and_flags(tmp):
    ok(run("query", "--raw", ".s", stdin=QDOC), 'line\nnext\n')
    ok(run("query", ".users[*].name", "--raw", stdin=QDOC), 'ann\nbob\ncé\n')
    ok(run("query", "--raw", ".users[0]", stdin='{"users":[{"b":1,"a":"x"}]}'), '{"b":1,"a":"x"}\n')
    ok(run("query", "--sort-keys", "--ascii", ".users[0]", stdin='{"users":[{"b":1,"a":"é"}]}'),
       '{"a":"\\u00e9","b":1}\n')


@test
def query_no_match(tmp):
    for path in [".missing", ".users[9]", ".users[-4]", ".users.name", ".n.x", ".users[1].emails[*]",
                 ".a.b", "[0]"]:
        r = run("query", path, stdin=QDOC if path != ".a.b" else '{"a":[1]}')
        eq(r.code, 4, f"{path} exit code")
        eq(r.out, b"", f"{path} stdout")
        eq(r.err.rstrip(b"\n"), f"error: no match for path: {path}".encode(), f"{path} stderr")


@test
def query_invalid_paths(tmp):
    for path in ["", "a", ".", "..a", ".1a", "[01]", "[-0]", "[x]", "[1", ".a.", ".a[]", '["a"', '[\'a\']', ".a-b", "[ 1]"]:
        r = run("query", path, stdin='{"a":1}')
        if path == ".":
            ok(r, '{"a":1}\n')
            continue
        usage(r)
        eq(r.err.decode().rstrip("\n"), f"error: invalid path: {path}", f"{path!r} stderr")


# ---------------- deep nesting ----------------

@test
def deep_arrays_at_limit(tmp):
    doc = "[" * 10000 + "]" * 10000
    ok(run("validate", stdin=doc), "valid\n")
    ok(run("min", stdin=doc), doc + "\n")


@test
def deep_objects_at_limit(tmp):
    doc = '{"a":' * 9999 + '[1]' + "}" * 9999
    ok(run("min", "--sort-keys", stdin=doc), doc + "\n")
    ok(run("query", "." + ".".join(["a"] * 9999) + "[0]", stdin=doc), "1\n")


@test
def deep_fmt(tmp):
    depth = 1500
    doc = "[" * depth + "]" * depth
    expected = "".join("  " * i + "[\n" for i in range(depth - 1)) + "  " * (depth - 1) + "[]\n" + \
        "".join("  " * i + "]\n" for i in reversed(range(depth - 1)))
    ok(run("fmt", stdin=doc), expected)


@test
def deep_too_deep(tmp):
    validate_err("[" * 10001, "1:10001", "nesting too deep")
    validate_err('{"k":' * 5000 + "\n" + "[" * 5001, "2:5001", "nesting too deep")
    bad_json(run("min", stdin="[" * 20000 + "]" * 20000), "1:10001", "nesting too deep")


# ---------------- command line ----------------

@test
def cli_help(tmp):
    for flag in ("--help", "-h"):
        r = run(flag)
        eq(r.code, 0, "exit code")
        assert r.out.startswith(b"usage: zj"), f"stdout {r.out[:60]!r}"


@test
def cli_usage_errors(tmp):
    cases = [[], ["bogus"], ["validate", "--sort-keys"], ["min", "--indent", "2"], ["fmt", "--indent"],
             ["fmt", "--indent", "0"], ["fmt", "--indent", "9"], ["fmt", "--indent", "x"],
             ["validate", "a", "b"], ["query"], ["query", ".a", "f", "g"], ["min", "--raw"],
             ["fmt", "--wat"], ["--help", "x"]]
    for args in cases:
        r = run(*args, stdin="[]")
        eq(r.code, 2, f"{args} exit code")
        eq(r.out, b"", f"{args} stdout")
        assert r.err.startswith(b"error: "), f"{args} stderr {r.err!r}"


@test
def cli_unreadable_file(tmp):
    r = run("min", "nope.json", cwd=tmp)
    eq(r.code, 3, "exit code")
    eq(r.out, b"", "stdout")
    eq(r.err.rstrip(b"\n"), b"error: cannot read file: nope.json", "stderr")
    r = run("validate", tmp)
    eq(r.code, 3, "directory exit code")
    eq(r.err.rstrip(b"\n"), f"error: cannot read file: {tmp}".encode(), "directory stderr")


@test
def cli_usage_checked_before_input(tmp):
    r = run("query", "bad path", "nope.json", cwd=tmp)
    eq(r.code, 2, "exit code")
    r = run("fmt", "--indent", "12", stdin="{")
    eq(r.code, 2, "exit code")


def main():
    for fn in TESTS:
        tmp = tempfile.mkdtemp(prefix="zj-hidden-")
        try:
            fn(tmp)
            print(f"PASS {fn.__name__}", flush=True)
        except Exception as e:  # noqa: BLE001
            msg = str(e) or traceback.format_exc(limit=1)
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {msg[:300]!r}", flush=True)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
