#!/usr/bin/env python3
"""Black-box tests for asm. Usage: test_asm.py /path/to/asm
Prints one line per test: `PASS <name>` or `FAIL <name>: <reason>`."""
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import traceback

BIN = os.path.abspath(sys.argv[1])
TESTS = []

OPS = {"halt": 0x00, "push": 0x01, "pop": 0x02, "dup": 0x03, "swap": 0x04, "over": 0x05,
       "add": 0x10, "sub": 0x11, "mul": 0x12, "div": 0x13, "mod": 0x14, "neg": 0x15, "cmp": 0x16,
       "jmp": 0x20, "jz": 0x21, "jnz": 0x22, "call": 0x23, "ret": 0x24,
       "load": 0x30, "store": 0x31, "print": 0x40}
WITH_ARG = {"push", "load", "store", "jmp", "jz", "jnz", "call"}


def test(fn):
    TESTS.append(fn)
    return fn


class R:
    def __init__(self, p):
        self.code, self.out, self.err = p.returncode, p.stdout, p.stderr


def run(*args, timeout=30):
    return R(subprocess.run([BIN, *args], capture_output=True, timeout=timeout))


def eq(a, b, msg=""):
    assert a == b, f"{msg} expected {b!r}, got {a!r}"


def ins(op, arg=None):
    """Encode one instruction; signed operand, or unsigned for large targets."""
    b = bytes([OPS[op]])
    if op in WITH_ARG:
        b += struct.pack("<I", arg) if arg is not None and arg > 0x7FFFFFFF else struct.pack("<i", arg)
    return b


def image(code=b"", data=(), version=1, magic=b"SVMB", reserved=b"\0\0\0"):
    return (magic + bytes([version]) + reserved + struct.pack("<II", len(code), len(data)) + code
            + b"".join(struct.pack("<i", w) for w in data))


class W:
    """A scratch directory with helpers."""

    def __init__(self, root):
        self.root = root

    def path(self, name):
        return os.path.join(self.root, name)

    def write(self, name, content):
        p = self.path(name)
        with open(p, "wb") as f:
            f.write(content.encode() if isinstance(content, str) else content)
        return p

    def read(self, name):
        with open(self.path(name), "rb") as f:
            return f.read()

    def asm(self, source, name="prog"):
        src = self.write(name + ".s", source)
        return run("assemble", src, "-o", self.path(name + ".bin"))

    def build(self, source, name="prog"):
        r = self.asm(source, name)
        assert r.code == 0, f"assemble failed: exit {r.code}, stderr {r.err!r}"
        eq(r.out, b"", "assemble stdout")
        return self.read(name + ".bin")

    def exec(self, source, *extra):
        self.build(source)
        return run("run", self.path("prog.bin"), *extra)

    def ok(self, source, *extra):
        r = self.exec(source, *extra)
        assert r.code == 0, f"run: exit {r.code}, stderr {r.err!r}"
        return r.out.decode()

    def run_image(self, img, cmd="run", *extra):
        return run(cmd, self.write("raw.bin", img), *extra)


def asm_error(w, source, line, msg):
    if os.path.exists(w.path("prog.bin")):
        os.remove(w.path("prog.bin"))
    r = w.asm(source)
    eq(r.code, 1, f"exit code for {source!r}")
    eq(r.out, b"", "stdout")
    eq(r.err.decode().rstrip("\n"), f"error: line {line}: {msg}", "stderr")
    assert not os.path.exists(w.path("prog.bin")), "output file created on error"


def trap(r, code, msg, out=b""):
    eq(r.code, code, "exit code")
    eq(r.err.decode().rstrip("\n"), msg, "stderr")
    eq(r.out, out, "stdout")


def bad_binary(w, img, msg):
    for cmd in ("run", "disasm"):
        r = w.run_image(img, cmd)
        eq(r.code, 4, f"{cmd} exit code")
        eq(r.out, b"", f"{cmd} stdout")
        eq(r.err.decode().rstrip("\n"), "error: " + msg, f"{cmd} stderr")


# ---------------- assembler encoding ----------------

@test
def asm_header_and_push(w):
    eq(w.build("push 1\nhalt\n"), image(ins("push", 1) + ins("halt")))


