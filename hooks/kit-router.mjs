// PreToolUse for Bash and Read: send Claude to the tkit tools instead of raw output and ad-hoc scripts.
//   Rewritten (updatedInput): raw build/test commands -> `tkit check` / `tkit test`; `ssh HOST CMD` and
//     scp -> `tkit ssh`. Only commands whose flags are all understood; anything else runs unchanged.
//   `cat FILES` inside the project -> `tview FILES` (long definition bodies folded, see lib/view.mjs).
//   Refused (deny + the tkit command to use): interactive `ssh HOST`, reads inside dependency
//     registries (Bash and whole-file Read).
//   Never rewritten: commands with a heredoc. A rewrite is auto-approved only when every segment became
//     a tkit/tview call, or the session already approves everything; otherwise the command runs unchanged
//     (asking would show a prompt on every rewrite, and nobody can answer it in a headless run).
//   Inline edit scripts are allowed: one script that edits a file in one call is cheaper than a chain
//     of small Edit calls, each of which re-reads the whole context.
// Escape hatches: a TFORGE_RAW=1 (or TS_RAW=1) prefix, or repeating the identical call.
// With TFORGE_REDIRECT=1, identifier greps in Bash are answered from tmap too (see code-redirect.mjs).
// Off: TFORGE_KIT_HOOKS=0 or TFORGE_KIT_ROUTE=0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { docReplacement } from '../lib/docread.mjs';
import { deny, exeName, isMain, kitHookOff, readInput, seenBefore, shq, splitPipes, splitSegments, tokenize } from '../lib/hookutil.mjs';

// ---------- build/test rewrites ----------
const DROP = new Set(['-q', '--quiet', '-v', '--verbose', '-B', '--batch-mode', '--console=plain', '--color=never', '--no-color']);

// Split args into [positionals, {opt: value}], or null when a flag we do not model appears.
function opts(args, takesValue, flagsOk, repeatOk = []) {
  const pos = [];
  const kv = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (DROP.has(a) || flagsOk.includes(a)) {
      kv[a] = true;
      continue;
    }
    const eq = a.indexOf('=');
    const k = eq > 0 ? a.slice(0, eq) : a;
    if (takesValue.includes(k)) {
      if (eq > 0) kv[k] = a.slice(eq + 1);
      else if (i + 1 < args.length) kv[k] = args[++i];
      else return null;
      continue;
    }
    if (repeatOk.some((p) => a.startsWith(p))) continue;
    if (a.startsWith('-')) return null;
    pos.push(a);
  }
  return [pos, kv];
}

const kit = (...xs) => ['tkit', ...xs.filter((x) => x)].map(shq).join(' ');
const isRemote = (x) => x.includes(':') && !/^(\/|\.\/|[A-Za-z]:[\\/])/.test(x);

