// SessionStart: inject the terse reply rule (re-injected after compaction, which drops it),
// and on startup or /clear reload .forge/HANDOFF.md and the two newest automatic snapshots
// (.forge/snapshots/, written by checkpoint.mjs) so a fresh session continues where the last one stopped.
// After compaction and on resume (`reloadOn`) it reloads what the context lacks: the session's own checkpoint after a
// compaction; on resume only what changed while the session was away. Files a skill declares (`stateFiles`, e.g. a
// review register) are reloaded in place of the generic checkpoint.
// Also adds the short tkit policy and the instruction files Claude Code did not load (lib/instructions.mjs), and starts
// the background gc when it is due. As a SubagentStart hook it injects the policy and the instruction files.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectRoot } from '../lib/util.mjs';
import { TERSE_RULES, globRe, listSetting, readConfig, terseLevel, writeConfig } from '../lib/config.mjs';
import { uiState } from '../lib/ui-control.mjs';
import { AUTO_MARK, HANDOFF_MAX_H, SNAP_DIR, listSnapshots, noteHandoffGiven, noteLoad, parseSnapshot, staleHandoff } from './checkpoint.mjs';
import { isMain, kitHookOff, skippedAgent, unattended } from '../lib/hookutil.mjs';
import { maybeGc } from '../lib/gc.mjs';
import { OMITS_INSTRUCTIONS, digest, writeGiven } from '../lib/instructions.mjs';
import { applyDefaultOnce, applyKeep, applyWindowOnce, leanStatus } from '../lib/lean.mjs';
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
// own=true (an agent with its own definition, e.g. a SpecAudit arbiter): only the tool-efficiency lines and the override
// line; its definition owns scope, planning and when to ask.
export function kitPolicy(quiet = true, subagent = false, own = false) {
  if (kitHookOff('TFORGE_KIT_POLICY')) return null;
  const plan = own ? '' : process.env.TFORGE_PLAN ?? (subagent ? '' : 'look');
  return [
    'tokenforge: tool results are re-read on every later call: keep them small, calls few. Read code in ONE call, not grep then sed: `tread NAME Type.method path:40-80 "path:/regex/"` prints definitions by name, line ranges, or the definition around each match, across files. Batch reads; edit each file in one call; create new files several per call (`tkit edit` `@@ path new`, not `cat >`). Independent shell commands: ONE `tkit batch "a" "b"`; throwaway code (math, parsing, a try): `tkit eval py|js|sh <<\'EOF\'`, sandboxed, no scratch files.' +
      (quiet ? ' No text between tool calls ("Now X."): just call the tool; text only in the final answer.' : ''),
    'Build/test output is compacted (tkit test [FILTER], tkit check). Changed code: run relevant checks once, at the end; read-only work: none; never re-run to double-check.',
    // "Lazy, not negligent" (adapted from ponytail without its challenge-the-requirement mode, which skips
    // requirements under hidden tests): full scope, nothing extra, concise but readable code. In bench/ runs Token
    // Forge already wrote 10-35% less code than plain Claude Code; references are ~half again. Off: TFORGE_LAZY=0.
    ...(process.env.TFORGE_LAZY !== '0' && !own
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

// Claude Code's own agent types; any other type comes from an agent definition (plugin, user or project).
const BUILTIN_AGENTS = new Set(['general-purpose', 'Explore', 'Plan', 'claude', 'statusline-setup', 'claude-code-guide']);
export const ownDefinition = (agentType) => !!agentType && !BUILTIN_AGENTS.has(agentType);

const ago = (ms, now = Date.now()) => {
  const m = Math.max(0, Math.round((now - ms) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

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
function readHandoff(cwd, sessionId, since = 0) {
  staleHandoff(cwd, HANDOFF_MAX_H);
  const h = readFresh(path.join(cwd, '.forge', 'HANDOFF.md'), HANDOFF_MAX_H, MAX_CHARS);
  if (!h || h.mtime <= since) return null;
  // on resume: not the automatic handoff this same session wrote (its context already holds that work)
  if (since && h.body.startsWith(AUTO_MARK) && h.body.slice(0, 400).includes(`session ${String(sessionId).slice(0, 8)}`)) return null;
  noteHandoffGiven(cwd, sessionId, h.mtime);
  return {
    ...h,
    text:
      `tokenforge handoff (.forge/HANDOFF.md, written ${h.when} UTC, ${ago(h.mtime)}). Continue from it. ` +
      `Trust its file map and decisions; read files only when the next step needs them.\n\n${h.body}`,
  };
}

function handoff(cwd, source, sessionId) {
  const parts = [];
  const h = readHandoff(cwd, sessionId);
  if (h) parts.push(h.text);
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

// After /clear with no fresh handoff (or after a compaction, or on resume when another session worked here since): a
// checkpoint, cut to its essentials (last requests, files changed, subagents, start of the last reply), at most ~1200
// characters. The full snapshots used to be re-read on every call (TFORGE_RECALL=inject); this bounded summary costs
// about 250 tokens per call. Off: TFORGE_CLEAR_RELOAD=0.
// pick: { sid } only this session's snapshots, { notSid, after } another session's snapshots newer than `after` (ms).
const CLEAR_MAX_H = 12;
const CLEAR_CHARS = 1200;
export function compactCheckpoint(cwd, { sid, notSid, after = 0, label = 'before /clear' } = {}) {
  if (process.env.TFORGE_CLEAR_RELOAD === '0') return null;
  const own = (f) => f.includes(`-${String(sid).slice(0, 8)}-`);
  const other = (f) => !f.includes(`-${String(notSid).slice(0, 8)}-`);
  const snaps = listSnapshots(cwd).filter((f) => (!sid || own(f)) && (!notSid || other(f)));
  if (!snaps.length) return null;
  const name = snaps[snaps.length - 1];
  const s = readFresh(path.join(cwd, '.forge', SNAP_DIR, name), after ? HANDOFF_MAX_H : CLEAR_MAX_H, 1e6);
  if (!s) return null;
  const { meta, body } = parseSnapshot(s.body);
  if (after && !(Date.parse(meta?.end) > after)) return null;
  const section = (name) => {
    const m = new RegExp(`## ${name}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`).exec(body);
    return m ? m[1].trim() : '';
  };
  const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
  const reqs = section('Requests').split('\n').filter((l) => l.startsWith('- ')).slice(-2).map((l) => clip(l, 220));
  const files = section('Files changed').split('\n').filter((l) => l.startsWith('- ')).slice(0, 10);
  const nodes = section('Graph').split('\n').filter((l) => l.startsWith('- R')).slice(-3);
  const agents = section('Subagents').split('\n').filter((l) => l.startsWith('- ')).slice(-4).map((l) => clip(l, 160));
  const reply = nodes.length ? '' : clip(section('Last reply').replace(/\s+/g, ' '), 300);
  const out = [`tokenforge checkpoint (${label}, ${s.when} UTC). Continue from the last request; read files only when the next step needs them.`];
  if (nodes.length) out.push('Last requests (request -> files edited/read, commands, outcome):', ...nodes.map((l, i) => clip(l, i === nodes.length - 1 ? 520 : 300)));
  else if (reqs.length) out.push('Last requests:', ...reqs);
  if (agents.length) out.push('Subagents (type "task"):', ...agents);
  if (files.length) out.push('Files changed:', ...files);
  if (reply) out.push(`Last reply: ${reply}`);
  if (out.length < 2) return null;
  noteLoad(cwd, [name]);
  return clip(out.join('\n'), CLEAR_CHARS);
}

// The session's own last activity (end of its newest snapshot), in ms; 0 when unknown.
function lastActivity(cwd, sessionId) {
  const sid8 = String(sessionId || '').slice(0, 8);
  if (!sid8) return 0;
  const name = listSnapshots(cwd).filter((f) => f.includes(`-${sid8}-`)).at(-1);
  if (!name) return 0;
  try {
    const { meta } = parseSnapshot(fs.readFileSync(path.join(cwd, '.forge', SNAP_DIR, name), 'utf8'));
    return Date.parse(meta?.end || meta?.start) || fs.statSync(path.join(cwd, '.forge', SNAP_DIR, name)).mtimeMs;
  } catch {
    return 0;
  }
}

// Files a skill keeps its own state in (`stateFiles` in the config, or TFORGE_STATE_FILES: globs relative to the project
// root, e.g. `spec-audit/*/register.md`). Reloaded at startup, after /clear and compaction, and on resume when changed
// since; never in subagents. Only files modified within STATE_MAX_H, newest first, STATE_CHARS each, STATE_TOTAL in all.
const STATE_MAX_H = 72;
const STATE_CHARS = 8000;
const STATE_TOTAL = 16000;
const WALK_SKIP = new Set(['node_modules', '.git']);
export function findFiles(root, globs, { maxDepth = 8, maxEntries = 20000 } = {}) {
  const found = new Map();
  let seen = 0;
  for (const g of globs) {
    const glob = g.replace(/^\.?\//, '');
    const re = globRe(glob);
    const segs = glob.split('/');
    const fixed = segs.slice(0, segs.findIndex((x) => /[*?]/.test(x))).join('/');
    const literal = !/[*?]/.test(glob);
    const walk = (rel, depth) => {
      let ents;
      try {
        ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of ents) {
        if (++seen > maxEntries) return;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!WALK_SKIP.has(e.name) && depth < maxDepth) walk(r, depth + 1);
        } else if (re.test(r)) found.set(r, path.join(root, r));
      }
    };
    if (literal) {
      if (fs.existsSync(path.join(root, glob))) found.set(glob, path.join(root, glob));
    } else walk(fixed, fixed ? fixed.split('/').length : 0);
  }
  return [...found].map(([rel, abs]) => ({ rel, abs }));
}

export function stateFiles(cwd, { since = 0, now = Date.now() } = {}) {
  const globs = listSetting('TFORGE_STATE_FILES', 'stateFiles');
  if (!globs.length) return null;
  const files = findFiles(cwd, globs)
    .map((f) => ({ ...f, mtime: fs.statSync(f.abs, { throwIfNoEntry: false })?.mtimeMs || 0 }))
    .filter((f) => f.mtime > since && now - f.mtime <= STATE_MAX_H * 3600e3)
    .sort((a, b) => b.mtime - a.mtime);
  const out = [];
  let total = 0;
  for (const f of files) {
    if (total >= STATE_TOTAL) break;
    let body;
    try {
      body = fs.readFileSync(f.abs, 'utf8');
    } catch {
      continue;
    }
    const room = Math.min(STATE_CHARS, STATE_TOTAL - total);
    if (body.length > room) body = body.slice(0, room) + '\n[truncated]';
    total += body.length;
    out.push(`tokenforge state file ${f.rel} (modified ${ago(f.mtime, now)}; declared in stateFiles). It is the current state of that work: continue from it.\n\n${body}`);
  }
  return out.length ? out.join('\n\n') : null;
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
  let applied, win, lifted;
  try {
    lifted = applyKeep();
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
  if (lifted?.length) return `tokenforge: lean no longer hides ${lifted.join(', ')} (leanKeep). Takes effect in your next session.`;
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

// What to put back into a context that lacks it. startup/clear: handoff (or memory hint), state files, and after /clear
// with neither, the checkpoint. compact: state files, else this session's checkpoint. resume: only what changed since
// the session's last activity (a newer handoff, changed state files, another session's newer checkpoint).
export function reloadParts(cwd, source, sessionId) {
  const parts = [];
  if (source === 'startup' || source === 'clear') {
    const h = handoff(cwd, source, sessionId);
    if (h) parts.push(h);
    const st = stateFiles(cwd);
    if (st) parts.push(st);
    if (source === 'clear' && !st && !(h && h.includes('tokenforge handoff')) && process.env.TFORGE_RECALL !== 'inject') {
      const c = compactCheckpoint(cwd);
      if (c) parts.push(c);
    }
    return parts;
  }
  const on = listSetting('TFORGE_RELOAD_ON', 'reloadOn', ['compact', 'resume']);
  if (!on.includes(source)) return parts;
  if (source === 'compact') {
    const st = stateFiles(cwd);
    const c = st ? null : compactCheckpoint(cwd, { sid: sessionId, label: 'before compaction' });
    return [st, c].filter(Boolean);
  }
  if (source === 'resume') {
    const since = lastActivity(cwd, sessionId);
    if (!since) return parts;
    const h = readHandoff(cwd, sessionId, since);
    if (h) parts.push(h.text);
    const st = stateFiles(cwd, { since });
    if (st) parts.push(st);
    if (!h) {
      const c = compactCheckpoint(cwd, { notSid: sessionId, after: since, label: `another session here since this one was last active, ${ago(since)}` });
      if (c) parts.push(c);
    }
  }
  return parts;
}

function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {}
  // `subagentSkip`: agents the user asked to leave alone get nothing at all.
  if (input.hook_event_name === 'SubagentStart' && skippedAgent(input)) return;
  // Subagents get neither SessionStart nor UserPromptSubmit: the tkit policy and the instruction files are all they
  // receive (Explore and Plan skip CLAUDE.md by design, so they skip these files too).
  // A new or compacted context holds no nested instruction files yet: context-watch.mjs adds them as tools reach them.
  const reads = !OMITS_INSTRUCTIONS.has(input.agent_type);
  const resume = input.source === 'resume';
  if (reads && !resume) writeGiven(input.session_id, input.agent_id, { root: input.cwd });
  const instructions = reads && !resume && digest(input.cwd || process.cwd());
  const own = ownDefinition(input.agent_type);
  if (input.hook_event_name === 'SubagentStart') {
    const k = [kitPolicy(true, true, own), instructions].filter(Boolean).join('\n\n');
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

  // A resumed session's transcript still holds the rules and instruction files given at its start (and after each
  // compaction): only the reload part is new.
  const parts = [];
  const level = terseLevel();
  if (!resume) {
    if (level !== 'off') parts.push(TERSE_RULES[level]);
    // Opt-in: in A/B runs the hint alone never got tmap used and slightly raised token use.
    if (process.env.TFORGE_MAP === '1') parts.push(MAP_HINT);
    const kit = kitPolicy(level !== 'full', false, own);
    if (kit) parts.push(kit);
    if (instructions) parts.push(instructions);
  }
  const reload = reloadParts(cwd, input.source, input.session_id);
  parts.push(...reload);
  if (input.source === 'clear' && !unattended()) {
    const c = clearNotice(cwd, reload.some((p) => p.startsWith('tokenforge checkpoint') || p.startsWith('tokenforge state file')));
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
