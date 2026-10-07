// SessionStart: inject the terse reply rule (re-injected after compaction, which drops it),
// and on startup or /clear reload .forge/HANDOFF.md so a fresh session continues where the last one stopped.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TERSE_RULES, terseLevel } from '../lib/config.mjs';
import { uiState } from '../lib/ui-control.mjs';

const MAX_AGE_H = Number(process.env.TFORGE_HANDOFF_MAX_AGE_H) || 72;
const MAX_CHARS = 8000;
const MAP_HINT =
  'Code search (tokenforge tmap): `tmap find <words>` gives ranked `path:start-end signature` lines; `tmap tree [dir|file]` gives a map or outline; ' +
  '`tmap sym|callers|callees <name>`. Use it before Grep or whole-file reads, then Read only the returned line ranges.';

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

// Start the local dashboard once per machine boot (or after it was stopped). Costs no context tokens.
function ensureDashboard() {
  if (process.env.TFORGE_UI === '0' || uiState()) return null;
  const tforge = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'tforge');
  try {
    const child = spawn(process.execPath, [tforge, 'ui', '--detach'], { detached: true, stdio: 'ignore' });
    child.unref();
    return `tokenforge dashboard starting at http://127.0.0.1:${Number(process.env.TFORGE_UI_PORT) || 7878}/ (tforge ui --status shows the exact port; TFORGE_UI=0 disables)`;
  } catch {
    return null;
  }
}

function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {}
  const notice = input.source === 'startup' ? ensureDashboard() : null;
  const parts = [];
  const level = terseLevel();
  if (level !== 'off') parts.push(TERSE_RULES[level]);
  // Opt-in: in A/B runs the hint alone never got tmap used and slightly raised token use.
  if (process.env.TFORGE_MAP === '1') parts.push(MAP_HINT);
  if (input.source !== 'compact' && input.source !== 'resume') {
    const h = handoff(input.cwd || process.cwd());
    if (h) parts.push(h);
  }
  if (!parts.length && !notice) return;
  const out = {};
  if (parts.length) out.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') };
  if (notice) out.systemMessage = notice;
  process.stdout.write(JSON.stringify(out));
}

main();
