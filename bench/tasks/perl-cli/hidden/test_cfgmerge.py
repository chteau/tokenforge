#!/usr/bin/env python3
"""Black-box tests for cfgmerge. Usage: test_cfgmerge.py PERL /path/to/bin/cfgmerge
Prints one line per test: `PASS <name>` or `FAIL <name>: <reason>`."""
import os
import shutil
import subprocess
import sys
import tempfile
import traceback

PERL = sys.argv[1]
SCRIPT = os.path.abspath(sys.argv[2])
TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


class R:
    def __init__(self, p):
        self.code, self.out, self.err = p.returncode, p.stdout.decode(), p.stderr.decode()


def eq(a, b, msg=""):
    assert a == b, f"{msg} expected {b!r}, got {a!r}"


class C:
    def __init__(self, root):
        self.root = root

    def file(self, name, text, raw=False):
        path = os.path.join(self.root, name)
        with open(path, "wb") as f:
            f.write(text if raw else text.encode())
        return name

    def __call__(self, *args, env=None):
        e = {k: v for k, v in os.environ.items() if not k.startswith("CFGT_")}
        e.update(env or {})
        return R(subprocess.run([PERL, SCRIPT, *args], cwd=self.root, env=e, capture_output=True, timeout=30))

    def ok(self, *args, env=None):
        r = self(*args, env=env)
        assert r.code == 0, f"{args}: exit {r.code}, stderr {r.err!r}"
        return r.out

    def fails(self, code, *args, err=None, out=""):
        r = self(*args)
        eq(r.code, code, f"{args} exit")
        if out is not None:
            eq(r.out, out, f"{args} stdout")
        if err is not None:
            eq(r.err, err, f"{args} stderr")
        else:
            assert r.err.startswith("error: ") or ": error: " in r.err, f"{args} stderr {r.err!r}"
        return r


BASE = """; base settings
name = demo
[db]
host = localhost
port = 5432
url = "postgres://${db.host}:${DB__PORT}/app"
[log]
level = info   ; default level
"""
PROD = """# production overrides
export DB__HOST=db.internal
LOG__LEVEL="warn"
"""


# ---------------- command line ----------------

@test
def cli_help_and_unknown(c):
    r = c("--help")
    eq(r.code, 0, "--help exit")
    assert r.out.startswith("usage: cfgmerge"), r.out[:60]
    eq(c("-h").code, 0, "-h exit")
    c.fails(2)
    c.fails(2, "frob", "a.ini")


@test
def cli_argument_errors(c):
    c.file("a.ini", "x = 1\n")
    c.fails(2, "merge")
    c.fails(2, "get", "x")
    c.fails(2, "diff", "a.ini")
    c.fails(2, "diff", "a.ini", "a.ini", "a.ini")
    c.fails(2, "merge", "--bogus", "a.ini")
    c.fails(2, "lint", "--set", "x=1", "a.ini")
    c.fails(2, "merge", "a.ini", "--format")
    c.fails(2, "merge", "--format", "json", "a.ini")
    c.fails(2, "merge", "--format", "ini", "--format", "env", "a.ini")
    c.fails(2, "merge", "--strict", "a.ini")
    c.fails(2, "merge", "--set", "noequals", "a.ini")
    c.fails(2, "merge", "--set", "bad key=1", "a.ini")


@test
def cli_file_format_and_io(c):
    c.file("a.yaml", "x: 1\n")
    c.fails(2, "merge", "a.yaml", err="error: cannot tell the format of a.yaml\n")
    r = c.fails(3, "merge", "missing.ini")
    assert r.err.startswith("error: cannot read missing.ini: "), r.err
    os.mkdir(os.path.join(c.root, "dir.ini"))
    c.fails(3, "lint", "dir.ini")
    for name in (".env", ".env.local", "prod.env", "a.cfg", "b.conf"):
        c.file(name, "K=v\n" if "env" in name else "k = v\n")
        c.ok("merge", name)


@test
def cli_options_anywhere_and_double_dash(c):
    c.file("a.ini", "x = 1\n")
    c.file("-odd.ini", "x = 2\n")
    eq(c.ok("merge", "a.ini", "--format", "env", "--set", "y=2"), "X=1\nY=2\n")
    eq(c.ok("merge", "a.ini", "--", "-odd.ini"), "x = 2\n")


# ---------------- lint ----------------