// t: tokens of one simple command (no pipes or redirects). Returns a tkit command or null.
export function rewrite(t) {
  if (!t.length) return null;
  const exe = exeName(t[0]);
  const sub = t[1] || '';
  const rest = t.slice(2);
  const P = (pos) => (pos[0] ? ['-p', pos[0]] : []);

  if (exe === 'ssh') {
    // plain `ssh [-q|-T|-n] HOST CMD..` only; other options (-p, -i, -L, -o ...) pass through
    const args = t.slice(1).filter((x) => !['-q', '-T', '-n'].includes(x));
    if (args.length < 2 || args[0].startsWith('-') || args.some((x) => x.startsWith('<'))) return null;
    return kit('ssh', ...args);
  }
  if (exe === 'scp') {
    const args = t.slice(1).filter((x) => !['-q', '-r', '-p'].includes(x));
    if (args.length < 2 || args.some((x) => x.startsWith('-'))) return null;
    const remote = args.map(isRemote);
    if (remote.at(-1) && !remote.slice(0, -1).some(Boolean)) return kit('ssh', 'put', ...args);
    if (args.length === 2 && remote[0] && !remote[1]) return kit('ssh', 'get', ...args);
    return null;
  }
  if (exe === 'cargo' && (sub === 'check' || sub === 'clippy')) {
    const r = opts(rest, ['-p', '--package'], ['--workspace', '--all-targets', '--all', '--tests', '--lib', '--bins']);
    if (!r || r[0].length || r[1]['-p'] || r[1]['--package']) return null;
    return kit('check', '-l', 'rust', sub === 'check' ? '--fast' : '');
  }
  if (exe === 'cargo' && sub === 'test') {
    if (rest.includes('--')) return null;
    const r = opts(rest, ['-p', '--package'], ['--workspace', '--no-fail-fast', '--lib', '--all-targets', '--all', '--tests']);
    if (!r || r[0].length > 1) return null;
    const pkg = r[1]['-p'] || r[1]['--package'];
    return kit('test', r[0][0], '-l', 'rust', ...(pkg ? ['-p', pkg] : []));
  }
  if (exe === 'go' && sub === 'test') {
    const flags = ['-race', '-short', '-failfast', '-cover'];
    const r = opts(rest, ['-run', '-count', '-timeout'], flags);
    if (!r || r[0].length > 1) return null;
    const extra = [];
    if (r[1]['-count']) extra.push(`-count=${r[1]['-count']}`);
    extra.push(...flags.filter((f) => r[1][f]));
    if (r[1]['-timeout']) extra.push(`-timeout=${r[1]['-timeout']}`);
    return kit('test', r[1]['-run'] || '', '-l', 'go', ...P(r[0]), ...(extra.length ? ['--', ...extra] : []));
  }
  if (exe === 'go' && (sub === 'vet' || sub === 'build')) {
    if (rest.some((a) => a !== './...' && a !== '.')) return null;
    return kit('check', '-l', 'go');
  }
  if (exe === 'tsc' || (['npx', 'bunx', 'pnpm'].includes(exe) && sub === 'tsc')) {
    const args = exe === 'tsc' ? t.slice(1) : t.slice(2);
    if (!args.includes('--noEmit') || args.some((a) => ['-w', '--watch', '-b', '--build'].includes(a))) return null;
    for (let i = 0; i < args.length; i++) {
      // a non-default project file changes what gets checked
      if ((args[i] === '-p' || args[i] === '--project') && !['.', './', 'tsconfig.json'].includes(args[i + 1] || '')) return null;
    }
    return kit('check', '-l', 'ts');
  }
  if ((exe === 'npx' || exe === 'bunx') && (sub === 'vitest' || sub === 'jest')) {
    const r = opts(rest.filter((a) => a !== 'run'), ['-t', '--testNamePattern'], ['--run', '--silent']);
    if (!r || r[0].length > 1) return null;
    return kit('test', r[1]['-t'] || r[1]['--testNamePattern'] || '', '-l', 'ts', ...P(r[0]));
  }
  if (['npm', 'pnpm', 'yarn'].includes(exe) && ((sub === 'test' && t.length === 2) || (sub === 'run' && rest[0] === 'test' && t.length === 3)))
    return kit('test', '-l', 'ts');
  if (exe === 'bun' && sub === 'test') {
    const r = opts(rest, ['-t', '--test-name-pattern'], []);
    if (!r || r[0].length > 1) return null;
    return kit('test', r[1]['-t'] || r[1]['--test-name-pattern'] || '', '-l', 'ts', ...P(r[0]));
  }
  if (exe === 'dotnet' && sub === 'build') {
    const r = opts(rest, [], ['--nologo', '--no-restore']);
    if (!r || r[0].length > 1) return null;
    return kit('check', '-l', 'cs');
  }
  if (exe === 'dotnet' && sub === 'test') {
    const r = opts(rest, ['--filter'], ['--nologo', '--no-build', '--no-restore']);
    if (!r || r[0].length > 1) return null;
    return kit('test', r[1]['--filter'] || '', '-l', 'cs', ...P(r[0]));
  }
  if (exe === 'pytest' || (/^python[0-9.]*$/.test(exe) && t[1] === '-m' && t[2] === 'pytest')) {
    const args = exe === 'pytest' ? t.slice(1) : t.slice(3);
    const r = opts(args, ['-k'], ['-x', '-q', '-vv', '--no-header', '-rA', '-rf', '-ra'], ['--tb=']);
    if (!r || r[0].length > 1) return null;
    return kit('test', r[1]['-k'] || '', '-l', 'py', ...P(r[0]), ...(r[1]['-x'] ? ['--', '-x'] : []));
  }
  if ((exe === 'flutter' || exe === 'dart') && sub === 'test') {
    const r = opts(rest, ['--name', '-n', '--plain-name'], ['--no-pub']);
    if (!r || r[0].length > 1) return null;
    return kit('test', r[1]['--name'] || r[1]['-n'] || r[1]['--plain-name'] || '', '-l', 'dart', ...P(r[0]));
  }
  if ((exe === 'flutter' || exe === 'dart') && sub === 'analyze' && rest.every((a) => a === '.' || DROP.has(a))) return kit('check', '-l', 'dart');
  if (exe === 'mvn' || exe === 'mvnw') {
    const goals = t.slice(1).filter((a) => !a.startsWith('-'));
    const flags = t.slice(1).filter((a) => a.startsWith('-'));
    if (flags.some((f) => !(DROP.has(f) || f.startsWith('-Dtest=') || f === '-e' || f === '-o'))) return null;
    const g = goals.join(' ');
    if (g === 'test') return kit('test', (flags.find((f) => f.startsWith('-Dtest=')) || '').slice(7), '-l', 'java');
    if (['compile', 'test-compile', 'compile test-compile'].includes(g)) return kit('check', '-l', 'java');
    return null;
  }
  if (exe === 'gradle' || exe === 'gradlew') {
    const r = opts(t.slice(1), ['--tests'], ['--continue', '--offline', '--no-daemon']);
    if (!r) return null;
    const g = r[0].join(' ');
    if (g === 'test') return kit('test', String(r[1]['--tests'] || '').replace(/^\*+|\*+$/g, ''), '-l', 'java');
    if (['classes', 'classes testClasses', 'compileJava', 'compileKotlin'].includes(g)) return kit('check', '-l', 'java');
    return null;
  }
  if (exe === 'mix' && sub === 'test') {
    if (rest.some((a) => a.startsWith('-')) || rest.length > 1) return null;
    return kit('test', rest[0], '-l', 'elixir');
  }
  if (exe === 'mix' && sub === 'compile' && !rest.length) return kit('check', '-l', 'elixir');
  // LaTeX builds: pdflatex/latexmk with pdflatex-compatible flags only (an engine switch like -xelatex keeps the raw run).
  // Output becomes errors with file:line, undefined refs/citations and a box summary instead of hundreds of log lines.
  if (exe === 'latexmk' || exe === 'pdflatex') {
    const ok = t.slice(1).every((x) => /\.tex$/.test(x) && !x.startsWith('-') ||
      ['-pdf', '-halt-on-error', '-file-line-error', '-synctex=1', '-interaction=nonstopmode', '-interaction=batchmode', '-quiet', '-silent'].includes(x));
    return ok ? kit('check', '-l', 'latex') : null;
  }
  if (exe === 'zig' && sub === 'build') {
    if (rest.length === 1 && rest[0] === 'test') return kit('test', '-l', 'zig');
    if (!rest.length) return kit('check', '-l', 'zig');
    return null;
  }
  if (exe === 'swift' && (sub === 'test' || sub === 'build')) {
    const r = opts(rest, ['--filter'], ['--build-tests']);
    if (!r || r[0].length) return null;
    return sub === 'test' ? kit('test', r[1]['--filter'] || '', '-l', 'swift') : kit('check', '-l', 'swift');
  }
  if (exe === 'ctest') {
    const r = opts(t.slice(1), ['--test-dir', '-R', '-j'], ['--output-on-failure']);
    if (!r || r[0].length) return null;
    return kit('test', r[1]['-R'] || '', '-l', 'cpp');
  }
  if ((exe === 'bundle' && sub === 'exec' && t[2] === 'rspec') || exe === 'rspec') {
    const r = opts(exe === 'bundle' ? t.slice(3) : t.slice(1), ['-e', '--example'], []);
    if (!r || r[0].length > 1) return null;
    return kit('test', r[1]['-e'] || r[1]['--example'] || '', '-l', 'ruby', ...P(r[0]));
  }
  if (exe === 'phpunit' || exe === 'pest') {
    const r = opts(t.slice(1), ['--filter'], []);
    if (!r || r[0].length) return null;
    return kit('test', r[1]['--filter'] || '', '-l', 'php');
  }
  if (exe === 'sbt' && t.length === 2 && (t[1] === 'test' || t[1] === 'compile')) return kit(t[1] === 'test' ? 'test' : 'check', '-l', 'scala');
  return null;
}

