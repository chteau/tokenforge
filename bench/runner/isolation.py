"""Environment isolation for the two benchmark configurations.

Each run gets a fresh, disposable sandbox:
    <work_root>/<run_id>/home     HOME (isolates ~/.claude, ~/.claude.json, ~/.config, ~/.cache)
    <work_root>/<run_id>/config   CLAUDE_CONFIG_DIR (settings, plugins, transcripts, memory)
    <work_root>/<run_id>/repo     the task repository (its own git root)
    <work_root>/<run_id>/tmp      TMPDIR
The process environment is built from scratch (allow-list), never inherited.

Claude Code mechanisms used (all from `claude --help` of the installed version):
    CLAUDE_CONFIG_DIR, --strict-mcp-config (no --mcp-config => zero MCP servers, also hides
    claude.ai connectors), --plugin-dir (token-forge only), --model, --permission-mode,
    --session-id, --output-format stream-json --verbose, --max-budget-usd.
"""
from __future__ import annotations

import hashlib
import re
import json
import os
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENVS = ("native", "token-forge")
ENV_DIR = {"native": "native-clean", "token-forge": "token-forge"}
PROHIBITED_NAMES = ["tokenforge", "tforge", "tmap", "tkit", "codegraph", "context-mode", "caveman",
                    "ponytail", "pr-review-lite", "token-surgeon"]
ALLOWED_ENV_PREFIXES = ()  # nothing from the invoking shell is inherited except the explicit keys below
AUTH_KEYS = ("CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY")


def load_config():
    """benchmark.config.json, with portable defaults resolved for whoever runs it:
    claude_bin "claude" -> found on PATH; plugin_source relative to the benchmark dir (".." = this
    tokenforge checkout); tmap_binary "auto" -> the binary tokenforge's own resolver would use."""
    cfg = json.loads(Path(os.environ.get("BENCH_CONFIG") or ROOT / "benchmark.config.json").read_text())
    if os.sep not in cfg["claude_bin"]:
        found = shutil.which(cfg["claude_bin"])
        if not found:
            raise SystemExit(f"{cfg['claude_bin']} not found on PATH")
        cfg["claude_bin"] = os.path.realpath(found)
    tf = cfg["token_forge"]
    src = Path(os.path.expanduser(tf["plugin_source"]))
    tf["plugin_source"] = str((ROOT / src).resolve() if not src.is_absolute() else src)
    if tf.get("tmap_binary", "auto") == "auto":
        tf["tmap_binary"] = _find_tmap(Path(tf["plugin_source"]))
    cfg["work_root"] = os.path.expanduser(cfg["work_root"])
    return cfg


def _find_tmap(plugin: Path) -> str:
    import re
    ver = re.search(r'^version\s*=\s*"([^"]+)"', (plugin / "native" / "tmap" / "Cargo.toml").read_text(), re.M).group(1)
    base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    for cand in (base / "tokenforge" / "bin" / f"tmap-{ver}", plugin / "native" / "tmap" / "target" / "release" / "tmap"):
        if cand.is_file():
            return str(cand)
    raise SystemExit(f"tmap {ver} binary not found; build it: cargo build --release --manifest-path {plugin}/native/tmap/Cargo.toml")


def sha256_dir(path: Path) -> str:
    h = hashlib.sha256()
    for p in sorted(Path(path).rglob("*")):
        if p.is_file():
            h.update(str(p.relative_to(path)).encode())
            h.update(p.read_bytes())
    return h.hexdigest()