@test
def lint_clean(c):
    c.file("base.ini", BASE)
    c.file("prod.env", PROD)
    r = c("lint", "base.ini", "prod.env")
    eq((r.code, r.out), (0, "0 error(s), 0 warning(s)\n"))


@test
def lint_all_messages_ini(c):
    c.file("bad.ini", "\n".join([
        "[db",                     # 1
        "[ok]  ; fine",            # 2
        "just text",               # 3
        "bad key = 1",             # 4
        'q = "open',               # 5
        'q2 = "a" b',              # 6
        "r = ${a b}",              # 7
        "r2 = ${x",                # 8
        "dup = 1",                 # 9
        "Dup = 2",                 # 10
        "[ok]",                    # 11
        "dup = 3",                 # 12
        "s = 'single' ; c",        # 13
        "t = 'x' y",               # 14
    ]) + "\n")
    r = c("lint", "bad.ini")
    eq(r.code, 1, "exit")
    eq(r.out.splitlines(), [
        "bad.ini:1: error: invalid section header",
        "bad.ini:3: error: missing '='",
        "bad.ini:4: error: invalid key 'bad key'",
        "bad.ini:5: error: unterminated quote",
        "bad.ini:6: error: trailing characters after closing quote",
        "bad.ini:7: error: invalid reference",
        "bad.ini:8: error: invalid reference",
        "bad.ini:10: warning: duplicate key 'ok.dup' (previous definition on line 9)",
        "bad.ini:12: warning: duplicate key 'ok.dup' (previous definition on line 10)",
        "bad.ini:14: error: trailing characters after closing quote",
        "8 error(s), 2 warning(s)",
    ])


@test
def lint_env_messages_and_multiple_files(c):
    c.file("a.env", "[section]\n1BAD=x\nGOOD=1\nexport  GOOD=2\nA-B=3\n")
    c.file("b.ini", "k = 1\nk = 2\n")
    r = c("lint", "b.ini", "a.env")
    eq(r.code, 1, "exit")
    eq(r.out.splitlines(), [
        "b.ini:2: warning: duplicate key 'k' (previous definition on line 1)",
        "a.env:1: error: section headers are not allowed in env files",
        "a.env:2: error: invalid key '1BAD'",
        "a.env:4: warning: duplicate key 'good' (previous definition on line 3)",
        "a.env:5: error: invalid key 'A-B'",
        "3 error(s), 2 warning(s)",
    ])
    r = c("lint", "b.ini")
    eq((r.code, r.out.splitlines()[-1]), (0, "0 error(s), 1 warning(s)"))


@test
def lint_bom_crlf(c):
    c.file("w.ini", b"\xef\xbb\xbf[db]\r\nhost = h\r\n\r\nbad\r\n", raw=True)
    r = c("lint", "w.ini")
    eq(r.out, "w.ini:4: error: missing '='\n1 error(s), 0 warning(s)\n")
    c.file("w2.ini", b"\xef\xbb\xbf[db]\r\nhost = h  \r\n", raw=True)
    eq(c.ok("get", "db.host", "w2.ini"), "h\n")


# ---------------- parsing values ----------------

@test
def parse_quoting_rules(c):
    c.file("v.ini", "\n".join([
        "[v]",
        "a = plain text ; comment",
        "b = no;comment#here",
        'c = "  padded \\"q\\" \\\\ \\t \\n end  "  # c',
        "d = 'lit ${x} \\n $$'",
        'e = "keep \\q backslash"',
        "f =",
        'g = ""',
        "h = a # b",
        "i = tab\there",
    ]) + "\n")
    eq(c.ok("get", "v.a", "v.ini"), "plain text\n")
    eq(c.ok("get", "v.b", "v.ini"), "no;comment#here\n")
    eq(c.ok("get", "v.c", "v.ini"), '  padded "q" \\ \t \n end  \n')
    eq(c.ok("get", "v.d", "v.ini"), "lit ${x} \\n $$\n")
    eq(c.ok("get", "v.e", "v.ini"), "keep \\q backslash\n")
    eq(c.ok("get", "v.f", "v.ini"), "\n")
    eq(c.ok("get", "v.g", "v.ini"), "\n")
    eq(c.ok("get", "v.h", "v.ini"), "a\n")
    eq(c.ok("get", "v.i", "v.ini"), "tab\there\n")