// ---------- dependency registries ----------
const S = '[\\\\/]';
const N = '[^\\\\/\\s\'"]';
const REGISTRY = new RegExp(
  [
    `\\.cargo${S}registry${S}src${S}${N}+${S}([A-Za-z0-9_.-]+?)-\\d${N}*`,
    `node_modules${S}((?:@${N}+${S})?${N}+)`,
    `${S}pkg${S}mod${S}([^@\\s'"]+)@`,
    `\\.m2${S}repository${S}(\\S+?)${S}\\d${N}*${S}`,
    `\\.nuget${S}packages${S}(${N}+)${S}`,
    `Packages${S}_Index${S}(${N}+)`,
    `\\.pub-cache${S}hosted${S}${N}+${S}([a-z0-9_]+)-\\d`,
  ].join('|'),
  'g',
);
const STACKS = ['rust', 'ts', 'go', 'java', 'cs', 'luau', 'dart'];

// [pkg, stack] of the first plausible registry path in `s`, or null.
export function registryPkg(s) {
  for (const m of String(s || '').matchAll(REGISTRY)) {
    if (s[m.index - 1] === '!') continue; // exclusion globs like '!node_modules/**'
    const i = m.slice(1).findIndex((g) => g);
    let pkg = m[i + 1];
    if (STACKS[i] === 'java') pkg = pkg.split(/[\\/]/).pop();
    if (STACKS[i] === 'go') pkg = pkg.replace(/\\/g, '/');
    if (/^[@\w][\w.@/-]*$/.test(pkg) && !pkg.startsWith('.')) return [pkg, STACKS[i]];
  }
  return null;
}

