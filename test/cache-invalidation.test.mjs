import './tmp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// What every cache in lib/caches.mjs promises: reuse only while what it depends on is unchanged (by content, not by
// size and mtime), and a torn or concurrent write never leaves a file a reader takes for valid.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-inv-'));
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'cc');
process.env.XDG_CACHE_HOME = path.join(root, 'cache');
const here = path.dirname(fileURLToPath(import.meta.url));

const { blocksOf } = await import('../lib/instructions.mjs');
const { headHash, sameHead, writeFileAtomic } = await import('../lib/util.mjs');
const { projectKey, recall } = await import('../lib/memory.mjs');
const { CACHES, cachesTable } = await import('../lib/caches.mjs');

// an edit that keeps the size and puts the mtime back: what an edit within the clock's resolution looks like
function sameStatEdit(file, text) {
  const st = fs.statSync(file);
  assert.equal(Buffer.byteLength(text), st.size);
  fs.writeFileSync(file, text);
  fs.utimesSync(file, st.atime, st.mtime);
}

test('instruction blocks: an edit with the same size and mtime is seen; rename and deletion too', () => {
  const dir = fs.mkdtempSync(path.join(root, 'instr-'));
  const f = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(f, '# Rules\n\nUse tabs.\n');
  assert.match(blocksOf(f).join('\n'), /Use tabs/);
  sameStatEdit(f, '# Rules\n\nUse bars.\n');
  assert.match(blocksOf(f).join('\n'), /Use bars/, 'a cache keyed by size and mtime would return "Use tabs"');
  const g = path.join(dir, 'CLAUDE.md');
  fs.renameSync(f, g);
  assert.deepEqual(blocksOf(f), []);
  assert.match(blocksOf(g).join('\n'), /Use bars/);
  fs.rmSync(g);
  assert.deepEqual(blocksOf(g), []);
});

test('instruction blocks: a torn cache entry is ignored and rewritten', () => {
  const dir = fs.mkdtempSync(path.join(root, 'instr-'));
  const f = path.join(dir, 'AGENTS.md');
  fs.writeFileSync(f, '# Build\n\nRun make.\n');
  blocksOf(f);
  const cacheDir = path.join(process.env.XDG_CACHE_HOME, 'tokenforge', 'instr');
  for (const c of fs.readdirSync(cacheDir)) fs.writeFileSync(path.join(cacheDir, c), '["half');
  assert.match(blocksOf(f).join('\n'), /Run make/);
  assert.ok(fs.readdirSync(cacheDir).every((c) => c.endsWith('.json')), 'no stray temp files');
});

test('headHash: an appended transcript keeps its head, a replaced one does not, even at the same size', () => {
  const f = path.join(root, 'h.jsonl');
  fs.writeFileSync(f, '{"a":1}\n');
  const small = headHash(f);
  fs.appendFileSync(f, '{"b":2}\n'.repeat(1000));
  assert.ok(sameHead(f, small), 'a file under 4 KB that grew is still the same file');
  const big = headHash(f);
  fs.appendFileSync(f, '{"c":3}\n');
  assert.ok(sameHead(f, big));
  sameStatEdit(f, fs.readFileSync(f, 'utf8').replace('{"a":1}', '{"z":9}'));
  assert.ok(!sameHead(f, big));
  assert.ok(sameHead(f, null), 'an entry from before heads were stored is kept');
});

test('memory index: a transcript replaced at the same size is scanned again', () => {
  const proj = fs.mkdtempSync(path.join(root, 'proj-'));
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', projectKey(proj));
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 's1.jsonl');
  const line = (t) => JSON.stringify({ type: 'user', timestamp: '2026-10-01T10:00:00Z', message: { role: 'user', content: t } }) + '\n';
  fs.writeFileSync(f, line('add the budget command'));
  const hits = (q) => recall(proj, q).sessions.length;
  assert.equal(hits('budget'), 1);
  sameStatEdit(f, line('add the ledger command'));
  assert.equal(hits('budget'), 0, 'an index trusting size alone keeps the old prompt');
  assert.equal(hits('ledger'), 1);
});

test('writeFileAtomic: concurrent writers never leave a torn file, and a failed write leaves the old one', async () => {
  const f = path.join(root, 'shared.json');
  const util = path.join(here, '..', 'lib', 'util.mjs');
  const writer = (n) => `import { writeFileAtomic } from ${JSON.stringify(util)};
for (let i = 0; i < 40; i++) writeFileAtomic(${JSON.stringify(f)}, JSON.stringify({ n: ${n}, i, pad: 'x'.repeat(200000) }));`;
  const procs = Array.from({ length: 6 }, (_, n) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', writer(n)], { stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${n} exited ${code}`))));
  }));
  let reads = 0;
  const done = Promise.all(procs);
  let finished = false;
  done.then(() => (finished = true), () => (finished = true));
  while (!finished) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      assert.equal(j.pad.length, 200000);
      reads++;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await new Promise((r) => setImmediate(r));
  }
  await done;
  assert.ok(reads > 0);
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('shared.json.')), [], 'no temp files left');

  // a write that fails halfway (here: the target is a directory) keeps the old content and removes its temp file
  const d = path.join(root, 'dir-target');
  fs.mkdirSync(d);
  assert.throws(() => writeFileAtomic(d, 'new'));
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('dir-target.')), []);
});

test('caches: every cache declares its kind and what it depends on, and tforge caches lists them', () => {
  assert.ok(CACHES.length >= 8);
  for (const c of CACHES) {
    assert.ok(['computation', 'memory', 'provider'].includes(c.kind), c.name);
    assert.ok(c.dependsOn.length && c.check && c.where, c.name);
  }
  const t = cachesTable();
  for (const c of CACHES) assert.ok(t.includes(c.name), c.name);
  assert.ok(t.indexOf('computation:') < t.indexOf('memory:') && t.indexOf('memory:') < t.indexOf('provider:'));
});
