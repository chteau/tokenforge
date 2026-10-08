#!/usr/bin/env node
// tokenforge status-line shim. Standalone on purpose: `tforge statusline --setup` copies it to
// ~/.config/tokenforge/ so it keeps working when the plugin updates and moves.
// It records rate_limits from Claude Code's status-line JSON, then runs your previous status-line command
// (passed base64-encoded, so any quoting survives) with the same input, prints its output unchanged and appends
// the savings segment ("TF -45% today (~1.2M saved)") from the installed plugin's lib/estimate.mjs.
// Usage in settings: "statusLine": {"type":"command","command":"\"/path/to/node\" \"~/.config/tokenforge/statusline.mjs\" --chain-b64 <base64>"}
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// The plugin moves on update; session-start records its current root in tokenforge's config. Never fails the line.
async function savingsSegment() {
  if (process.env.TFORGE_STATUSLINE_SEGMENT === '0') return { text: '' };
  const roots = [];
  try {
    const cfg = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'tokenforge', 'config.json');
    const r = JSON.parse(fs.readFileSync(cfg, 'utf8')).pluginRoot;
    if (r) roots.push(r);
  } catch {}
  roots.push(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  for (const r of roots) {
    const mod = path.join(r, 'lib', 'estimate.mjs');
    if (!fs.existsSync(mod)) continue;
    try {
      const m = await import(pathToFileURL(mod).href);
      let data = {};
      try {
        data = JSON.parse(input);
      } catch {}
      const ascii = m.asciiOnly();
      return { text: m.statuslineSegment(data, { ascii }), sep: ascii ? ' | ' : ' \u00b7 ' };
    } catch {}
  }
  return { text: '' };
}
const seg = await savingsSegment();
const join = (a, b) => (a && b ? a + seg.sep + b : a || b);

const at = process.argv.indexOf('--chain-b64');
const chain = at >= 0 && process.argv[at + 1] ? Buffer.from(process.argv[at + 1], 'base64').toString('utf8') : '';

if (chain) {
  const shell = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', chain]] : ['/bin/sh', ['-c', chain]];
  const r = spawnSync(shell[0], shell[1], { input, encoding: 'utf8', timeout: 10000 });
  // Append to the last line of the user's own output, which is otherwise printed unchanged.
  const out = (r.stdout || '').replace(/\s+$/, '');
  const lines = out ? out.split('\n') : [''];
  lines[lines.length - 1] = join(lines[lines.length - 1], seg.text);
  process.stdout.write(lines.join('\n'));
  process.exit(r.status ?? 0);
} else {
  const fmt = (w, label) => {
    if (!w) return null;
    const t = new Date(w.resetsAt * 1000);
    const at = w.resetsAt - Date.now() / 1000 < 86400 ? t.toTimeString().slice(0, 5) : t.toDateString().slice(4, 10);
    return `${label} ${Math.round(w.used)}% (resets ${at})`;
  };
  const limits = (rec && [fmt(rec.fiveHour, '5h'), fmt(rec.sevenDay, '7d')].filter(Boolean).join(seg.sep || ' | ')) || '';
  process.stdout.write(join(limits, seg.text) || 'tokenforge');
}
