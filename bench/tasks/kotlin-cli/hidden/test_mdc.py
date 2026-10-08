#!/usr/bin/env python3
"""Black-box tests for mdc. Usage: test_mdc.py /path/to/mdc.jar
Prints one line per test: `PASS <name>` or `FAIL <name>: <reason>`."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import traceback

JAR = os.path.abspath(sys.argv[1])
JAVA = shutil.which("java", path="/home/linuxbrew/.linuxbrew/bin:" + os.environ.get("PATH", "")) or "java"
TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


class R:
    def __init__(self, p):
        self.code, self.out, self.err = p.returncode, p.stdout.decode("utf-8", "replace"), p.stderr.decode("utf-8", "replace")


def run(*args, stdin="", cwd=None):
    p = subprocess.run([JAVA, "-jar", JAR, *args], input=stdin.encode("utf-8"), capture_output=True,
                       timeout=30, cwd=cwd)
    return R(p)


def eq(a, b, msg=""):
    assert a == b, f"{msg} expected {b!r}, got {a!r}"


def md(src, *args):
    """Convert src (via stdin) and return stdout; asserts success."""
    r = run(*args, stdin=src)
    assert r.code == 0, f"exit {r.code}, stderr {r.err!r}"
    return r.out


def html(*lines):
    return "".join(l + "\n" for l in lines)


def err(r, code, text=None):
    eq(r.code, code, "exit code")
    eq(r.out, "", "stdout")
    assert r.err.startswith("error: "), f"stderr {r.err!r}"
    if text is not None:
        eq(r.err.rstrip("\n"), "error: " + text, "stderr")


# ---------------- command line ----------------

@test
def cli_help(tmp):
    r = run("--help")
    eq(r.code, 0)
    assert r.out.startswith("usage: mdc"), r.out


@test
def cli_file_and_output(tmp):
    src = os.path.join(tmp, "in.md")
    with open(src, "w", encoding="utf-8") as f:
        f.write("# Hi\n")
    r = run(src)
    eq(r.code, 0)
    eq(r.out, html('<h1 id="hi">Hi</h1>'))
    out = os.path.join(tmp, "out.html")
    r = run("-o", out, src)
    eq(r.code, 0)
    eq(r.out, "", "stdout with -o")
    with open(out, encoding="utf-8") as f:
        eq(f.read(), html('<h1 id="hi">Hi</h1>'))


@test
def cli_stdin_dash_and_empty(tmp):
    eq(md("plain\n", "-"), html("<p>plain</p>"))
    eq(md(""), "")
    eq(md("\n\n  \n"), "")


@test
def cli_missing_file(tmp):
    p = os.path.join(tmp, "nope.md")
    err(run(p), 1, f"cannot read {p}")


@test
def cli_usage_errors(tmp):
    err(run("--bogus"), 2)
    err(run("a.md", "b.md"), 2)
    err(run("--toc-depth", "9"), 2)
    err(run("--toc-depth"), 2)
    err(run("-o"), 2)


@test
def cli_crlf(tmp):
    eq(md("# T\r\n\r\nline one\r\nline two\r\n"), html('<h1 id="t">T</h1>', "<p>line one\nline two</p>"))


# ---------------- front matter ----------------

FM = """---
title: Hello "World"
draft: false
count: 42
tags: [kotlin, cli , md]
empty:
quoted: "007"
# a comment

