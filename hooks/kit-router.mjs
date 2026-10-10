// PreToolUse for Bash and Read: send Claude to the tkit tools instead of raw output and ad-hoc scripts.
//   Rewritten (updatedInput): raw build/test commands -> `tkit check` / `tkit test`; `ssh HOST CMD` and
//     scp -> `tkit ssh`. Only commands whose flags are all understood; anything else runs unchanged.
//   `cat FILES` inside the project -> `tview FILES` (long definition bodies folded, see lib/view.mjs).
//   grep/rg printing lines -> `tkit run --group` (each path once above its lines, long lines cut, capped);
//     noisy installs, CI logs and recursive listings -> `tkit run` (squeezed, capped, full log saved).
//   Refused (deny + the command to use): interactive `ssh HOST` and installers that would stop for an answer.
//   Narrowed with a note instead of refused (a deny shows as "hook error"): a lone `cat` of dependency source
//     -> tview; a whole-file Read of dependency source, a lockfile or generated file -> its first 200 lines; of a
//     big saved tool output (tool-results/*.txt) -> its last ~8k chars.
//   Never refused: focused reads (grep, sed -n, head, cat) and inline edit scripts. A refusal costs a round trip
//     that re-reads the whole context, more than the output it saves, and one script that edits a file in one
//     call is cheaper than a chain of small Edit calls.
//   Never rewritten: commands with a heredoc. A rewrite is auto-approved only when every segment became
//     a tkit/tview call, or the session already approves everything; otherwise the command runs unchanged
//     (asking would show a prompt on every rewrite, and nobody can answer it in a headless run).
//   Polling loops (until/while/for with sleep and only reads) asking for more than 4 minutes get 4 where the prompt
//     cache lives 5 minutes (subagents): a longer wait lets it expire, and the next call rewrites the whole context.
// Escape hatches: a TFORGE_RAW=1 (or TS_RAW=1) prefix, or repeating the identical call.
// With TFORGE_REDIRECT=1, identifier greps in Bash are answered from tmap first (see code-redirect.mjs).
// Off: TFORGE_KIT_HOOKS=0 or TFORGE_KIT_ROUTE=0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { docReplacement } from '../lib/docread.mjs';
import { codexHost, deny, exeName, isMain, kitHookOff, readInput, seenBefore, shq, skippedAgent, splitPipes, splitSegments, tokenize } from '../lib/hookutil.mjs';

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
  // Unbounded history/status become one line per item; anything with options or paths is left as is.
  if (exe === 'git' && sub === 'status' && t.length === 2) return 'git status -sb';
  if (exe === 'git' && sub === 'log' && t.length === 2) return 'git --no-pager log --oneline -n 20';
  // Noisy but unparsed commands: same arguments, output squeezed by `tkit run` (no colours/progress, repeats collapsed,
  // capped, full log saved). Never followed/interactive forms (-f, --follow, -i, -w/--watch), which would hang or stream.
  const live = t.some((a) => ['-f', '--follow', '-i', '-it', '-ti', '-w', '--watch', '--interactive'].includes(a) || /^-[a-z]*f[a-z]*$/.test(a) && exe !== 'docker');
  if (!live) {
    const noisy =
      (['npm', 'pnpm', 'yarn', 'bun'].includes(exe) && ['install', 'i', 'ci', 'add'].includes(sub)) ||
      (['pip', 'pip3'].includes(exe) && sub === 'install') ||
      (/^python[0-9.]*$/.test(exe) && sub === '-m' && t[2] === 'pip' && t[3] === 'install') ||
      (exe === 'cargo' && sub === 'build') ||
      (exe === 'docker' && ['logs', 'build', 'pull'].includes(sub)) ||
      (exe === 'kubectl' && sub === 'logs') ||
      (exe === 'journalctl' && !t.includes('-n'));
    const logs = (['docker', 'kubectl'].includes(exe) && sub === 'logs') || exe === 'journalctl';
    if (noisy) return kit('run', ...(logs ? ['--fuzzy'] : []), ...t);
    // CI logs: thousands of timestamped lines, the failure near the end
    if (exe === 'gh' && sub === 'run' && t[2] === 'view' && t.some((a) => a === '--log' || a === '--log-failed')) return kit('run', '--fuzzy', '-n', '200', ...t);
    // unbounded listings: capped, full list saved to a file
    const bounded = t.some((a) => ['-c', '-l', '-L', '-q', '-m', '--count', '--files-with-matches', '--max-count', '-print0', '-maxdepth', '-quit'].includes(a));
    const listing =
      (exe === 'ls' && t.some((a) => /^-[a-zA-Z]*R/.test(a) || a === '--recursive')) ||
      exe === 'tree' ||
      (exe === 'find' && !t.some((a) => /^-(exec|execdir|delete|ok|fprint|print0|maxdepth|quit)/.test(a)));
    if (listing && !bounded) return kit('run', '-n', '150', ...t);
    // big diffs: 1 line of context instead of 3, capped
    if (exe === 'git' && (sub === 'diff' || sub === 'show') && rest.every((a) => !a.startsWith('-') || a === '--staged' || a === '--cached'))
      return kit('run', '-n', '300', 'git', '--no-pager', sub, '-U1', ...rest);
  }
  if (exe === 'curl') {
    // plain `curl [-s|-S|-L] [-X METHOD] [-H 'K: V']... [-d BODY] URL` only
    let method = '', body = '', url = '';
    const hdr = [];
    for (let i = 1; i < t.length; i++) {
      const a = t[i];
      if (['-s', '-S', '-sS', '-Ss', '-L', '-sL', '-sSL', '--silent', '--location', '--fail', '-f'].includes(a)) continue;
      if (a === '-X' && t[i + 1]) method = t[++i];
      else if (a === '-H' && t[i + 1]) hdr.push('-H', t[++i]);
      else if ((a === '-d' || a === '--data') && t[i + 1] && !t[i + 1].startsWith('@')) body = t[++i];
      else if (!a.startsWith('-') && !url) url = a;
      else return null;
    }
    if (!url || !/^(https?:\/\/|localhost|:\d)/.test(url)) return null;
    return kit('http', method || (body ? 'POST' : ''), url, body, ...hdr);
  }
  if (exe === 'cargo' && (sub === 'check' || sub === 'clippy')) {
    const r = opts(rest, ['-p', '--package'], ['--workspace', '--all-targets', '--all', '--tests', '--lib', '--bins']);
    if (!r || r[0].length) return null;
    return kit('check', '-l', 'rust', ...P([r[1]['-p'] || r[1]['--package']]), sub === 'check' ? '--fast' : '');
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
  // Commands that stop to ask a question hang until the timeout: one wasted turn. Hint the non-interactive form.
  const ask =
    (/(^|[;&|]\s*)npm\s+init\s*($|[;&|])/.test(cmd) && 'npm init -y') ||
    (/(^|[;&|]\s*)(sudo\s+)?apt(-get)?\s+(install|upgrade|dist-upgrade|remove|purge)\b(?![^;&|]*(\s-y\b|\s--yes\b|\s-qq\b))/.test(cmd) && 'apt-get -y …') ||
    (/(^|[;&|]\s*)pip3?\s+uninstall\s/.test(cmd) && !/\s-y\b/.test(cmd) && 'pip uninstall -y …');
  if (ask) return `tokenforge: this command may stop and wait for an answer, which hangs the call. Use the non-interactive form: \`${ask}\`.`;
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

// A lone `cat` of dependency source is shown through tview (long bodies folded) with a note, rather than refused:
// Claude Code shows any deny as "hook error". Read-only either way; the usual permission check still applies.
export function depsView(cmd) {
  const reg = registryPkg(cmd);
  const t = reg && tokenize(cmd.trim());
  if (!t || t.length < 2 || t[0] !== 'cat' || !t.slice(1).every((a) => !/^-|[<>|;&*?$`(){}]/.test(a))) return null;
  return {
    command: `node ${shq(TVIEW)} ${t.slice(1).map(shq).join(' ')}`,
    note: `tokenforge: dependency source, shown with long bodies folded (each fold gives the sed -n command that prints it). Next time: \`tkit deps api ${reg[0]} [SYMBOL]\` from the project dir.`,
  };
}

// Lockfiles, minified bundles, source maps and build output: huge, no signal. Whole-file Reads are narrowed once.
const BULK = /(^|[\\/])(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|composer\.lock|Gemfile\.lock|go\.sum)$|\.(min\.(js|css)|map)$|[\\/](dist|build|target|\.next|__pycache__)[\\/]/;

// Whole-file Read inside a dependency registry, or of a bulk generated file.
export function readReason(file, sliced) {
  if (sliced) return null;
  if (BULK.test(String(file || '')))
    return `tokenforge: ${file} is a lockfile/minified/generated file: reading it whole is mostly noise. Grep it for the entry you need, or Read with offset/limit. Repeat this Read to load it whole.`;
  const reg = registryPkg(file);
  return reg
    ? `tokenforge: ${file} is dependency source. Use \`tkit deps api ${reg[0]} [SYMBOL]\` from the project dir (declaration, docs, members). ` +
        'If you really need the body, Read it with offset/limit, or repeat this Read.'
    : null;
}

const ENV = /^[A-Za-z_][A-Za-z0-9_]*=/;
// An assignment re-quoted as one word (`'FOO=a b'`) is a command name, not an assignment: quote the value only.
const envq = (x) => x.replace(/=([\s\S]*)$/, (_, v) => `=${shq(v)}`);

// True when the shell would expand something in `s`: $VAR, $(..) or `..` (unquoted or in double quotes), and unquoted
// globs, braces and a leading ~. Rewrites rebuild a command from its tokens and quote every one, which would turn these
// into literals: `find "$D"` searching a directory named $D, `ls -R ~/x` one named ~.
export function expands(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") {
      if (c === "'") q = null;
    } else if (c === '\\') i++;
    else if (c === '$' || c === '`') return true;
    else if (q === '"') {
      if (c === '"') q = null;
    } else if (c === "'" || c === '"') q = c;
    else if ('*?[{'.includes(c) || (c === '~' && (i === 0 || /[\s=:]/.test(s[i - 1])))) return true;
  }
  return false;
}

// Later pipeline stages a rewritten build/test command may drop: they only trim what is displayed. Anything that
// writes (tee, a redirection), counts or transforms the output keeps the command as typed.
function displayOnly(stage) {
  const t = tokenize(stage);
  if (!t || !t.length || t.some((x) => !NULLREDIR.has(x) && /[<>]|^[&(){}]$/.test(x))) return false;
  const exe = exeName(t[0]);
  if (exe === 'head' || exe === 'cat' || exe === 'less' || exe === 'more') return true;
  if (exe === 'tail') return !t.some((x) => /^-[a-zA-Z]*[fF]|^--follow/.test(x));
  if (['grep', 'egrep', 'fgrep'].includes(exe)) return !t.some((x) => /^-[a-zA-Z]*[clLqoZz]/.test(x) || GREP_SKIP.has(x));
  return false;
}
const NULLREDIR = new Set(['2>&1', '&>/dev/null', '>/dev/null', '2>/dev/null', '>NUL', '2>NUL']);

// Rewrite raw build/test/ssh/scp segments. Returns { command, notes, allow } or null when nothing changed.
const TVIEW = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'tview');

