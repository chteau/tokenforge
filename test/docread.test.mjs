import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, '..', 'hooks', 'kit-router.mjs');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('Read of a big notebook gets its cells with trimmed outputs and no images', () => {
  const dir = tmp('tforge-nb-');
  const nb = path.join(dir, 'analysis.ipynb');
  const png = 'iVBORw0KGgo'.repeat(4000);
  fs.writeFileSync(nb, JSON.stringify({
    metadata: { kernelspec: { language: 'python' } },
    cells: [
      { cell_type: 'markdown', source: ['# Results\n', 'Effect of dose'] },
      { cell_type: 'code', source: ['import pandas as pd\n', 'df = pd.read_csv("d.csv")\n', 'df.plot()'], outputs: [
        { output_type: 'stream', name: 'stdout', text: Array.from({ length: 200 }, (_, i) => `row ${i}\n`) },
        { output_type: 'display_data', data: { 'image/png': png, 'text/plain': ['<Figure size 640x480>'] } },
      ] },
      { cell_type: 'code', source: '1/0', outputs: [{ output_type: 'error', ename: 'ZeroDivisionError', evalue: 'division by zero', traceback: ['\x1b[0;31mTraceback\x1b[0m', 'line 1', 'ZeroDivisionError: division by zero'] }] },
    ],
  }));
  const env = { ...process.env, XDG_CACHE_HOME: dir };
  const r = spawnSync('node', [HOOK], { input: JSON.stringify({ tool_name: 'Read', session_id: 's' + Date.now(), tool_input: { file_path: nb } }), encoding: 'utf8', env });
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'allow');
  const text = fs.readFileSync(out.updatedInput.file_path, 'utf8');
  assert.match(text, /# %% \[code\] cell 2\nimport pandas as pd/);
  assert.match(text, /row 19\n… output trimmed \(201 lines\)/);
  assert.match(text, /\[image\/png output omitted, \d+ KB\]/);
  assert.match(text, /error: ZeroDivisionError: division by zero/);
  assert.doesNotMatch(text, /iVBORw0KGgo/);
  assert.ok(text.length < fs.statSync(nb).size / 5, 'much smaller than the raw notebook');
  // offset/limit (raw JSON wanted), small notebooks and the switch keep the original
  assert.equal(spawnSync('node', [HOOK], { input: JSON.stringify({ tool_name: 'Read', session_id: 's2', tool_input: { file_path: nb, offset: 1, limit: 50 } }), encoding: 'utf8', env }).stdout, '');
  assert.equal(spawnSync('node', [HOOK], { input: JSON.stringify({ tool_name: 'Read', session_id: 's3', tool_input: { file_path: nb } }), encoding: 'utf8', env: { ...env, TFORGE_DOCREAD: '0' } }).stdout, '');
});

test('opt-in (TFORGE_DOCREAD_PDF=1): Read of a text PDF gets its extracted text; off by default; a scanned PDF and a page request keep the original', async () => {
  const { existingBinary } = await import('../lib/tmapbin.mjs');
  if (!existingBinary()) return; // tmap not built here
  const fx = path.join(HERE, '..', 'native', 'tmap', 'tests', 'fixtures');
  const dir = tmp('tforge-pdf-');
  const env = { ...process.env, XDG_CACHE_HOME: dir, TFORGE_DOCREAD_PDF: '1' };
  const read = (ti, e = {}) => spawnSync('node', [HOOK], { input: JSON.stringify({ tool_name: 'Read', session_id: 's' + Math.random(), tool_input: ti }), encoding: 'utf8', env: { ...env, ...e } }).stdout;
  const out = JSON.parse(read({ file_path: path.join(fx, 'paper.pdf') })).hookSpecificOutput;
  const text = fs.readFileSync(out.updatedInput.file_path, 'utf8');
  assert.match(text, /^\[tokenforge: text of .*paper\.pdf, 3 pages/);
  assert.match(text, /--- page 2 ---/);
  assert.equal(read({ file_path: path.join(fx, 'scanned.pdf') }), '', 'scanned: Claude sees the page images');
  assert.equal(read({ file_path: path.join(fx, 'paper.pdf'), pages: '2' }), '', 'a page request means the figure is wanted');
  assert.equal(read({ file_path: path.join(fx, 'paper.pdf') }, { TFORGE_DOCREAD_PDF: '' }), '', 'off by default');
});

test('raw LaTeX builds become the compact check; engine switches stay raw', async () => {
  const { rewrite } = await import('../hooks/kit-router.mjs');
  assert.equal(rewrite(['pdflatex', 'main.tex']), 'tkit check -l latex');
  assert.equal(rewrite(['latexmk', '-pdf', '-interaction=nonstopmode', 'main.tex']), 'tkit check -l latex');
  assert.equal(rewrite(['latexmk', '-xelatex', 'main.tex']), null);
  assert.equal(rewrite(['xelatex', 'main.tex']), null);
});
