// Start/stop/locate the dashboard server. State lives in ~/.cache/tokenforge/ui.json ({ pid, port }).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheBase } from './usage.mjs';

const stateFile = () => path.join(cacheBase(), 'ui.json');
const TFORGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'tforge');

export function uiState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    process.kill(s.pid, 0);
    return s;
  } catch {
    return null;
  }
}

export function uiStop() {
  const s = uiState();
  if (!s) return false;
  try {
    process.kill(s.pid);
  } catch {}
  fs.rmSync(stateFile(), { force: true });
  return true;
}

// foreground: record this process as the server. detach: spawn a background server and wait for it to report its port.
export async function uiStart({ port, foreground, detach } = {}) {
  fs.mkdirSync(cacheBase(), { recursive: true });
  if (foreground) {
    fs.writeFileSync(stateFile(), JSON.stringify({ pid: process.pid, port }));
    const clear = () => {
      try {
        const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
        if (s.pid === process.pid) fs.rmSync(stateFile(), { force: true });
      } catch {}
    };
    process.on('exit', clear);
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
    return { port };
  }
  if (detach) {
    const log = fs.openSync(path.join(cacheBase(), 'ui.log'), 'a');
    const args = [TFORGE, 'ui'];
    if (port) args.push('--port', String(port));
    const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log] });
    child.unref();
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const s = uiState();
      if (s && s.pid === child.pid) return s;
    }
    return null;
  }
  return null;
}
