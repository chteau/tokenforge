import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { JsonlStore } from '../src/index.ts';

test('memory store keeps latest version per id', () => {
  const s = new JsonlStore(':memory:');
  s.append('things', { id: 'a', v: 1 });
  s.append('things', { id: 'a', v: 2 });
  s.append('things', { id: 'b', v: 1 });
  assert.equal(s.all('things').length, 2);
  assert.equal(s.find<{ id: string; v: number }>('things', 'a')?.v, 2);
});

test('file store appends json lines and compacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kf-store-'));
  try {
    const s = new JsonlStore(dir);
    s.append('quotes', { id: 'q1', total: 1 });
    s.replace('quotes', { id: 'q1', total: 2 });
    assert.equal(readFileSync(join(dir, 'quotes.jsonl'), 'utf8').trim().split('\n').length, 2);
    assert.equal(s.compact('quotes'), 1);
    assert.equal(readFileSync(join(dir, 'quotes.jsonl'), 'utf8').trim().split('\n').length, 1);
    assert.throws(() => s.append('../evil', { id: 'x' }), /invalid collection/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
