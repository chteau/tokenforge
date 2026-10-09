// SessionStart: inject the terse reply rule (re-injected after compaction, which drops it),
// and on startup or /clear reload .forge/HANDOFF.md and the two newest automatic snapshots
// (.forge/snapshots/, written by checkpoint.mjs) so a fresh session continues where the last one stopped.
// Also adds the short tkit policy and the instruction files Claude Code did not load (lib/instructions.mjs), and starts
// the background gc when it is due. As a SubagentStart hook it injects the policy and the instruction files.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectRoot } from '../lib/util.mjs';
import { TERSE_RULES, readConfig, terseLevel, writeConfig } from '../lib/config.mjs';
import { uiState } from '../lib/ui-control.mjs';
import { HANDOFF_MAX_H, SNAP_DIR, listSnapshots, noteLoad, parseSnapshot, staleHandoff } from './checkpoint.mjs';
import { isMain, kitHookOff, unattended } from '../lib/hookutil.mjs';
import { maybeGc } from '../lib/gc.mjs';
import { OMITS_INSTRUCTIONS, digest, writeGiven } from '../lib/instructions.mjs';
import { applyDefaultOnce, applyWindowOnce, leanStatus } from '../lib/lean.mjs';
import { autoStatusline } from '../lib/limits.mjs';
import { memoryHint } from '../lib/memory.mjs';
import { updateNotice } from '../lib/update-check.mjs';

const MAX_CHARS = 8000;
const SNAP_CHARS = 4000;
const SNAPS_LOADED = 2;
// On a plain startup (not /clear) only recent snapshots are likely to be the same piece of work.
const SESSION_STARTUP_MAX_H = 12;
const MAP_HINT =
  'Code search (tokenforge tmap): `tmap find <words>` gives ranked `path:start-end signature` lines; `tmap tree [dir|file]` gives a map or outline; ' +
  '`tmap sym|callers|callees <name>`. Use it before Grep or whole-file reads, then Read only the returned line ranges.';

// Always-on efficiency policy. Paid on every call, so it stays short (~300 tokens, ~100 more with the default
// planning line). Measured in bench/: tool results are 80-95% of context growth, and every result is re-read on
// every later call, so the rules target result size and call count. Off: TFORGE_KIT_HOOKS=0 or TFORGE_KIT_POLICY=0.
// quiet=false: the terse reply rule already says what goes between tool calls.
// Subagents get a planning line only when TFORGE_PLAN names one: the "look" default was measured on main sessions.
export function kitPolicy(quiet = true, subagent = false) {
  if (kitHookOff('TFORGE_KIT_POLICY')) return null;
  const plan = process.env.TFORGE_PLAN ?? (subagent ? '' : 'look');
  return [
    'tokenforge: tool results are re-read on every later call: keep them small, calls few. Read code in ONE call, not grep then sed: `tread NAME Type.method path:40-80 "path:/regex/"` prints definitions by name, line ranges, or the definition around each match, across files. Batch reads; edit each file in one call; create new files several per call (`tkit edit` `@@ path new`, not `cat >`). Independent shell commands: ONE `tkit batch "a" "b"`; throwaway code (math, parsing, a try): `tkit eval py|js|sh <<\'EOF\'`, sandboxed, no scratch files.' +
      (quiet ? ' No text between tool calls ("Now X."): just call the tool; text only in the final answer.' : ''),
    'Build/test output is compacted (tkit test [FILTER], tkit check). Changed code: run relevant checks once, at the end; read-only work: none; never re-run to double-check.',
    // "Lazy, not negligent" (adapted from ponytail without its challenge-the-requirement mode, which skips
    // requirements under hidden tests): full scope, nothing extra, concise but readable code. In bench/ runs Token
    // Forge already wrote 10-35% less code than plain Claude Code; references are ~half again. Off: TFORGE_LAZY=0.
    ...(process.env.TFORGE_LAZY !== '0'
      ? ['Scope: do every stated requirement, nothing extra (no unasked features, docs, refactors, deps or abstractions); reuse existing helpers/patterns. Write concise, readable code: no boilerplate, dead code or comments that restate it. Bug: fix the shared function all callers use, once. Infer, don\'t ask. Once relevant checks pass, stop and answer.']
      : []),
    // Opt-in, TFORGE_PLAN=brief (bench variant "plan-brief"): in write-heavy tasks a 20k+ token upfront plan was
    // re-sent with every later call, ~40% of the total. 36 paired tasks: 7% cheaper than no planning line, "look"
    // 9% cheaper still.
    ...(plan === 'brief'
      ? ['Planning: think briefly (key decisions only), then write; let the files carry the detail. Re-plan only when a check fails.']
      : []),
    // Default (bench variant "plan-look"): thinking was Token Forge's only cost regression vs plain Claude Code, and
    // it is priced as output and re-sent with every later call. 36 paired tasks (bench/reports/final-comparison.md):
    // thinking -44%, list cost -15% (95% CI -21% to -10%), hidden tests passed unchanged. Off: TFORGE_PLAN=0.
    ...(plan === 'look'
      ? ['Planning: thinking is output, priced like the code you write and re-read on every later call (a few hundred tokens ≈ one extra tool call). Look before you plan: the first call lists the repo and reads the key files, with little thinking; then plan briefly (key decisions only) and write. Never draft code in thinking; write it into the files.']
      : []),
    // Skills and agents from other plugins define their own workflow (SpecAudit: whole-document reads, reviewer
    // scripts kept on disk, checks repeated until convergence, closing questions); generic rules must not override it.
    'A skill or agent definition you follow overrides these rules and the reply style where they differ (output format, full reads, scripts, re-runs, questions).',
  ].join('\n');
}

