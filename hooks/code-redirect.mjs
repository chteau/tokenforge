// PreToolUse for Grep and Read: answer code lookups from the tmap index instead of raw search output or whole files.
// Escape hatch: repeating the identical call goes through, so literal-text searches and full reads stay possible.
// onBashGrep (called by kit-router.mjs for Bash) does the same for `grep`/`rg`/`git grep` of one code identifier.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { existingBinary } from '../lib/tmapbin.mjs';
import { deny, exeName, isMain, seenBefore, splitPipes, splitSegments, tokenize } from '../lib/hookutil.mjs';

const CODE_EXT = /\.(rs|ts|mts|cts|tsx|js|jsx|mjs|cjs|py|pyi|go)$/;
const BIG_FILE_LINES = Number(process.env.TFORGE_READ_OUTLINE_LINES) || 250;
const REGEX_WORDS = new Set(['fn', 'def', 'class', 'struct', 'impl', 'pub', 'let', 'const', 'function', 'async', 'self', 'this', 'return', 'type', 'enum', 'trait', 'mod', 'use', 'import', 'from', 'export', 'new']);

const COMMON = new Set(['warn', 'warning', 'error', 'errors', 'todo', 'fixme', 'panic', 'debug', 'info', 'test', 'tests', 'unwrap', 'expect', 'print',
  'println', 'console', 'return', 'async', 'await', 'import', 'export', 'class', 'struct', 'function', 'const', 'static', 'public', 'private',
  'string', 'number', 'true', 'false', 'null', 'none', 'self', 'this', 'main', 'init', 'new']);
const DOC_EXT = /\.(md|txt|json|ya?ml|toml|lock|log|csv|html?|xml|ini|cfg|env|sql)$|(^|[\\/])(README|CHANGELOG|LICENSE)/i;