@test
def parse_keys_sections_case(c):
    c.file("k.ini", "Top = 1\n[DB.Replica]\nHost = r1\npool.size = 4\n[db]\nhost = main\n[db.replica]\nhost = r2\n")
    eq(c.ok("merge", "k.ini"), "top = 1\n\n[db]\nhost = main\n\n[db.replica]\nhost = r2\n\n[db.replica.pool]\nsize = 4\n")
    eq(c.ok("get", "DB.REPLICA.HOST", "k.ini"), "r2\n")


@test
def parse_env_mapping(c):
    c.file("e.env", "export APP_NAME=shop\nDB__REPLICA__HOST = r\nLog__Level='x'\n")
    eq(c.ok("merge", "e.env"), "app_name = shop\n\n[db.replica]\nhost = r\n\n[log]\nlevel = x\n")


# ---------------- merging ----------------

@test
def merge_precedence_and_ini_output(c):
    c.file("base.ini", BASE)
    c.file("prod.env", PROD)
    eq(c.ok("merge", "base.ini", "prod.env"),
       "name = demo\n\n[db]\nhost = db.internal\nport = 5432\nurl = postgres://db.internal:5432/app\n\n"
       "[log]\nlevel = warn\n")
    eq(c.ok("merge", "prod.env", "base.ini"),
       "name = demo\n\n[db]\nhost = localhost\nport = 5432\nurl = postgres://localhost:5432/app\n\n"
       "[log]\nlevel = info\n")


@test
def merge_env_format(c):
    c.file("base.ini", BASE)
    c.file("prod.env", PROD)
    eq(c.ok("merge", "--format", "env", "base.ini", "prod.env"),
       "DB__HOST=db.internal\nDB__PORT=5432\nDB__URL=postgres://db.internal:5432/app\nLOG__LEVEL=warn\nNAME=demo\n")


@test
def merge_set_overrides_everything(c):
    c.file("base.ini", BASE)
    c.file("prod.env", PROD)
    out = c.ok("merge", "--set", "db.host=cli", "base.ini", "prod.env", "--set", "DB.Port=1", "--set", "db.port=2")
    assert "host = cli\nport = 2\nurl = postgres://cli:2/app\n" in out, out


@test
def merge_output_quoting_roundtrip(c):
    c.file("q.ini", "\n".join([
        "[q]",
        'a = "  lead"',
        'b = "semi;colon"',
        "c = 'dollar $HOME'",
        'd = "line\\nbreak"',
        'e = ""',
        "f = plain-value.with:chars/ok",
        'g = "quote \\" and \\\\"',
        'h = "tab\\tx"',
        "i = it's",
    ]) + "\n")
    out = c.ok("merge", "q.ini")
    eq(out, "\n".join([
        "[q]",
        'a = "  lead"',
        'b = "semi;colon"',
        'c = "dollar \\$HOME"',
        'd = "line\\nbreak"',
        'e = ""',
        "f = plain-value.with:chars/ok",
        'g = "quote \\" and \\\\"',
        'h = "tab\\tx"',
        "i = \"it's\"",
    ]) + "\n")
    c.file("again.ini", out)
    eq(c.ok("merge", "again.ini"), out, "re-read")
    env_out = c.ok("merge", "--format", "env", "q.ini")
    c.file("again.env", env_out)
    eq(c.ok("merge", "again.env"), out, "re-read env")


@test
def merge_layer_errors(c):
    c.file("good.ini", "a = 1\n")
    c.file("bad.ini", "a = 1\nnope\n")
    c.file("bad.env", "[x]\nB=2\nB=3\n")
    r = c.fails(1, "merge", "good.ini", "bad.ini", "bad.env")
    eq(r.err, "bad.ini:2: error: missing '='\nbad.env:1: error: section headers are not allowed in env files\n")


# ---------------- references ----------------

@test
def interp_chain_and_final_values(c):
    c.file("a.ini", "[a]\nurl = ${a.scheme}://${A__HOST}${a.path:-/}\nscheme = http\nhost = ${env:CFGT_HOST}\n")
    c.file("b.ini", "[a]\nscheme = https\n")
    eq(c.ok("get", "a.url", "a.ini", "b.ini", env={"CFGT_HOST": "ex.org"}), "https://ex.org/\n")
    eq(c.ok("get", "a.url", "a.ini", "b.ini", "--set", "a.path=/x", env={"CFGT_HOST": "h"}), "https://h/x\n")


