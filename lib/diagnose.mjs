// Fixed-context diagnosis for the dashboard: skills whose listing is long, skills and MCP servers nothing called lately.
// Skill names+descriptions and MCP tool lists are re-sent on every request, so unused or wordy ones cost on every call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir } from './meter.mjs';

const DAYS = 30;
const LONG = 120; // tokens of name + description
const MAX_FILES = 400;
const safe = (f, d) => {
  try {
    return f();
  } catch {
    return d;
  }
};
const json = (f) => safe(() => JSON.parse(fs.readFileSync(f, 'utf8')), null);
const sanitize = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_');

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) out[(key = kv[1])] = kv[2].replace(/^[>|][-+]?$/, '').replace(/^(['"])([\s\S]*)\1$/, '$2');
    else if (key) out[key] += ` ${line.trim()}`;
  }
  return out;
}

function skillsIn(dir, source, found) {
  for (const d of safe(() => fs.readdirSync(dir, { withFileTypes: true }), [])) {
    const f = path.join(dir, d.name, 'SKILL.md');
    const text = safe(() => fs.readFileSync(f, 'utf8'), null);
    if (text === null) continue;
    const fm = frontmatter(text);
    const name = fm.name || d.name;
    found.push({ name, source, id: source === 'user' ? name : `${source}:${name}`, tokens: Math.ceil((name.length + (fm.description || '').length) / 4) + 8, file: f });
  }
}

function mcpServers() {
  const found = [];
  const add = (name, scope, key) => found.push({ name, scope, key: key || `mcp__${sanitize(name)}__` });
  const cfg = json(path.join(configDir(), '.claude.json')) || json(path.join(os.homedir(), '.claude.json')) || {};
  for (const n of Object.keys(cfg.mcpServers || {})) add(n, 'user');
  for (const [p, v] of Object.entries(cfg.projects || {})) for (const n of Object.keys(v.mcpServers || {})) add(n, path.basename(p));
  for (const n of Object.keys((json(path.join(configDir(), 'settings.json')) || {}).mcpServers || {})) add(n, 'settings');
  const installed = json(path.join(configDir(), 'plugins', 'installed_plugins.json'));
  for (const [id, list] of Object.entries((installed && installed.plugins) || {})) {
    const plugin = id.split('@')[0];
    const dir = Array.isArray(list) && list[0] && list[0].installPath;
    const mj = dir && json(path.join(dir, '.mcp.json'));
    const servers = mj ? mj.mcpServers || mj : {};
    for (const n of Object.keys(servers)) add(`${n} (${plugin})`, `plugin ${plugin}`, `mcp__plugin_${sanitize(plugin)}_${sanitize(n)}__`);
  }
  const seen = new Set();
  return found.filter((s) => !seen.has(s.name + s.scope) && seen.add(s.name + s.scope));
}

let cache = null;
export function diagnose(store, now = Date.now()) {
  if (cache && now - cache.at < 60e3) return cache.value;
  const files = Object.entries(store.files)
    .filter(([, e]) => e.mtime && now - e.mtime < DAYS * 864e5)
    .sort((a, b) => b[1].mtime - a[1].mtime)
    .slice(0, MAX_FILES)
    .map(([f]) => f);
  const skills = [];
  skillsIn(path.join(configDir(), 'skills'), 'user', skills);
  const installed = json(path.join(configDir(), 'plugins', 'installed_plugins.json'));
  for (const [id, list] of Object.entries((installed && installed.plugins) || {})) {
    const dir = Array.isArray(list) && list[0] && list[0].installPath;
    if (dir) skillsIn(path.join(dir, 'skills'), id.split('@')[0], skills);
  }
  const mcps = mcpServers();
  const skillUse = {};
  const mcpUse = new Map(mcps.map((m) => [m.key, 0]));
  for (const f of files) {
    const text = safe(() => fs.readFileSync(f, 'utf8'), '');
    for (const m of text.matchAll(/"name":"Skill","input":\{[^}]*?"skill":"([^"]+)"/g)) skillUse[m[1]] = (skillUse[m[1]] || 0) + 1;
    for (const k of mcpUse.keys()) {
      const n = text.split(`"name":"${k}`).length - 1;
      if (n) mcpUse.set(k, mcpUse.get(k) + n);
    }
  }
  const rows = skills.map((s) => ({ name: s.id, tokens: s.tokens, uses: skillUse[s.id] || skillUse[s.name] || 0 })).sort((a, b) => b.tokens - a.tokens);
  const value = {
    days: DAYS,
    sessions: files.length,
    longTokens: LONG,
    skills: rows,
    mcps: mcps.map((m) => ({ name: m.name, scope: m.scope, uses: mcpUse.get(m.key) })).sort((a, b) => a.uses - b.uses),
  };
  cache = { at: now, value };
  return value;
}
