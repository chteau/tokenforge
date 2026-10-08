// Outline view of source files: what `cat` would print, with long definition bodies folded.
// Every tool result stays in context and is re-read on every later model call, so a 20k-char
// multi-file dump early in a session is paid for dozens of times. Small files and short
// definitions print in full; a long body keeps its signature and closing line, and the folded
// lines are replaced by the exact `sed -n` command that prints them.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { existingBinary } from './tmapbin.mjs';

export const FOLD_MIN = Number(process.env.TFORGE_VIEW_FOLD) || 8; // bodies longer than this fold
export const FILE_MIN = Number(process.env.TFORGE_VIEW_LINES) || 40; // shorter files print in full
// Only broad exploration dumps fold. A focused read (one file, or a few small ones) is usually the code
// being worked on: folding it just costs a follow-up call to fetch it back, and every call re-reads the
// whole context. Measured: folding 4-8k reads made short tasks dearer; folding 17-55k dumps made long ones cheaper.
export const TOTAL_MIN = Number(process.env.TFORGE_VIEW_CHARS) || 12000; // smaller requests print in full

// Parse `tmap tree FILE`: "  a-b signature" lines; indentation gives nesting.
export function outline(file) {
  const bin = existingBinary();
  if (!bin) return null;
  const r = spawnSync(bin, ['tree', path.resolve(file)], { encoding: 'utf8', timeout: 8000, cwd: path.dirname(path.resolve(file)) });
  if (r.status !== 0) return null;
  const items = [];
  for (const line of r.stdout.split('\n').slice(1)) {
    const m = /^(\s+)(\d+)-(\d+)\s/.exec(line);
    if (m) items.push({ depth: m[1].length, a: Number(m[2]), b: Number(m[3]) });
  }
  return items;
}

// Language-agnostic fallback for files tmap does not parse (Luau/Lua, Ruby, Java, C#, Kotlin, C/C++, PHP...):
// a definition line plus indentation gives the body. Same item shape as outline(): {depth, a, b}, 1-based, inclusive.
const DEF_KW = /\b(function|def|fn|func|fun|sub|procedure|class|module|impl|struct|enum|interface|trait|object|record|namespace)\b/;
const CONTROL = /^\s*(if|else|elseif|elif|for|foreach|while|do|switch|case|try|catch|finally|repeat|until|return|unless|with)\b/;
const SIGNATURE = /^\s*[\w$<>\[\],.:*&?@\s]+\([^;]*\)\s*(?:[\w<>\[\],.\s]*)?(?:->\s*[^{]+|:\s*[^{=]+|throws [\w., ]+)?\s*\{\s*$/;
const ARROW = /=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[^=]+)?=>\s*\{\s*$/;
const CLOSER = /^\s*(\}|end\b|\]|\)|};|end\)|}\))/;
const indentOf = (s) => /^[ \t]*/.exec(s)[0].replace(/\t/g, '    ').length;