function readFresh(file, maxH, maxChars) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if ((Date.now() - st.mtimeMs) / 3.6e6 > maxH) return null;
  let body = fs.readFileSync(file, 'utf8');
  if (body.length > maxChars) body = body.slice(0, maxChars) + '\n[truncated]';
  return { body, mtime: st.mtimeMs, when: new Date(st.mtimeMs).toISOString().slice(0, 16).replace('T', ' ') };
}

// HANDOFF.md is a deliberate "continue from here", so it is loaded. Snapshots are loaded only with
// TFORGE_RECALL=inject: by default a one-line memory hint points Claude to `tforge recall`, so past work
// costs tokens only when the task needs it, instead of ~2k re-read on every call of every new session.
function handoff(cwd, source, sessionId) {
  const parts = [];
  staleHandoff(cwd, HANDOFF_MAX_H);
  const h = readFresh(path.join(cwd, '.forge', 'HANDOFF.md'), HANDOFF_MAX_H, MAX_CHARS);
  if (h)
    parts.push(
      `tokenforge handoff (.forge/HANDOFF.md, written ${h.when}). Continue from it. ` +
        `Trust its file map and decisions; read files only when the next step needs them.\n\n${h.body}`,
    );
  if (process.env.TFORGE_RECALL === 'inject') {
    const maxH = source === 'clear' ? HANDOFF_MAX_H : SESSION_STARTUP_MAX_H;
    const loaded = listSnapshots(cwd)
      .slice(-SNAPS_LOADED)
      .map((f) => ({ f, s: readFresh(path.join(cwd, '.forge', SNAP_DIR, f), maxH, SNAP_CHARS) }))
      .filter(({ s }) => s && (!h || s.mtime > h.mtime));
    noteLoad(cwd, loaded.map(({ f }) => f));
    const snaps = loaded.map(({ s }) => parseSnapshot(s.body).body.trim());
    if (snaps.length)
      parts.push(
        `tokenforge snapshots of the previous session (.forge/${SNAP_DIR}/, newest ${snaps.length}, oldest first${h ? ', newer than the handoff' : ''}). ` +
          `Continue from the last request; don't re-read files unless the next step needs them.\n\n${snaps.join('\n\n')}`,
      );
  } else if (process.env.TFORGE_RECALL !== '0') {
    try {
      const hint = memoryHint(cwd, sessionId);
      if (hint) parts.push(hint);
    } catch {}
  }
  return parts.length ? parts.join('\n\n') : null;
}

