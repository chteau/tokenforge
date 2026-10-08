import fs from 'node:fs';
import { defineConfig } from 'vite';

// Served from https://chteau.github.io/tokenforge/ (GitHub Pages project site).
const SITE = 'https://chteau.github.io/tokenforge/';

// Fill %TITLE%, %DESC%, %SITE% ... in index.html from the benchmark data, so link previews never go stale.
/** @returns {import("vite").Plugin} */
function meta() {
  return {
    name: 'tf-meta',
    transformIndexHtml(html) {
      const d = JSON.parse(fs.readFileSync('src/data/bench.json', 'utf8'));
      const a = d.aggregate;
      const langs = new Set(d.tasks.map((t) => t.language)).size;
      const vars = {
        SITE,
        TITLE: 'TokenForge: where the fuck did all my tokens go?',
        DESC: `Claude Code plugin that cuts token use. Median −${Math.round(a.medianSavings)}% total tokens vs clean Claude Code, cheaper on ${a.tasksCheaper} of ${a.tasks} tasks in ${langs} languages. Claude Opus 5.5 on both sides.`,
        IMG_ALT: `TokenForge: −${Math.round(a.medianSavings)}% median total tokens vs clean Claude Code, ${a.tasksCheaper}/${a.tasks} tasks cheaper.`,
        VERSION: d.tokenforgeVersion,
      };
      return html.replace(/%(SITE|TITLE|DESC|IMG_ALT|VERSION)%/g, (_, k) => vars[k].replace(/"/g, '&quot;'));
    },
  };
}

export default defineConfig({
  base: '/tokenforge/',
  build: { target: 'es2022' },
  plugins: [meta()],
});
