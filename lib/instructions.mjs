// AGENTS.md and CLAUDE.md for every agent, compact and cached. Claude Code loads the CLAUDE.md chain itself, but its
// agents-md plugin (default mode) skips AGENTS.md in any project that has a CLAUDE.md, nested instruction files load
// only when the Read tool reaches their directory (never through tread, Bash, Grep or edits), and tforge workers
// (--setting-sources '') get none. digest() is what a session or worker starts without, nestedFor() what a tool call
// reached. Same files, same bytes: the text stays in the prompt cache, and no agent spends calls reading them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isOff, stateDir } from './hookutil.mjs';
import { configDir } from './meter.mjs';
import { cacheBase } from './usage.mjs';
import { sha } from './util.mjs';

const AGENTS = ['AGENTS.md', '.claude/AGENTS.md'];
const CLAUDE = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];
// cc-plugin-agents-md modes, and the aliases its projectInstructions option takes
const MODES = ['claude-md', 'claude-md-or-agents-md', 'claude-md-and-agents-md', 'managed-only'];
const [CLAUDE_ONLY, FALLBACK, BOTH, NONE] = MODES;
const ALIASES = { none: NONE, claude: CLAUDE_ONLY, 'agents-fallback': FALLBACK, both: BOTH };
const MANAGED =
  { win32: 'C:\\Program Files\\ClaudeCode\\managed-settings.json', darwin: '/Library/Application Support/ClaudeCode/managed-settings.json' }[process.platform] ??
  '/etc/claude-code/managed-settings.json';
const MAX_CHARS = 20000;
const STUB_CHARS = 2000; // a file this short that names another instruction file points to it
const LONG = 60; // shorter blocks (headings, one-line rules) may repeat on purpose
const POINTER = /[\w./-]*(?:AGENTS|CLAUDE)(?:\.local)?\.md\b/g;
const HEADER = 'tokenforge: project instruction files Claude Code did not load. Follow them; they are in context, so do not Read them.';
const NESTED_HEADER = 'tokenforge: instruction files of the directories this call reached. Follow them there; do not Read them.';
// Explore and Plan run without CLAUDE.md by design (omitClaudeMd).
export const OMITS_INSTRUCTIONS = new Set(['Explore', 'Plan']);
// Hook state per agent: { root: its starting directory, which scopes nested files; loaded: the nested instruction
// files already in its context }.
const safe = (s) => String(s).replace(/[^\w-]/g, '');
const givenFile = (sessionId, agentId) => path.join(stateDir(), `${safe(sessionId || 'unknown')}-${safe(agentId || 'main')}-instr.json`);
export function readGiven(sessionId, agentId) {
  try {
    return JSON.parse(fs.readFileSync(givenFile(sessionId, agentId), 'utf8'));
  } catch {
    return {};
  }
}
export function writeGiven(sessionId, agentId, state) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(givenFile(sessionId, agentId), JSON.stringify(state));
  } catch {}
}

const stat = (p) => {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
};
const isFile = (p) => !!stat(p)?.isFile();
const inside = (root, p) => {
  const rel = path.relative(root, p);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};

// The agents-md plugin's mode as Claude Code resolves it: options from user, then managed settings (project settings
// are not read); projectInstructions (an alias) counts only while instructionFiles is the default.
export function instructionMode() {
  let opts = {};
  for (const file of [path.join(configDir(), 'settings.json'), MANAGED]) {
    let cfgs = {};
    try {
      cfgs = JSON.parse(fs.readFileSync(file, 'utf8')).pluginConfigs || {};
    } catch {}
    for (const [id, c] of Object.entries(cfgs)) if (/^cc-plugin-agents-md(@|$)/.test(id)) opts = { ...opts, ...c?.options };
  }
  const files = MODES.includes(opts.instructionFiles) ? opts.instructionFiles : FALLBACK;
  const alias = opts.projectInstructions === undefined ? undefined : (ALIASES[opts.projectInstructions] ?? CLAUDE_ONLY);
  return alias !== undefined && files === FALLBACK ? alias : files;
}

// Instruction files in `dir`; the user's own CLAUDE.md is Claude Code's user memory, not a project file.
const filesIn = (dir, names) => names.map((n) => path.join(dir, n)).filter((p) => p !== path.join(configDir(), 'CLAUDE.md') && isFile(p));

