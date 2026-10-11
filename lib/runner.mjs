import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './instructions.mjs';
import { MODELS, isolated, loadPlan, nextModel, parseRef, topoOrder } from './plan.mjs';
import {
  FORGE_DIR, appendJsonl, changedFiles, fmtTokens, fmtUsd, readJson, run, runShell, sha, snapshot, tail, writeJsonAtomic,
} from './util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PROMPT = path.join(HERE, '..', 'prompts', 'worker.md');

// Input-equivalent tokens: cache writes cost 1.25x, cache reads 0.1x, output 5x an uncached input token.
export function weighted(u = {}) {
  return (u.input_tokens || 0) + 1.25 * (u.cache_creation_input_tokens || 0) + 0.1 * (u.cache_read_input_tokens || 0) + 5 * (u.output_tokens || 0);
}

export function contextTokens(u = {}) {
  return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
}

function readFileSafe(root, ref) {
  const { file, from, to } = parseRef(ref);
  let body;
  try {
    body = fs.readFileSync(path.join(root, file), 'utf8');
  } catch {
    return null;
  }
  if (from === undefined) return body;
  const lines = body.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return `[lines ${from}-${Math.min(to, lines.length)} of ${lines.length}; Read other lines only if needed]\n` + lines.slice(from - 1, to).join('\n');
}

export const ownedPaths = (task) => task.files.map((f) => parseRef(f).file);

function fence(rel, body) {
  return `--- ${rel} ---\n${body}\n--- end ${rel} ---`;
}

// Shared context goes in the system prompt: identical across workers, so it is served from the prompt cache. Workers
// run without setting sources, so Claude Code loads no CLAUDE.md for them: the project's instruction files come here.
export function buildSystemPrompt(root, plan) {
  const parts = [fs.readFileSync(WORKER_PROMPT, 'utf8').trim(), digest(root, { engine: false }), `PROJECT GOAL: ${plan.goal}`].filter(Boolean);
  const ctx = plan.context || [];
  if (ctx.length) {
    parts.push('SHARED CONTEXT (read-only):');
    for (const rel of ctx) {
      const body = readFileSafe(root, rel);
      parts.push(fence(rel, body ?? '(missing file)'));
    }
  }
  return parts.join('\n\n') + '\n';
}

export function buildTaskPrompt(root, plan, task, { failure, attempt, inlineOwned } = {}) {
  const budget = plan.defaults.inlineMaxChars;
  let used = 0;
  const notInlined = [];
  const inline = (rel, emptyLabel) => {
    const body = readFileSafe(root, rel);
    if (body === null) return emptyLabel ? fence(rel, emptyLabel) : null;
    if (used + body.length > budget) {
      notInlined.push(rel);
      return null;
    }
    used += body.length;
    return fence(rel, body);
  };
  const out = [`TASK ${task.id}${task.title ? `: ${task.title}` : ''}`, task.spec.trim()];
  out.push(`OWNED FILES (only these may change):\n${ownedPaths(task).map((f) => `- ${f}`).join('\n')}`);
  if (failure) {
    out.push(`ATTEMPT ${attempt + 1}: the previous attempt failed its checks. Fix the cause. Check output:\n\`\`\`\n${failure}\n\`\`\``);
  }
  const owned = (inlineOwned || task.files).map((f) => inline(f, '(new file: does not exist yet)')).filter(Boolean);
  const rest = inlineOwned ? ownedPaths(task).filter((f) => !inlineOwned.includes(f)) : [];
  out.push(`CURRENT OWNED FILES:\n${owned.join('\n\n') || '(none inlined)'}`);
  if (rest.length) out.push(`Other owned files (Read only if needed): ${rest.join(', ')}`);
  const reads = (task.reads || []).map((f) => inline(f)).filter(Boolean);
  if (reads.length) out.push(`REFERENCE FILES (read-only):\n${reads.join('\n\n')}`);
  if (notInlined.length) out.push(`Not inlined (too large; Read only if needed): ${notInlined.join(', ')}`);
  return out.join('\n\n') + '\n';
}

function fingerprints(plan) {
  const fp = new Map();
  for (const t of topoOrder(plan.tasks)) {
    fp.set(t.id, sha(plan.goal, plan.context || [], t, (t.deps || []).map((d) => fp.get(d))));
  }
  return fp;
}

