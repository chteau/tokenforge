#!/usr/bin/env node
// tokenforge status-line shim. Standalone on purpose: `tforge statusline --setup` copies it to
// ~/.config/tokenforge/ so it keeps working when the plugin updates and moves.
// It records rate_limits from Claude Code's status-line JSON, then runs your previous status-line command
// (passed base64-encoded, so any quoting survives) with the same input and prints its output unchanged.
// Usage in settings: "statusLine": {"type":"command","command":"node ~/.config/tokenforge/statusline.mjs --chain-b64 <base64>"}
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const input = (() => {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
})();

const cacheDir = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'tokenforge');

const pick = (w) => (w && typeof w.used_percentage === 'number' ? { used: w.used_percentage, resetsAt: w.resets_at } : null);

let rec = null;
try {
  const rl = JSON.parse(input).rate_limits;
  if (rl) {
    rec = { at: Date.now(), fiveHour: pick(rl.five_hour), sevenDay: pick(rl.seven_day), spend: pick(rl.spend_limit) };
    if (rec.fiveHour || rec.sevenDay || rec.spend) {
      fs.mkdirSync(cacheDir, { recursive: true });
      const file = path.join(cacheDir, 'limits.json');
      let prev = null;
      try {
        prev = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {}
      fs.writeFileSync(file, JSON.stringify(rec));
      const key = (r) => JSON.stringify([r.fiveHour, r.sevenDay, r.spend]);
      if (!prev || key(prev) !== key(rec)) {
        const hist = path.join(cacheDir, 'limits-history.jsonl');
        try {
          if (fs.statSync(hist).size > 2 << 20) {
            const lines = fs.readFileSync(hist, 'utf8').trim().split('\n');
            fs.writeFileSync(hist, lines.slice(-Math.floor(lines.length / 2)).join('\n') + '\n');
          }
        } catch {}
        fs.appendFileSync(hist, JSON.stringify(rec) + '\n');
      }
    } else rec = null;
  }
} catch {}

const at = process.argv.indexOf('--chain-b64');
const chain = at >= 0 && process.argv[at + 1] ? Buffer.from(process.argv[at + 1], 'base64').toString('utf8') : '';

if (chain) {
  const shell = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', chain]] : ['/bin/sh', ['-c', chain]];
  const r = spawnSync(shell[0], shell[1], { input, encoding: 'utf8', timeout: 10000 });
  process.stdout.write(r.stdout || '');
  process.exit(r.status ?? 0);
} else {
  const fmt = (w, label) => {
    if (!w) return null;
    const t = new Date(w.resetsAt * 1000);
    const at = w.resetsAt - Date.now() / 1000 < 86400 ? t.toTimeString().slice(0, 5) : t.toDateString().slice(4, 10);
    return `${label} ${Math.round(w.used)}% (resets ${at})`;
  };
  process.stdout.write((rec && [fmt(rec.fiveHour, '5h'), fmt(rec.sevenDay, '7d')].filter(Boolean).join(' · ')) || 'tokenforge');
}
