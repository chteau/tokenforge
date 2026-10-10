// The installed tokenforge's version and plugin build hash, as the benchmark records them per run.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentVersion } from './update-check.mjs';

export { currentVersion };

export const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// bench/runner/isolation.py copies the plugin without these (at any depth), then hashes the copy
const SKIP = new Set(['target', '.git', 'node_modules', '.forge', 'bench']);

function files(dir, rel, out) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const abs = path.join(dir, name);
    let st;
    try { st = fs.statSync(abs); } catch { continue; } // dangling link
    const r = [...rel, name];
    if (st.isDirectory()) files(abs, r, out);
    else if (st.isFile()) out.push(r);
  }
  return out;
}

// Same value as isolation.sha256_dir() of the benchmark's plugin copy (`plugin_sha256` in run manifests):
// sha256 over every file, in path order, of its relative path then its bytes.
export function pluginBuildHash(dir = PLUGIN_DIR) {
  const list = files(dir, [], []);
  list.sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length - b.length;
  });
  const h = createHash('sha256');
  for (const parts of list) {
    h.update(parts.join('/'));
    h.update(fs.readFileSync(path.join(dir, ...parts)));
  }
  return h.digest('hex');
}