export function workerArgs({ model, effort, tools, maxTurns, budgetUsd, systemFile }) {
  return [
    '-p', '--output-format', 'json',
    '--model', model,
    '--effort', effort,
    '--max-turns', String(maxTurns),
    '--max-budget-usd', String(budgetUsd),
    '--permission-mode', 'acceptEdits',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--system-prompt-file', systemFile,
    '--tools', tools.join(','),
  ];
}

function parseResult(stdout) {
  const s = stdout.trim();
  for (const cand of [s, s.split('\n').pop()]) {
    try {
      const j = JSON.parse(cand);
      if (j && typeof j === 'object') return j;
    } catch {}
  }
  return null;
}

async function runWorker(ctx, task, model, prompt, { escalated = false } = {}) {
  const { root, plan, claudeBin, systemFile } = ctx;
  const d = plan.defaults;
  const effort = escalated ? d.escalateEffort : task.effort || d.effort;
  // "auto": haiku tasks are mechanical (tests, wiring, styles); thinking roughly doubles their output for no gain.
  const pref = task.thinking ?? d.thinking;
  const thinking = escalated || (pref === 'auto' ? model !== 'haiku' : pref);
  const env = thinking ? process.env : { ...process.env, CLAUDE_CODE_DISABLE_THINKING: '1' };
  const args = workerArgs({
    model,
    effort,
    tools: task.tools || d.tools,
    maxTurns: task.maxTurns || d.maxTurns,
    budgetUsd: task.budgetUsd || d.budgetUsd,
    systemFile,
  });
  const r = await run(claudeBin, args, { cwd: root, input: prompt, env, timeoutMs: d.timeoutMin * 60000 });
  const j = parseResult(r.stdout);
  if (!j) {
    return { ok: false, error: r.timedOut ? 'worker timed out' : tail(r.stderr || r.stdout || `exit ${r.code}`, 20, 1500), ms: r.ms, usage: {}, cost: 0, turns: 0 };
  }
  const text = String(j.result || '').trim();
  const blocked = /^BLOCKED:/m.test(text) ? text.match(/^BLOCKED:.*$/m)[0] : null;
  return {
    ok: !j.is_error || j.subtype === 'error_max_turns',
    error: j.is_error ? (j.subtype || 'error') + (text ? `: ${text.slice(0, 300)}` : '') : null,
    blocked,
    subtype: j.subtype,
    usage: j.usage || {},
    cost: j.total_cost_usd || 0,
    turns: j.num_turns || 0,
    ms: r.ms,
  };
}

const git = (args, cwd) => run('git', args, { cwd });

// Top of the git work tree holding root, or null outside git or before the first commit (no HEAD to check out).
export async function gitTop(root) {
  const top = await git(['rev-parse', '--show-toplevel'], root);
  const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD'], root);
  return top.code === 0 && head.code === 0 ? top.stdout.trim() : null;
}

// Brings a fresh worktree of HEAD to the checkout's current state: every path that differs from HEAD (tracked changes
// and deletions, untracked files that are not ignored) is copied over or removed.
async function syncTree(top, wt) {
  const list = async (args) => (await git(args, top)).stdout.split('\0').filter(Boolean);
  const paths = new Set([
    ...(await list(['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--'])),
    ...(await list(['ls-files', '--others', '--exclude-standard', '-z'])),
  ]);
  for (const rel of paths) {
    const src = path.join(top, rel);
    const dst = path.join(wt, rel);
    let st = null;
    try {
      st = fs.lstatSync(src);
    } catch {}
    if (st?.isDirectory()) continue; // a submodule: left at its recorded commit
    fs.rmSync(dst, { force: true, recursive: true });
    if (!st) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { verbatimSymlinks: true });
  }
}