def build_templates(cfg):
    """Create environments/<env>/ templates. Native: empty home + empty config.
    Token Forge: plugin copy (frozen) + its tmap binary where its hooks look for it."""
    out = {}
    for env in ENVS:
        d = ROOT / "environments" / ENV_DIR[env]
        if (d / "template").exists():
            shutil.rmtree(d / "template")
        (d / "template" / "home").mkdir(parents=True)
        (d / "template" / "config").mkdir(parents=True)
        if env == "token-forge":
            tf = cfg["token_forge"]
            src = Path(tf["plugin_source"]).expanduser()
            dst = d / "template" / "plugin" / "tokenforge"
            shutil.copytree(src, dst, ignore=shutil.ignore_patterns("target", ".git", "node_modules", ".forge", "bench"))
            if (dst / "bench").exists():  # hidden tests and ground truth must never be reachable by the agent
                raise SystemExit("bench/ leaked into the plugin copy")
            # the tmap binary is named after its Cargo version, exactly as tokenforge's installer names it
            binsrc = Path(tf["tmap_binary"]).expanduser()
            tver = re.search(r'^version\s*=\s*"([^"]+)"', (dst / "native" / "tmap" / "Cargo.toml").read_text(), re.M).group(1)
            bindst = d / "template" / "home" / ".cache" / "tokenforge" / "bin" / f"tmap-{tver}"
            bindst.parent.mkdir(parents=True)
            shutil.copy2(binsrc, bindst)
            if tf.get("lean"):
                # tokenforge's own opt-in `tforge lean on`, run against the template's config dir exactly as a user would
                import subprocess
                level = tf.get("lean") if tf.get("lean") in ("balanced", "max", "ultra") else "on"
                r = subprocess.run(["node", str(dst / "bin" / "tforge"), "lean", level], capture_output=True, text=True,
                                   env={"PATH": os.environ["PATH"], "HOME": str(d / "template" / "home"),
                                        "CLAUDE_CONFIG_DIR": str(d / "template" / "config"),
                                        "XDG_CONFIG_HOME": str(d / "template" / "home" / ".config")})
                if r.returncode != 0:
                    raise SystemExit(f"tforge lean on failed: {r.stderr}")
            out[env] = {"lean": tf.get("lean") or False, "plugin_sha256": sha256_dir(dst), "tmap_sha256": hashlib.sha256(bindst.read_bytes()).hexdigest(),
                        "version": json.loads((dst / ".claude-plugin" / "plugin.json").read_text())["version"]}
        # telemetry shim (identical in both environments)
        shim = d / "template" / "shim"
        shim.mkdir()
        (shim / "claude").write_text(
            "#!/bin/sh\n"
            "# Benchmark telemetry shim: runs the real Claude Code binary unchanged, except that it drops\n"
            "# --no-session-persistence so nested sessions are written to disk and their tokens counted.\n"
            "for a do shift; [ \"$a\" = \"--no-session-persistence\" ] || set -- \"$@\" \"$a\"; done\n"
            f"exec {cfg['claude_bin']} \"$@\"\n")
        (shim / "claude").chmod(0o755)
    return out


def _lean_names(sb, const) -> list[str]:
    import re as _re
    src = (Path(sb["plugin"]) / "lib" / "lean.mjs").read_text()
    if const not in src:
        return []
    return _re.findall(r"'([A-Za-z-]+)'", src[src.index(const):src.index("]", src.index(const))])


def _lean_deny(sb) -> list[str]:
    import re as _re
    src = (Path(sb["plugin"]) / "lib" / "lean.mjs").read_text()
    names = []
    for const in ("LEAN_DENY = [", "LEAN_MAX_EXTRA = [", "LEAN_ULTRA_EXTRA = ["):
        if const in src:
            names += _re.findall(r"'([A-Za-z]+)'", src[src.index(const):src.index("]", src.index(const))])
    return names


def make_sandbox(cfg, env, run_dir_work: Path):
    tpl = ROOT / "environments" / ENV_DIR[env] / "template"
    if not tpl.exists():
        raise SystemExit(f"environment template missing: run `bench.py env build` first ({tpl})")
    run_dir_work.mkdir(parents=True)
    for sub in ("home", "config", "shim"):
        shutil.copytree(tpl / sub, run_dir_work / sub, symlinks=True)
    if env == "token-forge":
        shutil.copytree(tpl / "plugin", run_dir_work / "plugin", symlinks=True)
    (run_dir_work / "tmp").mkdir()
    return {k: run_dir_work / k for k in ("home", "config", "shim", "tmp")} | (
        {"plugin": run_dir_work / "plugin" / "tokenforge"} if env == "token-forge" else {})


