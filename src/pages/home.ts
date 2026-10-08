import { contextChart, contextTable } from '../charts/context';
import { dumbbellChart, resultsTable } from '../charts/dumbbell';
import { leanChart, leanTable } from '../charts/lean';
import { data, MODEL_NAME } from '../data';
import { bindCopy, fmtK } from '../util';

const base = import.meta.env.BASE_URL;

export function home(view: HTMLElement): void {
  const a = data.aggregate;
  const { native, tokenforge } = data.curve.series;
  const off = data.lean.find((l) => l.level === 'off')?.tokens ?? 0;
  const bal = data.lean.find((l) => l.level === 'balanced')?.tokens ?? 0;
  const worse = data.tasks.filter((t) => t.qualityDiff < 0);

  view.innerHTML = `
  <section class="card hero" aria-labelledby="hero-title">
    <img class="hero-mark" src="${base}logo.svg" alt="" width="96" height="96">
    <div>
      <div class="eyebrow">Claude Code plugin · v${data.tokenforgeVersion} · MIT</div>
      <h1 id="hero-title">TokenForge</h1>
      <p class="tag"><b>TF?!</b> Where the fuck did all my tokens go?</p>
      <p class="lead">Build big things with Claude Code for a fraction of the tokens. TokenForge trims what every request re-sends, so the same work reads far less context, at the same quality.</p>
    </div>
    <div class="install">
      <pre data-copy><code><span class="c"># inside Claude Code</span>
/plugin marketplace add chteau/tokenforge
/plugin install tokenforge@tokenforge</code></pre>
    </div>
    <div class="btns">
      <a class="btn primary" href="#/docs/install">Get started</a>
      <a class="btn" href="#/benchmark">See the benchmark</a>
      <a class="btn" href="https://github.com/chteau/tokenforge">GitHub</a>
    </div>
  </section>

  <section class="grid cols-4" style="margin-top:18px" aria-label="Headline results">
    <div class="card kpi"><span class="label">Median total tokens saved</span><span class="value">−${Math.round(a.medianSavings)}%</span><span class="note">across ${a.tasks} tasks vs clean Claude Code</span></div>
    <div class="card kpi"><span class="label">Tasks where it was cheaper</span><span class="value">${a.tasksCheaper}/${a.tasks}</span><span class="note">equal or better quality on all but one</span></div>
    <div class="card kpi"><span class="label">Built from scratch</span><span class="value">−${Math.round(a.scratchMedian)}%</span><span class="note">median over ${a.scratchTasks} projects in 8 languages</span></div>
    <div class="card kpi"><span class="label">Model, both sides</span><span class="value">Opus 5.5</span><span class="note">checked in every API response</span></div>
  </section>

  <section class="section" id="how">
    <div class="section-head">
      <div class="eyebrow">How it works</div>
      <h2>Where the tokens go, and what TokenForge changes</h2>
      <p>Claude Code is stateless between requests. Every tool call is a new API request that sends the whole conversation again: the tool definitions, the instructions, and every file and command output so far. Most of the bill is re-reading.</p>
    </div>

    <article class="card">
      <h2><span class="step-num">1</span>Every request re-reads everything</h2>
      <p class="sub">${data.curve.label} task (“${data.curve.title}”), one real session each. Each point is the context size of one API request. The shaded area is what the session read.</p>
      <div class="counter" id="ctx-counter" aria-live="off"></div>
      <div class="chart-box" id="ctx-chart"></div>
      <div class="chart-foot"><span>Same task, repo commit and model. Total including output: ${fmtK(native.total)} vs ${fmtK(tokenforge.total)}.</span><span>Hover or use arrow keys to read each request.</span></div>
      <details class="data"><summary>Data table: context per request</summary>${contextTable()}</details>
    </article>

    <div class="grid cols-2" style="margin-top:18px">
      <article class="card">
        <h2><span class="step-num">2</span>The fixed cost of every call</h2>
        <p class="sub">Tool and skill definitions ride along with every request, before any work happens. Measured per request, by TokenForge lean level. The default, <code>balanced</code>, sends ${fmtK(bal, true)} instead of ${fmtK(off, true)}.</p>
        <div class="legend"><span><i style="background:var(--native)"></i>clean Claude Code</span><span><i style="background:var(--tf)"></i>tokenforge lean levels</span></div>
        <div class="chart-box" id="lean-chart"></div>
        <details class="data"><summary>Data table: fixed context by level</summary>${leanTable()}</details>
      </article>
      <article class="card">
        <h2>Why that adds up</h2>
        <p class="sub">Three things multiply: the fixed part, the number of requests, and how big each tool result is. TokenForge works on all three.</p>
        <ul class="prose" style="padding-left:18px;margin:0">
          <li><strong>Smaller floor.</strong> Lean levels hide tools a coding session rarely needs. On short tasks the floor is most of the cost.</li>
          <li><strong>Fewer round trips.</strong> Batched, one-call reads (<code>tread</code>) and edits. Median ${Math.round(a.medianToolCallReduction)}% fewer tool calls in the benchmark.</li>
          <li><strong>Smaller tool results.</strong> They are 80–95% of context growth in existing codebases, and every later call re-reads them. Broad dumps fold, long lines are cut, build and test output is compacted.</li>
          <li><strong>Less code.</strong> “Every stated requirement, nothing extra”, written concisely but readably.</li>
        </ul>
      </article>
    </div>

    <article class="card" style="margin-top:18px">
      <h2><span class="step-num">3</span>Results: the same tasks, far fewer tokens</h2>
      <p class="sub">Total tokens per task (input, cache and output), log scale. Each dot slides from clean Claude Code to TokenForge. Quality is scored by hidden tests. ${MODEL_NAME} on both sides.</p>
      <div class="legend"><span><i style="background:var(--native)"></i>clean Claude Code</span><span><i style="background:var(--tf)"></i>tokenforge (default)</span></div>
      <h3 style="margin-top:18px">Built from scratch · median −${Math.round(a.scratchMedian)}%</h3>
      <p class="sub" style="margin-bottom:6px">A spec and an empty repo. Hidden black-box tests check the result.</p>
      <div class="chart-box" id="db-scratch"></div>
      <h3 style="margin-top:26px">In an existing codebase · median −${Math.round(a.existingMedian)}%</h3>
      <p class="sub" style="margin-bottom:6px">Features, debugging, review, refactoring and architecture tracing in real-sized repos.</p>
      <div class="chart-box" id="db-existing"></div>
      <div class="chart-foot"><span>Medians of 1–3 runs per side; single runs vary about ±20%. ${worse.length ? `Quality was lower on one task: ${worse.map((t) => t.label).join(', ')} (every hidden test passes; it scores ${worse[0]?.tokenforge.quality} because of the structural design checks).` : ''}</span><a href="#/benchmark">Method and caveats →</a></div>
      <details class="data"><summary>Data table: all ${a.tasks} tasks</summary>${resultsTable()}</details>
    </article>
  </section>

  <section class="section" id="changes">
    <div class="section-head">
      <div class="eyebrow">In a session</div>
      <h2><span class="step-num">4</span>What changes when TokenForge is on</h2>
      <p>No new workflow to learn. These run through hooks and a short session policy, and each one has an off switch.</p>
    </div>
    <div class="grid cols-3">${FEATURES}</div>
  </section>

  <section class="section">
    <div class="card" style="display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between">
      <div><h2>Try it on your own sessions</h2><p class="sub" style="margin:4px 0 0">The local dashboard shows your context-per-call curve and where the tokens went, per session.</p></div>
      <div class="btns"><a class="btn primary" href="#/docs/install">Install</a><a class="btn" href="#/docs/dashboard">The dashboard</a></div>
    </div>
  </section>`;

  bindCopy(view);
  contextChart(view.querySelector('#ctx-chart') as HTMLElement, view.querySelector('#ctx-counter') as HTMLElement);
  leanChart(view.querySelector('#lean-chart') as HTMLElement);
  dumbbellChart(view.querySelector('#db-scratch') as HTMLElement, 'scratch');
  dumbbellChart(view.querySelector('#db-existing') as HTMLElement, 'existing');
}

