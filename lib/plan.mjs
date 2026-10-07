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
  if (plan.verify !== undefined && !isStr(plan.verify)) errors.push('verify: string command');
  const d = plan.defaults || {};
  if (d.model !== undefined && !MODELS.includes(d.model)) errors.push(`defaults.model: one of ${MODELS.join('|')}`);
  for (const k of ['effort', 'escalateEffort']) if (d[k] !== undefined && !EFFORTS.includes(d[k])) errors.push(`defaults.${k}: one of ${EFFORTS.join('|')}`);
  if (d.thinking !== undefined && typeof d.thinking !== 'boolean' && d.thinking !== 'auto') errors.push('defaults.thinking: true, false or "auto"');
  if (d.tools !== undefined && !(isStrArr(d.tools) && d.tools.every((t) => WORKER_TOOLS.includes(t))))
    errors.push(`defaults.tools: subset of ${WORKER_TOOLS.join(',')}`);
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
    if (t.verify !== undefined && !isStr(t.verify)) errors.push(`${w}: verify must be a command string`);
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