// `cat` of regular files inside the project root, no flags: [files] or null.
export function catFiles(core, cwd, root) {
  if (exeName(core[0]) !== 'cat' || core.length < 2 || !cwd) return null;
  const args = core.slice(1);
  if (args.some((f) => f.startsWith('-') || /[$`~{\[]/.test(f))) return null;
  // globs are expanded here only to check them; the rewritten command keeps them as typed so the shell expands them
  // in its own (locale) order, which fs.globSync does not follow. A quoted or unusual glob is left alone.
  const files = [];
  for (const a of args) {
    if (!/[*?]/.test(a)) files.push(a);
    else if (!/^[\w./*?@+,=-]+$/.test(a)) return null;
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

// grep/rg printing matched lines: each path once above its lines (--null marks where it ends; `tkit run --group`
// reads it), long lines cut, capped. Lists, counts and quiet or NUL-separated output keep their own form, and so
// does a run whose stdout goes to /dev/null (only its exit code is wanted). toks: the segment's tokens with redirects;
// raw: its text, kept as written after the program name so globs, ~ and $VARS still expand in the shell.
const GREP_SKIP = new Set(['--count', '--count-matches', '--files', '--files-with-matches', '--files-without-match', '--quiet', '--silent', '--json', '--null', '--null-data', '--heading', '--pretty', '--type-list', '--help', '--version']);
const NOISE_DIRS = ['.git', 'node_modules', '.venv', '__pycache__'];
function grepWrap(core, toks, raw, cwd) {
  const exe = exeName(core[0]);
  if (!['grep', 'egrep', 'fgrep', 'rg'].includes(exe) || !onPath(core[0], cwd)) return null;
  if (core.some((a) => /^-[a-zA-Z]*[lLqcpzZ0]/.test(a) || GREP_SKIP.has(a) || a.startsWith('--pre'))) return null;
  if (toks.some((x) => ['>/dev/null', '&>/dev/null', '>NUL'].includes(x))) return null;
  const extra = ['--null'];
  if (toks.some((x) => x === '2>/dev/null' || x === '2>NUL')) extra.push('--no-messages');
  // recursive grep: skip VCS, dependency and cache dirs the command does not name (rg skips them through .gitignore)
  if (exe !== 'rg' && core.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || /^--(dereference-)?recursive$/.test(a))) {
    const dirs = [...NOISE_DIRS, ...(cwd && fs.existsSync(path.join(cwd, 'target', 'CACHEDIR.TAG')) ? ['target'] : [])];
    extra.push(...dirs.filter((d) => !core.some((a) => a.includes(d))).map((d) => `--exclude-dir=${d}`));
  }
  const text = raw.trim();
  const prog = /^\S+/.exec(text)[0];
  return `${kit('run', '--group', '-n', '200')} ${prog} ${extra.join(' ')}${text.slice(prog.length)}`;
}

// A program `tkit run` can start: rg is often a shell function or alias (Claude Code ships its own).
function onPath(name, cwd) {
  if (/[\\/]/.test(name)) return fs.existsSync(path.resolve(cwd || '.', name));
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  return (process.env.PATH || '').split(path.delimiter).some((d) => d && exts.some((x) => fs.existsSync(path.join(d, name + x))));
}

// Read-only segments that keep a rewritten command auto-approvable (no redirection, checked by caller).
const READ_ONLY = new Set(['grep', 'egrep', 'fgrep', 'rg', 'head', 'tail','ls', 'wc', 'echo', 'printf', 'pwd', 'tree', 'nl', 'cat', 'sort', 'uniq', 'cut', 'file', 'stat', 'true']);
export function readOnly(core) {
  const exe = exeName(core[0] || '');
  if (exe === 'rg' && core.some((x) => x.startsWith('--pre'))) return false; // runs a command per file
  if (READ_ONLY.has(exe)) return true;
  if (exe === 'sed') return core.includes('-n') && !core.some((x) => /^-i|^--in-place/.test(x));
  if (exe === 'find') return !core.some((x) => /^-(exec|execdir|delete|ok|fprint)/.test(x));
  if (exe === 'git') return ['status', 'log', 'diff', 'show', 'ls-files', 'grep', 'blame', 'rev-parse', 'branch'].includes(core[1]);
  if (exe === 'gh') return core[1] === 'run' && core[2] === 'view';
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
        const words = pipes[0].trim().split(/\s+/);
        if (files && core.slice(1).every((a) => !/[*?]/.test(a) || words.includes(a))) {
          const lead = /^\s*/.exec(text)[0];
          const rest = pipes.slice(1).map((p) => ` | ${p.trim()}`).join('');
          out.push(`${lead}node ${shq(TVIEW)} ${core.slice(1).map((a) => (/[*?]/.test(a) ? a : shq(a))).join(' ')}${rest}${sep && !sep.startsWith('\n') ? ' ' : ''}${sep}`);
          viewed = true;
          continue;
        }
        // grepWrap keeps the typed text, so expansions survive there; other rewrites re-quote every token
        const literal = !expands(pipes[0]);
        kitcmd = (literal && rewrite(core)) || (pipes.length === 1 && !env.length ? grepWrap(core, toks, pipes[0], here) : null);
        // filters after a rewritten generic/git command would be dropped: leave piped commands alone; a build/test
        // command drops only display filters (`| tail -30`), never a tee, a count or a redirection
        if (kitcmd && pipes.length > 1 && (/^(tkit run|git )/.test(kitcmd) || !pipes.slice(1).every(displayOnly))) kitcmd = null;
        // `tkit run` wraps any command: only read-only ones may skip the permission prompt
        if (kitcmd && /^tkit run/.test(kitcmd) && !readOnly(core)) onlyKit = false;
        // opt-in: cap the output of any other plain command (TFORGE_CAP_ALL=1)
        if (!kitcmd && process.env.TFORGE_CAP_ALL === '1' && pipes.length === 1 && !env.length && !redirFile && literal &&
            !['cd', 'export', 'source', 'tkit', 'tread', 'tview', 'tforge', 'tmap', 'vim', 'nano', 'less', 'top', 'htop', 'ssh', 'scp', 'sleep', 'echo', 'printf'].includes(exeName(core[0] || '')) &&
            !core.some((x) => ['-f', '--follow', '-i', '-w', '--watch'].includes(x))) {
          kitcmd = kit('run', '-n', '200', ...core);
          if (!readOnly(core)) onlyKit = false;
        }
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
    out.push(`${lead}${[...env.map(envq), kitcmd].join(' ')}${sep && !sep.startsWith('\n') ? ' ' : ''}${sep}`);
    notes.push(`\`${core.map(shq).join(' ')}\` -> \`${kitcmd}\``);
  }
  if (!notes.length && !viewed) return null;
  const allow = onlyKit || permissionMode === 'bypassPermissions';
  if (!allow) return null; // mixed command in a session that would prompt: run it unchanged
  // no announcement line: tkit's own output says what it ran, and every printed line is re-read on later calls
  return { command: out.join(''), notes, allow: true };
}

// ---------- polling waits ----------
// A subagent's prompt cache expires after 5 idle minutes. A Bash call that polls longer lets it lapse, and the next
// request rewrites the whole context at 12.5x the price of reading it: over 14 days, 394 such waits cost 112M
// input-equivalent tokens. There, a loop that only sleeps and looks gets 4 minutes; running it again goes on waiting.
// Builds, tests, writes, background runs and contexts on the 1-hour cache keep the timeout they asked for.
export const WAIT_CAP = 240e3;
const POLL_OK = new Set(['sleep', 'test', '[', '[[', 'pgrep', 'ps', 'true', 'false', ':', 'break', 'continue', 'date']);
const SHELL_WORDS = new Set(['until', 'while', 'do', 'done', 'if', 'then', 'elif', 'else', 'fi', '!', '{', '}']);

// A loop (until/while/for) that sleeps and otherwise only looks (test, grep, tail, pgrep...): cutting it short loses nothing.
export function pollingWait(cmd) {
  let loop = false;
  let sleeps = false;
  const looks = (script) => {
    const s = script.replace(/\$\(seq [\d ]+\)/g, '1');
    // outside quotes: no subshell, other substitution, background job, or output to anything but /dev/null
    const bare = s.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""').replace(/[\d&]?>>?\s*(\/dev\/null\b|&\d)/g, ' ');
    if (/[()`>]|(^|[^&])&(?!&)/.test(bare)) return false;
    const segs = splitSegments(s);
    return Boolean(segs) && segs.every(([text]) => splitPipes(text).every((p) => {
      const words = tokenize(p);
      if (!words) return false;
      const t = words.filter((x) => x !== '/dev/null' && !/^[\d&]?>/.test(x));
      let i = 0;
      for (; SHELL_WORDS.has(t[i]) || ENV.test(t[i]); i++) if (t[i] === 'until' || t[i] === 'while') loop = true;
      if (t[i] === 'for') {
        loop = true;
        return t[i + 2] === 'in';
      }
      if (t[i] === 'cd') return t.length <= i + 2;
      if (exeName(t[i]) === 'timeout') {
        for (i++; /^-/.test(t[i]); i++) if (/^(-[sk]|--signal|--kill-after)$/.test(t[i])) i++;
        if (!/^\d/.test(t[i])) return false;
        i++;
      }
      const core = t.slice(i);
      const exe = exeName(core[0]);
      if (['sh', 'bash', 'zsh', 'dash'].includes(exe)) return core[1] === '-c' && core.length === 3 && looks(core[2]);
      if (exe === 'kill') return core[1] === '-0';
      if (exe === 'sleep') sleeps = true;
      return !core.length || POLL_OK.has(exe) || readOnly(core);
    }));
  };
  return looks(cmd) && loop && sleeps;
}

// The prompt-cache TTL this context's requests write ('5m' or '1h'), from the end of its transcript; null when unknown.
function cacheTtl(input) {
  if (!input.transcript_path) return null;
  const file = input.agent_id
    ? path.join(path.dirname(input.transcript_path), input.session_id, 'subagents', `agent-${input.agent_id}.jsonl`)
    : input.transcript_path;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, 256e3));
      fs.readSync(fd, buf, 0, buf.length, size - buf.length);
      return [...buf.toString('utf8').matchAll(/"ephemeral_(5m|1h)_input_tokens":[1-9]/g)].pop()?.[1] ?? null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

// A 4-minute timeout for a polling wait on the 5-minute cache (a subagent, unless its transcript says 1h).
function waitCap(input, cmd) {
  const ti = input.tool_input || {};
  const asked = Number(ti.timeout) || Number(process.env.BASH_DEFAULT_TIMEOUT_MS) || 120e3;
  // Codex: no Bash timeout field to lower, and updatedInput without 'allow' is an error there.
  if (codexHost(input) || asked <= WAIT_CAP || ti.run_in_background || !pollingWait(cmd)) return null;
  if ((cacheTtl(input) || (input.agent_id ? '5m' : null)) !== '5m') return null;
  const out = { updatedInput: { ...ti, timeout: WAIT_CAP } };
  if (!seenBefore(input.session_id, `waitcap\0${input.agent_id || ''}`, 'kit')) {
    out.additionalContext = 'tokenforge: polling loops are cut at 4 min here (the prompt cache expires after 5 idle min); if one times out, run it again.';
  }
  return out;
}

async function onBash(input) {
  const ti = input.tool_input || {};
  const cmd = String(ti.command || '');
  if (!cmd || RAW.test(cmd)) return;
  const dv = depsView(cmd);
  if (dv) {
    if (!seenBefore(input.session_id, `kitdeny\0${cmd}`, 'kit'))
      rewriteOut({ ...ti, command: dv.command }, `${dv.note}\nRepeating the identical command runs it as is.`, 'allow');
    return;
  }
  const why = denyReason(cmd);
  if (why) {
    if (!seenBefore(input.session_id, `kitdeny\0${cmd}`, 'kit')) deny('PreToolUse', why + '\nRepeating the identical command runs it as is.');
    return;
  }
  if (process.env.TFORGE_REDIRECT === '1') {
    const { onBashGrep } = await import('./code-redirect.mjs');
    if (onBashGrep(input)) return;
  }
  const cap = waitCap(input, cmd);
  const r = routeCommand(cmd, { cwd: input.cwd, permissionMode: input.permission_mode });
  let out = cap;
  if (r) {
    if (!seenBefore(input.session_id, `kitrw\0${cmd}`, 'kit')) out = { ...cap, permissionDecision: 'allow', updatedInput: { ...ti, ...cap?.updatedInput, command: r.command } };
  } else if (ownToolsOnly(cmd, input.permission_mode)) out = { ...cap, permissionDecision: 'allow' };
  if (out) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...out } }));
}

// Claude Code saves oversized Bash output under .../tool-results/ and shows a preview of its start; reading the
// whole file back puts the full output into context anyway. A whole Read of one is narrowed to its last ~8k
// chars (where errors and summaries usually are) with a note on how to see the rest. A rewrite, not a deny:
// Claude Code shows any deny as "hook error", which looked like a crash.
export function spillWindow(file, sliced) {
  if (sliced || !/[\\/]tool-results[\\/][^\\/]+\.txt$/.test(String(file || ''))) return null;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (text.length < 8000) return null;
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let from = lines.length;
  for (let chars = 0; from > 0 && (chars < 8000 || lines.length - from < 20); ) chars += lines[--from].length + 1;
  if (from === 0) return null;
  const offset = from + 1;
  const note =
    `tokenforge: ${file} is saved command output (${lines.length} lines, ${text.length} chars). ` +
    `This Read was narrowed to lines ${offset}-${lines.length} (the end); the preview already showed the start. ` +
    `For other parts, Read with offset/limit or search the file for a pattern; repeat the same whole Read to load all of it.`;
  return { offset, limit: lines.length - from, note };
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
  const sliced = Boolean(ti.offset || ti.limit);
  const win = headWindow(ti.file_path, readReason(ti.file_path, sliced)) || spillWindow(ti.file_path, sliced);
  if (win && !seenBefore(input.session_id, `kitread\0${ti.file_path}`, 'kit')) rewriteOut({ ...ti, offset: win.offset, limit: win.limit }, win.note);
}

// A rewritten tool input plus a note for the model, used instead of a deny (Claude Code shows any deny as "hook
// error"). With no decision the usual permission check runs on the new input; 'allow' only for a pure tview call.
function rewriteOut(updatedInput, note, decision) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...(decision && { permissionDecision: decision }), updatedInput, additionalContext: note } }));
}

// A whole Read that readReason flags (lockfile, generated file, dependency source) is narrowed to its first
// HEAD_LINES lines; a file not much longer than that, or unreadable, is left alone.
const HEAD_LINES = 200;
export function headWindow(file, why) {
  if (!why) return null;
  let lines;
  try {
    if (fs.statSync(file).size > 64e6) return null;
    lines = fs.readFileSync(file, 'utf8').split('\n').length;
  } catch {
    return null;
  }
  if (lines <= HEAD_LINES * 1.5) return null;
  return { offset: 1, limit: HEAD_LINES, note: `${why.replace(/ Repeat this Read.*$|If you really need.*$/, '')}\nThis Read was narrowed to lines 1-${HEAD_LINES} of ${lines}; Read with offset/limit for other parts, or repeat the same whole Read to load all of it.` };
}

// PowerShell (Windows): only plain one-line commands with nothing PowerShell-specific in them are routed
// (cargo test, npm install, ssh ...). Quoting, variables, pipelines and script blocks are left alone.
async function onPowerShell(input) {
  const cmd = String((input.tool_input || {}).command || '');
  if (!/^[\w .\/\\:=@%+,-]+$/.test(cmd) || RAW.test(cmd)) return;
  const r = routeCommand(cmd, { cwd: input.cwd, permissionMode: input.permission_mode });
  if (!r || seenBefore(input.session_id, `kitrw\0${cmd}`, 'kit')) return;
  const out = { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input.tool_input, command: r.command } };
  process.stdout.write(JSON.stringify({ hookSpecificOutput: out }));
}

async function main() {
  if (kitHookOff('TFORGE_KIT_ROUTE')) return;
  const input = readInput();
  if (!input || skippedAgent(input)) return;
  try {
    if (input.tool_name === 'Bash') await onBash(input);
    else if (input.tool_name === 'PowerShell') await onPowerShell(input);
    else if (input.tool_name === 'Read') onRead(input);
  } catch {
    // never block a tool call on the router's own errors
  }
}

if (isMain(import.meta.url)) await main();
