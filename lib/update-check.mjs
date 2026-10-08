// "Update available" for the startup banner. The check runs at most once a day in a detached process, so session
// start never waits on the network; the banner reads the last result. Off: TFORGE_UPDATE_CHECK=0.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cacheBase } from './usage.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = process.env.TFORGE_UPDATE_URL || 'https://raw.githubusercontent.com/chteau/tokenforge/master/.claude-plugin/plugin.json';
const DAY = 24 * 3600e3;
const file = () => path.join(cacheBase(), 'update.json');
export const currentVersion = () => JSON.parse(fs.readFileSync(path.join(HERE, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version;

// 1 when a > b, -1 when a < b, 0 otherwise (numeric x.y.z; anything else compares equal).
export function cmpVersion(a, b) {
  const p = (v) => String(v || '').split('.').map((x) => parseInt(x, 10));
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) {
    if (!(x[i] >= 0) || !(y[i] >= 0)) return 0;
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return {};
  }
}

// Banner line when a newer version was seen, else null. Starts a background refresh when the last check is a day old.
export function updateNotice() {
  if (process.env.TFORGE_UPDATE_CHECK === '0') return null;
  const c = readCache();
  if (!(Date.now() - (c.checked || 0) < DAY)) {
    try {
      spawn(process.execPath, [fileURLToPath(import.meta.url), '--fetch'], { detached: true, stdio: 'ignore' }).unref();
    } catch {}
  }
  let cur;
  try {
    cur = currentVersion();
  } catch {
    return null;
  }
  if (cmpVersion(c.latest, cur) <= 0) return null;
  return `TokenForge ${c.latest} is available (you have ${cur}): run /plugin marketplace update tokenforge, then start a new session. ` +
    'To update automatically: /plugin → Marketplaces → tokenforge → Enable auto-update.';
}

async function fetchLatest() {
  const out = { checked: Date.now(), latest: readCache().latest || null };
  try {
    const r = await fetch(SOURCE, { signal: AbortSignal.timeout(5000) });
    if (r.ok) out.latest = (await r.json()).version || out.latest;
  } catch {}
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(out) + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv[2] === '--fetch') await fetchLatest();
