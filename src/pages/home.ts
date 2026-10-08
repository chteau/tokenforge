import { contextChart, contextTable } from '../charts/context';
import { dumbbellChart, resultsTable } from '../charts/dumbbell';
import { anatomy } from '../charts/anatomy';
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

  <section class="psec" id="how">
    <p class="plabel">How it works</p>
    <h2>Claude Code pays for the same tokens over and over.</h2>
    <div class="how-intro">
      <article class="card prose">
        <p>Claude Code doesn’t remember anything between API calls. Each time Claude runs a tool (read a file, run the tests, edit something), the next call sends <b>everything again</b>: the tool definitions and instructions, your messages, and every file and command output so far.</p>
        <p>So a file read early in a session is paid for on every call after it. In an 18-call session, a file read in the first call is sent again in each of the other 17. Most of a bill is re-reading, not new work.</p>
        <p>That gives three things to cut: <b>what every call carries</b>, <b>how big each tool output is</b>, and <b>how many calls there are</b>. TokenForge works on all three, without changing how you use Claude Code.</p>
      </article>
      <article class="card">
        <div id="anatomy"></div>
        <p class="pcap" style="margin-top:12px">A sketch, not one real session: the tools-and-instructions part is measured (${fmtK(off, true)} vs ${fmtK(bal, true)} per call), the output sizes are made up to show the shape. Real sessions are below.</p>
      </article>
    </div>
    <div class="cuts">
      <article class="card"><h3><i style="background:var(--s4)"></i>Carry less on every call</h3><p>Lean levels hide tools and built-in skills a coding session rarely needs. They’re sent with every call, so trimming them saves on all of them.</p><p class="how">${fmtK(off, true)} → ${fmtK(bal, true)} per call by default</p></article>
      <article class="card"><h3><i style="background:var(--s2)"></i>Keep tool output small</h3><p>Big file dumps fold to their outline, long lines are cut, and build and test runs report only the summary and failures. Whatever lands in context is re-sent on every later call.</p><p class="how">tview · tkit check / test</p></article>
      <article class="card"><h3><i style="background:var(--muted)"></i>Make fewer calls</h3><p>Several reads in one call, edits batched together, past sessions searched instead of re-explored, and a question you already asked answered without a model call.</p><p class="how">median ${Math.round(a.medianToolCallReduction)}% fewer tool calls</p></article>
    </div>
  </section>

  <section class="psec" id="idea">
    <p class="plabel">One real session</p>
    <h2>The same task, measured: two real sessions.</h2>
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
  anatomy(view.querySelector('#anatomy') as HTMLElement);
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