export function heuristicOutline(lines) {
  const items = [];
  const isStart = (s) => {
    const t = s.replace(/\s*(\/\/|--|#).*$/, '');
    if (!t.trim() || CONTROL.test(t)) return false;
    return DEF_KW.test(t) || SIGNATURE.test(t) || ARROW.test(t);
  };
  for (let i = 0; i < lines.length; i++) {
    if (!isStart(lines[i])) continue;
    const ind = indentOf(lines[i]);
    let j = i + 1;
    // multi-line signatures: continuation lines indented deeper until the body opens
    while (j < lines.length && (!lines[j].trim() || indentOf(lines[j]) > ind)) j++;
    if (j === i + 1) continue; // no indented body: a declaration or one-liner
    const end = j < lines.length && indentOf(lines[j]) === ind && CLOSER.test(lines[j]) ? j : j - 1;
    let last = end;
    while (last > i && !lines[last].trim()) last--;
    if (last - i < 2) continue;
    items.push({ depth: ind, a: i + 1, b: last + 1 });
  }
  // nest: drop exact duplicates; an item inside another keeps a larger depth so foldRanges sees parents
  items.sort((x, y) => x.a - y.a || y.b - x.b);
  return items.map((it) => ({ ...it, depth: 2 + it.depth }));
}

// Ranges to fold: leaf definitions (no nested entries) longer than FOLD_MIN.
export function foldRanges(items) {
  const out = [];
  items.forEach((it, i) => {
    const next = items[i + 1];
    const hasChild = next && next.depth > it.depth && next.a >= it.a && next.b <= it.b;
    if (!hasChild && it.b - it.a + 1 > FOLD_MIN) out.push(it);
  });
  return out;
}

const OPENS = /[{:(\[]\s*$|=>\s*$|\bdo\s*$|=\s*$/;

// A dump this large folds every file with long bodies, not just long files.
export const LONG_LINE = Number(process.env.TFORGE_VIEW_LONG) || 400; // minified/generated/serialized lines

// Cut lines longer than LONG_LINE (minified bundles, generated tables, serialized data) to their start.
export function cutLongLines(out, display) {
  let cut = 0;
  const lines = out.split('\n').map((l, i) => {
    if (l.length <= LONG_LINE) return l;
    cut++;
    return `${l.slice(0, 200)} … [+${l.length - 200} chars: sed -n '${i + 1}p' ${display} | cut -c201-]`;
  });
  return { out: lines.join('\n'), cut };
}

export const BIG_TOTAL = Number(process.env.TFORGE_VIEW_BIG) || 24000;

// Documents are read for every word (proofreading, reviews): folding would hide exactly what is being checked.
export const PROSE = /\.(md|markdown|mdx|txt|tex|ltx|bib|rst|adoc|asciidoc|org|typ|rtf|html?|csv|tsv)$/i;

export function viewFile(file, display = file, fileMin = FILE_MIN) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  if (lines.length <= fileMin || PROSE.test(file)) return { out: text, folded: 0 };
  let items = outline(file);
  if (!items || !items.length) items = heuristicOutline(lines);
  if (!items.length) return { out: text, folded: 0 };
  const folds = foldRanges(items);
  if (!folds.length) return { out: text, folded: 0 };
  const res = [];
  let ln = 1;
  let folded = 0;
  for (const { a, b } of folds) {
    if (a < ln) continue;
    while (ln < a) res.push(lines[ln++ - 1]);
    // keep the signature: lines until its parentheses balance (multi-line parameter lists), plus a lone
    // `{` on the next line (Allman style). Works without knowing the language.
    let s = a;
    let depth = 0;
    for (;;) {
      for (const ch of lines[s - 1].replace(/(["'`]).*?\1/g, '')) depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
      if (depth <= 0 || s >= b - 1 || s >= a + 6) break;
      s++;
    }
    if (!OPENS.test(lines[s - 1]) && s < b - 1 && /^\s*\{\s*$/.test(lines[s])) s++;
    for (let k = a; k <= s; k++) res.push(lines[k - 1]);
    const from = s + 1;
    const to = b - 1;
    if (to >= from) {
      const indent = /^\s*/.exec(lines[from - 1] || '')[0] || '    ';
      res.push(`${indent}… ${to - from + 1} lines folded: sed -n '${from},${to}p' ${display}`);
      folded += to - from + 1;
    }
    res.push(lines[b - 1]);
    ln = b + 1;
  }
  while (ln <= lines.length) res.push(lines[ln++ - 1]);
  return { out: res.join('\n') + '\n', folded };
}

// `cat`-compatible: same order, no headers for a single small file. Returns the text to print.
export function view(files) {
  const total = files.reduce((n, f) => n + (fs.statSync(f).size || 0), 0);
  if (total <= TOTAL_MIN) return files.map((f) => fs.readFileSync(f, 'utf8')).join('');
  const fileMin = total > BIG_TOTAL ? FOLD_MIN * 2 : FILE_MIN;
  const views = files.map((f) => {
    const v = viewFile(f, f, fileMin);
    // line numbers in the cut note refer to the file, so only cut files that were not folded
    const c = v.folded ? { out: v.out, cut: 0 } : cutLongLines(v.out, f);
    return { f, out: c.out, folded: v.folded, cut: c.cut };
  });
  const foldedAll = views.reduce((n, v) => n + v.folded, 0);
  const cutAll = views.reduce((n, v) => n + v.cut, 0);
  if (!foldedAll && !cutAll) return views.map((v) => v.out).join(''); // nothing changed: byte-identical to cat
  const parts = views.map((v) => (files.length > 1 ? `==> ${v.f} <==\n${v.out}` : v.out));
  const what = [foldedAll && `${foldedAll} lines folded`, cutAll && `${cutAll} long lines cut`].filter(Boolean).join(', ');
  parts.push(`[${what}; print only what you need with the sed -n commands shown]\n`);
  return parts.join('');
}