@test
def asm_empty_program(w):
    eq(w.build(""), image())
    eq(w.build("; nothing here\n\n   \n"), image())


@test
def asm_integer_literals(w):
    got = w.build("push -2\npush 0x7FFFFFFF\npush -2147483648\npush 0xff\npush 0\n")
    eq(got, image(ins("push", -2) + ins("push", 0x7FFFFFFF) + ins("push", -2147483648)
                  + ins("push", 255) + ins("push", 0)))


@test
def asm_all_opcodes(w):
    src, code = [".data d 0"], b""
    for m in OPS:
        if m in {"jmp", "jz", "jnz", "call"}:
            src.append(f"{m} here")
            code += ins(m, 0)
        elif m in WITH_ARG:
            src.append(f"{m} 7")
            code += ins(m, 7)
        else:
            src.append(m)
            code += ins(m)
    src.insert(1, "here:")
    eq(w.build("\n".join(src) + "\n"), image(code, [0]))


@test
def asm_labels_forward_backward(w):
    got = w.build("start: push 1\njz end\njmp start\nend: halt\n")
    eq(got, image(ins("push", 1) + ins("jz", 15) + ins("jmp", 0) + ins("halt")))


@test
def asm_label_forms(w):
    # several labels on one line, a label alone on a line, a label at the very end
    got = w.build("a: b: push 1\nc:\n  jmp a\n  jnz b\n  call c\n  jmp end\nend:\n")
    eq(got, image(ins("push", 1) + ins("jmp", 0) + ins("jnz", 0) + ins("call", 5) + ins("jmp", 25)))


@test
def asm_comments_case_whitespace(w):
    src = "  ; header comment\n\n\tPUSH\t3 ; three\nPrint;inline\n Loop:  HaLt\n\tjmp Loop\n"
    eq(w.build(src), image(ins("push", 3) + ins("print") + ins("halt") + ins("jmp", 6)))


@test
def asm_data_section(w):
    got = w.build(".data a 5 6\npush b\nload a\n.DATA b -1 0x10\nstore b\n")
    eq(got, image(ins("push", 2) + ins("load", 0) + ins("store", 2), [5, 6, -1, 16]))


# ---------------- assembler errors ----------------

@test
def err_unknown_instruction(w):
    asm_error(w, "; comment\n\npush 1\n  frob 3\n", 4, "unknown instruction 'frob'")
    asm_error(w, "x: .word 1\n", 1, "unknown directive '.word'")


@test
def err_operand_counts(w):
    asm_error(w, "push\n", 1, "'push' expects 1 operand")
    asm_error(w, "halt\nPUSH 1 2\n", 2, "'push' expects 1 operand")
    asm_error(w, "DUP 1\n", 1, "'dup' expects no operand")
    asm_error(w, "jmp\n", 1, "'jmp' expects 1 operand")
    asm_error(w, ".data\n", 1, "'.data' expects a name and at least one value")
    asm_error(w, "\n.data x\n", 2, "'.data' expects a name and at least one value")


@test
def err_invalid_operand(w):
    asm_error(w, "push 1x\n", 1, "invalid operand '1x'")
    asm_error(w, "jmp 12\n", 1, "invalid operand '12'")
    asm_error(w, "push -0x10\n", 1, "invalid operand '-0x10'")
    asm_error(w, ".data t 1 two\n", 1, "invalid operand 'two'")


@test
def err_out_of_range(w):
    asm_error(w, "push 2147483648\n", 1, "integer out of range '2147483648'")
    asm_error(w, "push -2147483649\n", 1, "integer out of range '-2147483649'")
    asm_error(w, "load 0x80000000\n", 1, "integer out of range '0x80000000'")
    asm_error(w, ".data t 99999999999999999999\n", 1, "integer out of range '99999999999999999999'")


@test
def err_undefined_names(w):
    asm_error(w, "jmp nowhere\n", 1, "undefined label 'nowhere'")
    asm_error(w, ".data d 1\njz d\n", 2, "undefined label 'd'")
    asm_error(w, "push nothing\n", 1, "undefined data 'nothing'")
    asm_error(w, "top: halt\nload top\n", 2, "undefined data 'top'")


