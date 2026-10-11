// Start/stop/locate the local servers (`tforge ui`, `tforge proxy`). State lives in ~/.cache/tokenforge/<name>.json ({ pid, port }).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheBase } from './usage.mjs';

const stateFile = (name) => path.join(cacheBase(), `${name}.json`);
const TFORGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'tforge');

export function daemonState(name) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(name), 'utf8'));
    process.kill(s.pid, 0);
    return s;
  } catch {
    return null;
  }
}

export function daemonStop(name) {
  const s = daemonState(name);
  if (!s) return false;
  try {
    process.kill(s.pid);
  } catch {}
  fs.rmSync(stateFile(name), { force: true });
  return true;
}

// foreground: record this process as the server. detach: spawn a background server and wait for it to report its port.
export async function daemonStart(name, { port, foreground, detach, env } = {}) {
  fs.mkdirSync(cacheBase(), { recursive: true });
  if (foreground) {
    fs.writeFileSync(stateFile(name), JSON.stringify({ pid: process.pid, port }));
    const clear = () => {
      try {
        const s = JSON.parse(fs.readFileSync(stateFile(name), 'utf8'));
        if (s.pid === process.pid) fs.rmSync(stateFile(name), { force: true });
      } catch {}
    };
    process.on('exit', clear);
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
    return { port };
  }
  if (detach) {
    const log = fs.openSync(path.join(cacheBase(), `${name}.log`), 'a');
    const args = [TFORGE, name];
    if (port) args.push('--port', String(port));
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], env: env || process.env, windowsHide: true });
    child.unref();
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const s = daemonState(name);
      if (s && s.pid === child.pid) return s;
    }
    return null;
  }
  return null;
}

export const uiState = () => daemonState('ui');
export const uiStop = () => daemonStop('ui');
export const uiStart = (opts) => daemonStart('ui', opts);
