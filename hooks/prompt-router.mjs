// UserPromptSubmit: pick the working mode from the prompt (review / debug / write / inspect) by keywords and
// pre-load that mode's context with tkit, so Claude starts working instead of spending turns gathering it.
//   review   "review", "PR #12", a /pull/12 URL, "check the diff/changes"  -> tkit diff (a PR: told to run tkit diff --pr N)
//   debug    "error", "fails", "crash", a stack trace                       -> playbook; a pasted trace is resolved (tkit debug --trace -)
//   write    "add", "implement", "refactor", ...                            -> playbook; `backticked` literals pre-loaded (tkit analog)
//   inspect  "where", "how does", "what calls", "explain", ...              -> `backticked` symbols pre-loaded (tkit ctx)
// Silent for slash commands, short prompts, document work (proofreading a manuscript, auditing a spec), prompts that
// match no mode and directories outside a git repo.
// No model or network calls; each tkit call has a short timeout and the injected text is capped.
// Opt-in: TFORGE_KIT_PROMPT=1 (TFORGE_KIT_HOOKS=0 still turns it off). Cap: TFORGE_ROUTE_MAX_LINES (default 300).
import fs from 'node:fs';
import path from 'node:path';
import { existingBinary } from '../lib/tmapbin.mjs';
import { cap, isMain, kitHookOff, readInput, runTmap } from '../lib/hookutil.mjs';

const MAX_LINES = Number(process.env.TFORGE_ROUTE_MAX_LINES) || 300;
const TIMEOUT = Number(process.env.TFORGE_ROUTE_TIMEOUT_MS) || 8000;

// Unicode-aware word boundary, so French words with accents ("cassé", "où") match like English ones.
const B = '(?:(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_])|(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_]))';
const re = (s) => new RegExp(s.replaceAll('\\b', B), 'u');

const REVIEW = re(
  '\\b(review|reviews|code review|revue|reviewer|relis)\\b|\\b(look at|check|verify|vérifie|audit|go over|sanity.?check)\\b.{0,40}\\b(pr|diff|changes|branch|commit|commits|pushed|patch)\\b|\\bready to (merge|ship)\\b|\\bwhat .{0,20}pushed\\b|\\bsafe to merge\\b|\\blgtm\\b',
);
const DEBUG = re(
  '\\b(error|errors|fail|fails|failing|failed|crash|crashes|crashing|bug|bugs|broken|breaks|exception|panic|panics|traceback|stack ?trace|regression|hangs?|freez(e|es|ing)|leak|leaks|flaky|wrong|incorrect|off by|looks? off|weird|unexpected|erreur|plante|bogue|cassé)\\b|doesn.?t work|not working|stopped working|can.?t|cannot|won.?t|no longer|anymore|since (yesterday|today|the last|last)|returns? (5[0-9][0-9]|4[0-9][0-9]|null|nan|undefined)|\\b5[0-9][0-9]\\b',
);
const WRITE = re(
  '\\b(add|implement|create|build|write|support|introduce|refactor|rename|migrate|extract|tidy|clean ?up|simplify|make|need|want|allow|enable|let users|port|convert|replace|remove|delete|update|upgrade|ajoute|implémente|crée|ajouter|faire)\\b',
);
const INSPECT = re(
  '\\b(where|how does|how do|how is|how are|what calls|who calls|who uses|explain|why|what does|what is|what happens|which|walk me through|show me how|trace the|understand|où|comment|pourquoi|explique|que fait)\\b',
);
const FIX_LIGHT = re('\\b(fix|correct|corrige)\\b.{0,30}\\b(typo|typos|spelling|comment|wording|grammar|indent|format|lint)');
const FIRST_WRITE = /^(add|implement|create|build|write|refactor|rename|migrate|extract|tidy|make|port|convert|replace|remove|update|upgrade|ajoute|implémente|crée)$/;
const FIRST_INSPECT = /^(where|how|explain|why|what|which|walk|show|trace|où|comment|pourquoi|explique)$/;
const TRACE = /[A-Za-z0-9_./-]+\.[a-z]{1,5}:[0-9]+/;
// Documents to proofread or audit (manuscripts, papers, proofs, specs; the SpecAudit plugin): code-mode context would
// only mislead. A PR or a code file named in the same prompt keeps the routing.
const DOC = re(
  '\\.(md|markdown|tex|ltx|bib|rst|adoc|typ|pdf|docx?|odt)\\b|\\b(manuscripts?|manuscrits?|papers?|thesis|thèses?|proofs?|preuves?|démonstrations?|theorems?|théorèmes?|lemmas?|lemmes?|specifications?|spécifications?|chapters?|chapitres?|proofread\\w*|relecture|spec-audit)\\b',
);
const CODE_FILE = /\.(c|cc|cpp|cs|go|h|hpp|java|kt|swift|rs|py|rb|php|sh|sql|lua|luau|lean|dart|zig|[cm]?js|jsx|[cm]?ts|tsx|vue|svelte)\b/;

