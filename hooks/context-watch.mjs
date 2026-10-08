// Context budget. Every API call re-reads the whole context from the cache, so cache reads grow with
// calls x context size. Past the soft limit Claude is told to wrap up; past the budget it is told to stop
// and hand off, and a new user prompt is held once with a /clear suggestion (sending it again goes through).
// .forge/snapshots/ (hooks/checkpoint.mjs) is kept current after every reply, so /clear loses nothing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

  if (event === 'UserPromptSubmit' && band >= 1) {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    const hash = crypto.createHash('sha1').update(prompt).digest('hex');
    if (prompt.startsWith('/') || state.held === hash) {
      // Slash commands (the handoff) and a re-sent prompt go through.
      delete state.held;
      save();
    } else {
      state.held = hash;
      save();
      process.stdout.write(
        JSON.stringify({
          decision: 'block',
          reason:
            `tokenforge: context is ~${k(ctx)} tokens (budget ${k(limit)}); every call re-reads all of it from the cache. ` +
            'Run /tokenforge:handoff, then /clear: the handoff and the newest .forge/snapshots/ reload automatically. ' +
            'Send the same message again to continue in this session anyway.',
        }),
      );
      return;
    }
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

main();
