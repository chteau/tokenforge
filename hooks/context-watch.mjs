// Context budget. Every API call re-reads the whole context from the cache, so cache reads grow with
// calls x context size. Past the budget, and each time the context doubles, the user's next message gets a
// non-blocking alert, and .forge/HANDOFF.md is written
// automatically from this session's snapshots (no model call), so /clear at any moment loses nothing: the next
// session reloads it. Prompts are never held. A handoff the user wrote (/tokenforge:handoff) is never overwritten.
// After each tool call it also adds the nested instruction files of the directories the call reached (Claude Code
// loads them only through Read) and counts reads of snapshots, which keep them from being pruned.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AUTO_MARK, SNAP_DIR, analyzeBash, listSnapshots, noteLoad, parseSnapshot } from './checkpoint.mjs';
import { isMain, skippedAgent, stateDir } from '../lib/hookutil.mjs';
import { OMITS_INSTRUCTIONS, nestedFor, readGiven, writeGiven } from '../lib/instructions.mjs';
import { projectRoot } from '../lib/util.mjs';

const BUDGET = Number(process.env.TFORGE_BUDGET) || 50000;
// The fixed part (system prompt, tools, skills, hook text) can be most of the budget on its own.
// Always leave this much room above it for actual work.
const FLOOR = Number(process.env.TFORGE_BUDGET_FLOOR) || 15000;
const SOFT_MARGIN = 10000;
const TAIL_BYTES = 512 * 1024;
const HEAD_BYTES = 1024 * 1024;

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

function usageCtx(line) {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return 0;
  try {
    const u = JSON.parse(line).message?.usage;
    if (u) return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  } catch {}
  return 0;
}

function readLines(file, fromEnd, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, fromEnd ? size - len : 0);
    return buf.toString('utf8').split('\n');
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Context size of the newest API call, read from the end of the transcript.
export function lastContext(file) {
  const lines = readLines(file, true, TAIL_BYTES);
  for (let i = lines.length - 1; i >= 0; i--) {
    const c = usageCtx(lines[i]);
    if (c) return c;
  }
  return 0;
}

// Context size of the session's first API call: the fixed part every call pays.
export function firstContext(file) {
  for (const l of readLines(file, false, HEAD_BYTES)) {
    const c = usageCtx(l);
    if (c) return c;
  }
  return 0;
}

export function limits(baseline) {
  const limit = Math.max(BUDGET, baseline + FLOOR);
  return { limit, soft: Math.max(limit - SOFT_MARGIN, baseline + 5000) };
}

const section = (body, name) => {
  const m = new RegExp(`## ${name}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`).exec(body);
  return m ? m[1].trim().split('\n').filter((l) => l.startsWith('- ')) : [];
};

// .forge/HANDOFF.md from this session's snapshots: recent requests, every file changed, the last reply.
// Returns true when written. Skips when the user's own handoff (no auto marker) is newer than this session's start.
export function autoHandoff(cwd, sid, ctx, now = Date.now()) {
  if (!cwd || process.env.TFORGE_AUTO_HANDOFF === '0') return false;
  const sid8 = String(sid).slice(0, 8);
  const names = listSnapshots(cwd).filter((f) => f.includes(`-${sid8}-`));
  if (!names.length) return false;
  const snaps = names.map((f) => {
    try {
      return parseSnapshot(fs.readFileSync(path.join(cwd, '.forge', SNAP_DIR, f), 'utf8')).body;
    } catch {
      return '';
    }
  }).filter(Boolean);
  const file = path.join(cwd, '.forge', 'HANDOFF.md');
  try {
    const st = fs.statSync(file);
    const first = fs.statSync(path.join(cwd, '.forge', SNAP_DIR, names[0])).mtimeMs;
    if (!fs.readFileSync(file, 'utf8').startsWith(AUTO_MARK) && st.mtimeMs > first - 3600e3) return false;
  } catch {}
  const reqs = snaps.flatMap((b) => section(b, 'Requests')).slice(-6);
  const files = [...new Set(snaps.flatMap((b) => section(b, 'Files changed')))].slice(0, 40);
  const agents = snaps.flatMap((b) => section(b, 'Subagents')).slice(-8);
  const last = snaps[snaps.length - 1];
  const reply = (/## Last reply\n([\s\S]*)$/.exec(last)?.[1] || '').trim().slice(0, 1500);
  const when = new Date(now).toISOString().slice(0, 16).replace('T', ' ');
  const out = [
    AUTO_MARK,
    `# Handoff (automatic, session ${sid8}, ${when} UTC, context ~${Math.round(ctx / 1000)}k tokens)`,
    'Written by tokenforge from the session transcript; /tokenforge:handoff writes one with decisions and next steps.',
    'Continue from the last request. Read files only when the next step needs them.',
  ];
  if (reqs.length) out.push('', '## Recent requests (oldest first)', ...reqs);
  if (files.length) out.push('', '## Files changed', ...files);
  if (agents.length) out.push('', '## Subagents (newest)', ...agents);
  if (reply) out.push('', '## Last reply', reply);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, out.join('\n') + '\n');
    return true;
  } catch {
    return false;
  }
}

