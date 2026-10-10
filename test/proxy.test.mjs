import './tmp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-'));
const { cacheBreak, capText, cleanText, compressResult, crushJson, foldRead, formatReport, matchSummary, openMemo, proxyReport, requestShape, startProxy, transformRequest } = await import('../lib/proxy.mjs');

const numbered = (text) => text.split('\n').map((l, i) => `${i + 1}\t${l}`).join('\n');
const bigSource = () => {
  const fns = [];
  for (let f = 0; f < 30; f++) {
    fns.push(`function f${f}(a, b) {`);
    for (let k = 0; k < 15; k++) fns.push(`  const v${k} = a * ${k} + b; // line of body number ${k} in f${f}`);
    fns.push('  return a;', '}', '');
  }
  return fns.join('\n');
};
const bashResult = () => ['\x1b[32mstart\x1b[0m', ...Array(400).fill('polling...'), ...Array.from({ length: 2000 }, (_, i) => `line ${i} of build output`), 'FAILED: test x'].join('\n');

test('cleanText strips colors, keeps the last state of \\r progress lines, counts repeats', () => {
  const out = cleanText('\x1b[1mbold\x1b[0m\n10%\r50%\r100%\nsame\nsame\nsame\nsame\nend');
  assert.equal(out, 'bold\n100%\nsame\n[previous line repeated 3 more times]\nend');
});

test('capText keeps head and tail and points to the full text', () => {
  const text = Array.from({ length: 1000 }, (_, i) => `row ${i}`).join('\n');
  let saved;
  const out = capText(text, 2000, (t) => ((saved = t), '/x/full.txt'));
  assert.ok(out.length < 2200);
  assert.match(out, /^row 0\n/);
  assert.match(out, /row 999$/);
  assert.match(out, /lines \(\d+ chars\) omitted; full output: \/x\/full\.txt/);
  assert.equal(saved, text);
  assert.equal(capText('short', 2000, () => 'f'), 'short');
});

test('a capped search result starts with its match counts per file, or per folder for a path list', () => {
  const grep = [];
  for (let i = 0; i < 300; i++) grep.push(`src/a.js:${i + 1}:  call(x)`);
  for (let i = 0; i < 40; i++) grep.push(`lib/b.mjs:${i + 1}:call(y)`);
  grep.push('test/c.test.mjs:7:call(z)');
  const out = capText(grep.join('\n'), 2000, () => '/f');
  assert.match(out, /^\[all 341 lines, by file: src\/a\.js 300, lib\/b\.mjs 40, test\/c\.test\.mjs 1\]\nsrc\/a\.js:1:/);
  const paths = Array.from({ length: 30 }, (_, i) => `${i < 20 ? 'src/x' : 'docs'}/f${i}.md`).join('\n');
  assert.equal(matchSummary(paths), '[all 30 lines, by folder: src/x/ 20, docs/ 10]');
  const many = Array.from({ length: 40 }, (_, i) => `d${i}/f.js:1:x`).join('\n');
  assert.match(matchSummary(many, 3), /d0\/f\.js 1, d1\/f\.js 1, d10\/f\.js 1, \+37 more files\]$/);
  assert.equal(matchSummary(bashResult()), null); // not a search result
  assert.equal(matchSummary(grep.slice(0, 5).join('\n')), null); // too short to need it
  assert.doesNotMatch(capText(grep.slice(0, 30).join('\n'), 20000, () => '/f'), /^\[all/); // not capped: no summary
});

test('crushJson compacts, keeps first, error and last items of long arrays', () => {
  const v = { items: Array.from({ length: 50 }, (_, i) => ({ id: i, status: i === 30 ? 'error: boom' : 'ok' })) };
  const out = crushJson(JSON.stringify(v, null, 2), () => '/x/full.json');
  assert.match(out, /"id":0/);
  assert.match(out, /error: boom/);
  assert.match(out, /"id":49/);
  assert.doesNotMatch(out, /"id":20,/);
  assert.match(out, /items omitted; full JSON: \/x\/full\.json/);
  assert.equal(crushJson('not json', () => null), null);
});

test('foldRead folds long bodies of a whole-file Read and keeps the line numbers of what it keeps', () => {
  const src = bigSource();
  const out = foldRead(numbered(src) + '\n\n<system-reminder>x</system-reminder>', 'a.js');
  assert.ok(out.length < src.length / 2);
  assert.match(out, /^1\tfunction f0\(a, b\) \{$/m);
  assert.match(out, /^\t {2}… 16 lines folded: Read offset=2 limit=16$/m);
  assert.match(out, /^18\t\}$/m);
  assert.match(out, /<system-reminder>x<\/system-reminder>$/);
});

