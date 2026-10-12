#!/usr/bin/env node
// Profiles what tokenforge adds to a session, with no API calls: each hook's wall time per call (they run on every
// prompt or tool call), the tmap index (cold and warm), and the proxy's work per request on a recorded session.
// Runs in temp config, cache and state dirs, with the dashboard, proxy, gc and update check off.
//
//   node bench/scripts/profile.mjs [--runs 15] [--repo DIR] [--transcript FILE.jsonl]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const RUNS = Number(opt('runs', 15));
const REPO = path.resolve(opt('repo', ROOT));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tforge-profile-'));
const ENV = {
  ...process.env, CLAUDE_CONFIG_DIR: path.join(tmp, 'cc'), XDG_CONFIG_HOME: path.join(tmp, 'xdg'), XDG_CACHE_HOME: path.join(tmp, 'cache'), TMPDIR: tmp,
  TFORGE_UI: '0', TFORGE_PROXY: '0', TFORGE_GC: '0', TFORGE_UPDATE_CHECK: '0', TFORGE_LEAN_DEFAULT: 'off', TFORGE_BANNER: '0', TFORGE_STATUSLINE: '0',
};
fs.mkdirSync(ENV.CLAUDE_CONFIG_DIR, { recursive: true });

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const p90 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.9)];
function time(cmd, argv, input) {
  const ms = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = process.hrtime.bigint();
    spawnSync(cmd, argv, { input, env: ENV, cwd: REPO, stdio: ['pipe', 'ignore', 'ignore'] });
    ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return { median: median(ms), p90: p90(ms) };
}

// a transcript to hand the hooks that read one, and to rebuild a request for the proxy
function findTranscript() {
  if (opt('transcript')) return path.resolve(opt('transcript'));
  const runs = path.join(ROOT, 'bench', 'runs');
  let best = null;
  try {
    for (const s of fs.readdirSync(runs).sort().reverse().slice(0, 40))
      for (const t of fs.readdirSync(path.join(runs, s)).filter((x) => !x.endsWith('.json')))
        for (const r of fs.readdirSync(path.join(runs, s, t)).filter((x) => x.startsWith('token-forge'))) {
          const dir = path.join(runs, s, t, r, 'transcripts');
          for (const d of fs.existsSync(dir) ? fs.readdirSync(dir) : [])
            for (const f of fs.readdirSync(path.join(dir, d)).filter((x) => x.endsWith('.jsonl'))) {
              const p = path.join(dir, d, f);
              const n = fs.statSync(p).size;
              if (!best || n > best.n) best = { p, n };
            }
        }
  } catch {}
  return best?.p || null;
}
const transcript = findTranscript();
const sid = '11111111-1111-4111-8111-111111111111';
const base = { session_id: sid, transcript_path: transcript, cwd: REPO, permission_mode: 'default' };
const hook = (name) => path.join(ROOT, 'hooks', name);
const node = process.execPath;

const rows = [];
const baseline = time(node, ['-e', '']);
rows.push(['node startup (baseline)', baseline]);
const H = [
  ['SessionStart  session-start.mjs', 'session-start.mjs', { ...base, hook_event_name: 'SessionStart', source: 'startup' }],
  ['UserPromptSubmit  context-watch.mjs', 'context-watch.mjs', { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'add a budget command' }],
  ['UserPromptSubmit  prompt-router.mjs', 'prompt-router.mjs', { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'add a budget command' }],
  ['UserPromptSubmit  answer-cache.mjs', 'answer-cache.mjs', { ...base, hook_event_name: 'UserPromptSubmit', prompt: 'what does the proxy do?' }],
  ['PreToolUse Bash  kit-router.mjs', 'kit-router.mjs', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'grep -rn needle .' } }],
  ['PreToolUse Read  kit-router.mjs', 'kit-router.mjs', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(REPO, 'README.md') } }],
  ['PreToolUse Read  code-redirect.mjs', 'code-redirect.mjs', { ...base, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(REPO, 'README.md') } }],
  ['PostToolUse  context-watch.mjs', 'context-watch.mjs', { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a\nb\n' } }],
  ['Stop  checkpoint.mjs', 'checkpoint.mjs', { ...base, hook_event_name: 'Stop' }],
];
for (const [label, file, input] of H) rows.push([label, time(node, [hook(file)], JSON.stringify(input))]);

// tmap: a cold index (no cache) and a warm refresh of REPO
const tmap = (await import(path.join(ROOT, 'lib', 'tmapbin.mjs'))).existingBinary();
if (tmap) {
  const cold = [];
  for (let i = 0; i < Math.min(RUNS, 5); i++) {
    fs.rmSync(path.join(ENV.XDG_CACHE_HOME, 'tokenforge', 'tmap'), { recursive: true, force: true });
    const t0 = process.hrtime.bigint();
    spawnSync(tmap, ['tree', '-C', REPO], { env: ENV, stdio: 'ignore' });
    cold.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  rows.push(['tmap tree, cold index', { median: median(cold), p90: p90(cold) }]);
  rows.push(['tmap tree, warm', time(tmap, ['tree', '-C', REPO])]);
}

// proxy: the last request of the recorded session, rebuilt from its transcript, through compression and pruning
let proxyRow = null;
if (transcript) {
  const msgs = [];
  for (const l of fs.readFileSync(transcript, 'utf8').split('\n')) {
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    const m = e.message;
    if (!m || !['user', 'assistant'].includes(m.role)) continue;
    const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    const last = msgs.at(-1);
    if (last && last.role === m.role) last.content.push(...content);
    else msgs.push({ role: m.role, content: [...content] });
  }
  const { transformRequest, openMemo } = await import(path.join(ROOT, 'lib', 'proxy.mjs'));
  const body = { model: 'claude-opus-5-5', messages: msgs };
  const bytes = JSON.stringify(body).length;
  const ms = [];
  for (let i = 0; i < RUNS; i++) {
    const memo = openMemo(path.join(tmp, `memo-${i}.jsonl`));
    const copy = structuredClone(body);
    const t0 = process.hrtime.bigint();
    transformRequest(copy, memo);
    ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  proxyRow = { msgs: msgs.length, bytes, median: median(ms), p90: p90(ms) };
  rows.push([`proxy transformRequest (${msgs.length} messages, ${Math.round(bytes / 1024)} KB)`, proxyRow]);
}

console.log(`tokenforge profile: ${RUNS} runs each, repo ${REPO}${transcript ? `, transcript ${path.basename(transcript)}` : ''}\n`);
console.log('| what | median ms | p90 ms | over node startup |');
console.log('|---|---|---|---|');
for (const [label, r] of rows) {
  const over = /\.mjs$/.test(label) ? `${Math.max(0, r.median - baseline.median).toFixed(0)}` : '';
  console.log(`| ${label} | ${r.median.toFixed(1)} | ${r.p90.toFixed(1)} | ${over} |`);
}
fs.rmSync(tmp, { recursive: true, force: true });
