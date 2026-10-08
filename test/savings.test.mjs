import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readLedger, savings } from '../lib/savings.mjs';

test('savings ledger: skips bad lines, sums per window and tool, never negative', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tforge-savings-'));
  const file = path.join(dir, 'savings.jsonl');
  const now = Date.UTC(2026, 9, 7, 12) / 1000;
  const rows = [
    { t: now - 60, tool: 'check', cwd: '/r', raw: 5000, out: 200 },
    { t: now - 3 * 86400, tool: 'diff', cwd: '/r/.claude/worktrees/a', raw: 1000, out: 300 },
    { t: now - 20 * 86400, tool: 'check', cwd: '/s', raw: 100, out: 400 },
    { t: now - 40 * 86400, tool: 'web', cwd: '/s', raw: 900, out: 100 },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\nnot json\n{"tool":"x"}\n');
  const s = savings(readLedger(file), now * 1000);
  assert.equal(s.totals.all.calls, 4);
  assert.equal(s.totals.all.saved, 4800 + 700 + 0 + 800);
  assert.equal(s.totals.d30.saved, 5500);
  assert.equal(s.totals.d7.saved, 5500);
  assert.deepEqual(s.tools.map((t) => [t.tool, t.calls, t.saved]), [['check', 2, 4800], ['diff', 1, 700]]);
  assert.deepEqual(s.projects.map((p) => [p.project, p.saved]), [['/r', 5500], ['/s', 0]]);
  assert.equal(s.daily.length, 30);
  assert.equal(s.daily.reduce((a, d) => a + d.saved, 0), 5500);
  assert.deepEqual(savings(readLedger(path.join(dir, 'missing.jsonl'))).totals.all, { calls: 0, raw: 0, out: 0, saved: 0 });
  fs.rmSync(dir, { recursive: true, force: true });
});
