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
  <header class="phero" aria-labelledby="hero-title">
    <img class="phero-mark" src="${base}logo.svg" alt="" width="88" height="88">
    <h1 id="hero-title">TokenForge<span class="cur" aria-hidden="true"></span></h1>
    <p class="tag">Where the fuck did all my tokens go?</p>
    <p class="psub">A Claude Code plugin that trims what every request re-sends. Same work, same quality, about half the tokens.</p>
    <div class="btns">
      <a class="btn primary" href="https://github.com/chteau/tokenforge">View on GitHub</a>
      <a class="btn" href="#install" data-jump>Install</a>
    </div>
    <p class="pmeta">Claude Code plugin · v${data.tokenforgeVersion} · MIT</p>
  </header>

  <section class="psec" id="idea">
    <p class="plabel">How it works</p>
    <h2>Every call re-sends everything. Most of the bill is re-reading.</h2>
    <article class="card">
      <p class="sub">${data.curve.label} task (“${data.curve.title}”), one real session each. Each point is the context size of one API request; the shaded area is what the session read.</p>
      <div class="counter" id="ctx-counter" aria-live="off"></div>
      <div class="chart-box" id="ctx-chart"></div>
      <div class="chart-foot"><span>Same task, repo commit and model. Total including output: ${fmtK(native.total)} vs ${fmtK(tokenforge.total)}.</span><span>Hover or use arrow keys to read each request.</span></div>
      <details class="data"><summary>Data table: context per request</summary>${contextTable()}</details>
    </article>
    <p class="pcap">Same task, fewer requests, and each one smaller.</p>
  </section>

  <section class="psec" id="levers">
    <p class="plabel">What it changes</p>
    <h2>Five changes, active from the first session.</h2>
    <ol class="ladder">
      <li><span><b>Smaller floor.</b> <span class="d">Lean levels hide tools and built-in skills a coding session rarely needs: ${fmtK(off, true)} → ${fmtK(bal, true)} per request by default.</span></span></li>
      <li><span><b>Fewer round trips.</b> <span class="d">One-call reads with <code>tread</code>, batched edits. Median ${Math.round(a.medianToolCallReduction)}% fewer tool calls.</span></span></li>
      <li><span><b>Smaller tool results.</b> <span class="d">Broad dumps fold, long lines are cut, build and test output is compacted to failures.</span></span></li>
      <li><span><b>Nothing asked twice.</b> <span class="d">Past sessions are searched with <code>tforge recall</code>; a repeated question is answered at zero tokens.</span></span></li>
      <li><span><b>Only what was asked.</b> <span class="d">Every stated requirement is met; unrequested extras are left out.</span></span></li>
    </ol>
  </section>

  <section class="psec" id="numbers">
    <p class="plabel">Benchmark</p>
    <h2>Measured on 19 real tasks, not estimated.</h2>
    <div class="pstats">
      <div class="hi"><div class="n">${Math.round(a.medianSavings)}%</div><div class="l">fewer tokens (median)</div></div>
      <div><div class="n">${a.tasksCheaper}/${a.tasks}</div><div class="l">tasks cheaper</div></div>
      <div><div class="n">${Math.round(a.scratchMedian)}%</div><div class="l">built from scratch</div></div>
      <div><div class="n">${Math.round(a.existingMedian)}%</div><div class="l">existing codebases</div></div>
      <div><div class="n">${Math.round(a.medianToolCallReduction)}%</div><div class="l">fewer tool calls</div></div>
    </div>
    <article class="card" style="margin-top:18px">
      <p class="sub">Total tokens per task (input, cache and output), log scale. Each dot slides from clean Claude Code to TokenForge. Quality is scored by hidden tests.</p>
      <div class="legend"><span><i style="background:var(--native)"></i>clean Claude Code</span><span><i style="background:var(--tf)"></i>tokenforge (default)</span></div>
      <h3 style="margin-top:18px">Built from scratch · median −${Math.round(a.scratchMedian)}%</h3>
      <div class="chart-box" id="db-scratch"></div>
      <h3 style="margin-top:26px">In an existing codebase · median −${Math.round(a.existingMedian)}%</h3>
      <div class="chart-box" id="db-existing"></div>
      <details class="data"><summary>Data table: all ${a.tasks} tasks</summary>${resultsTable()}</details>
    </article>
    <p class="pcap">${a.tasks} tasks, ${a.scratchTasks} from-scratch projects in 8 languages. ${MODEL_NAME} on both sides, checked in every API response. Medians of 1–3 runs per side.${worse.length ? ` Quality was lower on one task (${worse.map((t) => t.label).join(', ')}): every hidden test passes, the design checks score lower.` : ''} <a href="#/benchmark">Method and caveats →</a></p>
  </section>

  <section class="psec" id="install">
    <p class="plabel">Install</p>
    <h2>Add the marketplace, install, restart.</h2>
    <pre class="term" data-copy><code>/plugin marketplace add chteau/tokenforge
