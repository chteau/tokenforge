// Documents Claude would otherwise read in their most expensive form. Read of a notebook includes every output
// (base64 images, long logs), all re-read on every later call: the router hands Read the cells with trimmed outputs
// instead (raw JSON still reachable with offset/limit). Off: TFORGE_DOCREAD=0.
// PDFs: opt-in (TFORGE_DOCREAD_PDF=1). Measured, Claude Code's own PDF Read costs ~1.3k tokens a page; extracted text
// was cheaper on plain prose (8 pages of R's NEWS.pdf: ~7k vs 10.4k) but dearer on a table-heavy two-column paper
// (15 pages: 26.4k vs 19.3k), and it drops figures. `tkit pdf` stays available to Claude either way.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { existingBinary } from './tmapbin.mjs';
import { cacheBase } from './usage.mjs';

const OUT_LINES = 20;
const OUT_CHARS = 2000;
export const NB_MIN_BYTES = 8 * 1024;

function cached(file, kind, make) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const key = crypto.createHash('sha1').update(`${path.resolve(file)}\0${st.size}\0${st.mtimeMs}\0${kind}`).digest('hex').slice(0, 16);
  const out = path.join(cacheBase(), 'docs', `${path.basename(file).replace(/[^\w.-]/g, '_')}.${key}.txt`);
  if (fs.existsSync(out)) return out;
  const text = make();
  if (text == null) return null;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  return out;
}

const trim = (s) => {
  const lines = String(s).split('\n');
  let t = lines.slice(0, OUT_LINES).join('\n');
  if (t.length > OUT_CHARS) t = t.slice(0, OUT_CHARS);
  const cut = lines.length > OUT_LINES || String(s).length > t.length;
  return cut ? `${t}\n… output trimmed (${lines.length} lines)` : t;
};
const joinSrc = (x) => (Array.isArray(x) ? x.join('') : String(x ?? ''));

export function notebookText(file) {
  let nb;
  try {
    nb = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(nb.cells)) return null;
  const lang = nb.metadata?.kernelspec?.language || nb.metadata?.language_info?.name || 'code';
  const out = [`[tokenforge: cells of ${file}, outputs trimmed and images omitted; Read the .ipynb with offset/limit for its raw JSON]`];
  nb.cells.forEach((c, i) => {
    out.push('', `# %% [${c.cell_type}] cell ${i + 1}`, joinSrc(c.source).trimEnd());
    for (const o of c.outputs || []) {
      if (o.output_type === 'stream') out.push(`# >> ${o.name || 'stdout'}`, trim(joinSrc(o.text)));
      else if (o.output_type === 'error') out.push(`# >> error: ${o.ename}: ${o.evalue}`, trim((o.traceback || []).slice(-3).join('\n').replace(/\x1b\[[0-9;]*m/g, '')));
      else if (o.data) {
        for (const [mime, v] of Object.entries(o.data)) {
          if (mime === 'text/plain') out.push('# >> result', trim(joinSrc(v)));
          else if (mime.startsWith('image/')) out.push(`# >> [${mime} output omitted, ${Math.round(joinSrc(v).length * 0.75 / 1024)} KB]`);
          else if (mime === 'text/html' && !o.data['text/plain']) out.push('# >> [html output omitted]');
        }
      }
    }
  });
  return out.join('\n') + '\n';
}

// Text of a PDF via `tmap kit pdf`; null when tmap is missing, the PDF is scanned (exit 3) or anything fails.
export function pdfText(file) {
  const bin = existingBinary();
  if (!bin) return null;
  const r = spawnSync(bin, ['kit', 'pdf', file], { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 && r.stdout.trim() ? r.stdout : null;
}

// Path of the text version Read should get instead of `file`, or null to read the original.
export function docReplacement(file, ti = {}) {
  if (process.env.TFORGE_DOCREAD === '0' || !file || ti.offset || ti.limit) return null;
  if (/\.ipynb$/i.test(file)) {
    try {
      if (fs.statSync(file).size < NB_MIN_BYTES) return null;
    } catch {
      return null;
    }
    return cached(file, 'nb1', () => notebookText(file));
  }
  if (/\.pdf$/i.test(file) && !ti.pages && process.env.TFORGE_DOCREAD_PDF === '1') return cached(file, 'pdf1', () => pdfText(file));
  return null;
}
