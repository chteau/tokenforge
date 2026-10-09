#!/usr/bin/env node
// Build-time data for the site, extracted from the plugin repo's benchmark.
//
//   node scripts/extract-data.mjs [path/to/tokenforge]     (default: ../tokenforge, or $TOKENFORGE_REPO)
//
// Reads bench/reports/benchmark-report.json, bench/tasks/*/task.json, bench/scripts/charts.py (measured fixed
// context per lean level) and two run transcripts (rust-cli: the native and tokenforge runs the report used), and
// writes src/data/bench.json. The output is committed because CI has no access to the raw runs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(process.argv[2] || process.env.TOKENFORGE_REPO || path.join(here, '..', '..', 'tokenforge'));
const bench = path.join(repo, 'bench');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const report = readJson(path.join(bench, 'reports', 'benchmark-report.json'));

// Display names and grouping follow the README tables (and bench/scripts/charts.py).
const SCRATCH = {
  'vite-landing': 'Vite front page', 'go-mock-api': 'Go mock REST API', 'csharp-api': 'C# loans API (ASP.NET Core)',
  'rust-tui': 'Rust TUI (ratatui)', 'luau-inventory': 'Luau inventory (Roblox-style)', 'node-ssg': 'Node static site generator',
  'python-cli': 'Python CLI', 'cpp-cli': 'C++ key-value store (CMake)', 'ts-lib': 'TypeScript library',
  'java-http': 'Java URL shortener (JDK HTTP)', 'php-api': 'PHP ticketing API (SQLite)', 'swift-cli': 'Swift cron tool (SwiftPM)',
  'dart-cli': 'Dart habit tracker', 'bash-tool': 'Bash backup rotation', 'c-cli': 'C CSV query tool (Make)',
  'kotlin-cli': 'Kotlin Markdown converter',
  'zig-cli': 'Zig JSON toolkit', 'elixir-app': 'Elixir job queue (GenServer)', 'haskell-cli': 'Haskell spreadsheet evaluator',
  'ocaml-cli': 'OCaml assembler + VM (dune)', 'lua-cli': 'Lua template engine', 'r-cli': 'R survey statistics',
  'fsharp-cli': 'F# expense splitter (.NET)', 'perl-cli': 'Perl config linter + merger',
};
const ACADEMIC = { 'paper-proofread': 'Proofread a LaTeX manuscript (19 planted errors)', 'pdf-paper-qa': 'Answer questions from a 15-page PDF paper' };
const EXISTING = {
  'cross-module-debug': 'Cross-module debugging (TS)', 'go-feature': 'Go scheduled notifications', 'banking-web': 'TS filters + CSV export',
  'rust-cli': 'Rust CLI feature', 'go-api': 'Go REST endpoint', 'rust-debug': 'Rust debugging', 'pr-review': 'PR review (Go)',
  'banking-transfers': 'Scheduled transfers (TS, multi-layer)', 'refactor': 'Rust refactor', 'architecture': 'Architecture investigation (TS)',
};
const SHORT = {
  'vite-landing': 'Vite page', 'go-mock-api': 'Go mock API', 'csharp-api': 'C# API', 'rust-tui': 'Rust TUI', 'luau-inventory': 'Luau inventory',
  'node-ssg': 'Node SSG', 'python-cli': 'Python CLI', 'cpp-cli': 'C++ KV store', 'ts-lib': 'TS library',
  'cross-module-debug': 'Cross-module debug', 'go-feature': 'Go notifications', 'banking-web': 'TS CSV export', 'rust-cli': 'Rust CLI feature',
  'go-api': 'Go endpoint', 'rust-debug': 'Rust debug', 'pr-review': 'PR review', 'banking-transfers': 'Sched. transfers',
  'refactor': 'Rust refactor', 'architecture': 'Architecture',
  'java-http': 'Java shortener', 'php-api': 'PHP API', 'swift-cli': 'Swift cron', 'dart-cli': 'Dart habits', 'bash-tool': 'Bash backups',
  'paper-proofread': 'Proofreading', 'pdf-paper-qa': 'PDF Q&A',
  'c-cli': 'C CSV tool', 'kotlin-cli': 'Kotlin Markdown', 'ruby-cli': 'Ruby logs',
  'zig-cli': 'Zig JSON', 'elixir-app': 'Elixir queue', 'haskell-cli': 'Haskell sheet', 'ocaml-cli': 'OCaml VM',
  'lua-cli': 'Lua templates', 'r-cli': 'R survey', 'fsharp-cli': 'F# splitter', 'perl-cli': 'Perl config',
};
const LANG = { rust: 'Rust', go: 'Go', typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', cpp: 'C++', csharp: 'C#', luau: 'Luau', java: 'Java', php: 'PHP', swift: 'Swift', dart: 'Dart', bash: 'Bash', c: 'C', kotlin: 'Kotlin', ruby: 'Ruby', zig: 'Zig', elixir: 'Elixir', haskell: 'Haskell', ocaml: 'OCaml', lua: 'Lua', r: 'R', fsharp: 'F#', perl: 'Perl' };

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const tasks = [];
for (const t of report.per_task) {
  const group = SCRATCH[t.task] ? 'scratch' : EXISTING[t.task] ? 'existing' : ACADEMIC[t.task] ? 'academic' : null;
  if (!group || !t['token-forge'] || !t.native) continue; // memory-followup has no paired default run
  const meta = readJson(path.join(bench, 'tasks', t.task, 'task.json'));
  const n = t.native, f = t['token-forge'];
  tasks.push({
    id: t.task, group, label: SCRATCH[t.task] || EXISTING[t.task] || ACADEMIC[t.task], short: SHORT[t.task], title: meta.title,
    category: t.category, language: LANG[meta.language] || meta.language,
    runs: { native: t.runs.native, tokenforge: t.runs['token-forge'] },
    native: { total: n.total_tokens, inputEq: n.input_equivalent_tokens, requests: n.api_requests, toolCalls: n.tool_calls, firstContext: n.first_request_context_tokens, quality: n.quality_score, output: n.output_tokens },
    tokenforge: { total: f.total_tokens, inputEq: f.input_equivalent_tokens, requests: f.api_requests, toolCalls: f.tool_calls, firstContext: f.first_request_context_tokens, quality: f.quality_score, output: f.output_tokens },
    savings: t.diff.token_savings_percent, savingsPriceWeighted: t.diff.list_cost_savings_percent, qualityDiff: t.diff.quality_diff,
  });
}
tasks.sort((a, b) => b.savings - a.savings);

const a = report.aggregate;
const groupMedian = (g) => median(tasks.filter((t) => t.group === g).map((t) => t.savings));
const session0 = Object.values(report.sessions)[0];

// Fixed context per lean level, measured by the plugin author: FLOOR in bench/scripts/charts.py.
const charts = fs.readFileSync(path.join(bench, 'scripts', 'charts.py'), 'utf8');
const floorSrc = charts.match(/^FLOOR = \[(.*)\]$/m)[1];
const floorVals = [...floorSrc.matchAll(/\("([^"]+)", (\d+)\)/g)].map((m) => Number(m[2]));
const LEVEL_NAMES = ['off', 'on', 'balanced', 'max', 'ultra'];
if (floorVals.length !== 5) throw new Error('FLOOR parse failed');
const lean = LEVEL_NAMES.map((level, i) => ({ level, tokens: floorVals[i] }));

// Context per request for one session pair (rust-cli): the report's runs, found by session id.
function runDir(sessionId, task) {
  for (const s of fs.readdirSync(path.join(bench, 'runs'))) {
    const tdir = path.join(bench, 'runs', s, task);
    if (!fs.existsSync(tdir)) continue;
    for (const r of fs.readdirSync(tdir)) {
      const m = path.join(tdir, r, 'manifest.json');
      if (fs.existsSync(m) && readJson(m).session_id === sessionId) return path.join(tdir, r);
    }
  }
  throw new Error(`run ${sessionId} not found`);
}
function jsonlFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'subagents') out.push(...jsonlFiles(p)); }
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out.sort();
}
function contextPoints(dir) {
  const seen = new Set(), pts = [];
  for (const f of jsonlFiles(path.join(dir, 'transcripts'))) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const d = JSON.parse(line);
      if (d.type !== 'assistant') continue;
      const m = d.message || {}, u = m.usage, k = d.requestId || m.id;
      if (!k || !u || seen.has(k)) continue;
      seen.add(k);
      pts.push((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0));
    }
  }
  return pts;
}
const CURVE_TASK = 'rust-cli';
const curve = { task: CURVE_TASK, label: EXISTING[CURVE_TASK], title: tasks.find((t) => t.id === CURVE_TASK).title, series: {} };
for (const agent of ['native', 'token-forge']) {
  const r = report.runs.find((x) => x.task === CURVE_TASK && x.agent === agent);
  const dir = runDir(r.session_id, CURVE_TASK);
  const env = path.join(dir, 'environment_manifest.json');
  const pts = contextPoints(dir);
  curve.series[agent === 'native' ? 'native' : 'tokenforge'] = {
    run: path.relative(repo, dir), lean: fs.existsSync(env) ? readJson(env).token_forge_lean || null : null,
    total: r.total_tokens, requests: pts.length, points: pts, sum: pts.reduce((x, y) => x + y, 0),
  };
}