// Escape hatch: a per-command prefix (`TFORGE_RAW=1 cargo test`). A session-wide `export TFORGE_RAW=1` is
// ignored: models that learned the escape exported it once and silently disabled every later optimisation.
const RAW = /(^|[;&|(]\s*|^\s*)(TFORGE_RAW|TS_RAW)=1\s+(?!;)[^\s;&|]/;

export function denyReason(cmd) {
  if (/(^|[\s;&|(])(tkit|tmap\s+kit)\s/.test(cmd)) return null;
  if (/(^|[;&|]\s*)ssh(\.exe)?(\s+-[a-zA-Z]+)*\s+(?!git@)[\w.@-]+\s*($|[;&|])/.test(cmd))
    return (
      'tokenforge: `ssh HOST` with no command opens an interactive shell, which hangs here. Run commands instead: ' +
      "`tkit ssh HOST 'CMD'` (capped output, no prompts, reused connection). Also: `tkit ssh hosts | check HOST | tail HOST FILE | svc HOST UNIT | get | put`."
    );
  const reg = registryPkg(cmd);
  // Only whole-file dumps are refused. Focused reads (grep, rg, sed -n, head, tail, awk) are already small, and refusing
  // one costs a round trip that re-reads the whole context, more than the slice itself, and blocks the batch around it.
  if (reg && /(^|[;&|]\s*|\s)(cat|less|more|bat|type)\s/.test(cmd))
    return (
      `tokenforge: dependency source. Use tkit from the project dir instead of reading the registry:\n` +
      `tkit deps api ${reg[0]} [SYMBOL]   (public API, or one item's declaration + docs + methods)\n` +
      `tkit deps where ${reg[0]}          (source dir, if you then need a precise slice: prefix TFORGE_RAW=1)`
    );
  return null;
}

// Whole-file Read inside a dependency registry.
export function readReason(file, sliced) {
  if (sliced) return null;
  const reg = registryPkg(file);
  return reg
    ? `tokenforge: ${file} is dependency source. Use \`tkit deps api ${reg[0]} [SYMBOL]\` from the project dir (declaration, docs, members). ` +
        'If you really need the body, Read it with offset/limit, or repeat this Read.'
    : null;
}

const ENV = /^[A-Za-z_][A-Za-z0-9_]*=/;
const NULLREDIR = new Set(['2>&1', '&>/dev/null', '>/dev/null', '2>/dev/null', '>NUL', '2>NUL']);

// Rewrite raw build/test/ssh/scp segments. Returns { command, notes, allow } or null when nothing changed.
const TVIEW = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'tview');

// `cat` of regular files inside the project root, no flags: [files] or null.
export function catFiles(core, cwd, root) {
  if (exeName(core[0]) !== 'cat' || core.length < 2 || !cwd) return null;
  const args = core.slice(1);
  if (args.some((f) => f.startsWith('-') || /[$`~{\[]/.test(f))) return null;
  // globs are expanded here only to check them; the shell still expands them in the rewritten command
  const files = [];
  for (const a of args) {
    if (!/[*?]/.test(a)) files.push(a);
    else if (typeof fs.globSync !== 'function') return null; // Node < 22: leave globbed cats alone
    else {
      let m = [];
      try {
        m = fs.globSync(a, { cwd });
      } catch {
        return null;
      }
      if (!m.length) return null;
      files.push(...m);
    }
  }
  for (const f of files) {
    const abs = path.resolve(cwd, f);
    const rel = path.relative(root || cwd, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    try {
      if (!fs.statSync(abs).isFile()) return null;
    } catch {
      return null;
    }
  }
  return files;
}

// Read-only segments that keep a rewritten command auto-approvable (no redirection, checked by caller).
const READ_ONLY = new Set(['grep', 'rg', 'head', 'tail', 'ls', 'wc', 'echo', 'printf', 'pwd', 'tree', 'nl', 'cat', 'sort', 'uniq', 'cut', 'file', 'stat', 'true']);
export function readOnly(core) {
  const exe = exeName(core[0] || '');
  if (READ_ONLY.has(exe)) return true;
  if (exe === 'sed') return core.includes('-n') && !core.some((x) => /^-i|^--in-place/.test(x));
  if (exe === 'find') return !core.some((x) => /^-(exec|execdir|delete|ok|fprint)/.test(x));
  if (exe === 'git') return ['status', 'log', 'diff', 'show', 'ls-files', 'grep', 'blame', 'rev-parse', 'branch'].includes(core[1]);
  return false;
}

// TokenForge's own read-only tools (and tkit check/test, which the router already auto-approves when it rewrites a
// raw build/test command). Without this, every `tread`/`tkit ctx` call asks for permission, so the model falls back
// to cat/sed, which Claude Code already allows. Writes, network and remote tools are not included. Off: TFORGE_AUTO_ALLOW=0.
const KIT_SAFE = new Set(['ctx', 'diff', 'debug', 'analog', 'proj', 'deps', 'tally', 'tab', 'check', 'test', 'pdf']);
const JX_SAFE = new Set(['shape', 'get', 'keys', 'find']);
export function ownTool(t, permissionMode) {
  const exe = exeName(t[0] || '');
  if (exe === 'tread' || exe === 'tview') return true;
  // edit tools: only where the user already lets Claude edit without asking
  if (exe === 'tkit' && permissionMode === 'acceptEdits' && ['edit', 'patch', 'fmt'].includes(t[1])) return true;
  if (exe === 'tkit') return KIT_SAFE.has(t[1]) || (t[1] === 'jx' && JX_SAFE.has(t[2]));
  if (exe === 'tforge') {
    return ['recall', 'meter', 'status', '--version', '--help'].includes(t[1]) ||
      (t[1] === 'lean' && (t.length === 2 || t[2] === 'status')) || (t[1] === 'ui' && t[2] === '--status');
  }
  return false;
}

// Every segment is one of our tools or plainly read-only, and at least one is ours: safe to approve.
export function ownToolsOnly(cmd, permissionMode) {
  if (process.env.TFORGE_AUTO_ALLOW === '0') return false;
  // `tkit edit <<'EOF' ... EOF` (the usual form): one quoted heredoc and nothing else, in accept-edits sessions
  const hd = /^\s*(?:cd\s+\S+\s*&&\s*)?tkit\s+(edit|patch)\b[^\n<]*<<-?\s*'(\w+)'\n[\s\S]*?\n\2\s*$/.exec(cmd);
  if (hd) return permissionMode === 'acceptEdits' && !/[;&|`]|\$\(/.test(cmd.split('\n')[0].replace(/^\s*cd\s+\S+\s*&&/, ''));
  if (cmd.includes('<<') || /\$\(|`/.test(cmd)) return false;
  const segs = splitSegments(cmd);
  if (!segs) return false;
  let own = false;
  for (const [text] of segs) {
    if (!text.trim() || /^\s*cd\s+\S+\s*$/.test(text)) continue;
    for (const p of splitPipes(text)) {
      const t = tokenize(p);
      if (!t || !t.length || ENV.test(t[0])) return false;
      const core = t.filter((x) => !NULLREDIR.has(x));
      if (core.some((x) => /^[&(){}]$|[<>]/.test(x))) return false;
      if (ownTool(core, permissionMode)) own = true;
      else if (!readOnly(core)) return false;
    }
  }
  return own;
}

export function routeCommand(cmd, { cwd, permissionMode } = {}) {
  if (cmd.includes('<<')) return null; // heredoc bodies must never be touched
  const segs = splitSegments(cmd);
  if (!segs) return null;
  const root = cwd;
  let here = cwd;
  const out = [];
  const notes = [];
  let viewed = false;
  let onlyKit = true; // every segment became a tkit/tview call (or is a plain cd): safe to auto-approve
  for (const [text, sep] of segs) {
    if (!text.trim()) {
      out.push(text + sep);
      continue;
    }
    if (/^\s*export\s+[A-Za-z_][A-Za-z0-9_]*=\S*\s*$/.test(text)) {
      out.push(text + sep); // sets a variable, changes nothing
      continue;
    }
    const cdm = /^\s*cd\s+(\S+)\s*$/.exec(text);
    if (cdm) {
      here = here ? path.resolve(here, cdm[1].replace(/^['"]|['"]$/g, '')) : null;
      out.push(text + sep);
      continue;
    }
    const pipes = splitPipes(text);
    const toks = tokenize(pipes[0]);
    let kitcmd = null;
    let env = [];
    let core = [];
    if (toks) {
      env = toks.filter((x) => ENV.test(x));
      core = toks.slice(env.length);
      const redirFile = core.some((x) => !NULLREDIR.has(x) && /^\d?>|^&>|^<|^>>/.test(x));
      core = core.filter((x) => !NULLREDIR.has(x));
      const meta = core.some((x) => /^[&(){}]$|[<>]/.test(x));
      // ssh output piped locally (`ssh h cat f | grep x`) must keep its pipe
      const remotePipe = pipes.length > 1 && ['ssh', 'scp'].includes(exeName(core[0]));
      if (!redirFile && !meta && !remotePipe) {
        // `cat FILES` alone, or piped only into filters (`| head -700`, `| grep x`): the first stage becomes tview
        const filters = pipes.slice(1).every((p) => { const t = tokenize(p); return t && ['head', 'tail', 'grep', 'sed'].includes(exeName(t[0])) && readOnly(t); });
        const files = filters && !env.length ? catFiles(core, here, root) : null;
        if (files) {
          const lead = /^\s*/.exec(text)[0];
          const rest = pipes.slice(1).map((p) => ` | ${p.trim()}`).join('');
          out.push(`${lead}node ${shq(TVIEW)} ${files.map(shq).join(' ')}${rest}${sep && !sep.startsWith('\n') ? ' ' : ''}${sep}`);
          viewed = true;
          continue;
        }
        kitcmd = rewrite(core);
      }
    }
    if (!kitcmd) {
      const safe = toks && !env.length && !core.some((x) => /^\d?>|^&>|^>>/.test(x)) &&
        pipes.every((p) => { const t = tokenize(p); return t && readOnly(t); });
      if (!safe) onlyKit = false;
      out.push(text + sep);
      continue;
    }
    if (env.length || ['ssh', 'scp'].includes(exeName(core[0]))) onlyKit = false;
    const lead = /^\s*/.exec(text)[0];
    out.push(`${lead}${[...env.map(shq), kitcmd].join(' ')}${sep && !sep.startsWith('\n') ? ' ' : ''}${sep}`);
    notes.push(`\`${core.map(shq).join(' ')}\` -> \`${kitcmd}\``);
  }
  if (!notes.length && !viewed) return null;
  const allow = onlyKit || permissionMode === 'bypassPermissions';
  if (!allow) return null; // mixed command in a session that would prompt: run it unchanged
  // no announcement line: tkit's own output says what it ran, and every printed line is re-read on later calls
  return { command: out.join(''), notes, allow: true };
}

async function onBash(input) {
  const ti = input.tool_input || {};
  const cmd = String(ti.command || '');
  if (!cmd || RAW.test(cmd)) return;
  const why = denyReason(cmd);
  if (why) {
    if (!seenBefore(input.session_id, `kitdeny\0${cmd}`, 'kit')) deny('PreToolUse', why + '\nRepeating the identical command runs it as is.');
    return;
  }
  const r = routeCommand(cmd, { cwd: input.cwd, permissionMode: input.permission_mode });
  if (r) {
    if (seenBefore(input.session_id, `kitrw\0${cmd}`, 'kit')) return;
    const out = { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...ti, command: r.command } };
    process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
    return;
  }
  if (ownToolsOnly(cmd, input.permission_mode)) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }));
    return;
  }
  if (process.env.TFORGE_REDIRECT === '1') {
    const { onBashGrep } = await import('./code-redirect.mjs');
    onBashGrep(input);
  }
}

