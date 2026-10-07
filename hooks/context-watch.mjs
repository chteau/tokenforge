// Warn (once per band) when the session's context passes a threshold: every turn re-sends all of it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WARN_AT = Number(process.env.TFORGE_WARN_AT) || 80000;
const STEP = Number(process.env.TFORGE_WARN_STEP) || 40000;
const TAIL_BYTES = 512 * 1024;

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

// Context size of the newest API call, read from the end of the transcript.
export function lastContext(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (!l.includes('"usage"') || !l.includes('"assistant"')) continue;
      try {
        const u = JSON.parse(l).message?.usage;
        if (u) return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      } catch {}
    }
  } catch {
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return 0;
}

function main() {
  if (process.env.TFORGE_WATCH === '0') return;
  const input = readStdin();
  const ctx = input.transcript_path ? lastContext(input.transcript_path) : 0;
  const sid = String(input.session_id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '');
  const dir = path.join(os.tmpdir(), `tokenforge-${process.getuid?.() ?? 'u'}`);
  const stateFile = path.join(dir, `${sid}.json`);
  let band = -1;
  try {
    band = JSON.parse(fs.readFileSync(stateFile, 'utf8')).band;
  } catch {}
  const now = ctx < WARN_AT ? -1 : Math.floor((ctx - WARN_AT) / STEP);
  if (now !== band) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(stateFile, JSON.stringify({ band: now }));
    } catch {}
  }
  if (now <= band || now < 0) return;
  const k = Math.round(ctx / 1000);
  const event = input.hook_event_name || 'PostToolUse';
  process.stdout.write(
    JSON.stringify({
      systemMessage: `tokenforge: context is ~${k}k tokens; each turn re-sends all of it.`,
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext:
          `tokenforge: this session's context is ~${k}k tokens and every turn re-sends all of it. ` +
          'At the next natural stopping point (not mid-edit): write a handoff with the tokenforge handoff skill, then tell the user to run /clear; the handoff reloads automatically. ' +
          'Send remaining bulk implementation to tforge workers instead of doing it in this session.',
      },
    }),
  );
}

main();