// Checks of sensitive tasks (or of every task with "isolateChecks") never run in the checkout. Workers keep editing the
// checkout, where ownership and stray writes are watched, and the check runs in a throwaway `git worktree add --detach`
// of HEAD brought to the checkout's state just before it (syncTree). Copying the state in is simpler than running the
// worker in the worktree and copying its edits back: the check sees this worker's edits and every earlier task's, and
// whatever the check itself writes or deletes stays in the copy, which is removed afterwards, after a timeout too.
// Ignored files (node_modules, build output) are not copied: a check that needs them installs them itself.
async function runIsolatedChecks(root, cmds, timeoutMs) {
  const top = await gitTop(root);
  if (!top) return { pass: false, cmd: cmds[0], output: `refused to run a sensitive check outside an isolated git worktree: ${root} is not a git repository with a commit` };
  await git(['worktree', 'prune'], top); // entries left by a driver that was killed mid-check
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tforge-check-'));
  const wt = path.join(parent, 'wt');
  try {
    const add = await git(['worktree', 'add', '--detach', '--quiet', wt, 'HEAD'], top);
    if (add.code !== 0) return { pass: false, cmd: cmds[0], output: `could not create a worktree for the check:\n${tail(add.stderr || add.stdout)}` };
    await syncTree(top, wt);
    return await runChecks(path.join(wt, path.relative(top, fs.realpathSync(root))), cmds, timeoutMs);
  } catch (e) {
    return { pass: false, cmd: cmds[0], output: `isolated check failed to run: ${e.message}` };
  } finally {
    await git(['worktree', 'remove', '--force', wt], top);
    fs.rmSync(parent, { recursive: true, force: true });
    await git(['worktree', 'prune'], top);
  }
}

async function runChecks(root, cmds, timeoutMs, { isolate = false } = {}) {
  if (isolate && cmds.length) return runIsolatedChecks(root, cmds, timeoutMs);
  for (const cmd of cmds) {
    const r = await runShell(cmd, { cwd: root, timeoutMs });
    if (r.code !== 0) {
      const why = r.timedOut ? `(timed out after ${timeoutMs / 1000}s)\n` : '';
      return { pass: false, cmd, output: `$ ${cmd}\n${why}${tail(r.stdout + '\n' + r.stderr)}` };
    }
  }
  return { pass: true };
}

function makeLogger(quiet) {
  return (line) => {
    if (!quiet) process.stdout.write(line + '\n');
  };
}

async function attemptTask(ctx, task, running) {
  const { root, plan, log, ledgerFile } = ctx;
  const d = plan.defaults;
  const base = task.model || d.model;
  const retries = task.retries ?? d.retries;
  const total = { cost: 0, weighted: 0, turns: 0, attempts: 0, peakCtx: 0 };
  let failure = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const escalated = attempt === retries && retries > 0 && (task.escalate ?? d.escalate);
    const model = escalated ? nextModel(base) : base;
    const prompt = buildTaskPrompt(root, plan, task, { failure, attempt });
    log(`  > ${task.id} [${model}] attempt ${attempt + 1}/${retries + 1}`);
    const before = snapshot(root);
    // Any task whose worker overlaps this one in time may legitimately write its own files meanwhile.
    const win = { files: ownedPaths(task), end: null };
    const overlapping = new Set(ctx.windows.filter((x) => x.end === null));
    ctx.windows.push(win);
    for (const open of ctx.onStart) open.add(win);
    ctx.onStart.add(overlapping);
    const w = await runWorker(ctx, task, model, prompt, { escalated });
    win.end = Date.now();
    ctx.onStart.delete(overlapping);
    const after = snapshot(root);
    const owned = new Set([...overlapping].flatMap((x) => x.files).concat(ownedPaths(task)));
    const strays = changedFiles(before, after).filter((f) => !owned.has(f));
    total.cost += w.cost;
    total.weighted += weighted(w.usage);
    total.turns += w.turns;
    total.attempts++;
    total.peakCtx = Math.max(total.peakCtx, contextTokens(w.usage));
    const rec = {
      ts: new Date().toISOString(), task: task.id, attempt: attempt + 1, model, ms: w.ms, turns: w.turns,
      costUsd: w.cost, usage: w.usage, promptChars: prompt.length, strays,
    };
    if (strays.length) log(`  ! ${task.id} touched files it does not own: ${strays.join(', ')}`);
    if (!w.ok) {
      appendJsonl(ledgerFile, { ...rec, outcome: 'worker-error', error: w.error });
      log(`  x ${task.id} worker error: ${w.error}`);
      failure = `worker error: ${w.error}`;
      continue;
    }
    const missing = ownedPaths(task).filter((f) => !fs.existsSync(path.join(root, f)));
    let check = missing.length
      ? { pass: false, output: `owned files were not written: ${missing.join(', ')}` }
      : await runChecks(root, task.verify ? [task.verify] : [], d.verifyTimeoutMin * 60000, { isolate: isolated(plan, task) });
    if (w.blocked && !check.pass) {
      appendJsonl(ledgerFile, { ...rec, outcome: 'blocked', error: w.blocked });
      log(`  x ${task.id} ${w.blocked}`);
      return { ok: false, reason: w.blocked, ...total };
    }
    appendJsonl(ledgerFile, { ...rec, outcome: check.pass ? 'pass' : 'verify-fail', error: check.pass ? undefined : tail(check.output, 15, 1200) });
    if (check.pass) return { ok: true, ...total };
    log(`  x ${task.id} checks failed (attempt ${attempt + 1})`);
    failure = check.output;
  }
  return { ok: false, reason: 'checks still failing after retries', lastFailure: failure, ...total };
}