// Claude Code saves oversized Bash output under .../tool-results/ and shows a preview; reading the
// whole file back puts the full output into context anyway. Ask for the part that matters instead.
export function spillReason(file, sliced) {
  if (sliced || !/[\\/]tool-results[\\/][^\\/]+\.txt$/.test(String(file || ''))) return null;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (text.length < 8000) return null;
  const lines = text.split('\n').length;
  return (
    `tokenforge: ${file} is saved command output (${lines} lines, ${text.length} chars); reading it whole puts all of it into context. ` +
    `Print only what you need: \`grep -n PATTERN FILE | head -40\`, \`sed -n a,bp FILE\`, or \`tail -50 FILE\`; or Read with offset/limit. Repeat this Read to load it whole.`
  );
}

function onRead(input) {
  const ti = input.tool_input || {};
  try {
    const alt = docReplacement(ti.file_path, ti);
    if (alt) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...ti, file_path: alt } } }));
      return;
    }
  } catch {}
  const why = readReason(ti.file_path, Boolean(ti.offset || ti.limit)) || spillReason(ti.file_path, Boolean(ti.offset || ti.limit));
  if (why && !seenBefore(input.session_id, `kitread\0${ti.file_path}`, 'kit')) deny('PreToolUse', why);
}

async function main() {
  if (kitHookOff('TFORGE_KIT_ROUTE')) return;
  const input = readInput();
  if (!input) return;
  try {
    if (input.tool_name === 'Bash') await onBash(input);
    else if (input.tool_name === 'Read') onRead(input);
  } catch {
    // never block a tool call on the router's own errors
  }
}

if (isMain(import.meta.url)) await main();