// `dir` and its ancestors, outermost first, without the filesystem root (Claude Code's walk).
function chain(dir) {
  const out = [];
  for (let d = path.resolve(dir); d !== path.parse(d).root; d = path.dirname(d)) out.unshift(d);
  return out;
}

// Directories strictly below `root`, down to `dir`.
function below(root, dir) {
  const rel = path.relative(root, dir);
  if (!rel || !inside(root, dir)) return [];
  const parts = rel.split(path.sep);
  return parts.map((_, i) => path.join(root, ...parts.slice(0, i + 1)));
}

export const isClaudeProject = (cwd) => chain(cwd).some((d) => filesIn(d, CLAUDE).length > 0);

// Text as blocks (paragraphs, whole code fences), compacted outside code: HTML comments, badge-only lines, trailing
// spaces, blank runs and table padding go; the wording stays.
export function blocks(text) {
  const out = [];
  let cur = [];
  let fence = null;
  let comment = false;
  const flush = () => {
    if (cur.length) out.push(cur.join('\n'));
    cur = [];
  };
  for (const raw of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      cur.push(raw);
      const m = /^\s*(`{3,}|~{3,})\s*$/.exec(raw);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length) (fence = null), flush();
      continue;
    }
    let line = raw;
    if (comment) {
      const end = line.indexOf('-->');
      if (end < 0) continue;
      comment = false;
      line = line.slice(end + 3);
    }
    line = line.replace(/<!--.*?-->/g, '');
    if (line.includes('<!--')) (comment = true), (line = line.slice(0, line.indexOf('<!--')));
    line = line.trimEnd();
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (open) {
      flush();
      fence = open[1];
      cur.push(line);
    } else if (!line) {
      if (!raw.trim()) flush(); // a blank line ends a paragraph, a line that only held a comment does not
    } else if (!/^\s*(\[?!\[[^\]]*\]\([^)]*\)\]?(\([^)]*\))?\s*)+$/.test(line)) {
      if (/^\s*\|/.test(line)) {
        line = line.replace(/\s*(?<!\\)\|\s*/g, '|');
        if (/^\|(:?-+:?\|)+$/.test(line)) line = line.replace(/:?-+:?/g, '-');
      }
      cur.push(line);
    }
  }
  flush();
  return out;
}

// blocks() of a file, cached by path, size and mtime.
function blocksOf(file) {
  const st = stat(file);
  if (!st) return [];
  const cache = path.join(cacheBase(), 'instr', `${sha(file, st.size, st.mtimeMs)}.json`);
  try {
    return JSON.parse(fs.readFileSync(cache, 'utf8'));
  } catch {}
  let out = [];
  try {
    out = blocks(fs.readFileSync(file, 'utf8'));
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, JSON.stringify(out));
  } catch {}
  return out;
}

// Files an instruction file imports with `@path` (outside code), as Claude Code does.
function atRefs(file) {
  const prose = blocksOf(file)
    .filter((b) => !/^\s*(`{3}|~{3})/.test(b))
    .join('\n')
    .replace(/`[^`\n]*`/g, '');
  return [...prose.matchAll(/(?<![^\s(])@(~?[\w./-]+)/g)]
    .map((m) => m[1].replace(/\.+$/, ''))
    .map((r) => (r.startsWith('~/') ? path.join(os.homedir(), r.slice(2)) : path.resolve(path.dirname(file), r)))
    .filter(isFile);
}

// Each file followed by the files it imports, recursively (depth 5, like Claude Code).
function expand(list, seen = new Set(), depth = 0) {
  return list.flatMap((f) => (seen.has(f) ? [] : (seen.add(f), [f, ...(depth < 5 ? expand(atRefs(f), seen, depth + 1) : [])])));
}

// A short file naming another instruction file ("Read agents/AGENTS.md first") points to it: its targets inside
// `root` belong with it. Longer files name others in passing ("each repo has its own CLAUDE.md").
function pointed(file, root) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {}
  if (!text || text.length > STUB_CHARS) return [];
  return [...text.matchAll(POINTER)].map((m) => path.resolve(path.dirname(file), m[0])).filter((p) => p !== file && inside(root, p) && isFile(p));
}

// "Contents of <path>:" sections, as Claude Code renders its own, without what is already in context (`known` files,
// earlier sections): a file all of whose blocks are known is skipped, a long block shows once. At most MAX_CHARS.
function render(list, known = []) {
  const seen = new Set(known.flatMap(blocksOf));
  let left = MAX_CHARS;
  const out = [];
  for (const f of list) {
    const bs = blocksOf(f);
    if (bs.every((b) => seen.has(b))) continue;
    const kept = [];
    for (const b of bs) if (b.length < LONG || !seen.has(b)) kept.push(b), seen.add(b);
    if (left <= 0) {
      out.push(`(not shown, over the size cap: ${f})`);
      continue;
    }
    let body = kept.join('\n\n');
    if (body.length > left) {
      const cut = body.lastIndexOf('\n', left);
      body = `${body.slice(0, cut > 0 ? cut : left)}\n[truncated: Read ${f} for the rest]`;
    }
    left -= body.length;
    out.push(`Contents of ${f}:\n\n${body}`);
  }
  return out.join('\n\n');
}

// What a session starting in `cwd` lacks. With `engine` (Claude Code loads the CLAUDE.md chain): the AGENTS.md files
// its agents-md plugin leaves out (all of them in a project with a CLAUDE.md), unless the mode is claude-md. Without
// it (tforge workers): the whole chain, imports expanded. Plus what short pointer files among them name.
export function digest(cwd, { engine = true, mode = instructionMode() } = {}) {
  if (isOff('TFORGE_INSTRUCTIONS') || mode === NONE) return '';
  const dirs = chain(cwd);
  const claudes = dirs.flatMap((d) => filesIn(d, CLAUDE));
  const agentsOf = (d) => (mode === CLAUDE_ONLY ? [] : filesIn(d, AGENTS));
  const engineAgents = mode === BOTH || (mode === FALLBACK && !claudes.length) ? dirs.flatMap(agentsOf) : [];
  const loaded = new Set(engine ? expand([...claudes, ...engineAgents]) : []);
  const wanted = dirs.flatMap((d) => [...(engine ? [] : filesIn(d, CLAUDE)), ...agentsOf(d)]);
  const seen = new Set();
  const add = [];
  const visit = (f, depth = 0) => {
    if (seen.has(f) || depth > 5) return;
    seen.add(f);
    if (!loaded.has(f)) {
      add.push(f);
      for (const p of atRefs(f)) visit(p, depth + 1);
    }
    for (const p of pointed(f, cwd)) visit(p, depth + 1);
  };
  for (const f of [...loaded, ...wanted]) visit(f);
  const body = add.length ? render(add, [...loaded]) : '';
  return body && `${HEADER}\n\n${body}`;
}

// Nested instruction files (directories strictly below `root`, as Claude Code scopes them) for the paths a tool call
// reached, minus `given`: files already in this agent's context, updated in place. Claude Code's Read loads nested
// CLAUDE files itself, and AGENTS.md as its mode says; every other tool loads none.
export function nestedFor(root, paths, { tool, given, mode } = {}) {
  if (isOff('TFORGE_INSTRUCTIONS')) return '';
  const dirs = [...new Set(paths.flatMap((p) => below(root, stat(p)?.isDirectory() ? p : path.dirname(p))))];
  const found = dirs.map((d) => [filesIn(d, CLAUDE), filesIn(d, AGENTS)]).filter(([c, a]) => c.length || a.length);
  if (!found.length) return '';
  mode ??= instructionMode();
  if (mode === NONE) return '';
  const claudeProject = tool === 'Read' && mode === FALLBACK && isClaudeProject(root);
  const known = [...given];
  const add = [];
  for (const [claudes, all] of found) {
    const agents = mode === CLAUDE_ONLY ? [] : all;
    const engine = tool !== 'Read' ? [] : [...claudes, ...(mode === BOTH || (mode === FALLBACK && !claudeProject && !claudes.length) ? agents : [])];
    for (const f of expand(engine)) if (!given.has(f)) given.add(f), known.push(f);
    for (const f of expand([...claudes, ...agents])) if (!given.has(f)) given.add(f), add.push(f);
  }
  const body = add.length ? render(add, known) : '';
  return body && `${NESTED_HEADER}\n\n${body}`;
}
