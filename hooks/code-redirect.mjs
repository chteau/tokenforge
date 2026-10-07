// PreToolUse for Grep and Read: answer code lookups from the tmap index instead of raw search output or whole files.
// Escape hatch: repeating the identical call goes through, so literal-text searches and full reads stay possible.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { existingBinary } from '../lib/tmapbin.mjs';

const CODE_EXT = /\.(rs|ts|mts|cts|tsx|js|jsx|mjs|cjs|py|pyi|go)$/;
const BIG_FILE_LINES = Number(process.env.TFORGE_READ_OUTLINE_LINES) || 250;
const REGEX_WORDS = new Set(['fn', 'def', 'class', 'struct', 'impl', 'pub', 'let', 'const', 'function', 'async', 'self', 'this', 'return', 'type', 'enum', 'trait', 'mod', 'use', 'import', 'from', 'export', 'new']);

function deny(event, reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: reason } }));
}

// First call is redirected; an identical second call in the same session is let through.
function seenBefore(sessionId, key) {
  const dir = path.join(os.tmpdir(), `tokenforge-${process.getuid?.() ?? 'u'}`);
  const file = path.join(dir, `${String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '')}-redirect.json`);
  let seen = [];
  try {
    seen = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  const h = createHash('sha1').update(key).digest('hex').slice(0, 16);
  if (seen.includes(h)) return true;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify([...seen.slice(-200), h]));
  } catch {}
  return false;
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

main();