// After /clear with no fresh handoff: the latest checkpoint, cut to its essentials (last requests, files changed, start
// of the last reply), at most ~1200 characters. The full snapshots used to be re-read on every call (TFORGE_RECALL=inject);
// this bounded summary costs about 250 tokens per call of the cleared session. Off: TFORGE_CLEAR_RELOAD=0.
const CLEAR_MAX_H = 12;
const CLEAR_CHARS = 1200;
export function compactCheckpoint(cwd) {
  if (process.env.TFORGE_CLEAR_RELOAD === '0') return null;
  const snaps = listSnapshots(cwd);
  if (!snaps.length) return null;
  const s = readFresh(path.join(cwd, '.forge', SNAP_DIR, snaps[snaps.length - 1]), CLEAR_MAX_H, 1e6);
  if (!s) return null;
  const body = parseSnapshot(s.body).body;
  const section = (name) => {
    const m = new RegExp(`## ${name}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`).exec(body);
    return m ? m[1].trim() : '';
  };
  const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
  const reqs = section('Requests').split('\n').filter((l) => l.startsWith('- ')).slice(-2).map((l) => clip(l, 220));
  const files = section('Files changed').split('\n').filter((l) => l.startsWith('- ')).slice(0, 10);
  const nodes = section('Graph').split('\n').filter((l) => l.startsWith('- R')).slice(-3);
  const reply = nodes.length ? '' : clip(section('Last reply').replace(/\s+/g, ' '), 300);
  const out = [`tokenforge checkpoint (before /clear, ${s.when}). Continue from the last request; read files only when the next step needs them.`];
  if (nodes.length) out.push('Last requests (request -> files edited/read, commands, outcome):', ...nodes.map((l, i) => clip(l, i === nodes.length - 1 ? 520 : 300)));
  else if (reqs.length) out.push('Last requests:', ...reqs);
  if (files.length) out.push('Files changed:', ...files);
  if (reply) out.push(`Last reply: ${reply}`);
  if (out.length < 2) return null;
  noteLoad(cwd, [snaps[snaps.length - 1]]);
  return clip(out.join('\n'), CLEAR_CHARS);
}

// Start the local dashboard once per machine boot (or after it was stopped); never headless (claude -p, the SDK, CI),
// where nobody opens it and a detached server would outlive the session. Costs no context tokens.
function ensureDashboard() {
  if (process.env.TFORGE_UI === '0' || unattended() || uiState()) return null;
  const tforge = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'tforge');
  try {
    const child = spawn(process.execPath, [tforge, 'ui', '--detach'], { detached: true, stdio: 'ignore' });
    child.unref();
    return `tokenforge dashboard starting at http://127.0.0.1:${Number(process.env.TFORGE_UI_PORT) || 7878}/ (tforge ui --status shows the exact port; TFORGE_UI=0 disables)`;
  } catch {
    return null;
  }
}

// Shown to the user only (systemMessage), never added to Claude's context.
function leanDefault() {
  let applied, win;
  try {
    applied = applyDefaultOnce();
    win = applied ? null : applyWindowOnce();
  } catch {
    return null;
  }
  const at = (w) => `1M-context sessions compact at ${w / 1e3}k tokens instead of near 1M`;
  if (applied) {
    const w = readConfig().leanWindowAdded;
    return `tokenforge: turned on lean tools ("${applied}") in your Claude Code settings: tools and built-in skills Claude rarely needs are hidden from it, for about 40% fewer tokens per request (measured)${w ? `, and ${at(w)}` : ''}. Takes effect in your next session. Change or undo: /tokenforge:lean on|off, or the dashboard's Settings page.`;
  }
  return win
    ? `tokenforge: with lean tools ("${win.level}"), ${at(win.window)} from now on: every request re-reads the whole context, and this cut input tokens by 40% or more in measured sessions. Set your own with /autocompact.`
    : null;
}

// The status-line shim lives outside the plugin (it survives updates) and loads lib/estimate.mjs from here.
const PLUGIN_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
function statusline() {
  try {
    if (readConfig().pluginRoot !== PLUGIN_ROOT) writeConfig({ pluginRoot: PLUGIN_ROOT });
    return unattended() ? null : autoStatusline();
  } catch {
    return null;
  }
}

// Shown to the user at startup (systemMessage: zero tokens). The walkthrough appears for the first few sessions only.
const INTRO_SESSIONS = 3;
function banner() {
  if (process.env.TFORGE_BANNER === '0') return null;
  let level = 'off';
  try {
    level = leanStatus().level;
  } catch {}
  const port = Number(process.env.TFORGE_UI_PORT) || 7878;
  const line = `TokenForge: active · lean ${level} · replies ${terseLevel()} · dashboard http://127.0.0.1:${port}/`;
  let shown = 0;
  try {
    shown = Number(readConfig().introShown) || 0;
    if (shown < INTRO_SESSIONS) writeConfig({ introShown: shown + 1 });
  } catch {}
  if (shown >= INTRO_SESSIONS) return line;
  return [
    line,
    'Nothing to learn: work as usual, TokenForge trims what every call re-sends. To get the most out of it:',
    '  • One task per session. Long job? /tokenforge:handoff, then /clear: the next session picks up from the notes.',
    '  • Ask about earlier work ("what did we change in billing last week?"): Claude searches past sessions itself.',
    '  • /tokenforge:dashboard shows where tokens went and your limits; its Settings page changes the lean level.',
    `  (This walkthrough shows ${INTRO_SESSIONS - shown - 1 > 0 ? `${INTRO_SESSIONS - shown - 1} more time${INTRO_SESSIONS - shown - 1 > 1 ? 's' : ''}` : 'for the last time'}. TFORGE_BANNER=0 hides the banner.)`,
  ].join('\n');
}

