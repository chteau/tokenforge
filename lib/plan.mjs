import fs from 'node:fs';
import path from 'node:path';
import { FORGE_DIR, readJson } from './util.mjs';

export const MODELS = ['haiku', 'sonnet', 'opus'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const WORKER_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'];

export const DEFAULTS = {
  model: 'sonnet',
  integrateModel: 'sonnet',
  tools: ['Read', 'Write', 'Edit'],
  effort: 'low',
  escalateEffort: 'high',
  thinking: 'auto',
  maxTurns: 12,
  retries: 2,
  escalate: true,
  budgetUsd: 1.5,
  timeoutMin: 20,
  verifyTimeoutMin: 10,
  inlineMaxChars: 60000,
};

// Numeric settings and their bounds. A 0, negative or non-number timeout used to turn the time limit off.
const NUMBERS = {
  maxTurns: { min: 1, max: 500, int: true },
  retries: { min: 0, max: 10, int: true },
  budgetUsd: { min: 0.01, max: 1000 },
  timeoutMin: { min: 0.01, max: 1440 },
  verifyTimeoutMin: { min: 0.01, max: 1440 },
  inlineMaxChars: { min: 0, max: 10_000_000, int: true },
};
function checkNumber(v, { min, max, int }) {
  if (typeof v !== 'number' || !Number.isFinite(v) || (int && !Number.isInteger(v))) return `must be ${int ? 'an integer' : 'a number'}`;
  if (v < min || v > max) return `must be between ${min} and ${max}`;
  return null;
}

export function planPath(root) {
  return path.join(root, FORGE_DIR, 'plan.json');
}

export function loadPlan(root) {
  const file = planPath(root);
  if (!fs.existsSync(file)) throw new Error(`no plan at ${file} (run: tforge init)`);
  const plan = readJson(file);
  const errors = validatePlan(plan, root);
  if (errors.length) throw new Error(`invalid plan:\n  - ${errors.join('\n  - ')}`);
  plan.defaults = { ...DEFAULTS, ...(plan.defaults || {}) };
  plan.warnings = planWarnings(plan);
  return plan;
}

const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const isStrArr = (v) => Array.isArray(v) && v.every(isStr);

// "src/a.rs:120-260" -> { file: "src/a.rs", from: 120, to: 260 }; plain paths have no range.
export function parseRef(ref) {
  const m = /^(.*):(\d+)-(\d+)$/.exec(ref);
  if (!m) return { file: ref };
  return { file: m[1], from: Number(m[2]), to: Number(m[3]) };
}

// A check is one shell command line. NUL can't reach a shell intact and a stray newline silently splits one check into
// several commands, so both are refused; a newline is accepted only as a backslash line continuation.
function checkVerify(cmd, where, errors) {
  if (cmd === undefined) return;
  if (!isStr(cmd)) return errors.push(`${where}: verify must be a non-empty command string`);
  if (cmd.includes('\0')) return errors.push(`${where}: verify contains a NUL byte`);
  if (/\r|(?<!\\)\n/.test(cmd.replace(/\n+$/, ''))) errors.push(`${where}: verify spans several lines; join the steps with && (or end a line with \\ to continue it)`);
}

// Obviously destructive or remote side effects in a check: reported, never refused (a plan may mean it).
const RISKY = [
  [/\brm\s+(-\w+\s+)*-\w*[rRf]\w*\s+(-\w+\s+)*(\/|~\/?|\$HOME\/?|\/\*)(\s|$|;|&|\|)/, 'removes the root or home directory'],
  [/\bgit\s+push\b/, 'pushes to a remote'],
  [/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, 'pipes a download into a shell'],
  [/(^|[\s;&|(])sudo\s/, 'runs sudo'],
  [/\bmkfs\b|\bdd\s[^|;&]*\bof=\/dev\//, 'writes a device'],
];

export function verifyWarnings(cmd) {
  if (typeof cmd !== 'string') return [];
  return RISKY.filter(([re]) => re.test(cmd)).map(([, why]) => why);
}

export function planWarnings(plan) {
  const out = [];
  const add = (where, cmd) => {
    for (const why of verifyWarnings(cmd)) out.push(`${where}: verify ${why}: ${cmd}`);
  };
  add('plan', plan.verify);
  for (const t of plan.tasks || []) add(`task ${t.id}`, t.verify);
  return out;
}

// Workers or inline? Workers pay off when tasks are many, independent and each needs a small part of the project; a
// worker re-reads its context from scratch, so few files, a serial chain of tasks, or tasks that each need most of the
// planned context cost more than one session doing the work. A recommendation printed by `tforge validate`, never a
// refusal. Thresholds follow what was measured so far (inline below about 5 files; small greenfield builds about 1.5x
// costlier with workers); the strategy benchmark will tune them.
export function strategyAdvice(plan, root) {
  const tasks = plan.tasks || [];
  const size = (ref) => {
    const { file, from, to } = parseRef(ref);
    try {
      const text = fs.readFileSync(path.join(root || '.', file), 'utf8');
      return from ? text.split('\n').slice(from - 1, to).join('\n').length : text.length;
    } catch {
      return 0;
    }
  };
  const owned = new Set(tasks.flatMap((t) => (t.files || []).map((f) => parseRef(f).file)));
  // longest chain of dependencies, in tasks
  const depth = new Map();
  const chain = (t, seen = new Set()) => {
    if (depth.has(t.id)) return depth.get(t.id);
    if (seen.has(t.id)) return 1;
    seen.add(t.id);
    const d = 1 + Math.max(0, ...(t.deps || []).map((id) => tasks.find((x) => x.id === id)).filter(Boolean).map((x) => chain(x, seen)));
    depth.set(t.id, d);
    return d;
  };
  const longest = Math.max(0, ...tasks.map((t) => chain(t)));
  // what each worker starts with (context, its reads, its existing owned files) against all of it once
  const ctx = (plan.context || []).reduce((a, f) => a + size(f), 0);
  const refs = (t) => [...(t.reads || []), ...(t.files || [])];
  const perTask = tasks.map((t) => ctx + refs(t).reduce((a, f) => a + size(f), 0));
  const all = ctx + [...new Set(tasks.flatMap(refs))].reduce((a, f) => a + size(f), 0);
  const share = all ? perTask.reduce((a, b) => a + b, 0) / tasks.length / all : 0;
  const facts = `${owned.size} file(s), ${tasks.length} task(s), longest dependency chain ${longest} of ${tasks.length}${all ? `, each worker starts with ${Math.round(share * 100)}% of the planned context on average` : ''}`;
  const why = [];
  if (owned.size < 5) why.push('fewer than 5 files');
  if (tasks.length < 3) why.push('fewer than 3 tasks');
  if (tasks.length > 1 && tasks.length <= 5 && longest === tasks.length) why.push('the tasks run one after another, so nothing runs in parallel');
  if (tasks.length > 1 && all > 20000 && share > 0.6) why.push('each worker needs most of the planned context, which it would read again');
  return why.length ? { strategy: 'inline', facts, why } : { strategy: 'workers', facts, why: [] };
}

// Tasks whose checks run in a throwaway git worktree instead of the checkout.
export const isolated = (plan, task) => !!(plan.isolateChecks || task?.sensitive);

function checkRelPath(ref, root, where, errors) {
  const { file: p, from, to } = parseRef(ref);
  if (from !== undefined && !(from >= 1 && to >= from)) errors.push(`${where}: bad line range in ${ref}`);
  if (path.isAbsolute(p) || p.split(/[\\/]/).includes('..')) {
    errors.push(`${where}: path must stay inside the project: ${p}`);
    return;
  }
  if (root && !path.resolve(root, p).startsWith(path.resolve(root))) errors.push(`${where}: path escapes project: ${p}`);
}

export function validatePlan(plan, root) {
  const errors = [];
  if (!plan || typeof plan !== 'object') return ['plan must be a JSON object'];
  if (plan.version !== 1) errors.push('version must be 1');
  if (!isStr(plan.goal)) errors.push('goal: required string');
  if (plan.context !== undefined && !isStrArr(plan.context)) errors.push('context: array of paths');
  for (const p of plan.context || []) checkRelPath(p, root, 'context', errors);
  checkVerify(plan.verify, 'plan', errors);
  if (plan.isolateChecks !== undefined && typeof plan.isolateChecks !== 'boolean') errors.push('isolateChecks must be boolean');
  const d = plan.defaults || {};
  if (d.model !== undefined && !MODELS.includes(d.model)) errors.push(`defaults.model: one of ${MODELS.join('|')}`);
  for (const k of ['effort', 'escalateEffort']) if (d[k] !== undefined && !EFFORTS.includes(d[k])) errors.push(`defaults.${k}: one of ${EFFORTS.join('|')}`);
  if (d.thinking !== undefined && typeof d.thinking !== 'boolean' && d.thinking !== 'auto') errors.push('defaults.thinking: true, false or "auto"');
  if (d.tools !== undefined && !(isStrArr(d.tools) && d.tools.every((t) => WORKER_TOOLS.includes(t))))
    errors.push(`defaults.tools: subset of ${WORKER_TOOLS.join(',')}`);
  for (const [k, v] of Object.entries(d)) if (NUMBERS[k] && checkNumber(v, NUMBERS[k])) errors.push(`defaults.${k}: ${checkNumber(v, NUMBERS[k])}`);
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    errors.push('tasks: non-empty array required');
    return errors;
  }
  const ids = new Set();
  const owner = new Map();
  for (const [i, t] of plan.tasks.entries()) {
    const w = `tasks[${i}]${t && t.id ? ` (${t.id})` : ''}`;
    if (!t || typeof t !== 'object') {
      errors.push(`${w}: must be an object`);
      continue;
    }
    if (!isStr(t.id) || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(t.id)) errors.push(`${w}: id must match [a-z0-9._-]`);
    else if (ids.has(t.id)) errors.push(`${w}: duplicate id`);
    else ids.add(t.id);
    if (!isStr(t.spec)) errors.push(`${w}: spec required`);
    if (!isStrArr(t.files) || t.files.length === 0) errors.push(`${w}: files (owned paths) required`);
    for (const ref of t.files || []) {
      checkRelPath(ref, root, w, errors);
      const f = parseRef(ref).file;
      if (owner.has(f)) errors.push(`${w}: ${f} already owned by ${owner.get(f)} (one owner per file)`);
      else owner.set(f, t.id);
    }
    for (const k of ['reads', 'deps']) if (t[k] !== undefined && !isStrArr(t[k])) errors.push(`${w}: ${k} must be string array`);
    for (const f of t.reads || []) checkRelPath(f, root, w, errors);
    checkVerify(t.verify, w, errors);
    if (t.sensitive !== undefined && typeof t.sensitive !== 'boolean') errors.push(`${w}: sensitive must be boolean`);
    if (t.retries !== undefined && checkNumber(t.retries, NUMBERS.retries)) errors.push(`${w}: retries ${checkNumber(t.retries, NUMBERS.retries)}`);
    if (t.model !== undefined && !MODELS.includes(t.model)) errors.push(`${w}: model one of ${MODELS.join('|')}`);
    if (t.effort !== undefined && !EFFORTS.includes(t.effort)) errors.push(`${w}: effort one of ${EFFORTS.join('|')}`);
    if (t.thinking !== undefined && typeof t.thinking !== 'boolean') errors.push(`${w}: thinking must be boolean`);
    if (t.tools !== undefined && !(isStrArr(t.tools) && t.tools.every((x) => WORKER_TOOLS.includes(x))))
      errors.push(`${w}: tools subset of ${WORKER_TOOLS.join(',')}`);
  }
  for (const t of plan.tasks) for (const dep of t.deps || []) if (!ids.has(dep)) errors.push(`${t.id}: unknown dep ${dep}`);
  if (!errors.length) {
    try {
      topoOrder(plan.tasks);
    } catch (e) {
      errors.push(e.message);
    }
  }
  return errors;
}

export function topoOrder(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const order = [], state = new Map();
  const visit = (id, stack) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) throw new Error(`dependency cycle: ${[...stack, id].join(' -> ')}`);
    state.set(id, 1);
    for (const d of byId.get(id).deps || []) visit(d, [...stack, id]);
    state.set(id, 2);
    order.push(byId.get(id));
  };
  for (const t of tasks) visit(t.id, []);
  return order;
}

export function nextModel(m) {
  const i = MODELS.indexOf(m);
  return i >= 0 && i < MODELS.length - 1 ? MODELS[i + 1] : m;
}

export const EXAMPLE_PLAN = {
  version: 1,
  goal: 'Browser image editor with layers and three filters',
  context: ['src/contracts.ts', '.forge/cheats/konva.md'],
  verify: 'npx tsc --noEmit && npx vitest run',
  defaults: { model: 'sonnet', retries: 2 },
  tasks: [
    {
      id: 'layers-test',
      spec: 'Write vitest tests for LayerStack in src/contracts.ts: add, remove, reorder, visibility, opacity clamp 0..1.',
      files: ['src/layers.test.ts'],
      model: 'haiku',
    },
    {
      id: 'layers',
      spec: 'Implement LayerStack from src/contracts.ts. Pure TS, no DOM.',
      files: ['src/layers.ts'],
      reads: ['src/layers.test.ts'],
      deps: ['layers-test'],
      verify: 'npx vitest run src/layers.test.ts',
    },
  ],
};
