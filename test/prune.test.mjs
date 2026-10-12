// Tests for stale-context pruning (lib/prune.mjs): what is stale, when a batch goes, and that later requests
// resend the same bytes.
import './tmp.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EDITED_READ_AGE, WRITE_AGE, candidates, pruneMode, pruneRequest, samePath, shellEdits, shouldCommit } from '../lib/prune.mjs';
import { openMemo, transformRequest } from '../lib/proxy.mjs';

const big = (tag, n = 3000) => `${tag}\n` + 'x'.repeat(n);
const call = (id, name, input) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input }] });
const result = (id, content, extra = {}) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] });

// read a.js, run tests, rewrite a.js, read it again, run tests again
const session = () => [
  { role: 'user', content: 'fix a.js' },
  call('r1', 'Read', { file_path: '/p/a.js' }),
  result('r1', big('v1')),
  call('t1', 'Bash', { command: 'npm test' }),
  result('t1', big('FAIL')),
  call('w1', 'Write', { file_path: '/p/a.js', content: big('v2') }),
  result('w1', 'ok'),
  call('r2', 'Bash', { command: 'cat a.js' }),
  result('r2', big('v2')),
  call('t2', 'Bash', { command: 'npm test' }),
  result('t2', big('PASS')),
];

test('samePath matches absolute and relative spellings of one file', () => {
  assert.ok(samePath('/p/src/a.js', 'src/a.js'));
  assert.ok(samePath('./a.js', '/p/a.js'));
  assert.ok(!samePath('/p/ba.js', 'a.js'));
  assert.equal(pruneMode('off'), 'off');
  assert.equal(pruneMode('cost'), 'cost');
  assert.equal(pruneMode(undefined), 'cost');
  assert.equal(pruneMode('tokens'), 'tokens');
});

test('stale: a read superseded by a rewrite, a write read back whole, a command run again; never the newest', () => {
  const c = candidates(session());
  const keys = c.map((x) => x.key).sort();
  assert.deepEqual(keys, ['in:w1', 'r1', 't1']);
  assert.match(c.find((x) => x.key === 'r1').c, /\/p\/a\.js was rewritten later/);
  assert.match(c.find((x) => x.key === 't1').c, /same command ran again later/);
  assert.match(JSON.parse(c.find((x) => x.key === 'in:w1').c).content, /written lines removed .*a\.js was read again later/);
});

test('stale: a partial re-read does not cover a whole read; a failed re-read covers nothing', () => {
  const msgs = [
    { role: 'user', content: 'go' },
    call('r1', 'Read', { file_path: '/p/a.js' }),
    result('r1', big('v1')),
    call('r2', 'Read', { file_path: '/p/a.js', offset: 10, limit: 20 }),
    result('r2', big('part')),
    call('r3', 'Read', { file_path: '/p/a.js' }),
    result('r3', 'File does not exist.', { is_error: true }),
  ];
  assert.deepEqual(candidates(msgs).map((x) => x.key), []);
  msgs.push(call('r4', 'Read', { file_path: '/p/a.js', offset: 1, limit: 4000 }), result('r4', big('v1')));
  assert.deepEqual(candidates(msgs).map((x) => x.key).sort(), ['r1', 'r2']);
});

test('heredoc writes keep their command shape, only the body goes', () => {
  const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const msgs = [
    { role: 'user', content: 'go' },
    call('h', 'Bash', { command: `cat > src/x.py <<'EOF'\n${body}\nEOF\npython3 src/x.py` }),
    result('h', 'ok'),
    call('r', 'Read', { file_path: '/p/src/x.py' }),
    result('r', 'small'),
  ];
  const [c] = candidates(msgs);
  const cmd = JSON.parse(c.c).command;
  assert.match(cmd, /^cat > src\/x\.py <<'EOF'\n\[tokenforge: 200 written lines removed/);
  assert.match(cmd, /\nEOF\npython3 src\/x\.py$/);
});

test('thinking: earlier turns lose it, the current turn keeps it', () => {
  const think = (s) => ({ type: 'thinking', thinking: big(s), signature: `sig-${s}` });
  const msgs = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: [think('a'), { type: 'text', text: 'done' }] },
    { role: 'user', content: [{ type: 'text', text: 'second' }] },
    { role: 'assistant', content: [think('b'), { type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } }] },
    result('x', 'a b'),
  ];
  const body = { messages: msgs };
  const st = pruneRequest(body, openMemo(null), { mode: 'tokens', min: 0 });
  assert.equal(st.pruned, 1);
  assert.deepEqual([st.thinkPast, st.thinkPastBlocks, st.thinkNow], [3002, 1, 3002], 'sizes of what was sent');
  assert.deepEqual(body.messages[1].content.map((b) => b.type), ['text']);
  assert.equal(body.messages[3].content[0].type, 'thinking');
});

