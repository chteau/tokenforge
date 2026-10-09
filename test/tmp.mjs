// Imported first by every test file: temp files go to one directory removed on exit, and nothing a test starts runs
// the real gc (it sweeps this machine's Claude Code scratch).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tforge-test-'));
process.env.TMPDIR = process.env.TEMP = process.env.TMP = dir;
process.env.TFORGE_GC = '0';
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