@test
def interp_defaults_and_dollars(c):
    c.file("d.ini", "a = ${missing:-}|${env:CFGT_NOPE:-fallback}|$$5|$x|cost $|${b:-unused}\nb = B\n"
                    'c = "esc \\${a}"\n')
    eq(c.ok("get", "a", "d.ini"), "|fallback|$5|$x|cost $|B\n")
    eq(c.ok("get", "c", "d.ini"), "esc ${a}\n")


@test
def interp_undefined(c):
    c.file("u.ini", "a = 1\n[s]\nk = x${Nope__Here}y\n")
    c.fails(1, "merge", "u.ini", err="error: undefined reference '${Nope__Here}' in key 's.k'\n")
    c.file("u2.ini", "k = ${env:CFGT_MISSING}\n")
    c.fails(1, "get", "k", "u2.ini", err="error: undefined reference '${env:CFGT_MISSING}' in key 'k'\n")


@test
def interp_cycles(c):
    c.file("c.ini", "a = ${b}\nb = ${c}\nc = x${b}\n")
    c.fails(1, "merge", "c.ini", err="error: reference cycle: b -> c -> b\n")
    c.file("s.ini", "z = 1\nself = ${self}\n")
    c.fails(1, "merge", "s.ini", err="error: reference cycle: self -> self\n")
    c.file("l.ini", "a = ${c}${b}\nb = ${a}\nc = ok\n")
    c.fails(1, "get", "c", "l.ini", err="error: reference cycle: a -> b -> a\n")


@test
def interp_cycle_broken_by_override(c):
    c.file("c.ini", "a = ${b}\nb = ${a}\n")
    c.file("fix.env", "B=done\n")
    eq(c.ok("merge", "c.ini", "fix.env"), "a = done\nb = done\n")


# ---------------- schema ----------------

SCHEMA = """[db.port]
type = int
required = true
min = 1
max = 65535

[log.level]
type = enum
values = debug, info , warn,error
default = info

[name]
type = string
min = 2
max = 5

[ratio]
type = number
min = -1.5
max = 0.75

[feature]
type = bool
default = off
"""


@test
def schema_valid_with_defaults(c):
    c.file("s.ini", SCHEMA)
    c.file("a.ini", "name = ünï\n[db]\nport = 80\n")
    eq(c.ok("merge", "--schema", "s.ini", "a.ini"), "feature = off\nname = ünï\n\n[db]\nport = 80\n\n[log]\nlevel = info\n")


@test
def schema_violations_sorted(c):
    c.file("s.ini", SCHEMA)
    c.file("a.ini", "name = abcdef\nratio = 0.8\nfeature = maybe\n[log]\nlevel = Info\n")
    r = c.fails(1, "merge", "--schema", "s.ini", "a.ini")
    eq(r.err.splitlines(), [
        "error: db.port: required key is missing",
        'error: feature: expected bool, got "maybe"',
        'error: log.level: "Info" is not one of: debug, info, warn, error',
        "error: name: length 6 is greater than maximum 5",
        "error: ratio: 0.8 is greater than maximum 0.75",
    ])


@test
def schema_type_and_bounds(c):
    c.file("s.ini", SCHEMA)
    cases = [
        (["db.port=08x"], 'error: db.port: expected int, got "08x"'),
        (["db.port=0"], "error: db.port: 0 is less than minimum 1"),
        (["db.port=65536"], "error: db.port: 65536 is greater than maximum 65535"),
        (["db.port=1", "ratio=-2"], "error: ratio: -2 is less than minimum -1.5"),
        (["db.port=1", "ratio=1."], 'error: ratio: expected number, got "1."'),
        (["db.port=1", "name=x"], "error: name: length 1 is less than minimum 2"),
        (["db.port=1.0"], 'error: db.port: expected int, got "1.0"'),
    ]
    c.file("empty.ini", "")
    for sets, msg in cases:
        args = ["merge", "--schema", "s.ini", "empty.ini"]
        for s in sets:
            args += ["--set", s]
        c.fails(1, *args, err=msg + "\n")
    eq(c.ok("get", "feature", "empty.ini", "--set", "feature=YES"), "YES\n")
    c.ok("merge", "--schema", "s.ini", "empty.ini", "--set", "db.port=-0", "--set", "db.port=65535", "--set", "feature=On",
         "--set", "ratio=-1.5")