function pathsMentioned(text, candidates) {
  return candidates.filter((f) => text.includes(f));
}

async function integrate(ctx, results) {
  const { root, plan, log } = ctx;
  const d = plan.defaults;
  const timeout = d.verifyTimeoutMin * 60000;
  let check = await runChecks(root, [plan.verify], timeout, { isolate: isolated(plan) });
  if (check.pass) {
    log(`  ok final check: ${plan.verify}`);
    return { ok: true };
  }
  const allFiles = plan.tasks.flatMap(ownedPaths);
  for (let i = 0; i < (ctx.integrateRetries ?? d.retries); i++) {
    const hit = pathsMentioned(check.output, allFiles);
    const task = {
      id: `integrate-${i + 1}`,
      spec: `The project's final check failed. Fix the integration errors shown below with the smallest correct change. You may edit any owned file. Never weaken, skip, or delete tests to make them pass.`,
      files: allFiles,
      reads: [],
      model: d.integrateModel,
    };
    // Inline only the files the failure mentions; the rest stay readable on demand.
    const prompt = buildTaskPrompt(root, plan, task, { failure: check.output, attempt: i, inlineOwned: hit.length ? hit : allFiles.slice(0, 8) });
    log(`  > ${task.id} [${task.model}] fixing final check`);
    const w = await runWorker(ctx, task, task.model, prompt);
    results.set(task.id, { ok: w.ok, cost: w.cost, weighted: weighted(w.usage), turns: w.turns, attempts: 1, peakCtx: contextTokens(w.usage) });
    appendJsonl(ctx.ledgerFile, {
      ts: new Date().toISOString(), task: task.id, attempt: 1, model: task.model, ms: w.ms, turns: w.turns, costUsd: w.cost, usage: w.usage, outcome: w.ok ? 'ran' : 'worker-error', error: w.error || undefined,
    });
    check = await runChecks(root, [plan.verify], timeout, { isolate: isolated(plan) });
    if (check.pass) {
      log(`  ok final check after ${task.id}`);
      return { ok: true };
    }
  }
  return { ok: false, output: check.output };
}