@test
def err_labels(w):
    asm_error(w, "a: halt\nb: halt\na: halt\n", 3, "duplicate label 'a'")
    asm_error(w, "x: halt\n.data x 1\n", 2, "duplicate label 'x'")
    asm_error(w, "halt\n1abc: halt\n", 2, "invalid label '1abc'")
    asm_error(w, ".data 9z 1\n", 1, "invalid label '9z'")


@test
def err_smallest_line_wins(w):
    asm_error(w, "halt\njmp later_missing\nhalt\nbogus\n", 2, "undefined label 'later_missing'")
    asm_error(w, "push x\nfoo\n.data x 1\n", 2, "unknown instruction 'foo'")
    asm_error(w, "dup: dup: push 1 2\n", 1, "duplicate label 'dup'")


@test
def err_data_too_large(w):
    asm_error(w, ".data a " + " ".join(["1"] * 200) + "\n.data b " + " ".join(["2"] * 56) + "\n"
              + ".data c 3\n", 3, "data section too large")
    eq(len(w.build(".data a " + " ".join(["1"] * 256) + "\n")), 16 + 1024)


@test
def err_existing_output_untouched(w):
    w.write("prog.bin", b"keep me")
    r = w.asm("push\n")
    eq(r.code, 1)
    eq(w.read("prog.bin"), b"keep me")


# ---------------- execution ----------------

@test
def run_arith_print(w):
    eq(w.ok("push 7\npush 3\nsub\nprint\npush 6\npush 7\nmul\nprint\npush 2\npush 40\nadd\nprint\n"),
       "4\n42\n42\n")


@test
def run_div_mod_signs(w):
    src = ""
    for a, b in [(7, 2), (-7, 2), (7, -2), (-7, -2), (-2147483648, -1)]:
        src += f"push {a}\npush {b}\ndiv\nprint\npush {a}\npush {b}\nmod\nprint\n"
    eq(w.ok(src), "3\n1\n-3\n-1\n-3\n1\n3\n-1\n-2147483648\n0\n")


@test
def run_wraparound(w):
    eq(w.ok("push 2147483647\npush 1\nadd\nprint\npush -2147483648\npush 1\nsub\nprint\n"
            "push 65536\npush 65536\nmul\nprint\npush 65537\npush 65537\nmul\nprint\n"
            "push -2147483648\nneg\nprint\n"),
       "-2147483648\n2147483647\n0\n131073\n-2147483648\n")


@test
def run_stack_ops(w):
    eq(w.ok("push 1\npush 2\nswap\nprint\nprint\npush 3\npush 4\nover\nprint\nprint\nprint\n"
            "push 5\ndup\nadd\nprint\npush 9\npush 8\npop\nneg\nprint\n"),
       "1\n2\n3\n4\n3\n10\n-9\n")


@test
def run_compare_and_branches(w):
    src = ("push 1\npush 2\ncmp\nprint\npush 2\npush 2\ncmp\nprint\npush -5\npush -9\ncmp\nprint\n"
           "push 0\njz zero\npush 111\nprint\nzero: push 7\njnz nonzero\npush 222\nprint\n"
           "nonzero: push 0\njnz bad\npush 3\njz bad\npush 1\nprint\nhalt\nbad: push 999\nprint\n")
    eq(w.ok(src), "-1\n0\n1\n1\n")


@test
def run_loop_and_halt(w):
    src = ("push 5\nloop: dup\nprint\npush 1\nsub\ndup\njnz loop\npop\nhalt\npush 77\nprint\n")
    eq(w.ok(src), "5\n4\n3\n2\n1\n")


@test
def run_call_ret_recursion(w):
    # recursive factorial: fact(n) = n <= 1 ? 1 : n * fact(n-1)
    src = """
        push 10
        call fact
        print
        jmp end
    fact:               ; ( n -- n! )
        dup
        push 2
        cmp             ; -1 when n < 2
        push -1
        cmp             ; 0 when n < 2
        jz base
        dup
        push 1
        sub
        call fact
        mul
        ret
    base:
        pop
        push 1
        ret
    end:
    """
    eq(w.ok(src), "3628800\n")


