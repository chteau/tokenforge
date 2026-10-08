// Context budget. Every API call re-reads the whole context from the cache, so cache reads grow with
// calls x context size. Past the budget the user sees a non-blocking alert, and .forge/HANDOFF.md is written
// automatically from this session's snapshots (no model call), so /clear at any moment loses nothing: the next
// session reloads it. Prompts are never held. A handoff the user wrote (/tokenforge:handoff) is never overwritten.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SNAP_DIR, listSnapshots, parseSnapshot } from './checkpoint.mjs';
import { isMain } from '../lib/hookutil.mjs';

const BUDGET = Number(process.env.TFORGE_BUDGET) || 50000;
// The fixed part (system prompt, tools, skills, hook text) can be most of the budget on its own.
// Always leave this much room above it for actual work.
const FLOOR = Number(process.env.TFORGE_BUDGET_FLOOR) || 15000;
const SOFT_MARGIN = 10000;
const STEP = 10000;
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

const AUTO_MARK = '<!-- tforge auto-handoff -->';
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
  const last = snaps[snaps.length - 1];
  const reply = (/## Last reply\n([\s\S]*)$/.exec(last)?.[1] || '').trim().slice(0, 1500);
  const when = new Date(now).toISOString().slice(0, 16).replace('T', ' ');
  const out = [
    AUTO_MARK,
    `# Handoff (automatic, ${when} UTC, context ~${Math.round(ctx / 1000)}k tokens)`,
    'Written by tokenforge from the session transcript; /tokenforge:handoff writes one with decisions and next steps.',
    'Continue from the last request. Read files only when the next step needs them.',
  ];
  if (reqs.length) out.push('', '## Recent requests (oldest first)', ...reqs);
  if (files.length) out.push('', '## Files changed', ...files);
  if (reply) out.push('', '## Last reply', reply);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, out.join('\n') + '\n');
    return true;
  } catch {
    return false;
  }
}

function main() {
  if (process.env.TFORGE_WATCH === '0') return;
  const input = readStdin();
  if (!input.transcript_path) return;
  const ctx = lastContext(input.transcript_path);
  if (!ctx) return;
  const sid = String(input.session_id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '');
  const dir = path.join(os.tmpdir(), `tokenforge-${process.getuid?.() ?? 'u'}`);
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
  const band = ctx < soft ? -1 : ctx < limit ? 0 : 1 + Math.floor((ctx - limit) / STEP);
  const event = input.hook_event_name || 'PostToolUse';
  const k = (n) => `${Math.round(n / 1000)}k`;

  if (event === 'UserPromptSubmit') {
    if (band < 1) return;
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (prompt.startsWith('/')) return;
    const saved = autoHandoff(input.cwd, input.session_id, ctx);
    if (state.alerted === band) return; // one alert per 10k step
    state.alerted = band;
    save();
    process.stdout.write(
      JSON.stringify({
        systemMessage:
          `TokenForge: context is ~${k(ctx)} tokens (budget ${k(limit)}); every call re-reads all of it. ` +
          (saved ? 'Handoff saved automatically (.forge/HANDOFF.md). ' : '') +
          'Type /clear when it suits you: the next message continues from it. Your message was sent normally.',
      }),
    );
    return;
  }

  const prev = state.band ?? -1;
  if (band === prev) return;
  state.band = band;
  save();
  if (band < prev) return; // context shrank (compaction): re-arm, stay silent
  const note =
    band === 0
      ? `tokenforge: context is ~${k(ctx)} tokens, near the ${k(limit)} budget. Finish the current step, avoid large reads, ` +
        'batch remaining lookups into one turn, and send bulk implementation to tforge workers.'
      : `tokenforge: context is ~${k(ctx)} tokens, over the ${k(limit)} budget; every further call re-reads all of it. ` +
        'Finish only the edit in progress, write the handoff with the tokenforge handoff skill, then stop and tell the user to run /clear. ' +
        'Prompts, changed files and your last reply are already saved in .forge/snapshots/.';
  process.stdout.write(
    JSON.stringify({
      systemMessage: `tokenforge: context ~${k(ctx)} / budget ${k(limit)}.`,
      // The note goes into the model's context only on request: every injected line is re-read on every
      // later call, and "stop and /clear" ends unattended tasks halfway. Default: shown to the user only.
      ...(process.env.TFORGE_WATCH_INJECT === '1' ? { hookSpecificOutput: { hookEventName: event, additionalContext: note } } : {}),
    }),
  );
}

if (isMain(import.meta.url)) main();