test('compressResult leaves partial reads, prose, small and image results alone', () => {
  const content = numbered(bigSource());
  const read = (input) => compressResult({ type: 'tool_result', tool_use_id: 't', content }, { name: 'Read', input });
  assert.ok(read({ file_path: '/p/a.js' }));
  assert.equal(read({ file_path: '/p/a.js', offset: 1, limit: 2000 }), null);
  assert.equal(read({ file_path: '/p/a.md' }), null);
  assert.equal(compressResult({ type: 'tool_result', content: 'tiny' }, { name: 'Bash', input: {} }), null);
  const img = [{ type: 'text', text: bashResult() }, { type: 'image', source: {} }];
  assert.equal(compressResult({ type: 'tool_result', content: img }, { name: 'Bash', input: {} }), null);
  const one = compressResult({ type: 'tool_result', content: [{ type: 'text', text: bashResult() }] }, { name: 'Bash', input: {} }, { saveFull: () => '/f' });
  assert.equal(one[0].type, 'text');
  assert.ok(one[0].text.length < bashResult().length);
});

const conversation = () => ({
  model: 'claude-x',
  messages: [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'old', name: 'Bash', input: { command: 'make' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: bashResult() }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'new', name: 'Bash', input: { command: 'make' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'new', content: bashResult(), cache_control: { type: 'ephemeral' } }] },
  ],
});

test('transformRequest: only the newest results are compressed, and later requests resend the same bytes', () => {
  const memo = openMemo(null);
  const a = conversation();
  const st = transformRequest(a, memo, { saveFull: () => '/f' });
  assert.equal(st.compressed, 1);
  assert.equal(a.messages[2].content[0].content, bashResult()); // first seen in an older message: untouched
  const compressed = a.messages[4].content[0].content;
  assert.ok(compressed.length < bashResult().length / 2);
  assert.deepEqual(a.messages[4].content[0].cache_control, { type: 'ephemeral' });

  const b = conversation();
  b.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: 'next' });
  const st2 = transformRequest(b, memo, { saveFull: () => '/f' });
  assert.equal(st2.memoHits, 1);
  assert.equal(st2.compressed, 0);
  assert.equal(b.messages[4].content[0].content, compressed);
  assert.equal(b.messages[2].content[0].content, bashResult());

  // Claude Code rewrote the old result itself: the hash no longer matches and its text passes as sent
  const c = conversation();
  c.messages[4].content[0].content = '[Old tool result content cleared]';
  c.messages.push({ role: 'user', content: 'next' });
  transformRequest(c, memo);
  assert.equal(c.messages[4].content[0].content, '[Old tool result content cleared]');
});

test('transformRequest counts edits and reads on files whose Read went out folded', () => {
  const memo = openMemo(null);
  const file = '/p/a.js';
  const msgs = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: file } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r', content: numbered(bigSource()) }] },
  ];
  transformRequest({ messages: msgs }, memo, { countFolds: true });
  assert.equal(memo.get('r').fold, 1);
  const next = structuredClone(msgs);
  next.push(
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: file } },
        { type: 'tool_use', id: 'e2', name: 'Edit', input: { file_path: file } },
        { type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: file, offset: 2, limit: 16 } },
        { type: 'tool_use', id: 'o', name: 'Edit', input: { file_path: '/p/other.js' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'e1', is_error: true, content: '<tool_use_error>String to replace not found in file.</tool_use_error>' },
        { type: 'tool_result', tool_use_id: 'e2', content: 'ok' },
        { type: 'tool_result', tool_use_id: 'r2', content: '2\tx' },
        { type: 'tool_result', tool_use_id: 'o', is_error: true, content: 'String to replace not found' },
      ],
    },
  );
  const st = transformRequest(structuredClone({ messages: next }), memo, { countFolds: true });
  assert.deepEqual([st.foldEdits, st.foldMisses, st.foldReads], [2, 1, 1]);
  assert.equal(transformRequest(structuredClone({ messages: next }), memo).foldEdits, 0); // count_tokens: not counted
});