test('tokens mode batches: nothing until enough is stale, then every later request sends the same bytes', () => {
  const memo = openMemo(null);
  const small = { messages: structuredClone(session()) };
  assert.equal(pruneRequest(small, memo, { mode: 'tokens', min: 1e9 }).committed, 0);
  assert.deepEqual(small.messages, session(), 'below the minimum: untouched');

  const a = { messages: structuredClone(session()) };
  const st = pruneRequest(a, memo, { mode: 'tokens', min: 1000 });
  assert.equal(st.committed, 3);
  assert.ok(st.prunedChars > 8000);
  const b = { messages: [...structuredClone(session()), { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, { role: 'user', content: 'thanks' }] };
  const st2 = pruneRequest(b, memo, { mode: 'off' });
  assert.equal(st2.committed, 0);
  assert.equal(st2.pruned, 3, 'off still replays what earlier requests sent');
  assert.deepEqual(b.messages.slice(0, a.messages.length), a.messages);
});

test('cost mode: an expired cache always prunes; a warm one only when the stale part sits near the end', () => {
  const p = [{ chars: 5000 }];
  p.after = 6000;
  assert.equal(shouldCommit(p, { mode: 'cost', min: 0, cold: false, requests: 10, ttl: '1h' }), true); // 1k rewritten, 50k reads saved
  p.after = 200000;
  assert.equal(shouldCommit(p, { mode: 'cost', min: 0, cold: false, requests: 10, ttl: '1h' }), false);
  assert.equal(shouldCommit(p, { mode: 'cost', min: 0, cold: true, requests: 10 }), true);
  assert.equal(shouldCommit(p, { mode: 'off', min: 0, cold: true, requests: 10 }), false);
});

test('cost mode: an old stale item does not hold back cheap ones near the end', () => {
  const memo = openMemo(null);
  const body = big('code', 20000);
  // a read made stale early (a.js read twice), then a long history, then a big write the model moved on from
  const msgs = [
    { role: 'user', content: 'go' },
    call('r1', 'Bash', { command: 'cat a.js' }),
    result('r1', big('a', 4000)),
    call('r2', 'Bash', { command: 'cat a.js' }),
    result('r2', big('a', 4000)),
    ...Array.from({ length: 6 }, (_, i) => [call(`x${i}`, 'Bash', { command: `grep -n f${i} src` }), result(`x${i}`, big(`hits${i}`, 30000))]).flat(),
    call('w', 'Bash', { command: `cat > b.js <<'EOF'\n${body}\nEOF` }),
    result('w', ''),
    ...Array.from({ length: WRITE_AGE }, (_, i) => [call(`l${i}`, 'Bash', { command: `echo ${i}` }), result(`l${i}`, 'x')]).flat(),
  ];
  const j = { messages: structuredClone(msgs) };
  const st = pruneRequest(j, memo, { mode: 'cost', min: 0, ttl: '5m' });
  assert.equal(st.committed, 1, 'only the write goes');
  assert.match(j.messages[17].content[0].input.command, /written lines removed/);
  assert.equal(j.messages[2].content[0].content, big('a', 4000), 'the early stale read stays: stubbing it rewrites everything after');
});

test('transformRequest prunes before compressing: a pruned result stays the stub', () => {
  const memo = openMemo(null);
  const j = { messages: structuredClone(session()) };
  const st = transformRequest(j, memo, { pruneOpts: { mode: 'tokens', min: 0 } });
  assert.equal(st.pruneCommitted, 3);
  assert.match(j.messages[2].content[0].content, /^\[tokenforge: stale file content removed/);
  assert.match(j.messages[4].content[0].content, /^\[tokenforge: stale output removed/);
  assert.equal(j.messages[10].content[0].content, big('PASS'), 'the newest result is never stale');
});

test('shell reads: chains of cat, sed -n and head are reads; a later read must cover every file they showed', () => {
  const msgs = [
    { role: 'user', content: 'go' },
    call('a', 'Bash', { command: 'cat -n src/{a,b}.ts docs/x.md 2>/dev/null' }),
    result('a', big('abx')),
    call('b', 'Bash', { command: "sed -n '1,40p;80,90p' src/a.ts && head -n 20 src/b.ts" }),
    result('b', big('ab')),
    call('c', 'Bash', { command: 'cat src/a.ts | head -50' }),
    result('c', big('a50')),
    call('d', 'Bash', { command: 'cat src/a.ts src/b.ts; cat docs/x.md' }),
    result('d', big('abx2')),
  ];
  const c = candidates(msgs);
  assert.deepEqual(c.map((x) => x.key).sort(), ['a', 'b'], 'the piped cat is an ordinary command; the newest read stays');
  assert.match(c.find((x) => x.key === 'a').c, /3 files were read again later/);
  msgs.splice(-2);
  assert.deepEqual(candidates(msgs).map((x) => x.key), [], 'docs/x.md was never shown again: the first read stays');
});

test('test runs: the same runner after a change supersedes the earlier output, whatever it was filtered through', () => {
  const msgs = [
    { role: 'user', content: 'go' },
    call('t1', 'Bash', { command: 'npm test 2>&1 | grep -E "not ok|# fail"' }),
    result('t1', big('FAIL a')),
    call('t2', 'Bash', { command: 'npm test 2>&1 | tail -5' }),
    result('t2', big('FAIL b')),
    call('e', 'Edit', { file_path: '/p/a.js', old_string: 'x', new_string: 'y' }),
    result('e', 'ok'),
    call('t3', 'Bash', { command: 'npm test 2>&1 | tail -3' }),
    result('t3', big('PASS')),
    call('g1', 'Bash', { command: 'git diff | grep foo' }),
    result('g1', big('foo')),
    call('g2', 'Bash', { command: 'git diff | grep bar' }),
    result('g2', big('bar')),
  ];
  const c = candidates(msgs);
  assert.deepEqual(c.map((x) => x.key).sort(), ['t1', 't2'], 'git diff filtered two ways shows two different things');
  assert.match(c[0].c, /`npm test` ran again after changes/);
});

test('heredoc writes after a prefix, and appends: an append never stands for the whole file', () => {
  const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  const msgs = [
    { role: 'user', content: 'go' },
    call('r', 'Bash', { command: 'cat src/x.py' }),
    result('r', big('old')),
    call('ap', 'Bash', { command: `cat >> src/x.py <<'EOF'\n${body}\nEOF` }),
    result('ap', ''),
    call('h', 'Bash', { command: `mkdir -p src && cat > src/y.py <<EOF\n${body}\nEOF` }),
    result('h', ''),
    call('r2', 'Bash', { command: 'cat src/y.py' }),
    result('r2', 'small'),
  ];
  const c = candidates(msgs);
  assert.deepEqual(c.map((x) => x.key), ['in:h']);
  assert.match(JSON.parse(c[0].c).command, /^mkdir -p src && cat > src\/y\.py <<EOF\n\[tokenforge: 200 written lines/);
});

test('written bodies go once the model moved on (WRITE_AGE calls, or an earlier turn); appends and failures stay', () => {
  const body = big('code');
  const msgs = [
    { role: 'user', content: 'go' },
    call('w', 'Write', { file_path: '/p/a.js', content: body }),
    result('w', 'ok'),
    call('ap', 'Bash', { command: `cat >> log.txt <<'EOF'\n${body}\nEOF` }),
    result('ap', ''),
    call('bad', 'Write', { file_path: '/ro/b.js', content: body }),
    result('bad', 'EACCES', { is_error: true }),
  ];
  const later = (n) => Array.from({ length: n }, (_, i) => [call(`l${i}`, 'Bash', { command: `echo ${i}` }), result(`l${i}`, 'x')]).flat();
  assert.deepEqual(candidates(msgs.slice(0, 5)).map((x) => x.key), [], 'too recent: one call since');
  const c = candidates([...msgs, ...later(WRITE_AGE - 2)]);
  assert.deepEqual(c.map((x) => x.key), ['in:w']);
  assert.match(JSON.parse(c[0].c).content, /written lines removed .*holds it on disk; read the lines you need before editing/);
  assert.deepEqual(candidates([...msgs, ...later(WRITE_AGE)], { writes: false }).map((x) => x.key), []);
  const turn = [...msgs, { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, { role: 'user', content: 'next' }];
  assert.deepEqual(candidates(turn).map((x) => x.key), ['in:w'], 'an earlier turn');
});

test('scripts fed by heredocs (python edits, files written after a prefix) keep their shape, lose their bodies', () => {
  const body = big('code');
  const py = `python3 - <<'EOF'\np='src/a.py'\ns=open(p).read()\n${body}\nEOF\necho done`;
  const msgs = [
    { role: 'user', content: 'go' },
    call('py', 'Bash', { command: py }),
    result('py', 'done'),
    call('gf', 'Bash', { command: `gofmt -w a.go && cat > b.go <<'GO'\n${body}\nGO` }),
    result('gf', ''),
    call('ko', 'Bash', { command: `python3 - <<'EOF'\n${body}\nEOF` }),
    result('ko', 'AssertionError', { is_error: true }),
  ];
  const later = Array.from({ length: WRITE_AGE }, (_, i) => [call(`l${i}`, 'Bash', { command: `echo ${i}` }), result(`l${i}`, 'x')]).flat();
  assert.deepEqual(candidates(msgs.slice(0, 5)).map((x) => x.key), [], 'too recent');
  const c = candidates([...msgs, ...later]);
  assert.deepEqual(c.map((x) => x.key), ['in:py', 'in:gf'], 'a failed script stays');
  const cmd = JSON.parse(c[0].c).command;
  assert.match(cmd, /^python3 - <<'EOF'\n\[.*script lines removed.*it ran; its changes are on disk.*\]\nEOF\necho done$/s);
  assert.match(JSON.parse(c[1].c).command, /^gofmt -w a\.go && cat > b\.go <<'GO'\n\[.*written lines removed.*\]\nGO$/s);
  assert.deepEqual(candidates([...msgs, ...later], { writes: false }).map((x) => x.key), []);
});

test('an earlier turn\'s read of a file changed since goes; in the current turn it stays', () => {
  const msgs = [
    { role: 'user', content: 'go' },
    call('r', 'Read', { file_path: '/p/a.js' }),
    result('r', big('v1')),
    call('e', 'Edit', { file_path: '/p/a.js', old_string: 'x', new_string: 'y' }),
    result('e', 'ok'),
  ];
  assert.deepEqual(candidates(msgs).map((x) => x.key), []);
  msgs.push({ role: 'assistant', content: [{ type: 'text', text: 'done' }] }, { role: 'user', content: 'next' });
  const c = candidates(msgs);
  assert.deepEqual(c.map((x) => x.key), ['r']);
  assert.match(c[0].c, /\/p\/a\.js changed after this read/);
});

test('stale: a read of a file edited later in this turn goes once the model left the file alone', () => {
  const edit = "tkit edit <<'EOF'\n@@ src/a.ts\n<<<\nold\n===\nnew\n>>>\nEOF";
  const other = (i) => [call(`o${i}`, 'Bash', { command: `ls src/dir${i}` }), result(`o${i}`, 'x')];
  const base = (n, extra = []) => [
    { role: 'user', content: 'fix a.ts' },
    call('r1', 'Bash', { command: 'cat src/a.ts' }),
    result('r1', big('v1')),
    call('e1', 'Bash', { command: edit }),
    result('e1', 'edited src/a.ts'),
    ...extra,
    ...Array.from({ length: n }, (_, i) => other(i)).flat(),
  ];
  const stale = (msgs) => candidates(msgs).find((x) => x.key === 'r1');
  assert.equal(stale(base(EDITED_READ_AGE - 2)), undefined, 'too soon: the model may edit it again');
  assert.match(stale(base(EDITED_READ_AGE)).c, /src\/a\.ts changed after this read and was not used in the last 6 calls/);
  // a later command that names the file keeps it: the clock starts again from there
  const touched = base(EDITED_READ_AGE - 2, [call('g1', 'Bash', { command: 'grep -n new src/a.ts' }), result('g1', '1:new')]);
  assert.equal(stale(touched), undefined);
  // never edited: a read stays, however old
  const unedited = [{ role: 'user', content: 'look' }, call('r1', 'Bash', { command: 'cat src/a.ts' }), result('r1', big('v1')), ...Array.from({ length: 10 }, (_, i) => other(i)).flat()];
  assert.equal(stale(unedited), undefined);
  assert.deepEqual(shellEdits(`${edit}\nsed -i 's/a/b/' src/b.ts && echo x | tee out.log`).sort(), ['out.log', 'src/a.ts', 'src/b.ts']);
});
