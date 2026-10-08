import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

const REPO = 'chteau/tokenforge';

// Release asset names: tmap-<os>-<arch>[.exe]
function target() {
  const osName = { linux: 'linux', darwin: 'macos', win32: 'windows' }[process.platform];
  const arch = { x64: 'x64', arm64: 'arm64' }[process.arch];
  return osName && arch ? `${osName}-${arch}` : null;
}

async function download(dest) {
  const t = target();
  if (!t || process.env.TFORGE_NO_DOWNLOAD === '1' || typeof fetch !== 'function') return false;
  const url = `https://github.com/${REPO}/releases/download/tmap-v${tmapVersion()}/tmap-${t}${EXE}`;
  try {
    const [bin, sum] = await Promise.all([fetch(url), fetch(url + '.sha256')]);
    if (!bin.ok || !sum.ok) return false;
    const buf = Buffer.from(await bin.arrayBuffer());
    const want = (await sum.text()).trim().split(/\s+/)[0].toLowerCase();
    const got = createHash('sha256').update(buf).digest('hex');
    if (want !== got) {
      process.stderr.write(`tmap: checksum mismatch for ${url}; not installing it\n`);
      return false;
    }
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buf, { mode: 0o755 });
    fs.renameSync(tmp, dest);
    return true;
  } catch {
    return false;
  }
}

function cargoBuild(dest) {
  if (spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status !== 0) return false;
  process.stderr.write('tmap: building the native binary once with cargo (one to two minutes)...\n');
  const targetDir = path.join(path.dirname(dest), 'build');
  const r = spawnSync('cargo', ['build', '--release', '--quiet', '--manifest-path', path.join(CRATE, 'Cargo.toml')], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, CARGO_TARGET_DIR: targetDir },
  });
  const built = path.join(targetDir, 'release', `tmap${EXE}`);
  if (r.status !== 0 || !isFile(built)) return false;
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.copyFileSync(built, tmp);
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, dest);
  fs.rmSync(targetDir, { recursive: true, force: true });
  return true;
}

async function resolveBinary() {
  const found = existingBinary();
  if (found) return found;
  const dest = cachedBinary();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if ((await download(dest)) || cargoBuild(dest)) return dest;
  process.stderr.write(
    'tmap: no binary for this platform and no cargo to build one.\n' +
      'Install Rust (https://rustup.rs) and rerun, or set TMAP_BIN to a tmap binary. Until then, use Grep and Read.\n',
  );
  process.exit(127);
}

// Find or install the binary once (order: $TMAP_BIN, a local build, the cache, a checksum-verified
// release download, a cargo build), run it with `args` and exit with its status.
export async function launch(args) {
  const bin = await resolveBinary();
  const r = spawnSync(bin, args, { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
