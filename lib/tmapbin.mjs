import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CRATE = path.join(ROOT, 'native', 'tmap');
export const EXE = process.platform === 'win32' ? '.exe' : '';

export const tmapVersion = () => /^version\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(CRATE, 'Cargo.toml'), 'utf8'))[1];

export function cacheDir() {
  const base = process.env.XDG_CACHE_HOME || (process.platform === 'win32' ? process.env.LOCALAPPDATA : null) || path.join(os.homedir(), '.cache');
  return path.join(base, 'tokenforge', 'bin');
}

export const cachedBinary = () => path.join(cacheDir(), `tmap-${tmapVersion()}${EXE}`);

export function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// A tmap binary that is already present; never downloads or builds (hooks must stay fast).
export function existingBinary() {
  if (process.env.TMAP_BIN) return process.env.TMAP_BIN;
  const local = path.join(CRATE, 'target', 'release', `tmap${EXE}`);
  if (isFile(local)) return local;
  const cached = cachedBinary();
  return isFile(cached) ? cached : null;
}