// After /clear: say plainly what survived, so "did I just lose my work?" never needs asking.
function clearNotice(cwd, reloaded = false) {
  if (process.env.TFORGE_BANNER === '0') return null;
  const ago = (ms) => {
    const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
  };
  const hf = path.join(cwd, '.forge', 'HANDOFF.md');
  const snaps = listSnapshots(cwd);
  let snapMs = 0;
  try {
    if (snaps.length) snapMs = fs.statSync(path.join(cwd, '.forge', SNAP_DIR, snaps[snaps.length - 1])).mtimeMs;
  } catch {}
  let hMs = 0;
  try {
    hMs = fs.statSync(hf).mtimeMs;
  } catch {}
  const fresh = (ms) => ms && Date.now() - ms < HANDOFF_MAX_H * 3600e3;
  const parts = [];
  if (fresh(snapMs)) parts.push(`TokenForge: checkpoint saved (${ago(snapMs)}, .forge/${SNAP_DIR}/).`);
  if (fresh(hMs)) parts.push(`Handoff reloaded (.forge/HANDOFF.md, ${ago(hMs)}): Claude continues from it.`);
  else if (reloaded) parts.push('Reloaded: Claude continues from your last request.');
  else if (fresh(snapMs)) parts.push('Say what to continue ("continue the billing fix"): Claude looks it up in past sessions.');
  return parts.length ? parts.join(' ') : 'TokenForge: no checkpoint in this folder yet. Fresh start.';
}

function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {}
  // Subagents get neither SessionStart nor UserPromptSubmit: the tkit policy and the instruction files are all they
  // receive (Explore and Plan skip CLAUDE.md by design, so they skip these files too).
  // A new or compacted context holds no nested instruction files yet: context-watch.mjs adds them as tools reach them.
  const reads = !OMITS_INSTRUCTIONS.has(input.agent_type);
  if (reads) writeGiven(input.session_id, input.agent_id, { root: input.cwd });
  const instructions = reads && digest(input.cwd || process.cwd());
  if (input.hook_event_name === 'SubagentStart') {
    const k = [kitPolicy(true, true), instructions].filter(Boolean).join('\n\n');
    if (k) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: k } }));
    return;
  }
  const cwd = projectRoot(input.cwd || process.cwd());
  if (input.source === 'startup' || input.source === 'clear') maybeGc(cwd, input.session_id);
  const notices = [];
  if (input.source === 'startup') {
    const b = unattended() ? null : banner();
    if (b) notices.push(b);
    if (!unattended()) {
      try {
        const u = updateNotice();
        if (u) notices.push(u);
      } catch {}
    }
    const d = ensureDashboard();
    if (d && !b) notices.push(d);
    const lean = leanDefault();
    if (lean) notices.push(lean);
    const sl = statusline();
    if (sl) notices.push(sl);
  }

  const parts = [];
  const level = terseLevel();
  if (level !== 'off') parts.push(TERSE_RULES[level]);
  // Opt-in: in A/B runs the hint alone never got tmap used and slightly raised token use.
  if (process.env.TFORGE_MAP === '1') parts.push(MAP_HINT);
  const kit = kitPolicy(level !== 'full');
  if (kit) parts.push(kit);
  if (instructions) parts.push(instructions);
  let reloaded = false;
  if (input.source !== 'compact' && input.source !== 'resume') {
    const h = handoff(cwd, input.source, input.session_id);
    if (h) parts.push(h);
    if (input.source === 'clear' && !(h && h.includes('tokenforge handoff')) && process.env.TFORGE_RECALL !== 'inject') {
      const c = compactCheckpoint(cwd);
      if (c) (parts.push(c), (reloaded = true));
    }
  }
  if (input.source === 'clear' && !unattended()) {
    const c = clearNotice(cwd, reloaded);
    if (c) notices.push(c);
  }
  const notice = notices.join('\n') || null;
  if (!parts.length && !notice) return;
  const out = {};
  if (parts.length) out.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') };
  if (notice) out.systemMessage = notice;
  process.stdout.write(JSON.stringify(out));
}

if (isMain(import.meta.url)) main();