/plugin install tokenforge@tokenforge</code></pre>
    <div class="pothers">
      <div><h3>update</h3><code>/plugin marketplace update tokenforge</code></div>
      <div><h3>dashboard</h3><code>/tokenforge:dashboard</code></div>
      <div><h3>everything off</h3><code>tforge lean off</code></div>
      <div><h3>uninstall</h3><code>/plugin uninstall tokenforge@tokenforge</code></div>
    </div>
    <p class="pcap">Start a new session after installing; <code>/clear</code> doesn’t reload plugins. The first start sets the lean level to <code>balanced</code>. More in the <a href="#/docs/install">install docs</a>.</p>
  </section>

  <section class="psec" id="commands">
    <p class="plabel">Commands</p>
    <h2>Everything it adds, in one table.</h2>
    <div class="card ptable"><table>
      <tr><td><code>/tokenforge:lean on|balanced|max|ultra|off</code></td><td>set the lean level</td></tr>
      <tr><td><code>/tokenforge:terse full|lite|off</code></td><td>reply style</td></tr>
      <tr><td><code>/tokenforge:dashboard</code></td><td>local dashboard: usage, limits, sessions, memory graph</td></tr>
      <tr><td><code>/tokenforge:meter</code></td><td>token use of recent sessions</td></tr>
      <tr><td><code>/tokenforge:handoff</code></td><td>save state, <code>/clear</code>, continue small</td></tr>
      <tr><td><code>/tokenforge:forge</code></td><td>plan-then-workers build for large new apps</td></tr>
      <tr><td><code>tforge recall &lt;words&gt;</code></td><td>search past sessions</td></tr>
      <tr><td><code>tread &lt;symbol|file:range|file:/re/&gt;…</code></td><td>several reads in one call</td></tr>
    </table></div>
  </section>

  <section class="psec" id="levels">
    <p class="plabel">Lean levels</p>
    <h2>Choose what each request carries.</h2>
    <div class="plevels">${LEVELS.map((l) => `<div class="card plvl${l.k === 'balanced' ? ' def' : ''}">${l.k === 'balanced' ? '<span class="badge">default</span>' : ''}<h3>${l.k}</h3><span class="tok">${fmtK(data.lean.find((x) => x.level === l.k)?.tokens ?? 0, true)} / request</span><p>${l.p}</p></div>`).join('')}</div>
    <article class="card" style="margin-top:18px">
      <p class="sub">Fixed context per request, before any work happens. Measured on Claude Code ${data.claudeCodeVersion}.</p>
      <div class="legend"><span><i style="background:var(--native)"></i>clean Claude Code</span><span><i style="background:var(--tf)"></i>tokenforge lean levels</span></div>
      <div class="chart-box" id="lean-chart"></div>
      <details class="data"><summary>Data table: fixed context by level</summary>${leanTable()}</details>
    </article>
  </section>

  <section class="pend">
    <img src="${base}logo.svg" alt="" width="56" height="56">
    <p class="q">Spend tokens on the work, not on re-reading it.</p>
    <div class="btns"><a class="btn primary" href="#install" data-jump>Install</a><a class="btn" href="#/docs/install">Read the docs</a></div>
  </section>`;

  bindCopy(view);
  view.querySelectorAll<HTMLAnchorElement>('[data-jump]').forEach((el) => el.addEventListener('click', (e) => {
    e.preventDefault(); // hash routing: scroll instead of changing the route
    view.querySelector(el.getAttribute('href') ?? '')?.scrollIntoView({ behavior: 'smooth' });
  }));
  contextChart(view.querySelector('#ctx-chart') as HTMLElement, view.querySelector('#ctx-counter') as HTMLElement);
  leanChart(view.querySelector('#lean-chart') as HTMLElement);
  dumbbellChart(view.querySelector('#db-scratch') as HTMLElement, 'scratch');
  dumbbellChart(view.querySelector('#db-existing') as HTMLElement, 'existing');
}

const LEVELS = [
  { k: 'on', p: 'Hides agent-orchestration tools: Workflow, Monitor, Cron, worktrees, NotebookEdit.' },
  { k: 'balanced', p: 'Also hides the 19 built-in skills from Claude. You can still type them. Your skills, subagents and web stay.' },
  { k: 'max', p: 'Also drops the Skill tool, subagents, web tools and the git instructions.' },
  { k: 'ultra', p: 'Also drops Read, Edit and Write. Claude works through Bash. No image or PDF viewing.' },
];
