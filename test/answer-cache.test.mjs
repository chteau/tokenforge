// Adversarial tests for the answer cache: an earlier answer is replayed only to the same information question,
// in the same repo, branch, working tree, dependencies, configuration and model.
import './tmp.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tforge-ac-home-'));
process.env.CLAUDE_CONFIG_DIR = path.join(HOME, 'cc');
process.env.XDG_CACHE_HOME = path.join(HOME, 'cache');
process.env.XDG_CONFIG_HOME = path.join(HOME, 'config');
const { buildIndex, projectKey, replayable, BYPASS } = await import('../lib/memory.mjs');

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'answer-cache.mjs');
const ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^TFORGE_/.test(k))), TFORGE_GC: '0' };
let seq = 0;
const sid = () => `ac${process.pid}x${seq++}`;
const tmpdir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function ask(proj, prompt, { session = sid(), env = {}, transcript } = {}) {
  const r = spawnSync('node', [HOOK], { input: JSON.stringify({ prompt, cwd: proj, session_id: session, transcript_path: transcript }), encoding: 'utf8', env: { ...ENV, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}
const held = (proj, prompt, opts) => ask(proj, prompt, opts)?.decision === 'block';

// An earlier session that asked `q` and got `a` without editing anything; the hook records the state it was asked in.
function prime(proj, q, a, { model } = {}) {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', projectKey(proj));
  fs.mkdirSync(dir, { recursive: true });
  const id = sid();
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), [
    { type: 'user', timestamp: '2026-10-01T09:00:00Z', message: { role: 'user', content: q } },
    { type: 'assistant', message: { model, content: [{ type: 'text', text: a }] } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  ask(proj, q, { session: id });
  buildIndex(proj);
}

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
function repo() {
  const d = tmpdir('tforge-ac-repo-');
  git(d, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, 'cache.js'), 'export const dir = "~/.cache/x";\n');
  fs.writeFileSync(path.join(d, 'package.json'), '{"name":"x"}\n');
  fs.writeFileSync(path.join(d, '.gitignore'), 'package-lock.json\n');
  fs.writeFileSync(path.join(d, 'package-lock.json'), '{"lockfileVersion":3,"v":1}\n');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'init');
  return d;
}
const Q = 'Where does the cache write its index files?';
const A = 'Under `~/.cache/x` (cache.js).';

test('answer cache: only information questions are replayed; actions, security and current state never (English and French)', () => {
  for (const p of [Q, 'where does the cache write its index files', 'How does the parser handle escapes?', 'Which module owns the session store?',
    'can you explain the parser?', 'Où le cache écrit-il son index ?', 'Comment fonctionne le parseur ?', 'Qu’est-ce que fait le module de cache ?',
    'Peux-tu m\'expliquer le parseur ?', 'Y a-t-il une limite de taille ?'])
    assert.ok(replayable(p), p);
  for (const p of [
    // actions and what running them shows
    'Do the tests pass?', 'Run the tests', 'does the build work', 'what does npm run build do', 'Is it deployed?', 'why does the login page show an error?',
    'Est-ce que les tests passent ?', 'Lance les tests', 'Pourquoi le build échoue ?', 'Pourquoi ça plante ?', 'Marche-t-il sous Windows ?',
    // security
    'what is the password of the admin account', 'Is the upload handler vulnerable to path traversal?', 'Est-ce sécurisé ?', 'Où est le mot de passe admin ?',
    // current state
    'is the api up', 'is the staging server down?', 'what is the latest release', 'what is the status of the migration', 'how many users are there now?',
    'what is currently in the queue?', 'Quel est le statut du serveur ?', 'Où en est le déploiement ?', 'Le serveur répond-il ?', 'Quelle version de node faut-il ?',
    'Qu\'y a-t-il actuellement dans la file ?',
    // requests, or wording that is not clearly a question: unsure, so not replayed
    'Add a budget command', 'can you add a flag?', 'Write the cache index files where?', 'cache index files: where?', 'Ajoute un flag --json',
    // fresh look (kept from before)
    'review the whole paper', 'vérifie le chapitre 3', 'check where the cache writes its index files',
  ])
    assert.ok(!replayable(p), p);
});

test('answer cache: the same words with another intent, and French, are judged on their own', () => {
  const proj = repo();
  prime(proj, Q, A);
  const out = ask(proj, Q);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /cache\.js/);
  assert.match(out.reason, /!nocache/);
  // same content words, not a question: neither held nor hinted
  assert.equal(ask(proj, 'Write the cache index files where?'), null);
  assert.equal(ask(proj, 'Where does the cache write its index files now?'), null, 'current state');
  const fr = repo();
  prime(fr, 'Où le cache écrit-il son index ?', 'Dans `~/.cache/x`.');
  assert.ok(held(fr, 'Où le cache écrit-il son index ?'));
  assert.equal(ask(fr, 'Où le cache écrit-il son index maintenant ?'), null);
  assert.equal(ask(fr, 'Lance le cache et écris son index'), null);
  // a question asked before its state was recorded is never reused
  const old = repo();
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', projectKey(old));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'legacy.jsonl'), [
    { type: 'user', timestamp: '2026-10-01T09:00:00Z', message: { role: 'user', content: Q } },
    { type: 'assistant', message: { content: [{ type: 'text', text: A }] } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n');
  buildIndex(old);
  assert.equal(ask(old, Q), null);
});

test('answer cache: a changed environment with unchanged files is a miss (deps, branch, repo, config, model)', () => {
  // dependencies: an ignored lockfile changes, git status does not
  let proj = repo();
  prime(proj, Q, A);
  assert.ok(held(proj, Q));
  fs.writeFileSync(path.join(proj, 'package-lock.json'), '{"lockfileVersion":3,"v":2}\n');
  assert.equal(git(proj, 'status', '--porcelain'), '');
  assert.equal(ask(proj, Q), null, 'dependency lockfile changed');
  // branch switched, same commit and files
  proj = repo();
  prime(proj, Q, A);
  git(proj, 'checkout', '-qb', 'other');
  assert.equal(ask(proj, Q), null, 'other branch');
  git(proj, 'checkout', '-q', 'main');
  assert.ok(held(proj, Q), 'back on the branch it was asked on');
  // another repository at the same path, same text: another remote
  proj = repo();
  prime(proj, Q, A);
  git(proj, 'remote', 'add', 'origin', 'https://example.invalid/other.git');
  assert.equal(ask(proj, Q), null, 'other repo identity');
  // configuration that shapes answers
  proj = repo();
  prime(proj, Q, A);
  assert.equal(ask(proj, Q, { env: { TFORGE_TERSE: 'lite' } }), null, 'terse level changed');
  // model: the earlier answer's model vs the current session's latest reply
  proj = repo();
  prime(proj, Q, A, { model: 'claude-a' });
  const tr = path.join(tmpdir('tforge-ac-tr-'), 'now.jsonl');
  fs.writeFileSync(tr, JSON.stringify({ type: 'assistant', message: { model: 'claude-b', content: [] } }) + '\n');
  assert.equal(ask(proj, Q, { transcript: tr }), null, 'other model');
  fs.writeFileSync(tr, JSON.stringify({ type: 'assistant', message: { model: 'claude-a', content: [] } }) + '\n');
  assert.ok(held(proj, Q, { transcript: tr }), 'same model');
});

test('answer cache: edits within the mtime resolution, renames and deletions are seen (git and plain folders)', () => {
  const sameTick = (f, text) => {
    const st = fs.statSync(f);
    fs.writeFileSync(f, text);
    fs.utimesSync(f, st.atime, st.mtime);
  };
  let proj = repo();
  prime(proj, Q, A);
  sameTick(path.join(proj, 'cache.js'), 'export const dir = "~/.cache/y";\n');
  assert.equal(ask(proj, Q), null, 'tracked file, same size and mtime');
  proj = repo();
  fs.writeFileSync(path.join(proj, 'notes.txt'), 'aaaa\n');
  prime(proj, Q, A);
  sameTick(path.join(proj, 'notes.txt'), 'bbbb\n');
  assert.equal(ask(proj, Q), null, 'untracked file, same size and mtime');
  proj = repo();
  prime(proj, Q, A);
  git(proj, 'mv', 'cache.js', 'store.js');
  assert.equal(ask(proj, Q), null, 'rename');
  proj = repo();
  prime(proj, Q, A);
  fs.rmSync(path.join(proj, 'cache.js'));
  assert.equal(ask(proj, Q), null, 'deletion');
  // not a git repo
  proj = tmpdir('tforge-ac-plain-');
  fs.mkdirSync(path.join(proj, 'src'));
  fs.writeFileSync(path.join(proj, 'src', 'cache.js'), 'export const dir = "~/.cache/x";\n');
  prime(proj, Q, A);
  assert.ok(held(proj, Q));
  sameTick(path.join(proj, 'src', 'cache.js'), 'export const dir = "~/.cache/y";\n');
  assert.equal(ask(proj, Q), null, 'plain folder, same size and mtime');
  proj = tmpdir('tforge-ac-plain-');
  fs.writeFileSync(path.join(proj, 'a.js'), 'x\n');
  prime(proj, Q, A);
  fs.renameSync(path.join(proj, 'a.js'), path.join(proj, 'b.js'));
  assert.equal(ask(proj, Q), null, 'plain folder rename');
});

test('answer cache: !nocache before sending, and TFORGE_ANSWER_CACHE=0, ask Claude', () => {
  const proj = repo();
  prime(proj, Q, A);
  for (const p of [`!nocache ${Q}`, `${Q} !nocache`, `!NOCACHE ${Q}`]) {
    assert.ok(BYPASS.test(p), p);
    assert.equal(ask(proj, p), null, p);
  }
  assert.ok(!BYPASS.test('why does !nocache appear in the docs?'), 'only as the first or last word');
  assert.equal(ask(proj, Q, { env: { TFORGE_ANSWER_CACHE: '0' } }), null);
  assert.equal(ask(proj, Q, { env: { TFORGE_ANSWER_CACHE: 'off' } }), null);
  assert.ok(held(proj, Q), 'the bypass changed nothing for the next prompt');
});