const out = {
  generated: new Date().toISOString().slice(0, 10),
  source: 'github.com/chteau/tokenforge bench/reports/benchmark-report.json',
  model: Object.keys(report.validation.api_models),
  apiModels: report.validation.api_models,
  runsWithOtherModels: report.validation.runs_with_other_models.length,
  contaminatedRuns: report.validation.contaminated_or_invalid_runs.length,
  claudeCodeVersion: session0.claude_code_version,
  tokenforgeVersion: report.token_forge_build.version,
  pluginVersion: readJson(path.join(repo, '.claude-plugin', 'plugin.json')).version,
  defaultLean: report.token_forge_build.lean,
  aggregate: {
    tasks: a.tasks_paired, runs: a.runs_executed,
    medianSavings: a.token_savings_percent.median, meanSavings: a.token_savings_percent.mean, pooledSavings: a.pooled_token_savings_percent,
    minSavings: a.token_savings_percent.min, maxSavings: a.token_savings_percent.max,
    medianPriceWeighted: a.list_cost_savings_percent.median, minPriceWeighted: a.list_cost_savings_percent.min, maxPriceWeighted: a.list_cost_savings_percent.max,
    medianToolCallReduction: a.tool_call_reduction_percent.median,
    tasksCheaper: a.cost_sign_test.tasks_tf_cheaper, tasksCostlier: a.cost_sign_test.tasks_tf_costlier, tasksFewerTokens: a.sign_test.tasks_tf_cheaper,
    firstRequestOverhead: a.first_request_overhead_tokens.median,
    scratchMedian: groupMedian('scratch'), existingMedian: groupMedian('existing'),
    scratchTasks: tasks.filter((t) => t.group === 'scratch').length, existingTasks: tasks.filter((t) => t.group === 'existing').length, academicTasks: tasks.filter((t) => t.group === 'academic').length, academicMedian: groupMedian('academic'),
    qualityWorse: tasks.filter((t) => t.qualityDiff < 0).map((t) => t.id),
  },
  lean, curve, tasks,
};
const dest = path.join(here, '..', 'src', 'data', 'bench.json');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 1) + '\n');
console.log(`wrote ${path.relative(process.cwd(), dest)}: ${tasks.length} tasks, curve ${curve.series.native.requests} vs ${curve.series.tokenforge.requests} requests`);
