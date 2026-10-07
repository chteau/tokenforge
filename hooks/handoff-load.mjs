// On startup or /clear, load .forge/HANDOFF.md so a fresh session continues where the last one stopped.
import fs from 'node:fs';
import path from 'node:path';

const MAX_AGE_H = Number(process.env.TFORGE_HANDOFF_MAX_AGE_H) || 72;
const MAX_CHARS = 8000;

function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {}
  const cwd = input.cwd || process.cwd();
  const file = path.join(cwd, '.forge', 'HANDOFF.md');
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return;
  }
  const ageH = (Date.now() - st.mtimeMs) / 3.6e6;
  if (ageH > MAX_AGE_H) return;
  let body = fs.readFileSync(file, 'utf8');
  if (body.length > MAX_CHARS) body = body.slice(0, MAX_CHARS) + '\n[handoff truncated]';
  const when = new Date(st.mtimeMs).toISOString().slice(0, 16).replace('T', ' ');
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext:
          `tokenforge handoff (.forge/HANDOFF.md, written ${when}). Continue from it. ` +
          `Trust its file map and decisions; read files only when the next step needs them.\n\n${body}`,
      },
    }),
  );
}

main();
