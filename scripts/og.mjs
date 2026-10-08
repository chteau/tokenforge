#!/usr/bin/env node
// Social preview images from src/data/bench.json: public/og.png (1200×630, Open Graph / X / Discord) and
// public/apple-touch-icon.png (180×180). Rendered with headless Chrome; rerun after `npm run data`.
//   node scripts/og.mjs        (needs google-chrome or chromium on PATH, or $CHROME)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(fs.readFileSync(path.join(root, 'src/data/bench.json'), 'utf8'));
const logo = fs.readFileSync(path.join(root, 'public/logo.svg'), 'utf8');
const a = data.aggregate;
const langs = new Set(data.tasks.map((t) => t.language)).size;
const chrome = process.env.CHROME || ['google-chrome', 'chromium', 'chromium-browser'].find((c) => spawnSync('which', [c]).status === 0);
if (!chrome) throw new Error('no Chrome found; set $CHROME');

// one row per task: track from tokenforge's share of native (dot) to native (100%)
const rows = [...data.tasks].sort((x, y) => y.savings - x.savings).map((t) => {
  const r = t.tokenforge.total / t.native.total;
  return `<div class="row"><span class="tr" style="left:${(r * 100).toFixed(1)}%;width:${((1 - r) * 100).toFixed(1)}%"></span><i class="t" style="left:${(r * 100).toFixed(1)}%"></i><i class="n"></i></div>`;
}).join('');

const card = `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
html,body{width:1200px;height:630px;overflow:hidden}
body{font-family:"Inter","Segoe UI",system-ui,sans-serif;color:#faf9f5;padding:64px 72px 56px;display:grid;grid-template-columns:1fr 360px;gap:64px;
background:radial-gradient(700px 420px at 92% -10%,rgba(209,106,71,.32),transparent 62%),radial-gradient(600px 380px at -5% 115%,rgba(63,143,216,.16),transparent 60%),#141413}
.brand{display:flex;align-items:center;gap:22px}.brand svg{width:84px;height:84px}
h1{font-size:76px;font-weight:800;letter-spacing:-.025em;line-height:1}
.tag{font-size:31px;color:#e8e4d8;margin:28px 0 0;line-height:1.25}
.big{display:flex;align-items:baseline;gap:20px;margin-top:40px}
.big b{font-size:112px;font-weight:800;color:#e48a68;letter-spacing:-.03em;line-height:1}
.big span{font-size:24px;color:#c2c0b6;line-height:1.3;max-width:300px}
.chips{display:flex;gap:12px;margin-top:34px}.chips span{font-size:20px;padding:9px 16px;background:rgba(250,249,245,.07);border:1px solid rgba(250,249,245,.14);color:#e8e4d8}
.panel{align-self:stretch;display:flex;flex-direction:column;padding:26px 26px 20px;background:linear-gradient(127deg,rgba(38,38,36,.96) 20%,rgba(26,25,24,.82));border:1px solid rgba(250,249,245,.08)}
.panel h2{font-size:17px;font-weight:600;color:#c2c0b6;letter-spacing:.06em;text-transform:uppercase}
.rows{flex:1;display:flex;flex-direction:column;justify-content:space-evenly;margin:14px 0 10px}
.row{position:relative;height:10px}
.row .tr{position:absolute;top:4px;height:2px;background:rgba(209,106,71,.55)}
.row i{position:absolute;top:0;width:10px;height:10px;border-radius:50%!important;margin-left:-5px}
.row .t{background:#d16a47}.row .n{left:100%;background:#3f8fd8}
.key{display:flex;justify-content:space-between;font-size:15px;color:#8f8d86}
.key i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:7px;vertical-align:0}
.left{display:flex;flex-direction:column}.url{margin-top:auto;font-size:19px;color:#8f8d86}
</style><body>
<div class="left"><div class="brand">${logo}<h1>TokenForge</h1></div>
<p class="tag">Where the fuck did all my tokens go?<br><span style="color:#8f8d86">A Claude Code plugin that cuts token use.</span></p>
<div class="big"><b>−${Math.round(a.medianSavings)}%</b><span>median total tokens vs clean Claude Code</span></div>
<div class="chips"><span>${a.tasksCheaper}/${a.tasks} tasks cheaper</span><span>${langs} languages</span><span>Opus 5.5</span></div></div>
<div class="panel"><h2>Every task, total tokens</h2><div class="rows">${rows}</div>
<div class="key"><span><i style="background:#d16a47"></i>tokenforge</span><span><i style="background:#3f8fd8"></i>clean Claude Code</span></div></div></body>`;

const icon = `<!doctype html><style>html,body{margin:0;width:180px;height:180px;overflow:hidden}svg{width:180px;height:180px;display:block}</style>${logo}`;

function shot(html, out, w, h) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'og-'));
  const f = path.join(tmp, 'card.html');
  fs.writeFileSync(f, html);
  const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', `--user-data-dir=${tmp}/p`,
    `--window-size=${w},${h}`, '--force-device-scale-factor=1', `--screenshot=${out}`, `file://${f}`], { encoding: 'utf8' });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!fs.existsSync(out)) throw new Error(`screenshot failed: ${r.stderr}`);
  console.log(`wrote ${path.relative(root, out)}`);
}
shot(card, path.join(root, 'public/og.png'), 1200, 630);
shot(icon, path.join(root, 'public/apple-touch-icon.png'), 180, 180);