TOKEN_FILE = Path(os.environ.get("BENCH_TOKEN_FILE") or Path.home() / ".config" / "claude-bench" / "oauth-token")


def auth_env() -> dict:
    """Credential for the benchmark sessions: CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY from the
    environment, else a `claude setup-token` token saved in TOKEN_FILE (mode 600). Never reads
    ~/.claude/.credentials.json: a sandbox refreshing that token could log out the real install."""
    auth = {k: os.environ[k] for k in AUTH_KEYS if os.environ.get(k)}
    if not auth and TOKEN_FILE.is_file():
        if TOKEN_FILE.stat().st_mode & 0o077:
            raise SystemExit(f"{TOKEN_FILE} must not be readable by others: chmod 600 {TOKEN_FILE}")
        tok = TOKEN_FILE.read_text().strip()
        if tok:
            auth = {"CLAUDE_CODE_OAUTH_TOKEN": tok}
    if not auth and os.environ.get("BENCH_USE_LOCAL_LOGIN") == "1":
        auth = _local_login_token()
    return auth


LOCAL_LOGIN_MIN_REMAINING_S = 40 * 60


def _local_login_token() -> dict:
    """Opt-in (--use-local-login): the current access token of the local Claude Code login.
    Read-only: the refresh token is never used or copied, nothing is written back, so a sandbox
    can never rotate the real login's credentials. Refuses tokens close to expiry; re-read per run,
    so a long benchmark picks up the token the real install refreshes on its own."""
    import time
    cred = Path(os.environ.get("CLAUDE_CONFIG_DIR_REAL") or Path.home() / ".claude") / ".credentials.json"
    deadline = time.time() + float(os.environ.get("BENCH_LOGIN_WAIT_S", 3 * 3600))
    warned = False
    while True:
        try:
            o = json.loads(cred.read_text())["claudeAiOauth"]
        except (OSError, ValueError, KeyError):
            return {}
        left = (int(o.get("expiresAt") or 0) / 1000) - time.time()
        if left >= LOCAL_LOGIN_MIN_REMAINING_S:
            return {"CLAUDE_CODE_OAUTH_TOKEN": o["accessToken"]}
        if time.time() > deadline:
            raise SystemExit(f"local login token expires in {left / 60:.0f} min and was not refreshed; "
                             "use any Claude Code session to refresh it, or use `claude setup-token`")
        if not warned:
            print(f"local login token expires in {left / 60:.0f} min; waiting for Claude Code to refresh it "
                  "(any active session does this)", flush=True)
            warned = True
        time.sleep(60)


def process_env(cfg, sb):
    """Allow-listed environment for the agent process. Identical for both agents except paths."""
    auth = auth_env()
    tc = {k: os.path.expanduser(v) for k, v in cfg["toolchain_env"].items()}
    path = [str(sb["shim"])] + [os.path.expanduser(p) for p in cfg["path"]]
    return {
        "PATH": ":".join(path),
        "HOME": str(sb["home"]),
        "CLAUDE_CONFIG_DIR": str(sb["config"]),
        "TMPDIR": str(sb["tmp"]),
        "TERM": "dumb",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "USER": os.environ.get("USER", "dev"),
        "SHELL": "/bin/bash",
        "DISABLE_AUTOUPDATER": "1",
        **tc,
        **auth,
    }