@test
def run_memory_data(w):
    src = (".data counter 0\n.data table 10 20 30\n"
           "load table\nload 2\nadd\nload 3\nadd\nprint\n"
           "push 41\nstore counter\nload counter\npush 1\nadd\nstore counter\nload counter\nprint\n"
           "push table\nprint\nload 255\nprint\npush 5\nstore 255\nload 255\nprint\n")
    eq(w.ok(src), "60\n42\n1\n0\n5\n")


@test
def run_falls_off_end(w):
    eq(w.ok("push 8\nprint\n"), "8\n")
    eq(w.ok("push 1\njz x\npush 2\nprint\njmp out\nx: halt\nout:\n"), "2\n")
    eq(w.ok(""), "")


# ---------------- traps ----------------

@test
def trap_stack_underflow(w):
    trap(w.exec("push 4\nprint\npush 1\nadd\n"), 10, "trap: stack underflow at offset 11", b"4\n")
    trap(w.exec("print\n"), 10, "trap: stack underflow at offset 0")
    trap(w.exec("push 1\nswap\n"), 10, "trap: stack underflow at offset 5")


@test
def trap_ret_without_call(w):
    trap(w.exec("push 1\nprint\nret\n"), 10, "trap: stack underflow at offset 6", b"1\n")


@test
def trap_division_by_zero(w):
    trap(w.exec("push 1\npush 0\ndiv\n"), 11, "trap: division by zero at offset 10")
    trap(w.exec("push 3\nprint\npush 1\npush 0\nmod\n"), 11, "trap: division by zero at offset 16", b"3\n")


@test
def trap_bad_address(w):
    trap(w.exec("load 256\n"), 13, "trap: bad address 256 at offset 0")
    trap(w.exec("push 2\nprint\npush 1\nstore -1\n"), 13, "trap: bad address -1 at offset 11", b"2\n")


@test
def trap_bad_jump(w):
    trap(w.run_image(image(ins("push", 1) + ins("jmp", 3))), 12, "trap: bad jump to 3 at offset 5")
    trap(w.run_image(image(ins("call", 0xFFFFFFFF))), 12, "trap: bad jump to 4294967295 at offset 0")
    # not taken: no trap
    r = w.run_image(image(ins("push", 1) + ins("jz", 2) + ins("push", 6) + ins("print")))
    eq((r.code, r.out), (0, b"6\n"))
    # jump to the end of the code is fine
    r = w.run_image(image(ins("jmp", 6) + ins("print")))
    eq((r.code, r.out), (0, b""))


@test
def trap_step_limit(w):
    src = "push 1\nprint\nhalt\n"
    eq(w.ok(src, "--steps", "3"), "1\n")
    trap(w.exec(src, "--steps", "2"), 14, "trap: step limit exceeded", b"1\n")
    eq(w.ok("push 1\nprint\n", "--steps", "2"), "1\n")


@test
def trap_default_step_limit(w):
    trap(w.exec("l: jmp l\n"), 14, "trap: step limit exceeded")
    src = "push 333332\nl: push 1\nsub\ndup\njnz l\nhalt\n"  # 1 + 4*333332 + 1 = 1,333,330 steps
    trap(w.exec(src), 14, "trap: step limit exceeded")
    src = "push 249999\nl: push 1\nsub\ndup\njnz l\nhalt\n"  # 1 + 4*249999 + 1 = 999,998 steps
    eq(w.ok(src), "")


@test
def trap_stack_overflow(w):
    trap(w.exec("l: push 1\njmp l\n"), 15, "trap: stack overflow at offset 0")
    trap(w.exec("push 9\nprint\nf: call f\n"), 15, "trap: stack overflow at offset 6", b"9\n")
    src = "\n".join(["push 1"] * 1024) + "\nhalt\n"
    eq(w.ok(src), "")


# ---------------- binary loading ----------------

@test
def bin_header_errors(w):
    bad_binary(w, b"SVMB\x01\0\0", "truncated file")
    bad_binary(w, b"", "truncated file")
    bad_binary(w, image(ins("halt"), magic=b"SVMX"), "bad magic")
    bad_binary(w, image(ins("halt"), version=2), "unsupported version 2")


@test
def bin_size_mismatch(w):
    img = image(ins("push", 1) + ins("print"), [1, 2])
    bad_binary(w, img[:-1], "truncated file")
    bad_binary(w, img + b"\0", "trailing data")
    big = b"SVMB\x01\0\0\0" + struct.pack("<II", 0, 257) + b"\0" * (4 * 257)
    bad_binary(w, big, "data section too large")


