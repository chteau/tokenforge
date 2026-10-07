// SessionStart: inject the terse reply rule (re-injected after compaction, which drops it),
// and on startup or /clear reload .forge/HANDOFF.md so a fresh session continues where the last one stopped.
import fs from 'node:fs';
import path from 'node:path';
import { TERSE_RULES, terseLevel } from '../lib/config.mjs';

const MAX_AGE_H = Number(process.env.TFORGE_HANDOFF_MAX_AGE_H) || 72;
const MAX_CHARS = 8000;

function handoff(cwd) {
  const file = path.join(cwd, '.forge', 'HANDOFF.md');
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if ((Date.now() - st.mtimeMs) / 3.6e6 > MAX_AGE_H) return null;
  let body = fs.readFileSync(file, 'utf8');
  if (body.length > MAX_CHARS) body = body.slice(0, MAX_CHARS) + '\n[handoff truncated]';
  const when = new Date(st.mtimeMs).toISOString().slice(0, 16).replace('T', ' ');
  return (
    `tokenforge handoff (.forge/HANDOFF.md, written ${when}). Continue from it. ` +
    `Trust its file map and decisions; read files only when the next step needs them.\n\n${body}`
  );
}

function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {}
  const parts = [];
  const level = terseLevel();
  if (level !== 'off') parts.push(TERSE_RULES[level]);
  if (input.source !== 'compact' && input.source !== 'resume') {
    const h = handoff(input.cwd || process.cwd());
    if (h) parts.push(h);
  }
  if (!parts.length) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') } }));
}

main();
