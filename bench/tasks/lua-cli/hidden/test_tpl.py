#!/usr/bin/env python3
"""Black-box tests for tpl. Usage: test_tpl.py LUA_BIN REPO
Runs `lua REPO/bin/tpl ...` from a temporary working directory and prints one line per
test: `PASS <name>` or `FAIL <name>: <reason>`."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import traceback

LUA, REPO = sys.argv[1], os.path.abspath(sys.argv[2])
BIN = os.path.join(REPO, "bin", "tpl")
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
    def errline(self):
        return self.err.decode("utf-8", "replace").rstrip("\n")


class Env:
    def __init__(self, tmp):
        self.tmp = tmp

    def run(self, *args, stdin=b"", cwd=None):
        p = subprocess.run([LUA, BIN, *args], input=stdin, capture_output=True,
                           cwd=cwd or self.tmp, timeout=30)
        return R(p)

    def write(self, name, data):
        if isinstance(data, str):
            data = data.encode()
        path = os.path.join(self.tmp, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        return name

    def render(self, template, data=None, *extra):
        """Render template text with data (dict or raw JSON text); returns the result."""
        self.write("t.mustache", template)
        args = ["t.mustache"]
        if data is not None:
            self.write("d.json", data if isinstance(data, str) else json.dumps(data))
            args += ["-d", "d.json"]
        r = self.run(*args, *extra)
        assert r.code == 0, f"exit {r.code}, stderr {r.err[:300]!r}"
        assert r.err == b"", f"unexpected stderr {r.err[:300]!r}"
        return r.text

    def fail(self, template, data=None, *extra):
        self.write("t.mustache", template)
        args = ["t.mustache"]
        if data is not None:
            self.write("d.json", data if isinstance(data, str) else json.dumps(data))
            args += ["-d", "d.json"]
        return self.run(*args, *extra)


def eq(a, b, msg=""):
    assert a == b, f"{msg} expected {b!r}, got {a!r}"


def error(r, code, message):
    eq(r.code, code, "exit code")
    eq(r.out, b"", "stdout")
    eq(r.errline, "error: " + message, "stderr")


def error_prefix(r, code, prefix):
    eq(r.code, code, "exit code")
    eq(r.out, b"", "stdout")
    assert r.errline.startswith("error: " + prefix), f"stderr {r.errline!r} should start with {prefix!r}"
    assert "\n" not in r.errline, f"stderr must be one line: {r.errline!r}"


# ---------------- variables ----------------

@test
def vars_escaped_and_raw(env):
    d = {"x": "<b>\"Tom\" & 'Jerry'</b>"}
    eq(env.render("{{x}}", d), "&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;")
    eq(env.render("{{{x}}}|{{&x}}|{{& x }}", d), "<b>\"Tom\" & 'Jerry'</b>|" * 2 + d["x"])


@test
def vars_dotted_paths_and_whitespace(env):
    d = {"user": {"address": {"city": "Lyon"}, "first-name": "Ann", "n_1": 5}}
    eq(env.render("{{ user.address.city }}/{{user.first-name}}/{{user.n_1}}/{{user.address.zip}}/{{nope.x}}", d),
       "Lyon/Ann/5//")


@test
def vars_scalar_formatting(env):
    data = '{"i": 42, "f": 2.0, "h": 1.5, "neg": -7, "big": 1e20, "e": 2.5e-3, "t": true, "fa": false, "nu": null, "z": 0}'
    eq(env.render("{{i}} {{f}} {{h}} {{neg}} {{big}} {{e}} {{t}} {{fa}} [{{nu}}] {{z}}", data),
       "42 2 1.5 -7 1e+20 0.0025 true false [] 0")


@test
def vars_unicode_escapes(env):
    data = '{"s": "caf\\u00e9 \\ud83d\\ude00 \\"q\\" \\\\ \\/ tab\\tend\\nline"}'
    eq(env.render("{{{s}}}", data), 'café 😀 "q" \\ / tab\tend\nline')


@test
def vars_text_outside_tags_untouched(env):
    tpl = "a { b } {not a tag} }} <p>&amp;</p>\n"
    eq(env.render(tpl, {}), tpl)


@test
def vars_implicit_iterator_and_missing(env):
    eq(env.render("[{{missing}}][{{{missing}}}]", {}), "[][]")
    eq(env.render("{{#list}}<{{.}}>{{/list}}", {"list": ["a&b", 1, True]}), "<a&amp;b><1><true>")


# ---------------- sections ----------------

@test
def sections_iterate_arrays(env):
    d = {"items": [{"name": "a", "qty": 1}, {"name": "b", "qty": 2}]}
    eq(env.render("{{#items}}{{name}}={{qty}};{{/items}}", d), "a=1;b=2;")


@test
def sections_falsy_values(env):
    d = {"s": "", "a": [], "f": False, "n": None}
    eq(env.render("{{#s}}S{{/s}}{{#a}}A{{/a}}{{#f}}F{{/f}}{{#n}}N{{/n}}{{#m}}M{{/m}}", d), "")
    eq(env.render("{{^s}}S{{/s}}{{^a}}A{{/a}}{{^f}}F{{/f}}{{^n}}N{{/n}}{{^m}}M{{/m}}", d), "SAFNM")


@test
def sections_truthy_scalars_and_objects(env):
    d = {"z": 0, "str": "hi", "t": True, "o": {}, "obj": {"k": "v"}}
    eq(env.render("{{#z}}[{{.}}]{{/z}}{{#str}}[{{.}}]{{/str}}{{#t}}[T]{{/t}}{{#o}}[O]{{/o}}{{#obj}}[{{k}}]{{/obj}}", d),
       "[0][hi][T][O][v]")
    eq(env.render("{{^z}}x{{/z}}{{^o}}y{{/o}}{{^t}}z{{/t}}", d), "")


@test
def sections_context_stack_lookup(env):
    d = {"site": "S", "user": {"name": "U", "posts": [{"title": "P1"}, {"title": "P2", "site": "own"}]}}
    eq(env.render("{{#user}}{{#posts}}{{title}}@{{site}}/{{name}} {{/posts}}{{/user}}", d), "P1@S/U P2@own/U ")


@test
def sections_null_key_stops_search(env):
    d = {"v": "outer", "inner": {"v": None}, "deep": {"a": {}}, "a": {"b": "top"}}
    eq(env.render("{{#inner}}[{{v}}]{{/inner}}", d), "[]")
    # `a` is found in the innermost frame, so `a.b` does not fall back to the outer `a`.
    eq(env.render("{{#deep}}[{{a.b}}]{{/deep}}", d), "[]")


@test
def sections_nested_arrays_and_dotted(env):
    d = {"m": [[1, 2], [3]], "cfg": {"flags": ["x", "y"]}}
    eq(env.render("{{#m}}({{#.}}{{.}}{{/.}}){{/m}}", d), "(12)(3)")
    eq(env.render("{{#cfg.flags}}{{.}},{{/cfg.flags}}{{^cfg.none}}-{{/cfg.none}}", d), "x,y,-")


@test
def sections_array_element_null_and_false_rendered(env):
    eq(env.render("{{#a}}<{{.}}>{{/a}}", {"a": [None, False, ""]}), "<><false><>")


# ---------------- standalone lines ----------------

@test
def standalone_section_lines_removed(env):
    tpl = "<ul>\n  {{#items}}\n  <li>{{.}}</li>\n  {{/items}}\n</ul>\n"
    eq(env.render(tpl, {"items": ["a", "b"]}), "<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>\n")
    eq(env.render(tpl, {"items": []}), "<ul>\n</ul>\n")


@test
def standalone_crlf_and_tabs(env):
    tpl = "a\r\n \t{{#x}}\t\r\nb\r\n{{/x}}\r\nc"
    eq(env.render(tpl, {"x": True}), "a\r\nb\r\nc")


@test
def standalone_comments_and_inverted(env):
    tpl = "1\n  {{! a comment }}\n2\n{{!\n  multi\n  line\n}}  \n3\n{{^no}}\n4\n{{/no}}\n"
    eq(env.render(tpl, {}), "1\n2\n3\n4\n")


@test
def standalone_not_when_other_content(env):
    eq(env.render(" {{#a}}x{{/a}} \n", {"a": True}), " x \n")
    eq(env.render("{{#a}}{{/a}}\n", {"a": True}), "\n")
    eq(env.render("x {{#a}}\ny\n{{/a}}\n", {"a": True}), "x \ny\n")
    eq(env.render("  {{v}}\n", {"v": ""}), "  \n")


@test
def standalone_last_line_without_newline(env):
    eq(env.render("a\n{{#s}}\nb\n  {{/s}}", {"s": True}), "a\nb\n")
    eq(env.render("x\n  {{! end }}", {}), "x\n")


@test
def standalone_set_delimiter_line(env):
    eq(env.render("a\n  {{=| |=}}\n|x|\n|={{ }}=|\n{{x}}\n", {"x": 1}), "a\n1\n1\n")


# ---------------- partials ----------------

@test
def partials_basic_and_context(env):
    env.write("parts/user.mustache", "<{{name}}>")
    env.write("parts/mail/footer.mustache", "bye {{site}}")
    d = {"site": "S", "users": [{"name": "a"}, {"name": "b"}]}
    eq(env.render("{{#users}}{{> user}}{{/users}} {{>mail/footer}}", d, "-p", "parts"), "<a><b> bye S")
    eq(env.render("{{> user }}", {"name": "z"}, "--partials", "parts/"), "<z>")


@test
def partials_standalone_indentation(env):
    env.write("p/list.mustache", "<ul>\n{{#items}}\n  <li>{{.}}</li>\n{{/items}}\n</ul>\n")
    tpl = "<body>\n    {{> list}}\n</body>\n"
    eq(env.render(tpl, {"items": ["x", "y"]}, "-p", "p"),
       "<body>\n    <ul>\n      <li>x</li>\n      <li>y</li>\n    </ul>\n</body>\n")


@test
def partials_inline_not_indented(env):
    env.write("p/two.mustache", "a\nb\n")
    eq(env.render("  x {{> two}}|\n", {}, "-p", "p"), "  x a\nb\n|\n")


@test
def partials_indent_does_not_affect_values(env):
    env.write("p/v.mustache", "[{{{v}}}]\n")
    eq(env.render("  {{> v}}\n", {"v": "1\n2"}, "-p", "p"), "  [1\n2]\n")


@test
def partials_recursive_tree(env):
    env.write("p/node.mustache", "{{name}}{{#kids}}({{> node}}){{/kids}}")
    d = {"name": "r", "kids": [{"name": "a", "kids": [{"name": "b", "kids": []}]}, {"name": "c", "kids": []}]}
    eq(env.render("{{> node}}", d, "-p", "p"), "r(a(b))(c)")
    # Without its own `kids`, node c finds the parent's list again and recursion never ends.
    del d["kids"][1]["kids"]
    error(env.fail("{{> node}}", d, "-p", "p", "--max-depth", "5"), 3,
          "p/node.mustache:1: partial depth limit exceeded: node")


@test
def partials_default_delimiters_per_file(env):
    env.write("p/q.mustache", "{{x}}")
    eq(env.render("{{=<% %>=}}<% x %>-<%> q %>-{{x}}", {"x": "v"}, "-p", "p"), "v-v-{{x}}")


@test
def partials_depth_limit(env):
    env.write("p/loop.mustache", "x{{> loop}}")
    error(env.fail("{{> loop}}", {}, "-p", "p"), 3, "p/loop.mustache:1: partial depth limit exceeded: loop")
    env.write("p/a.mustache", "A{{> b}}")
    env.write("p/b.mustache", "\n\nB")
    eq(env.render("{{> a}}", {}, "-p", "p", "--max-depth", "2"), "A\n\nB")
    error(env.fail("{{> a}}", {}, "-p", "p", "--max-depth", "1"), 3, "p/a.mustache:1: partial depth limit exceeded: b")
    error(env.fail("\n{{> a}}", {}, "-p", "p", "--max-depth", "0"), 3, "t.mustache:2: partial depth limit exceeded: a")


@test
def partials_not_found_and_lazy(env):
    os.makedirs(os.path.join(env.tmp, "p"))
    error(env.fail("ok\n{{> nope}}", {}, "-p", "p"), 3, "t.mustache:2: partial not found: nope")
    error(env.fail("{{> nope}}", {}), 3, "t.mustache:1: partial not found: nope")
    eq(env.render("{{#no}}{{> nope}}{{/no}}ok", {}, "-p", "p"), "ok")


@test
def partials_errors_inside_partial(env):
    env.write("p/bad.mustache", "line1\n{{#sec}}\n")
    error(env.fail("{{> bad}}", {}, "-p", "p/"), 3, "p/bad.mustache:2: unclosed section 'sec'")


# ---------------- delimiters ----------------

@test
def delims_switch_and_back(env):
    tpl = "{{=<% %>=}}<% a %> {{a}} <%& r %> <%={{ }}=%>{{a}} {{{r}}}"
    eq(env.render(tpl, {"a": "<", "r": "<"}), "&lt; {{a}} < &lt; <")


@test
def delims_sections_and_comments(env):
    tpl = "{{=[ ]=}}[#list][.],[/list][! note ][^none]-[/none]"
    eq(env.render(tpl, {"list": [1, 2]}), "1,2,-")


@test
def delims_long_and_asymmetric(env):
    eq(env.render("{{= <<< >> =}}<<<x>> <<<#t>>y<<</t>>", {"x": "1", "t": True}), "1 y")


@test
def delims_invalid(env):
    error(env.fail("ok\n{{=<% =}}"), 3, "t.mustache:2: invalid delimiter tag")
    error(env.fail("{{=a b c=}}"), 3, "t.mustache:1: invalid delimiter tag")
    error(env.fail("{{=a= b=}}"), 3, "t.mustache:1: invalid delimiter tag")


# ---------------- template errors ----------------

@test
def errors_unclosed_section_line(env):
    error(env.fail("<h1>\n{{#items}}\n<li>\n{{#sub}}{{/sub}}\n"), 3, "t.mustache:2: unclosed section 'items'")
    error(env.fail("{{#a}}\n{{#b}}\n{{/b}}\n{{#c}}\n"), 3, "t.mustache:4: unclosed section 'c'")


@test
def errors_closing_tags(env):
    error(env.fail("x\n\n{{/a}}"), 3, "t.mustache:3: unexpected closing tag 'a'")
    error(env.fail("{{#a}}\n{{#b}}\n{{/a}}\n{{/b}}"), 3, "t.mustache:3: mismatched closing tag 'a', expected 'b'")


@test
def errors_unclosed_tag_and_names(env):
    error(env.fail("a\nb {{ name\n"), 3, "t.mustache:2: unclosed tag")
    error(env.fail("{{{raw}}"), 3, "t.mustache:1: unclosed tag")
    error(env.fail("x {{}}"), 3, "t.mustache:1: invalid tag name ''")
    error(env.fail("{{first name}}"), 3, "t.mustache:1: invalid tag name 'first name'")
    error(env.fail("{{#a..b}}{{/a..b}}"), 3, "t.mustache:1: invalid tag name 'a..b'")
    error(env.fail("{{> ../etc}}"), 3, "t.mustache:1: invalid partial name '../etc'")


@test
def errors_first_in_source_order(env):
    error(env.fail("{{! multi\nline }}\n{{/x}}\n{{bad name}}\n{{#open}}"), 3, "t.mustache:3: unexpected closing tag 'x'")
    error(env.fail("{{#open}}\n{{bad name}}"), 3, "t.mustache:2: invalid tag name 'bad name'")


@test
def errors_interpolate_containers(env):
    error(env.fail("{{#u}}\n{{tags}}{{/u}}", {"u": {"tags": ["a"]}}), 3, "t.mustache:2: cannot interpolate array: tags")
    error(env.fail("{{{u}}}", {"u": {}}), 3, "t.mustache:1: cannot interpolate object: u")


@test
def errors_parse_before_render(env):
    r = env.fail("{{#x}}hello{{/x}}\n{{/y}}", {"x": True})
    error(r, 3, "t.mustache:2: unexpected closing tag 'y'")


# ---------------- JSON data ----------------

@test
def json_invalid_positions(env):
    for text, pos in [("{\"a\": [1,]}", "1, column 10"), ('{"a" 1}', "1, column 6"),
                      ('{"a": tru}', "1, column 10"), ('{"n": 01}', "1, column 8"),
                      ("{} x", "1, column 4"), ('{\n  "a": {\n    "b": [1, 2', "3, column 15"),
                      ("", "1, column 1"), ('{"s": "a\tb"}', "1, column 9"), ('{"s": "\\x"}', "1, column 9"),
                      ("{'a': 1}", "1, column 2"), ('{"a": 1 /* c */}', "1, column 9"), ('{"a": -}', "1, column 8"),
                      ('{"a": 1.}', "1, column 9")]:
        env.write("d.json", text)
        env.write("t.mustache", "x")
        error(env.run("t.mustache", "-d", "d.json"), 4, f"d.json: invalid JSON at line {pos}")


@test
def json_top_level_must_be_object(env):
    env.write("t.mustache", "x")
    for text in ["[1, 2]", "\"s\"", "null", " 3 "]:
        env.write("d.json", text)
        error(env.run("t.mustache", "-d", "d.json"), 4, "d.json: top-level value must be an object")


@test
def json_valid_documents(env):
    data = ' \r\n\t{"a" : [ ] , "b":{ },"c":[{"d":[true,false,null]}],"e":-0.5e+1,"k":1,"k":2,"":"empty"}\n'
    eq(env.render("{{^a}}A{{/a}}{{#b}}B{{/b}}{{#c}}{{#d}}{{.}},{{/d}}{{/c}}{{e}} {{k}}", data), "ABtrue,false,,-5 2")


@test
def json_unreadable_and_stdin(env):
    env.write("t.mustache", "{{a}}")
    error_prefix(env.run("t.mustache", "-d", "missing.json"), 4, "cannot read missing.json")
    r = env.run("t.mustache", "--data", "-", stdin=b'{"a": "from stdin"}')
    eq((r.code, r.text), (0, "from stdin"))
    error(env.run("t.mustache", "-d", "-", stdin=b"{"), 4, "-: invalid JSON at line 1, column 2")


@test
def json_data_error_before_template_error(env):
    env.write("d.json", "[]")
    error(env.run("missing.mustache", "-d", "d.json"), 4, "d.json: top-level value must be an object")


# ---------------- command line ----------------

@test
def cli_help(env):
    for flag in ("-h", "--help"):
        r = env.run(flag)
        eq(r.code, 0, "exit code")
        assert r.text.startswith("Usage: tpl"), f"help text {r.out[:80]!r}"


@test
def cli_usage_errors(env):
    env.write("t.mustache", "x")
    for args in [[], ["t.mustache", "t.mustache"], ["t.mustache", "--bogus"], ["t.mustache", "-d"],
                 ["t.mustache", "--max-depth", "-1"], ["t.mustache", "--max-depth", "two"],
                 ["-", "-d", "-"]]:
        error_prefix(env.run(*args), 2, "")


@test
def cli_template_stdin_and_any_order(env):
    env.write("d.json", '{"n": "N"}')
    r = env.run("-d", "d.json", "-", stdin=b"hi {{n}}")
    eq((r.code, r.text), (0, "hi N"))
    env.write("t.mustache", "{{n}}")
    r = env.run("t.mustache", "-d", "nope.json", "-d", "d.json")
    eq((r.code, r.text), (0, "N"))


@test
def cli_output_file(env):
    env.write("t.mustache", "out {{x}}\n")
    env.write("d.json", '{"x": 1}')
    r = env.run("t.mustache", "-d", "d.json", "-o", "result.txt")
    eq((r.code, r.out), (0, b""))
    with open(os.path.join(env.tmp, "result.txt"), "rb") as f:
        eq(f.read(), b"out 1\n")
    env.write("bad.mustache", "{{#x}}")
    r = env.run("bad.mustache", "--output", "other.txt")
    eq(r.code, 3)
    assert not os.path.exists(os.path.join(env.tmp, "other.txt")), "output file written on error"
    error_prefix(env.run("t.mustache", "-o", "no/such/dir/x.txt"), 5, "cannot write no/such/dir/x.txt")


@test
def cli_template_unreadable(env):
    error_prefix(env.run("missing.mustache"), 5, "cannot read missing.mustache")


@test
def cli_absolute_paths_other_cwd(env):
    env.write("t.mustache", "{{> p}}!")
    env.write("parts/p.mustache", "{{v}}")
    env.write("d.json", '{"v": "ok"}')
    j = lambda n: os.path.join(env.tmp, n)  # noqa: E731
    r = env.run(j("t.mustache"), "-d", j("d.json"), "-p", j("parts"), cwd="/")
    eq((r.code, r.text), (0, "ok!"))


@test
def cli_no_trailing_newline_added(env):
    eq(env.render("no newline", {}), "no newline")
    eq(env.render("", {}), "")


def main():
    for fn in TESTS:
        tmp = tempfile.mkdtemp(prefix="tpl-hidden-")
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