export async function runPlan(root, opts = {}) {
  const plan = loadPlan(root);
  const log = makeLogger(opts.quiet);
  const dir = path.join(root, FORGE_DIR);
  const stateFile = path.join(dir, 'state.json');
  const state = readJson(stateFile, { tasks: {} });
  const fp = fingerprints(plan);
  const only = opts.only?.length ? new Set(opts.only) : null;
  const force = new Set(opts.force || []);
  const systemFile = path.join(dir, '.worker-system.md');
  fs.writeFileSync(systemFile, buildSystemPrompt(root, plan));
  const ctx = {
    root, plan, log, systemFile,
    claudeBin: opts.claudeBin || process.env.TFORGE_CLAUDE || 'claude',
    ledgerFile: path.join(dir, 'ledger.jsonl'),
    integrateRetries: opts.integrateRetries,
    windows: [],
    onStart: new Set(),
  };
  const t0 = Date.now();
  const results = new Map();
  const isDone = (id) => state.tasks[id]?.status === 'done' && state.tasks[id].fp === fp.get(id);
  const order = topoOrder(plan.tasks);
  const pending = order.filter((t) => {
    if (only && !only.has(t.id)) return false;
    if (force.has(t.id) || opts.forceAll) return true;
    return !isDone(t.id);
  });
  const skipped = order.length - pending.length;
  for (const w of plan.warnings || []) log(`  ! ${w}`);
  // Refuse before any worker spends money: a sensitive check never falls back to running in the checkout.
  const needsIsolation = pending.some((t) => t.verify && isolated(plan, t)) || (plan.isolateChecks && plan.verify && !opts.noIntegrate);
  if (needsIsolation && !opts.dryRun && !(await gitTop(root))) {
    const which = plan.isolateChecks ? 'the plan sets "isolateChecks"' : `sensitive task(s): ${pending.filter((t) => t.verify && isolated(plan, t)).map((t) => t.id).join(', ')}`;
    throw new Error(`${which}, whose checks run only in a temporary git worktree, and ${root} is not a git repository with a commit (git init && git commit first)`);
  }
  log(`tforge: ${pending.length} task(s) to run, ${skipped} up to date or filtered, concurrency ${opts.concurrency || 2}`);
  if (opts.dryRun) {
    for (const t of pending) {
      const p = buildTaskPrompt(root, plan, t);
      log(`  - ${t.id} [${t.model || plan.defaults.model}] prompt ~${fmtTokens(Math.round(p.length / 4))} est. tokens, owns ${t.files.join(', ')}`);
    }
    const sys = fs.readFileSync(systemFile, 'utf8');
    log(`  shared system prompt ~${fmtTokens(Math.round(sys.length / 4))} est. tokens (cached across workers)`);
    return { ok: true, dryRun: true };
  }
  const running = new Map();
  const failed = new Set();
  const queue = [...pending];
  const concurrency = Math.max(1, opts.concurrency || 2);
  await new Promise((resolveAll) => {
    const pump = () => {
      for (let i = 0; i < queue.length && running.size < concurrency; ) {
        const t = queue[i];
        const deps = t.deps || [];
        if (deps.some((dep) => failed.has(dep))) {
          queue.splice(i, 1);
          failed.add(t.id);
          state.tasks[t.id] = { status: 'blocked', fp: fp.get(t.id) };
          log(`  - ${t.id} skipped: a dependency failed`);
          continue;
        }
        const ready = deps.every((dep) => isDone(dep) || results.get(dep)?.ok);
        const waitingOnQueued = deps.some((dep) => queue.some((q) => q.id === dep) || running.has(dep));
        if (!ready && !waitingOnQueued) {
          // Dependency outside this run (filtered by --only) and never completed.
          queue.splice(i, 1);
          failed.add(t.id);
          log(`  - ${t.id} skipped: dependency not done (run it first)`);
          continue;
        }
        if (!ready) {
          i++;
          continue;
        }
        queue.splice(i, 1);
        running.set(t.id, t);
        attemptTask(ctx, t, running).then((r) => {
          running.delete(t.id);
          results.set(t.id, r);
          state.tasks[t.id] = { status: r.ok ? 'done' : 'failed', fp: fp.get(t.id), attempts: r.attempts, costUsd: r.cost, reason: r.reason };
          writeJsonAtomic(stateFile, state);
          if (r.ok) log(`  ok ${t.id}: ${r.attempts} attempt(s), ${r.turns} turns, peak ctx ${fmtTokens(r.peakCtx)}, ${fmtUsd(r.cost)}`);
          else failed.add(t.id);
          pump();
        });
      }
      if (running.size === 0 && queue.length === 0) resolveAll();
    };
    pump();
  });
  writeJsonAtomic(stateFile, state);
  const allDone = order.every((t) => isDone(t.id));
  let final = { ok: allDone };
  if (allDone && plan.verify && !opts.noIntegrate) final = await integrate(ctx, results);
  const sum = [...results.values()].reduce(
    (a, r) => ({ cost: a.cost + (r.cost || 0), weighted: a.weighted + (r.weighted || 0), turns: a.turns + (r.turns || 0) }),
    { cost: 0, weighted: 0, turns: 0 },
  );
  const ok = [...results.entries()].filter(([id, r]) => r.ok && !id.startsWith('integrate-')).length;
  log(
    `tforge: ${ok}/${pending.length} task(s) passed, ${failed.size} failed or blocked, final check ${!plan.verify ? 'none' : !allDone || opts.noIntegrate ? 'not run' : final.ok ? 'passed' : 'FAILED'}` +
      ` | ${sum.turns} turns, ${fmtTokens(Math.round(sum.weighted))} input-equiv tokens, ${fmtUsd(sum.cost)}, ${Math.round((Date.now() - t0) / 1000)}s`,
  );
  if (final.output) log(`  final check still failing after integration:\n${tail(final.output, 25, 2500).replace(/^/gm, '    ')}`);
  if (failed.size) {
    for (const id of failed) {
      const r = results.get(id);
      if (r?.lastFailure) log(`  ${id}: ${r.reason}\n${tail(r.lastFailure, 12, 1200).replace(/^/gm, '    ')}`);
      else if (r?.reason) log(`  ${id}: ${r.reason}`);
    }
  }
  return { ok: failed.size === 0 && final.ok, failed: [...failed], cost: sum.cost };
}

export { MODELS };