const FEATURES = [
  {
    t: 'Lean tools', s: 'Fewer definitions on every request',
    p: 'Hides tools and built-in skills a coding session rarely needs. You can still type the skills as slash commands.',
    ill: `<div class="toolchips"><span>Bash</span><span>Read</span><span>Edit</span><span>Write</span><span>Grep</span><span>Skill</span><span>Task</span><span class="off">Workflow</span><span class="off">Monitor</span><span class="off">CronCreate</span><span class="off">SendMessage</span><span class="off">NotebookEdit</span><span class="off">EnterWorktree</span><span class="off">19 built-in skills</span></div>`,
    link: 'lean',
  },
  {
    t: 'Broad dumps fold', s: '<code>cat</code> of 12k+ characters goes through <code>tview</code>',
    p: 'Long bodies fold to their signature plus the exact command that prints them. Focused reads print unchanged.',
    ill: `<div class="ba"><span class="lbl">illustration · folded output</span><pre><code>pub fn monthly_totals(&amp;self, m: Month) -&gt; Totals {
<span class="hl">    … 37 lines folded: sed -n '142,178p' src/report.rs</span>
}</code></pre></div>`,
    link: 'tread',
  },
  {
    t: 'Compact test output', s: 'Raw build and test commands → <code>tkit check</code> / <code>tkit test</code>',
    p: 'Summary plus failures only, instead of pages of passing tests and progress lines.',
    ill: `<div class="ba"><span class="lbl">before · cargo test</span><pre><code>running 48 tests
test store::tests::load ... ok
test store::tests::save ... ok
<span class="c">… 45 more lines …</span></code></pre><span class="lbl after">after · tkit test (illustration)</span><pre><code>rust: 47 passed, 1 failed [3.2s]
FAIL budget::over_limit  (src/budget.rs:88)</code></pre></div>`,
    link: 'hooks',
  },
  {
    t: 'One-call reads with tread', s: 'Definitions, ranges and regex matches in one call',
    p: 'Replaces “grep, then sed” chains. Each extra call re-reads the whole context, so one call is cheaper.',
    ill: `<pre><code>tread Ledger.add src/cli.rs:40-80 "src/store.rs:/fn save/"</code></pre>`,
    link: 'tread',
  },
  {
    t: 'Memory recall', s: 'Past sessions, searched only when needed',
    p: 'Session start adds one line pointing to <code>tforge recall</code>, instead of re-reading old snapshots on every call.',
    ill: `<pre><code>tforge recall budget alerts</code></pre>`,
    link: 'memory',
  },
  {
    t: 'Repeated questions', s: 'Asked before? Answered at zero tokens',
    p: 'If an earlier turn already answered the same question and changed no files, you see that answer without a model call. Send it again to ask Claude anyway.',
    ill: `<div class="ba"><span class="lbl after">illustration</span><pre><code>tokenforge: you asked this on <span class="c">&lt;date&gt;</span>, so it
wasn't sent to Claude (0 tokens). …</code></pre></div>`,
    link: 'repeated',
  },
  {
    t: 'Concise scope rules', s: '“Lazy, not negligent”',
    p: 'Every stated requirement and nothing extra. Reuse existing code, fix shared code once, infer instead of asking, stop when the checks pass.',
    ill: `<div class="minibar"><span>requirements</span><span class="b"><span style="width:100%;background:var(--tf)"></span></span><span class="v">all</span></div><div class="minibar"><span>unasked extras</span><span class="b"><span style="width:0"></span></span><span class="v">none</span></div>`,
    link: 'hooks',
  },
].map((f) => `<article class="card feature"><h3>${f.t}</h3><span class="tagline">${f.s}</span><p>${f.p}</p><div class="ill">${f.ill}</div><a href="#/docs/${f.link}" style="font-size:13px">Read more →</a></article>`).join('');
