// Real subscription limits come only from Claude Code's status-line payload (rate_limits.five_hour / seven_day).
// bin/statusline-shim.mjs records them (the dashboard reads them here) and appends the savings segment.
// The shim is set as the statusLine once automatically when there is none (session-start), or by
// `tforge statusline --setup`, which wraps an existing one; `--remove` restores exactly what was there.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig, writeConfig } from './config.mjs';
import { readSettings, settingsFile, writeSettings } from './lean.mjs';
import { cacheBase } from './usage.mjs';

export const limitsFile = () => path.join(cacheBase(), 'limits.json');
const historyFile = () => path.join(cacheBase(), 'limits-history.jsonl');
export const shimPath = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'tokenforge', 'statusline.mjs');

export const bundledShim = () => new URL('../bin/statusline-shim.mjs', import.meta.url);

export function setupShim(source = bundledShim()) {
  fs.mkdirSync(path.dirname(shimPath()), { recursive: true });
  fs.copyFileSync(source, shimPath());
  fs.chmodSync(shimPath(), 0o755);
  return shimPath();
}

// Keep an installed copy in step with the plugin (the copy outlives plugin updates). Returns true if it was refreshed.
export function refreshShim(source = bundledShim()) {
  try {
    const want = fs.readFileSync(source);
    if (!fs.existsSync(shimPath()) || want.equals(fs.readFileSync(shimPath()))) return false;
    setupShim(source);
    return true;
  } catch {
    return false;
  }
}

// Double-quoted for both cmd.exe and sh. On Windows, forward slashes: node and cmd accept them, and sh would turn a
// UNC "\\server" into "\server". Only the base64 alphabet follows --chain-b64, so no shell syntax at all.
const quote = (p, platform) => `"${platform === 'win32' ? p.replace(/\\/g, '/') : p}"`;
export function statuslineCommand(previous, { node = process.execPath, shim = shimPath(), platform = process.platform } = {}) {
  return `${quote(node, platform)} ${quote(shim, platform)}${previous ? ` --chain-b64 ${Buffer.from(previous, 'utf8').toString('base64')}` : ''}`;
}

// The statusLine value for settings; `previous` is the user's current status-line command, if any.
export function statuslineSnippet(previous) {
  return JSON.stringify({ statusLine: { type: 'command', command: statuslineCommand(previous) } }, null, 2);
}

const isOurs = (sl) => !!sl && typeof sl.command === 'string' && sl.command.includes(path.basename(path.dirname(shimPath()))) && sl.command.includes('statusline.mjs');

// Set our shim as the statusLine, wrapping the user's command if there is one. Records the exact previous value.
export function installStatusline(file = settingsFile()) {
  const s = readSettings(file);
  if (isOurs(s.statusLine)) return { already: true };
  setupShim();
  const previous = s.statusLine === undefined ? null : s.statusLine;
  const next = { ...(previous || {}), type: 'command', command: statuslineCommand(previous?.type === 'command' ? previous.command : null) };
  s.statusLine = next;
  writeSettings(file, s);
  writeConfig({ statusline: { previous, installed: next }, statuslineOffered: true, pluginRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), '..') });
  return { wrapped: !!previous?.command, installed: next };
}

// Put back exactly what installStatusline replaced, if the entry is still ours.
export function removeStatusline(file = settingsFile()) {
  const rec = readConfig().statusline;
  const s = readSettings(file);
  if (!isOurs(s.statusLine)) return { removed: false, reason: s.statusLine ? 'the statusLine is not ours; left as is' : 'no statusLine set' };
  // No record (set up by hand from an older snippet): the wrapped command is in the entry itself.
  const chain = /--chain-b64 (\S+)/.exec(s.statusLine.command)?.[1];
  const previous = rec ? rec.previous : chain ? { type: 'command', command: Buffer.from(chain, 'base64').toString('utf8') } : null;
  if (previous) s.statusLine = previous;
  else delete s.statusLine;
  writeSettings(file, s);
  writeConfig({ statusline: null, statuslineOffered: true });
  return { removed: true, restored: previous };
}

// Session start, once: add the shim when there is no statusLine; when the user has one, only offer (never replace).
// Also repoints our own entry at the current node when the recorded one is gone (e.g. after a node upgrade).
// Returns a one-line notice or null. Off: TFORGE_STATUSLINE=0.
export function autoStatusline(file = settingsFile()) {
  if (process.env.TFORGE_STATUSLINE === '0') return null;
  const cfg = readConfig();
  const s = readSettings(file);
  if (isOurs(s.statusLine)) {
    refreshShim();
    const node = /^"([^"]+)"/.exec(s.statusLine.command)?.[1];
    if (node && !fs.existsSync(node)) {
      const chain = /--chain-b64 (\S+)/.exec(s.statusLine.command)?.[1];
      s.statusLine = { ...s.statusLine, command: statuslineCommand(chain ? Buffer.from(chain, 'base64').toString('utf8') : null) };
      writeSettings(file, s);
      if (cfg.statusline) writeConfig({ statusline: { ...cfg.statusline, installed: s.statusLine } });
    }
    if (!cfg.statuslineOffered) writeConfig({ statuslineOffered: true });
    return null;
  }
  if (cfg.statuslineOffered) return null;
  if (s.statusLine) {
    writeConfig({ statuslineOffered: true });
    return 'TokenForge: to see your savings next to your status line, run tforge statusline --setup (it keeps yours and appends the savings).';
  }
  installStatusline(file);
  return 'TokenForge: added a status line showing your savings; tforge statusline --remove undoes it';
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