def _settings_findings(p: Path):
    found = []
    try:
        s = json.loads(p.read_text())
    except Exception:
        return [f"unreadable settings {p}"]
    for key in ("hooks", "enabledPlugins", "mcpServers", "enabledMcpjsonServers", "statusLine", "apiKeyHelper",
                "extraKnownMarketplaces", "outputStyle", "env", "permissions", "model"):
        if s.get(key):
            found.append(f"{p}: '{key}' set")
    return found


def preflight(cfg, env, sb, repo: Path, claude_args: list[str], penv: dict, history=None):
    """Audit a sandbox before launch. Returns (clean: bool, manifest: dict)."""
    findings = []
    home, conf = sb["home"], sb["config"]
    # 1. config dir must be empty; token-forge may only hold the settings.json written by `tforge lean on`
    lean_deny = _lean_deny(sb) if env == "token-forge" and cfg["token_forge"].get("lean") else None
    hist = Path(history["path"]) if history else None
    for p in conf.rglob("*"):
        if hist and (p == hist or p in hist.parents):
            continue  # the declared earlier session of a two-session task
        if lean_deny is not None and p.relative_to(conf).as_posix() == "settings.json":
            s = json.loads(p.read_text())
            builtin = set(_lean_names(sb, "BUILTIN_SKILLS = ["))
            ov = s.get("skillOverrides", {})
            if (not set(s) <= {"permissions", "skillOverrides", "includeGitInstructions"} or s.get("includeGitInstructions", False) is not False
                    or set(s.get("permissions", {})) != {"deny"}
                    or not set(s["permissions"]["deny"]) <= set(lean_deny)
                    or not (set(ov) <= builtin and set(ov.values()) <= {"user-invocable-only"})):
                findings.append(f"token-forge settings.json holds more than tforge lean's own entries: {s}")
            continue
        findings.append(f"config dir not empty: {p.relative_to(conf)}")
    # 2. HOME: nothing Claude-related; token-forge may only contain its tmap binary cache
    for p in home.rglob("*"):
        rel = str(p.relative_to(home))
        if env == "token-forge" and (rel.startswith(".cache") or rel.startswith(".config")):
            continue  # tmap binary cache; tokenforge's own config (lean bookkeeping)
        findings.append(f"home not empty: {rel}")
    # 3. workspace and every ancestor: no CLAUDE.md / CLAUDE.local.md / .claude / .mcp.json
    for d in [repo, *repo.parents]:
        for name in ("CLAUDE.md", "CLAUDE.local.md", ".claude", ".mcp.json"):
            if (d / name).exists():
                findings.append(f"{d / name} exists")
    for p in repo.rglob("CLAUDE.md"):
        findings.append(f"nested {p}")
    # 4. managed (policy) settings apply to every session; record and refuse if they inject anything
    managed = Path("/etc/claude-code/managed-settings.json")
    managed_found = managed.exists()
    if managed_found:
        findings += _settings_findings(managed)
    # 5. process environment
    for k in penv:
        if (k.startswith(("TFORGE_", "TMAP_", "TS_")) and not (env == "token-forge" and k in ("TFORGE_RECALL", "TFORGE_LAZY", "TFORGE_PLAN"))) or (k.startswith("CLAUDE_") and k not in ("CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN") and not (env == "token-forge" and k == "CLAUDE_CODE_EFFORT_LEVEL")):
            findings.append(f"env var {k} set")
    for p in penv["PATH"].split(":"):
        if any(n in p.lower() for n in PROHIBITED_NAMES):
            findings.append(f"PATH entry {p}")
    shim = sb["shim"]
    if sorted(x.name for x in shim.iterdir()) != ["claude"]:
        findings.append("shim dir contains more than the claude shim")
    # 6. CLI arguments
    if "--strict-mcp-config" not in claude_args:
        findings.append("--strict-mcp-config missing")
    if "--mcp-config" in claude_args:
        findings.append("--mcp-config present")
    pdirs = [claude_args[i + 1] for i, a in enumerate(claude_args) if a == "--plugin-dir"]
    if env == "native" and pdirs:
        findings.append(f"--plugin-dir in native run: {pdirs}")
    if env == "token-forge":
        if pdirs != [str(sb["plugin"])]:
            findings.append(f"token-forge run must load exactly its plugin, got {pdirs}")
        if not (Path(sb["plugin"]) / ".claude-plugin" / "plugin.json").exists():
            findings.append("token-forge plugin missing")
    if not any(penv.get(k) for k in AUTH_KEYS):
        findings.append("no CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY in the benchmark's environment")
    manifest = {
        "environment": ENV_DIR[env],
        "clean": not findings,
        "model": cfg["model"],
        "custom_skills": [], "plugins": [] if env == "native" else ["tokenforge (via --plugin-dir)"],
        "mcp_servers": [], "hooks": [] if env == "native" else ["tokenforge hooks/hooks.json"],
        "claude_md_files": [], "custom_integrations": [],
        "managed_settings_present": managed_found,
        "findings": findings,
    }
    if env == "token-forge":
        manifest["token_forge"] = True
        manifest["token_forge_lean"] = cfg["token_forge"].get("lean") or False
        manifest["other_custom_components"] = []
        manifest["token_forge_dependencies"] = [
            "tmap native binary (bundled by tokenforge; copied to HOME/.cache/tokenforge/bin as its installer does)",
            "node (tokenforge hooks are node scripts; node is also a normal dev tool present in both environments)",
            "nested `claude -p` calls made by tkit distill / tforge workers (counted via the PATH shim)"]
    return not findings, manifest