// Absolute paths a tool call reached.
function toolPaths(tool, ti, cwd) {
  let base = cwd;
  let list = [];
  if (tool === 'Bash') {
    const cmd = String(ti.command || '');
    const cd = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*&&/.exec(cmd);
    if (cd) base = path.resolve(cwd, cd[1].replace(/^["']|["']$/g, ''));
    const { edits, reads } = analyzeBash(cmd);
    list = [...(cd ? [base] : []), ...[...edits, ...reads].map((p) => p.replace(/:(\d|\/).*$/, ''))];
  } else if (tool === 'Grep' || tool === 'Glob') list = [ti.path];
  else list = [ti.file_path ?? ti.notebook_path];
  return list.filter((p) => typeof p === 'string' && p).map((p) => path.resolve(base, p.replace(/^~(?=[\\/])/, os.homedir())));
}

// After a tool call: count snapshot reads, and return the nested instruction files the call reached that this agent
// does not have yet.
function afterTool(input) {
  try {
    const ti = input.tool_input || {};
    const cwd = input.cwd || process.cwd();
    const snaps = [...JSON.stringify(ti).matchAll(/\.forge[\\/]+snapshots[\\/]+(\d{8}-\d{4}-[\w-]+-\d{3}\.md)/g)].map((m) => m[1]);
    if (snaps.length) noteLoad(projectRoot(cwd), [...new Set(snaps)]);
    if (OMITS_INSTRUCTIONS.has(input.agent_type) || skippedAgent(input)) return '';
    const paths = toolPaths(input.tool_name, ti, cwd);
    if (!paths.length) return '';
    const state = readGiven(input.session_id, input.agent_id);
    const given = new Set(state.loaded);
    const before = given.size;
    const text = nestedFor(state.root || cwd, paths, { tool: input.tool_name, given });
    if (given.size !== before) writeGiven(input.session_id, input.agent_id, { ...state, loaded: [...given] });
    return text;
  } catch {
    return '';
  }
}

// Context budget. Bands: near the budget, over it, then each doubling. The user gets one alert per band, with
// their next message; after a tool call that crossed a band Claude gets a note only with TFORGE_WATCH_INJECT=1.
function watch(input, event) {
  if (process.env.TFORGE_WATCH === '0' || !input.transcript_path) return null;
  const ctx = lastContext(input.transcript_path);
  if (!ctx) return null;
  const sid = String(input.session_id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '');
  const dir = stateDir();
  const stateFile = path.join(dir, `${sid}.json`);
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {}
  const save = () => {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(stateFile, JSON.stringify(state));
    } catch {}
  };
  if (!state.baseline) {
    state.baseline = firstContext(input.transcript_path) || ctx;
    save();
  }
  const { limit, soft } = limits(state.baseline);
  const band = ctx < soft ? -1 : ctx < limit ? 0 : 1 + Math.floor(Math.log2(ctx / limit));
  const k = (n) => `${Math.round(n / 1000)}k`;

  if (event === 'UserPromptSubmit') {
    if (band < 1) return null;
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (prompt.startsWith('/')) return null;
    const saved = autoHandoff(input.cwd, input.session_id, ctx);
    if (state.alerted === band) return null;
    state.alerted = band;
    save();
    return {
      systemMessage:
        `TokenForge: context ~${k(ctx)} tokens (budget ${k(limit)}), re-read on every call. ` +
        (saved ? 'Handoff saved: when it suits you, /clear or a new session continues from it.' : 'When it suits you, /clear or start a new session.') +
        ' Your message was sent.',
    };
  }

  // Every injected line is re-read on every later call, and "stop and /clear" ends unattended tasks halfway.
  if (process.env.TFORGE_WATCH_INJECT !== '1') return null;
  const prev = state.band ?? -1;
  if (band === prev) return null;
  state.band = band;
  save();
  if (band < prev) return null; // context shrank (compaction): re-arm, stay silent
  const note =
    band === 0
      ? `tokenforge: context is ~${k(ctx)} tokens, near the ${k(limit)} budget. Finish the current step, avoid large reads, ` +
        'batch remaining lookups into one turn, and send bulk implementation to tforge workers.'
      : `tokenforge: context is ~${k(ctx)} tokens, over the ${k(limit)} budget; every further call re-reads all of it. ` +
        'Finish only the edit in progress, write the handoff with the tokenforge handoff skill, then stop and tell the user to run /clear. ' +
        'Prompts, changed files and your last reply are already saved in .forge/snapshots/.';
  return { context: note };
}

function main() {
  const input = readStdin();
  const event = input.hook_event_name || 'PostToolUse';
  const nested = event === 'PostToolUse' ? afterTool(input) : '';
  const w = watch(input, event);
  const context = [nested, w?.context].filter(Boolean).join('\n\n');
  if (!context && !w?.systemMessage) return;
  process.stdout.write(
    JSON.stringify({
      ...(w?.systemMessage && { systemMessage: w.systemMessage }),
      ...(context && { hookSpecificOutput: { hookEventName: event, additionalContext: context } }),
    }),
  );
}

if (isMain(import.meta.url)) main();