export function detect(prompt) {
  const lc = prompt.toLowerCase();
  let pr = (/(?:\/pull\/|\bpr ?#?|pull request #?)(\d+)/i.exec(prompt) || [])[1];
  // "PR on repo #167": any #N counts when the prompt talks about a PR.
  if (!pr && re('\\b(pr|prs|pull request|merge request)\\b').test(lc)) pr = (/#(\d+)/.exec(prompt) || [])[1];
  const trace = TRACE.test(prompt);
  const ticks = [...new Set([...prompt.matchAll(/`([^`\s][^`]{0,80})`/g)].map((m) => m[1]))].slice(0, 3);
  if (!pr && DOC.test(lc) && !CODE_FILE.test(lc)) return { mode: null, pr: null, trace, ticks };
  const first = (/^[a-zéèàùçô]+/u.exec(lc) || [''])[0];
  let mode = null;
  if (pr || REVIEW.test(lc)) mode = 'review';
  else if (trace) mode = 'debug';
  else if (FIX_LIGHT.test(lc) || FIRST_WRITE.test(first)) mode = 'write';
  else if (DEBUG.test(lc)) mode = 'debug';
  else if (FIRST_INSPECT.test(first)) mode = 'inspect';
  else if (WRITE.test(lc)) mode = 'write';
  else if (INSPECT.test(lc)) mode = 'inspect';
  return { mode, pr: pr || null, trace, ticks };
}

function inGitRepo(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return true;
    if (path.dirname(d) === d) return false;
  }
}

export function route(prompt, cwd, bin = existingBinary()) {
  if (!prompt || prompt.startsWith('/') || prompt.length < 12 || !inGitRepo(cwd)) return null;
  const { mode, pr, trace, ticks } = detect(prompt);
  if (!mode) return null;
  const kit = (args, input) => (bin ? runTmap(bin, ['kit', ...args], { cwd, input, timeout: TIMEOUT }) : null);
  const parts = [];
  if (mode === 'review') {
    parts.push(
      'tokenforge auto-mode: REVIEW. Findings: [P0-P3] path:line: problem. why. fix. Nothing actionable: LGTM. ' +
        'Fetch more only to verify a specific changed contract or caller, batched in one call.',
    );
    if (pr) parts.push(`First call: \`tkit diff --pr ${pr}\` (stat, touched symbols with callers, affected tests, whole-function diff); don't also run gh pr diff or git diff.`);
    else {
      const out = kit(['diff', '--max-lines', String(Math.max(50, MAX_LINES - 40))]);
      if (out) parts.push('The diff summary below (tkit diff) IS the review context: do not re-fetch it (no git diff).', out);
      else parts.push('First call: `tkit diff [BASE|--worktree]`; do not also run git diff.');
    }
  } else if (mode === 'debug') {
    parts.push(
      "tokenforge auto-mode: DEBUG. First call: `tkit debug [-- <failing test cmd>]` (failures, frame code, code under test, recent diff). " +
        "Then the minimal root-cause fix, validated in one call: `tkit edit -t '<test cmd>'`. Never weaken tests.",
    );
    if (trace) {
      const out = kit(['debug', '--trace', '-'], prompt);
      const at = out ? out.indexOf('## code at') : -1;
      if (out) parts.push('Stack trace resolved (no need to run tkit debug --trace again):', at >= 0 ? out.slice(at) : out);
    }
  } else if (mode === 'write') {
    parts.push(
      "tokenforge auto-mode: WRITE. Context = nearest analog + helper to reuse + registration point, in one call: `tkit analog '<most specific literal>'` (skip if pre-loaded below). " +
        "Then all edits + the narrowest test in one call: `tkit edit -t '<test cmd>'`. Smallest patch; reuse existing guards and helpers.",
    );
    if (ticks.length) {
      const out = kit(['analog', ...ticks]);
      if (out) parts.push('Pre-loaded analog for the backticked names (tkit analog):', out);
    }
  } else {
    parts.push(
      'tokenforge auto-mode: INSPECT. Answer the exact question from the code index: `tkit ctx SYM`, `tmap callers|callees SYM`, `tmap find WORDS`. No source dumps, no architecture tour.',
    );
    const syms = ticks.filter((t) => /^[A-Za-z_][A-Za-z0-9_:.]*$/.test(t));
    const outs = syms.map((s) => {
      const out = kit(['ctx', s]);
      return out ? `== tkit ctx ${s}\n${cap(out, 60)}` : null;
    });
    if (outs.some(Boolean)) parts.push('Pre-loaded:', outs.filter(Boolean).join('\n'));
  }
  return { mode, text: cap(parts.join('\n'), MAX_LINES, MAX_LINES * 100) };
}

function main() {
  // Opt-in: its mode guess misfired on feature work (DEBUG for plain features) and its pre-loaded
  // context is re-read on every call. TFORGE_KIT_PROMPT=1 turns it on.
  if (kitHookOff('TFORGE_KIT_PROMPT') || process.env.TFORGE_KIT_PROMPT !== '1') return;
  const input = readInput();
  if (!input) return;
  let r = null;
  try {
    r = route(String(input.prompt || ''), input.cwd || process.cwd());
  } catch {}
  if (r) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: r.text } }));
}

if (isMain(import.meta.url)) main();