@test
def bin_bad_code(w):
    bad_binary(w, image(ins("push", 1) + b"\x99" + ins("halt")), "unknown opcode 0x99 at offset 5")
    bad_binary(w, image(ins("print") + b"\x01\x02\x00"), "truncated instruction at offset 1")


@test
def bin_reserved_ignored_and_data_loaded(w):
    img = image(ins("load", 1) + ins("print"), [5, -12], reserved=b"\x07\x08\x09")
    r = w.run_image(img)
    eq((r.code, r.out, r.err), (0, b"-12\n", b""))


# ---------------- disassembler ----------------

@test
def dis_canonical_text(w):
    w.build(".data t 1 -2\nstart: PUSH t ; c\nload 1\njz done\n\n call start\ndone:\n")
    r = run("disasm", w.path("prog.bin"))
    eq(r.code, 0)
    eq(r.out.decode(), ".data data 1 -2\nL0:\n    push 0\n    load 1\n    jz L20\n    call L0\nL20:\n")


@test
def dis_no_data_no_labels(w):
    w.build("push -5\nneg\nprint\nhalt\n")
    r = run("disasm", w.path("prog.bin"))
    eq(r.out.decode(), "    push -5\n    neg\n    print\n    halt\n")
    w.build("")
    eq(run("disasm", w.path("prog.bin")).out, b"")


@test
def dis_roundtrip_identical(w):
    src = (".data a 1 2 3\n.data b -7\nmain: push 10\nloop: dup\nprint\npush 1\nsub\ndup\njnz loop\n"
           "pop\ncall sub1\nload b\nprint\nhalt\nsub1: push 0x7fffffff\nstore a\nret\n")
    original = w.build(src)
    r = run("disasm", w.path("prog.bin"))
    eq(r.code, 0)
    w.write("again.s", r.out)
    r2 = run("assemble", w.path("again.s"), "-o", w.path("again.bin"))
    eq(r2.code, 0, "reassemble")
    eq(w.read("again.bin"), original, "round trip bytes")


@test
def dis_invalid_target(w):
    r = w.run_image(image(ins("push", 1) + ins("jnz", 2)), "disasm")
    eq(r.code, 4)
    eq(r.out, b"")
    eq(r.err.decode().rstrip("\n"), "error: invalid jump target 2 at offset 5")


# ---------------- command line ----------------

@test
def cli_help(w):
    for flag in ("--help", "-h"):
        r = run(flag)
        eq(r.code, 0)
        assert r.out.startswith(b"usage: asm"), r.out


@test
def cli_usage_errors(w):
    w.build("halt\n")
    p = w.path("prog.bin")
    for args in ([], ["frobnicate"], ["assemble", w.path("prog.s")], ["disasm"],
                 ["run", p, "--steps"], ["run", p, "--steps", "0"], ["run", p, "--steps", "x"],
                 ["run", p, "--steps", "-3"], ["disasm", p, "extra"], ["--help", "run"]):
        r = run(*args)
        eq(r.code, 2, f"exit code for {args}")
        eq(r.out, b"", f"stdout for {args}")
        assert r.err.startswith(b"error: "), f"stderr for {args}: {r.err!r}"


@test
def cli_io_errors(w):
    missing = w.path("missing.s")
    r = run("assemble", missing, "-o", w.path("x.bin"))
    eq(r.code, 3)
    eq(r.err.decode().rstrip("\n"), f"error: cannot read {missing}")
    r = run("run", w.path("missing.bin"))
    eq(r.code, 3)
    src = w.write("ok.s", "halt\n")
    out = w.path("no/such/dir/out.bin")
    r = run("assemble", src, "-o", out)
    eq(r.code, 3)
    eq(r.err.decode().rstrip("\n"), f"error: cannot write {out}")


def main():
    for fn in TESTS:
        tmp = tempfile.mkdtemp(prefix="asm-hidden-")
        try:
            fn(W(tmp))
            print(f"PASS {fn.__name__}", flush=True)
        except Exception as e:  # noqa: BLE001
            msg = str(e) or traceback.format_exc(limit=1)
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {msg[:300]!r}", flush=True)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