// A bare code identifier (snake_case, camelCase, PascalCase with 2+ humps, a::b, name( ), not prose
// or a literal-text pattern. Returns the symbol or null. Stricter than patternWords: Bash greps are
// often deliberate literal searches.
export function symbolLike(p) {
  p = String(p || '').trim()
    .replace(/^(\\b|\\<|\^)|(\\b|\\>|\$)$/g, '')
    .replace(/\\?\([\w\s,&*.:]*\\?\)$/, '')
    .replace(/(\\\(|\()$/, '')
    .replace(/^(fn|def|func|function|class|struct|enum|trait|interface|type|impl)\s+/, '');
  if (!/^[A-Za-z_][A-Za-z0-9_]*(::[A-Za-z_][A-Za-z0-9_]*)*$/.test(p)) return null;
  const last = p.split('::').pop();
  if (last.length < 4 || COMMON.has(last.toLowerCase())) return null;
  if (last.replace(/^_+|_+$/g, '').includes('_') || /[a-z][A-Z]/.test(last) || p.includes('::')) return last;
  if (/^[A-Z][a-z0-9]+([A-Z][a-z0-9]*)+$/.test(last)) return last;
  return null;
}

// tokens of `grep|egrep|rg|git grep ...` -> { sym, refs } or null (case-insensitive, inverted, several
// patterns, file targets, doc/config targets and paths outside cwd are left alone).
export function parseGrep(t, cwd) {
  let args;
  if (exeName(t[0]) === 'git' && t[1] === 'grep') args = t.slice(2);
  else if (['grep', 'egrep', 'rg'].includes(exeName(t[0]))) args = t.slice(1);
  else return null;
  const pats = [];
  const paths = [];
  let refs = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      paths.push(...args.slice(i + 1));
      break;
    }
    if (a === '-e' || a === '--regexp') {
      pats.push(args[++i] ?? '');
      continue;
    }
    if (['-i', '--ignore-case', '-v', '--invert-match', '-f', '-P', '-z', '-L', '--files-without-match', '-F', '--fixed-strings'].includes(a)) return null;
    if (/^-[a-zA-Z]*[ivF]/.test(a) && !a.startsWith('--')) return null;
    if (['-l', '-c', '--count', '--files-with-matches'].includes(a) || /^-[a-zA-Z]*[lc][a-zA-Z]*$/.test(a)) refs = true;
    if (/^--(include|glob|type)=/.test(a) && DOC_EXT.test(a.split('=')[1].replace(/\*/g, ''))) return null;
    if (['-g', '--glob', '-t', '--type', '--include', '-A', '-B', '-C', '-m', '--max-count', '--exclude', '--exclude-dir'].includes(a)) {
      if (['-g', '--glob', '--include'].includes(a) && DOC_EXT.test(String(args[i + 1] || '').replace(/\*/g, ''))) return null;
      i++;
      continue;
    }
    if (a.startsWith('-')) continue;
    if (!pats.length) pats.push(a);
    else paths.push(a);
  }
  if (pats.length !== 1) return null;
  const root = path.resolve(cwd);
  for (const p of paths) {
    const ap = path.resolve(cwd, p);
    if (p.startsWith('~') || DOC_EXT.test(p) || (ap !== root && !ap.startsWith(root + path.sep))) return null;
    // a grep aimed at specific files wants those lines, not a repo-wide symbol answer
    if (!isDir(ap)) return null;
  }
  const sym = symbolLike(pats[0]);
  return sym ? { sym, refs } : null;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Bash: a command that is just one identifier grep (optionally `| head`) is answered by `tkit ctx`.
export function onBashGrep(input, bin = existingBinary()) {
  const cmd = String(input.tool_input?.command || '');
  const segs = splitSegments(cmd);
  if (!bin || !segs || segs.filter(([t]) => t.trim()).length !== 1) return;
  const pipes = splitPipes(segs[0][0]);
  if (pipes.length > 2 || (pipes[1] && !/^\s*(head|tail)(\s+-n?\s*\d+|\s+-\d+)?\s*$/.test(pipes[1]))) return;
  const toks = tokenize(pipes[0]);
  const cwd = input.cwd || process.cwd();
  const hit = toks && parseGrep(toks.filter((x) => !/^[A-Za-z_]\w*=/.test(x)), cwd);
  if (!hit || seenBefore(input.session_id, `bashgrep\0${cmd}`)) return;
  const out = tmap(bin, ['kit', 'ctx', ...(hit.refs ? ['--refs'] : []), hit.sym], cwd);
  if (!out) return;
  deny(
    'PreToolUse',
    `tokenforge: \`${hit.sym}\` is a code identifier, so the code index answered (tkit ctx${hit.refs ? ' --refs' : ''} ${hit.sym}), cheaper than grep output:\n${out}\n` +
      'Follow with `tkit ctx SYM`, `tmap callers SYM` or a Read of the line range. For literal text, prefix TFORGE_RAW=1 or repeat the same command.',
  );
}

function tmap(bin, args, cwd) {
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: 4000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Identifier-like words from a regex: "fn (new|update)\b|orbit_speed" -> update, orbit_speed.
export function patternWords(pattern) {
  if (/["'`]/.test(pattern) || pattern.length > 200) return [];
  const cleaned = pattern.replace(/\\[bBsSwWdD]/g, ' ').replace(/\\./g, ' ');
  const words = cleaned.split(/[^A-Za-z0-9_]+/).filter((w) => w.length >= 3 && !REGEX_WORDS.has(w) && !/^\d+$/.test(w));
  // Prose ("failed to connect") is a text search, not a symbol lookup.
  if (/[a-z]+ [a-z]+ [a-z]+/.test(pattern) && !/[_A-Z|]/.test(pattern)) return [];
  return [...new Set(words)].slice(0, 6);
}

function onGrep(input, bin) {
  const ti = input.tool_input || {};
  if (ti.glob && !/\.(rs|ts|tsx|js|jsx|mjs|py|go)\b|\*\*?$|\{/.test(ti.glob)) return;
  if (ti.type && !['rust', 'ts', 'js', 'py', 'go'].includes(ti.type)) return;
  if (ti.path && fs.existsSync(ti.path) && fs.statSync(ti.path).isFile() && !CODE_EXT.test(ti.path)) return;
  const words = patternWords(String(ti.pattern || ''));
  if (!words.length) return;
  if (seenBefore(input.session_id, `grep\0${ti.pattern}\0${ti.path || ''}\0${ti.glob || ''}`)) return;
  const args = ['find', ...words, '-n', '12'];
  if (ti.path && fs.existsSync(ti.path) && fs.statSync(ti.path).isDirectory()) args.push('--in', ti.path);
  const out = tmap(bin, args, input.cwd);
  if (!out) return;
  deny(
    'PreToolUse',
    `tokenforge: answered from the code index (tmap find ${words.join(' ')}), cheaper than grep output:\n${out}\n` +
      'Read only the line ranges you need. For literal text (strings, comments, config), repeat the same Grep call and it will run.',
  );
}

function onRead(input, bin) {
  const ti = input.tool_input || {};
  const file = ti.file_path;
  if (!file || ti.offset || ti.limit || !CODE_EXT.test(file)) return;
  let text;
  try {
    if (fs.statSync(file).size < BIG_FILE_LINES * 20) return;
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  if (lines <= BIG_FILE_LINES) return;
  if (seenBefore(input.session_id, `read\0${file}`)) return;
  const out = tmap(bin, ['tree', file], path.dirname(file));
  if (!out) return;
  const outline = out.split('\n');
  const shown = outline.length > 120 ? [...outline.slice(0, 120), `[+${outline.length - 120} more definitions]`].join('\n') : out;
  deny(
    'PreToolUse',
    `tokenforge: ${path.basename(file)} has ${lines} lines. Its outline (line ranges):\n${shown}\n` +
      'Read the ranges you need with offset/limit. If you really need the whole file, repeat the same Read and it will run.',
  );
}

function main() {
  // Opt-in: measured mixed (two small wins, one run where the agent worked around it and doubled its calls).
  if (process.env.TFORGE_REDIRECT !== '1') return;
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const bin = existingBinary();
  if (!bin) return;
  if (input.tool_name === 'Grep') onGrep(input, bin);
  else if (input.tool_name === 'Read') onRead(input, bin);
}

if (isMain(import.meta.url)) main();