test('cacheBreak names the first prefix part that changed, or expiry', () => {
  const base = { model: 'm', metadata: { user_id: 'u' }, system: [{ type: 'text', text: 'S' }], tools: [{ name: 't' }], messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] };
  const shape = (f) => requestShape(f(structuredClone(base)));
  const prev = { ...shape((j) => j), ctx: 50000, t: 1e6 };
  const u = (cr) => ({ in: 10, cr, cw: 50000 - cr });
  const later = (j) => (j.messages.push({ role: 'user', content: 'c' }), j);
  assert.equal(cacheBreak(prev, shape(later), u(49000), 1e6 + 1000), null); // cache held
  assert.equal(shape((j) => ((j.system[0].cache_control = { type: 'ephemeral' }), j)).sys, prev.sys); // markers don't count
  assert.equal(shape(later).chain, prev.chain);
  assert.deepEqual(cacheBreak(prev, shape((j) => ((j.system[0].text = 'S2'), j)), u(0), 1e6), { cause: 'system', lost: 50000 });
  assert.equal(cacheBreak(prev, shape((j) => (j.tools.push({ name: 'x' }), j)), u(3000), 1e6).cause, 'tools');
  assert.deepEqual(cacheBreak(prev, shape((j) => ((j.messages[1].content = 'B'), j)), u(100), 1e6), { cause: 'history', lost: 49900, idx: 1 });
  assert.equal(cacheBreak(prev, shape(later), u(0), 1e6 + 400e3).cause, 'expired');
  assert.equal(cacheBreak(prev, shape(later), u(0), 1e6 + 1000).cause, 'unknown');
  const r = { requests: 2, in: 0, cr: 0, cw: 0, out: 0, compressed: 0, saved: 0, system: 0, tools: 0, resultChars: 0, models: {}, breaks: { tools: { n: 1, lost: 48000 } }, foldEdits: 3, foldMisses: 1, foldReads: 2 };
  assert.match(formatReport(r, 1), /cache breaks {3}tools 1 \(~48\.0k tokens written again\)/);
  assert.match(formatReport(r, 1), /3 edits on folded files, 1 failed; 2 reads back/);
});

test('memo survives a restart and drops stale entries', () => {
  const file = path.join(os.tmpdir(), 'memo-test.jsonl');
  const m = openMemo(file);
  m.set('x', { h: 'h1', c: 'C', t: Date.now() });
  fs.appendFileSync(file, JSON.stringify({ id: 'stale', h: 'h', c: 'c', t: Date.now() - 30 * 86400e3 }) + '\n');
  const again = openMemo(file);
  assert.equal(again.get('x').c, 'C');
  assert.equal(again.get('stale'), undefined);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /stale/);
});

function fakeUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.url.startsWith('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"input_tokens":42}');
      }
      if (!req.url.startsWith('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('nope');
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":1000,"cache_creation_input_tokens":200,"output_tokens":1}}}\n\n');
      setTimeout(() => {
        res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":33}}\n\n');
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      }, 20);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

function send(port, { method = 'POST', url = '/v1/messages?beta=true', body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('proxy: streams the answer unchanged, forwards auth, compresses new results, logs sizes and usage', async () => {
  const up = await fakeUpstream();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-'));
  const p = await startProxy({ port: 0, upstream: up.url, dir });
  try {
    const body = JSON.stringify({ ...conversation(), stream: true });
    const r = await send(p.port, { body, headers: { authorization: 'Bearer tok', 'anthropic-beta': 'x' } });
    assert.equal(r.status, 200);
    assert.match(r.body, /message_start[^]*message_delta[^]*message_stop/);
    const got = up.seen[0];
    assert.equal(got.url, '/v1/messages?beta=true');
    assert.equal(got.headers.authorization, 'Bearer tok');
    assert.equal(got.headers.host, new URL(up.url).host);
    const sent = JSON.parse(got.body);
    assert.ok(sent.messages[4].content[0].content.length < bashResult().length / 2);
    assert.equal(sent.messages[2].content[0].content, bashResult());

    const ct = await send(p.port, { url: '/v1/messages/count_tokens?beta=true', body });
    assert.equal(JSON.parse(ct.body).input_tokens, 42);
    assert.equal(JSON.parse(up.seen[1].body).messages[4].content[0].content, sent.messages[4].content[0].content);

    // not JSON: passed through as sent (fail-safe), other endpoints too
    await send(p.port, { body: '{broken' });
    assert.equal(up.seen[2].body, '{broken');
    const other = await send(p.port, { method: 'GET', url: '/v1/models' });
    assert.equal(other.status, 404);

    const log = fs.readFileSync(fs.readdirSync(dir).filter((f) => f.startsWith('requests-')).map((f) => path.join(dir, f))[0], 'utf8');
    const recs = log.trim().split('\n').map((l) => JSON.parse(l));
    const first = recs.find((e) => e.ep === '/v1/messages' && e.compressed);
    assert.deepEqual(first.usage, { in: 5, cr: 1000, cw: 200, out: 33 });
    assert.ok(first.saved > 10000);
    assert.doesNotMatch(log, /build output|Bearer/); // sizes only, never content or credentials
    assert.ok(recs.some((e) => e.error && /transform/.test(e.error)));
    const rep = proxyReport({ dir });
    assert.equal(rep.cr, 2000); // the broken body was forwarded too, and answered
    assert.ok(first.chain && !first.brk);
  } finally {
    p.server.close();
    up.server.close();
  }
});

test('proxy: an unreachable upstream answers 502 with an API-shaped error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-'));
  const p = await startProxy({ port: 0, upstream: 'http://127.0.0.1:1', dir });
  try {
    const r = await send(p.port, { body: JSON.stringify({ messages: [] }) });
    assert.equal(r.status, 502);
    assert.equal(JSON.parse(r.body).type, 'error');
  } finally {
    p.server.close();
  }
});
