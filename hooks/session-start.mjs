// SessionStart: inject the terse reply rule (re-injected after compaction, which drops it),
// and on startup or /clear reload .forge/HANDOFF.md and the two newest automatic snapshots
// (.forge/snapshots/, written by checkpoint.mjs) so a fresh session continues where the last one stopped.
// Also adds the short tkit policy; as a SubagentStart hook it injects only that policy.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TERSE_RULES, readConfig, terseLevel, writeConfig } from '../lib/config.mjs';
import { uiState } from '../lib/ui-control.mjs';
import { SNAP_DIR, listSnapshots, parseSnapshot } from './checkpoint.mjs';
import { isMain, kitHookOff } from '../lib/hookutil.mjs';
import { applyDefaultOnce, leanStatus } from '../lib/lean.mjs';
import { memoryHint } from '../lib/memory.mjs';

const MAX_AGE_H = Number(process.env.TFORGE_HANDOFF_MAX_AGE_H) || 72;
const MAX_CHARS = 8000;
const SNAP_CHARS = 4000;
const SNAPS_LOADED = 2;
// On a plain startup (not /clear) only recent snapshots are likely to be the same piece of work.
const SESSION_STARTUP_MAX_H = 12;
const MAP_HINT =
  'Code search (tokenforge tmap): `tmap find <words>` gives ranked `path:start-end signature` lines; `tmap tree [dir|file]` gives a map or outline; ' +
  '`tmap sym|callers|callees <name>`. Use it before Grep or whole-file reads, then Read only the returned line ranges.';

// Always-on efficiency policy. Paid on every call, so it stays short (~150 tokens). Measured in bench/:
// tool results are 80-95% of context growth, and every result is re-read on every later call, so the
// rules target result size and call count. Off: TFORGE_KIT_HOOKS=0 or TFORGE_KIT_POLICY=0.
export function kitPolicy() {
  if (kitHookOff('TFORGE_KIT_POLICY')) return null;
  return [
    'tokenforge: tool results are re-read on every later call: keep them small, calls few. Read code in ONE call, not grep then sed: `tread NAME Type.method path:40-80 "path:/regex/"` prints definitions by name, line ranges, or the definition around each match, across files. Batch reads; edit each file in one call; create new files several per call (one Bash call with several heredocs).',
    'Build/test output is compacted (tkit test [FILTER], tkit check). Changed code: run relevant checks once at the end. Read-only work: no checks. Never re-read or re-run to double-check.',
    // "Lazy, not negligent" (adapted from ponytail without its challenge-the-requirement mode, which skips
    // requirements under hidden tests): full scope, nothing extra, concise but readable code. In bench/ runs Token
    // Forge already wrote 10-35% less code than plain Claude Code; references are ~half again. Off: TFORGE_LAZY=0.
    ...(process.env.TFORGE_LAZY !== '0'
      ? ['Scope: do every stated requirement, nothing extra (no unasked features, docs, refactors, deps or abstractions); reuse existing helpers/patterns. Write concise, readable code: no boilerplate, dead code or comments that restate it. Bug: fix the shared function all callers use, once. Infer, don\'t ask. Once relevant checks pass, stop and answer.']
      : []),
    // Experimental (bench variant "plan-brief"): in write-heavy tasks a 20k+ token upfront plan was re-sent with every
    // later call, ~40% of the total. Opt-in until measured: TFORGE_PLAN=brief.
    ...(process.env.TFORGE_PLAN === 'brief'
      ? ['Planning: think briefly (key decisions only), then write; let the files carry the detail. Re-plan only when a check fails.']
      : []),
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
  const h = readFresh(path.join(cwd, '.forge', 'HANDOFF.md'), MAX_AGE_H, MAX_CHARS);
  if (h)
    parts.push(
      `tokenforge handoff (.forge/HANDOFF.md, written ${h.when}). Continue from it. ` +
        `Trust its file map and decisions; read files only when the next step needs them.\n\n${h.body}`,
    );
  if (process.env.TFORGE_RECALL === 'inject') {
    const maxH = source === 'clear' ? MAX_AGE_H : SESSION_STARTUP_MAX_H;
    const snaps = listSnapshots(cwd)
      .slice(-SNAPS_LOADED)
      .map((f) => readFresh(path.join(cwd, '.forge', SNAP_DIR, f), maxH, SNAP_CHARS))
      .filter((s) => s && (!h || s.mtime > h.mtime))
      .map((s) => parseSnapshot(s.body).body.trim());
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

// Headless sessions (claude -p, the SDK, CI) have nobody to open a dashboard, and a detached server would outlive them.
const unattended = () => /^sdk/.test(process.env.CLAUDE_CODE_ENTRYPOINT || '') || process.env.CLAUDE_CODE_SESSION_ATTENDED === '0' || !!process.env.CI;

// Start the local dashboard once per machine boot (or after it was stopped). Costs no context tokens.
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
  let applied;
  try {
    applied = applyDefaultOnce();
  } catch {
    return null;
  }
  return applied
    ? `tokenforge: turned on lean tools ("${applied}") in your Claude Code settings: skills, subagents, web tools and agent-orchestration tools are hidden from Claude, for about 40% fewer tokens (measured). Takes effect in your next session. Change or undo: /tokenforge:lean on|off, or the dashboard's Settings page.`
    : null;
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
function clearNotice(cwd) {
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
  const fresh = (ms) => ms && Date.now() - ms < MAX_AGE_H * 3600e3;
  const parts = [];
  if (fresh(snapMs)) parts.push(`TokenForge: checkpoint saved (${ago(snapMs)}, .forge/${SNAP_DIR}/).`);
  if (fresh(hMs)) parts.push(`Handoff reloaded (.forge/HANDOFF.md, ${ago(hMs)}): Claude continues from it.`);
  else if (fresh(snapMs)) parts.push('Say what to continue ("continue the billing fix"): Claude looks it up in past sessions.');
  return parts.length ? parts.join(' ') : 'TokenForge: no checkpoint in this folder yet. Fresh start.';
}

function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {}
  // Subagents get neither SessionStart nor UserPromptSubmit: the tkit policy is all they receive.
  if (input.hook_event_name === 'SubagentStart') {
    const k = kitPolicy();
    if (k) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: k } }));
    return;
  }
  const notices = [];
  if (input.source === 'startup') {
    const b = unattended() ? null : banner();
    if (b) notices.push(b);
    const d = ensureDashboard();
    if (d && !b) notices.push(d);
    const lean = leanDefault();
    if (lean) notices.push(lean);
  }
  if (input.source === 'clear' && !unattended()) {
    const c = clearNotice(input.cwd || process.cwd());
    if (c) notices.push(c);
  }
  const notice = notices.join('\n') || null;
  const parts = [];
  const level = terseLevel();
  if (level !== 'off') parts.push(TERSE_RULES[level]);
  // Opt-in: in A/B runs the hint alone never got tmap used and slightly raised token use.
  if (process.env.TFORGE_MAP === '1') parts.push(MAP_HINT);
  const kit = kitPolicy();
  if (kit) parts.push(kit);
  if (input.source !== 'compact' && input.source !== 'resume') {
    const h = handoff(input.cwd || process.cwd(), input.source, input.session_id);
    if (h) parts.push(h);
  }
  if (!parts.length && !notice) return;
  const out = {};
  if (parts.length) out.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') };
  if (notice) out.systemMessage = notice;
  process.stdout.write(JSON.stringify(out));
}

if (isMain(import.meta.url)) main();
