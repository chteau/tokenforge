// Local dashboard server. Binds to 127.0.0.1 only, accepts only localhost Host headers (blocks DNS rebinding),
// serves aggregate numbers only: no prompt, reply or file content from transcripts ever leaves this process.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { readLimits } from './limits.mjs';
import { existingBinary, ROOT } from './tmapbin.mjs';
import { UsageStore, overview, projects, sessionDetail, sessions } from './usage.mjs';
import { readJson } from './util.mjs';

const UI_DIR = path.join(ROOT, 'ui');
const STATIC = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
const REFRESH_MS = 15000;

export function createServer({ store = new UsageStore(), port }) {
  const graphCache = new Map();
  const known = () => new Set(projects(store).map((p) => p.project));

  const ensureFresh = () => {
    if (!store.progress.scanning && (!store.lastRefresh || Date.now() - store.lastRefresh > REFRESH_MS)) store.refresh().catch(() => {});
  };

  function graph(project) {
    const hit = graphCache.get(project);
    if (hit && Date.now() - hit.at < 30000) return hit.data;
    const bin = existingBinary();
    if (!bin) return { error: 'tmap is not installed yet. Run `tmap stats` once in a terminal (it downloads or builds it), then reload.' };
    if (!fs.existsSync(project)) return { error: 'This project folder no longer exists on disk.' };
    const r = spawnSync(bin, ['json', '-C', project], { encoding: 'utf8', timeout: 60000, maxBuffer: 256 << 20 });
    if (r.status !== 0) return { error: `tmap failed: ${(r.stderr || '').trim().slice(0, 300)}` };
    const data = JSON.parse(r.stdout);
    graphCache.set(project, { at: Date.now(), data });
    return data;
  }

  function find(project, q) {
    const bin = existingBinary();
    if (!bin) return { lines: [] };
    const words = String(q).split(/\s+/).filter(Boolean).slice(0, 8);
    if (!words.length) return { lines: [] };
    const r = spawnSync(bin, ['find', ...words, '-n', '25', '-C', project], { encoding: 'utf8', timeout: 20000 });
    return { lines: (r.stdout || '').split('\n').filter(Boolean) };
  }

  function forge(project) {
    const dir = path.join(project, '.forge');
    if (!fs.existsSync(path.join(dir, 'plan.json'))) return { present: false };
    const plan = readJson(path.join(dir, 'plan.json'), {});
    const state = readJson(path.join(dir, 'state.json'), { tasks: {} });
    const attempts = [];
    try {
      for (const l of fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').split('\n')) {
        if (!l) continue;
        const r = JSON.parse(l);
        attempts.push({ ts: r.ts, task: r.task, attempt: r.attempt, model: r.model, turns: r.turns, costUsd: r.costUsd, outcome: r.outcome, usage: r.usage });
      }
    } catch {}
    return {
      present: true,
      goal: plan.goal,
      tasks: (plan.tasks || []).map((t) => ({ id: t.id, model: t.model || plan.defaults?.model || 'sonnet', status: state.tasks?.[t.id]?.status || 'pending', costUsd: state.tasks?.[t.id]?.costUsd || 0 })),
      attempts,
    };
  }

  const routes = {
    '/api/status': () => ({ ...store.progress, lastRefresh: store.lastRefresh || null, files: Object.keys(store.files).length }),
    '/api/overview': () => ({ ...overview(store), limits: readLimits(), scanning: store.progress }),
    '/api/projects': () => projects(store),
    '/api/sessions': (q) => sessions(store, q.get('project') || undefined).slice(0, 200),
    '/api/session': (q) => sessionDetail(store, q.get('id')),
    '/api/limits': () => readLimits(),
    '/api/graph': (q) => (known().has(q.get('project')) ? graph(q.get('project')) : { error: 'unknown project' }),
    '/api/find': (q) => (known().has(q.get('project')) ? find(q.get('project'), q.get('q') || '') : { lines: [] }),
    '/api/forge': (q) => (known().has(q.get('project')) ? forge(q.get('project')) : { present: false }),
  };

  const allowedHost = (h) => {
    const host = String(h || '').toLowerCase();
    return host === `127.0.0.1:${port()}` || host === `localhost:${port()}`;
  };

  const server = http.createServer((req, res) => {
    const send = (code, type, body) => {
      res.writeHead(code, {
        'content-type': `${type}; charset=utf-8`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
        'referrer-policy': 'no-referrer',
      });
      res.end(body);
    };
    if (!allowedHost(req.headers.host)) return send(403, 'text/plain', 'forbidden host');
    if (req.method !== 'GET') return send(405, 'text/plain', 'method not allowed');
    const url = new URL(req.url, 'http://localhost');
    if (STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return send(200, type, fs.readFileSync(path.join(UI_DIR, file)));
    }
    const route = routes[url.pathname];
    if (!route) return send(404, 'text/plain', 'not found');
    ensureFresh();
    try {
      send(200, 'application/json', JSON.stringify(route(url.searchParams)));
    } catch (e) {
      send(500, 'application/json', JSON.stringify({ error: e.message }));
    }
  });
  return server;
}

export async function listen(preferred = 7878) {
  let port = preferred;
  const store = new UsageStore();
  const server = createServer({ store, port: () => port });
  for (let i = 0; i < 20; i++, port++) {
    const ok = await new Promise((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (ok) {
      store.refresh().catch(() => {});
      setInterval(() => store.refresh().catch(() => {}), REFRESH_MS).unref();
      return { server, port, store };
    }
  }
  throw new Error(`no free port from ${preferred} to ${preferred + 19}`);
}