path: C:\\temp
---
# Body
"""


@test
def fm_json_types(tmp):
    out = md(FM, "--front-matter")
    eq(out, '{"title": "Hello \\"World\\"", "draft": false, "count": 42, "tags": ["kotlin", "cli", "md"], '
            '"empty": null, "quoted": "007", "path": "C:\\\\temp"}\n')
    json.loads(out)


@test
def fm_stripped_from_html(tmp):
    eq(md(FM), html('<h1 id="body">Body</h1>'))


@test
def fm_absent_gives_empty_object(tmp):
    eq(md("# x\n", "--front-matter"), "{}\n")
    eq(md("---\n---\ntext\n", "--front-matter"), "{}\n")
    eq(md("---\n---\ntext\n"), html("<p>text</p>"))


@test
def fm_empty_array_and_unicode(tmp):
    eq(md("---\nlist: []\nname: Zoë ☕\n---\n", "--front-matter"), '{"list": [], "name": "Zoë ☕"}\n')


@test
def fm_unterminated(tmp):
    err(run(stdin="---\ntitle: x\n# Body\n"), 3, "unterminated front matter")


@test
def fm_invalid_line(tmp):
    err(run(stdin="---\ntitle: ok\nnot a pair\n---\n"), 3, "front matter line 3: invalid line")
    err(run(stdin="---\n1abc: x\n---\n"), 3, "front matter line 2: invalid line")


@test
def fm_duplicate_key(tmp):
    err(run(stdin="---\na: 1\n\nb: 2\na: 3\n---\n", ), 3, "front matter line 5: duplicate key a")


# ---------------- blocks ----------------

@test
def block_headings_levels(tmp):
    eq(md("# One\n## Two\n###### Six\n####### Seven\n#NoSpace\n"),
       html('<h1 id="one">One</h1>', '<h2 id="two">Two</h2>', '<h6 id="six">Six</h6>',
            "<p>####### Seven\n#NoSpace</p>"))


@test
def block_paragraphs_and_breaks(tmp):
    eq(md("first  \n   second\n\nthird\n---\n***\n___\n-- not\n"),
       html("<p>first\nsecond</p>", "<p>third</p>", "<hr>", "<hr>", "<hr>", "<p>-- not</p>"))


@test
def block_heading_interrupts_paragraph(tmp):
    eq(md("para\n# Head\nmore\n"), html("<p>para</p>", '<h1 id="head">Head</h1>', "<p>more</p>"))


@test
def block_blockquote_nested(tmp):
    eq(md("> quoted *text*\n> still\n>\n> > inner\n\nafter\n"),
       html("<blockquote>", "<p>quoted <em>text</em>\nstill</p>", "<blockquote>", "<p>inner</p>",
            "</blockquote>", "</blockquote>", "<p>after</p>"))


@test
def block_blockquote_with_list(tmp):
    eq(md(">- a\n>- b\n"), html("<blockquote>", "<ul>", "<li>a</li>", "<li>b</li>", "</ul>", "</blockquote>"))


@test
def block_escaping(tmp):
    eq(md('<b>"Tom" & Jerry</b>\n'), html("<p>&lt;b&gt;&quot;Tom&quot; &amp; Jerry&lt;/b&gt;</p>"))


# ---------------- inline ----------------

@test
def inline_emphasis_strong(tmp):
    eq(md("**bold** and *it* and __b2__ and _i2_\n"),
       html("<p><strong>bold</strong> and <em>it</em> and <strong>b2</strong> and <em>i2</em></p>"))


@test
def inline_nested_emphasis(tmp):
    eq(md("**bold *inner* x** and *a **b** c*\n"),
       html("<p><strong>bold <em>inner</em> x</strong> and <em>a <strong>b</strong> c</em></p>"))


@test
def inline_unmatched_and_spaces(tmp):
    eq(md("a * b * c and *open end\n"), html("<p>a * b * c and *open end</p>"))


@test
def inline_intraword_underscore(tmp):
    eq(md("call snake_case_name and _yes_\n"), html("<p>call snake_case_name and <em>yes</em></p>"))


@test
def inline_code_spans(tmp):
    eq(md("use `a < b` and ``x ` y`` and `*no*` and `open\n"),
       html("<p>use <code>a &lt; b</code> and <code>x ` y</code> and <code>*no*</code> and `open</p>"))


@test
def inline_backslash_escapes(tmp):
    eq(md("\\*not\\* \\# \\[x\\] \\q\n"), html("<p>*not* # [x] \\q</p>"))


@test
def inline_links(tmp):
    eq(md('[home](https://ex.com/?a=1&b=2) and [**bold** `c`](/p "The Title") and [broken] (x) [no](\n'),
       html('<p><a href="https://ex.com/?a=1&amp;b=2">home</a> and '
            '<a href="/p" title="The Title"><strong>bold</strong> <code>c</code></a> and [broken] (x) [no](</p>'))


@test
def inline_images(tmp):
    eq(md('![a *cat* & "dog"](cat.png) and ![](e.gif)\n'),
       html('<p><img src="cat.png" alt="a *cat* &amp; &quot;dog&quot;"> and <img src="e.gif" alt=""></p>'))


@test
def inline_images_simple(tmp):
    eq(md('![Logo](img/logo.svg "Our logo")\n'),
       html('<p><img src="img/logo.svg" alt="Logo" title="Our logo"></p>'))


# ---------------- fenced code ----------------

@test
def code_fence_language(tmp):
    eq(md("```kotlin extra\nval x = a < b && c\n  indented *x*\n```\n"),
       html('<pre><code class="language-kotlin">val x = a &lt; b &amp;&amp; c\n  indented *x*\n</code></pre>'))


@test
def code_fence_plain_and_blank_lines(tmp):
    eq(md("```\n# not heading\n\n- not list\n```\nafter\n"),
       html("<pre><code># not heading\n\n- not list\n</code></pre>", "<p>after</p>"))


@test
def code_fence_unclosed_and_empty(tmp):
    eq(md("```\n```\n"), html("<pre><code></code></pre>"))
    eq(md("text\n```py\nx = 1\n"), html("<p>text</p>", '<pre><code class="language-py">x = 1\n</code></pre>'))


# ---------------- lists ----------------

@test
def list_unordered_markers(tmp):
    eq(md("- a\n* b\n+ *c*\n"), html("<ul>", "<li>a</li>", "<li>b</li>", "<li><em>c</em></li>", "</ul>"))


@test
def list_ordered_start(tmp):
    eq(md("1. one\n2. two\n"), html("<ol>", "<li>one</li>", "<li>two</li>", "</ol>"))
    eq(md("3. three\n7. four\n"), html('<ol start="3">', "<li>three</li>", "<li>four</li>", "</ol>"))


@test
def list_nested_mixed(tmp):
    eq(md("- a\n  1. one\n  2. two\n     - deep\n- b\n"),
       html("<ul>", "<li>a", "<ol>", "<li>one</li>", "<li>two", "<ul>", "<li>deep</li>", "</ul>", "</li>",
            "</ol>", "</li>", "<li>b</li>", "</ul>"))


@test
def list_depth_capped(tmp):
    eq(md("- a\n      - b\n  - c\n"),
       html("<ul>", "<li>a", "<ul>", "<li>b</li>", "<li>c</li>", "</ul>", "</li>", "</ul>"))


@test
def list_type_switch_and_blank_lines(tmp):
    eq(md("- a\n\n- b\n1. c\n\npara\n"),
       html("<ul>", "<li>a</li>", "<li>b</li>", "</ul>", "<ol>", "<li>c</li>", "</ol>", "<p>para</p>"))


@test
def list_ends_at_text_line(tmp):
    eq(md("text\n- item\nnot item\n"), html("<p>text</p>", "<ul>", "<li>item</li>", "</ul>", "<p>not item</p>"))


# ---------------- tables ----------------

@test
def table_basic_alignment(tmp):
    eq(md("| Name | Qty | Mid | Left |\n|------|----:|:---:|:-----|\n| Apple | 3 | x | `a|b` |\n"),
       html("<table>", "<thead>",
            '<tr><th>Name</th><th align="right">Qty</th><th align="center">Mid</th><th align="left">Left</th></tr>',
            "</thead>", "<tbody>",
            '<tr><td>Apple</td><td align="right">3</td><td align="center">x</td><td align="left">`a</td></tr>',
            "</tbody>", "</table>"))


@test
def table_pad_truncate_escape(tmp):
    eq(md("a | b\n--|--\n1 |\n1 | 2 | 3\nx \\| y | *z*\n\nafter\n"),
       html("<table>", "<thead>", "<tr><th>a</th><th>b</th></tr>", "</thead>", "<tbody>",
            "<tr><td>1</td><td></td></tr>", "<tr><td>1</td><td>2</td></tr>",
            "<tr><td>x | y</td><td><em>z</em></td></tr>", "</tbody>", "</table>", "<p>after</p>"))


@test
def table_header_only_and_not_a_table(tmp):
    eq(md("| h |\n|---|\n"), html("<table>", "<thead>", "<tr><th>h</th></tr>", "</thead>", "</table>"))
    eq(md("| a | b |\n|---|\n"), html("<p>| a | b |\n|---|</p>"))


@test
def table_interrupts_paragraph(tmp):
    eq(md("intro\n| k | v |\n| - | - |\n| 1 | 2 |\n"),
       html("<p>intro</p>", "<table>", "<thead>", "<tr><th>k</th><th>v</th></tr>", "</thead>", "<tbody>",
            "<tr><td>1</td><td>2</td></tr>", "</tbody>", "</table>"))


# ---------------- slugs and table of contents ----------------

@test
def toc_slug_rules(tmp):
    eq(md("# Hello, World!\n## *Fancy* `code` -- Title\n### Café Déjà vu\n#### ???\n"),
       html('<h1 id="hello-world">Hello, World!</h1>',
            '<h2 id="fancy-code-title"><em>Fancy</em> <code>code</code> -- Title</h2>',
            '<h3 id="café-déjà-vu">Café Déjà vu</h3>', '<h4 id="section">???</h4>'))


@test
def toc_slug_dedup(tmp):
    eq(md("# Intro\n# Intro\n# Intro 1\n# Intro\n"),
       html('<h1 id="intro">Intro</h1>', '<h1 id="intro-1">Intro</h1>', '<h1 id="intro-1-1">Intro 1</h1>',
            '<h1 id="intro-2">Intro</h1>'))


@test
def toc_nested(tmp):
    eq(md("# Guide\n## Install\n### Linux\n## Use & Abuse\n#### Deep\n", "--toc"),
       html('<nav class="toc">', "<ul>", '<li><a href="#guide">Guide</a>', "<ul>",
            '<li><a href="#install">Install</a>', "<ul>", '<li><a href="#linux">Linux</a></li>', "</ul>", "</li>",
            '<li><a href="#use-abuse">Use &amp; Abuse</a></li>', "</ul>", "</li>", "</ul>", "</nav>",
            '<h1 id="guide">Guide</h1>', '<h2 id="install">Install</h2>', '<h3 id="linux">Linux</h3>',
            '<h2 id="use-abuse">Use &amp; Abuse</h2>', '<h4 id="deep">Deep</h4>'))


@test
def toc_depth_and_relative_levels(tmp):
    eq(md("## A\n#### B\n### C\n# Top\n", "--toc", "--toc-depth", "4"),
       html('<nav class="toc">', "<ul>", '<li><a href="#a">A</a>', "<ul>",
            '<li><a href="#b">B</a>', "<ul>", '<li><a href="#c">C</a></li>', "</ul>", "</li>", "</ul>", "</li>",
            '<li><a href="#top">Top</a></li>', "</ul>", "</nav>",
            '<h2 id="a">A</h2>', '<h4 id="b">B</h4>', '<h3 id="c">C</h3>', '<h1 id="top">Top</h1>'))


@test
def toc_none_and_dedup_links(tmp):
    eq(md("text only\n", "--toc"), html("<p>text only</p>"))
    eq(md("#### Deep\n", "--toc"), html('<h4 id="deep">Deep</h4>'))
    out = md("## X\n## X\n", "--toc", "--toc-depth", "2")
    eq(out, html('<nav class="toc">', "<ul>", '<li><a href="#x">X</a></li>', '<li><a href="#x-1">X</a></li>',
                 "</ul>", "</nav>", '<h2 id="x">X</h2>', '<h2 id="x-1">X</h2>'))


def main():
    for fn in TESTS:
        tmp = tempfile.mkdtemp(prefix="mdc-hidden-")
        try:
            fn(tmp)
            print(f"PASS {fn.__name__}", flush=True)
        except Exception as e:  # noqa: BLE001
            msg = str(e) or traceback.format_exc(limit=1)
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {msg[:400]!r}", flush=True)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