@test
def schema_strict(c):
    c.file("s.ini", SCHEMA)
    c.file("a.ini", "zeta = 1\n[db]\nport = 5\nhost = h\n")
    c.ok("merge", "--schema", "s.ini", "a.ini")
    r = c.fails(1, "merge", "--schema", "s.ini", "--strict", "a.ini")
    eq(r.err, "error: db.host: not in schema\nerror: zeta: not in schema\n")


@test
def schema_invalid(c):
    c.file("a.ini", "x = 1\n")
    bad = {
        "s1.ini": "[x]\ntype = text\n",
        "s2.ini": "[x]\ntype = int\ncolour = red\n",
        "s3.ini": "[x]\ntype = enum\nvalues = a,b\nmax = 3\n",
        "s4.ini": "[x]\ntype = enum\n",
        "s5.ini": "type = int\n",
        "s6.ini": "[x]\nrequired = true\n",
        "s7.ini": "[x]\ntype = int\nmin = one\n",
    }
    for name, text in bad.items():
        c.file(name, text)
        r = c.fails(2, "merge", "--schema", name, "a.ini")
        assert r.err.startswith("error: invalid schema: "), (name, r.err)
    r = c.fails(2, "merge", "--schema", "s1.ini", "a.ini", err="error: invalid schema: x: unknown type 'text'\n")


# ---------------- explain ----------------

@test
def explain_sources_and_overrides(c):
    c.file("base.ini", BASE)
    c.file("prod.env", PROD)
    c.file("local.ini", "[log]\nlevel = debug\nlevel = trace\n")
    out = c.ok("explain", "base.ini", "prod.env", "local.ini", "--set", "log.level=${db.host}")
    eq(out, "\n".join([
        'db.host = "db.internal"  [prod.env:2]',
        '  overrides "localhost"  [base.ini:4]',
        'db.port = "5432"  [base.ini:5]',
        'db.url = "postgres://db.internal:5432/app"  [base.ini:6]',
        'log.level = "db.internal"  [--set]',
        '  overrides "trace"  [local.ini:3]',
        '  overrides "warn"  [prod.env:3]',
        '  overrides "info"  [base.ini:8]',
        'name = "demo"  [base.ini:2]',
    ]) + "\n")


@test
def explain_unexpanded_and_defaults(c):
    c.file("s.ini", "[port]\ntype = int\ndefault = 8080\n[host]\ntype = string\n")
    c.file("a.ini", 'host = "${base}\\tx"\nbase = b\n')
    c.file("b.ini", "host = 'lit$'\n")
    eq(c.ok("explain", "--schema", "s.ini", "a.ini", "b.ini"), "\n".join([
        'base = "b"  [a.ini:2]',
        'host = "lit$"  [b.ini:1]',
        '  overrides "${base}\\tx"  [a.ini:1]',
        'port = "8080"  [default]',
    ]) + "\n")


# ---------------- diff and get ----------------

@test
def diff_output(c):
    c.file("a.ini", "same = 1\nold = x\n[s]\nv = 1\nref = ${same}\n")
    c.file("b.env", 'SAME=1\nNEW="q\\"t"\nS__V=2\nS__REF=${same}\n')
    r = c("diff", "a.ini", "b.env")
    eq(r.code, 1, "exit")
    eq(r.out, '+ new = "q\\"t"\n- old = "x"\n~ s.v: "1" -> "2"\n')
    r = c("diff", "a.ini", "a.ini")
    eq((r.code, r.out), (0, ""))


@test
def diff_layer_error(c):
    c.file("a.ini", "x = 1\n")
    c.file("b.ini", "x = ${y}\n")
    c.fails(1, "diff", "a.ini", "b.ini", err="error: undefined reference '${y}' in key 'x'\n")


@test
def get_missing_key(c):
    c.file("a.ini", "x = 1\n")
    c.fails(1, "get", "y.z", "a.ini", err="error: key not found: y.z\n")
    eq(c.ok("get", "X", "a.ini"), "1\n")



def main():
    for fn in TESTS:
        tmp = tempfile.mkdtemp(prefix="cfgmerge-hidden-")
        try:
            fn(C(tmp))
            print(f"PASS {fn.__name__}", flush=True)
        except Exception as e:  # noqa: BLE001
            msg = str(e) or traceback.format_exc(limit=1)
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {msg[:300]!r}", flush=True)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
