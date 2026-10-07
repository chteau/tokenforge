// Real subscription limits come only from Claude Code's status-line payload (rate_limits.five_hour / seven_day).
// bin/statusline-shim.mjs records them; the dashboard reads them here. tokenforge never edits Claude Code settings:
// `tforge statusline --setup` installs the shim and prints the snippet for the user to add.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cacheBase } from './usage.mjs';

export const limitsFile = () => path.join(cacheBase(), 'limits.json');
const historyFile = () => path.join(cacheBase(), 'limits-history.jsonl');
export const shimPath = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'tokenforge', 'statusline.mjs');

export function setupShim(source) {
  fs.mkdirSync(path.dirname(shimPath()), { recursive: true });
  fs.copyFileSync(source, shimPath());
  fs.chmodSync(shimPath(), 0o755);
  return shimPath();
}

// The statusLine value to paste into settings; `previous` is the user's current status-line command, if any.
export function statuslineSnippet(previous) {
  const command = `node "${shimPath()}"${previous ? ` --chain-b64 ${Buffer.from(previous, 'utf8').toString('base64')}` : ''}`;
  return JSON.stringify({ statusLine: { type: 'command', command } }, null, 2);
}

export function readLimits() {
  let current = null;
  const history = [];
  try {
    current = JSON.parse(fs.readFileSync(limitsFile(), 'utf8'));
  } catch {}
  try {
    for (const l of fs.readFileSync(historyFile(), 'utf8').split('\n')) if (l) history.push(JSON.parse(l));
  } catch {}
  return { current, history: history.filter((h) => h.at > Date.now() - 8 * 86400e3) };
}