def is_builtin_plugin(p) -> bool:
    """Plugins compiled into the Claude Code binary (source `<name>@builtin`, path `builtin`).
    They load in every vanilla install, identically for both agents, so they are part of the baseline."""
    return isinstance(p, dict) and (str(p.get("source", "")).endswith("@builtin") or p.get("path") == "builtin")


def kill_sandbox_processes(sandbox: Path) -> list[str]:
    """Kill every process whose command line references the sandbox (e.g. a detached dashboard
    server started by a plugin hook), so nothing outlives its run or leaks into the next one."""
    import signal
    killed = []
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit() or int(proc.name) == os.getpid():
            continue
        try:
            cmd = (proc / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
        except OSError:
            continue
        if str(sandbox) in cmd:
            try:
                os.kill(int(proc.name), signal.SIGTERM)
                killed.append(cmd.strip()[:200])
            except OSError:
                pass
    return killed


def verify_init(env, init: dict | None, hooks_seen: int, vanilla_skills: list[str] | None):
    """Post-launch check using Claude Code's own init event (ground truth of what was loaded)."""
    problems = []
    if not init:
        return ["no init event captured"]
    if init.get("mcp_servers"):
        problems.append(f"mcp_servers loaded: {init['mcp_servers']}")
    plugins = [p.get("name") if isinstance(p, dict) else p for p in init.get("plugins") or []
               if not is_builtin_plugin(p)]
    if env == "native":
        if plugins:
            problems.append(f"plugins loaded: {plugins}")
        if hooks_seen:
            problems.append(f"{hooks_seen} hook executions recorded")
        if vanilla_skills is not None:
            extra = sorted(set(init.get("skills") or []) - set(vanilla_skills))
            if extra:
                problems.append(f"non-built-in skills: {extra}")
        for s in init.get("skills") or []:
            if any(n in str(s).lower() for n in PROHIBITED_NAMES):
                problems.append(f"prohibited skill {s}")
    else:
        if plugins != ["tokenforge"]:
            problems.append(f"expected exactly the tokenforge plugin, got {plugins}")
        if vanilla_skills is not None:
            extra = sorted(s for s in set(init.get("skills") or []) - set(vanilla_skills) if not str(s).startswith("tokenforge"))
            if extra:
                problems.append(f"non-tokenforge extra skills: {extra}")
    return problems
