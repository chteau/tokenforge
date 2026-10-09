import { resultsTable } from '../charts/dumbbell';
import { data, MODEL_NAME } from '../data';
import { bindCopy, fmtInt, pct } from '../util';

export function benchmark(view: HTMLElement): void {
  const a = data.aggregate;
  const models = Object.entries(data.apiModels).map(([m, n]) => `<code>${m}</code> (${n} runs)`).join(', ');
  view.innerHTML = `
  <header class="page-head">
    <div class="crumb">Benchmark</div>
    <h1>Clean Claude Code vs TokenForge</h1>
    <p>The same ${a.tasks} tasks, run in sandboxed sessions with ${MODEL_NAME} on both sides. Tokens come from the API usage in every transcript. Quality comes from hidden tests. Everything is in the plugin repo’s <code>bench/</code> folder, so you can rerun it.</p>
  </header>

  <section class="grid cols-4" aria-label="Summary">
    <div class="card kpi"><span class="label">Median total tokens saved</span><span class="value">−${Math.round(a.medianSavings)}%</span><span class="note">mean −${Math.round(a.meanSavings)}%, pooled −${Math.round(a.pooledSavings)}%, fewer on ${a.tasksFewerTokens}/${a.tasks}</span></div>
    <div class="card kpi"><span class="label">Cheaper at list prices on</span><span class="value">${a.tasksCheaper}/${a.tasks}</span><span class="note">range ${pct(a.maxPriceWeighted)} to ${pct(a.minPriceWeighted)}</span></div>
    <div class="card kpi"><span class="label">Median cost at list prices</span><span class="value">${pct(a.medianPriceWeighted)}</span><span class="note">roughly what usage limits count</span></div>
    <div class="card kpi"><span class="label">Runs</span><span class="value">${a.runs}</span><span class="note">all answered by ${data.model.join(', ')}</span></div>
  </section>

  <section class="card" style="margin-top:18px">
    <h2>Per-task results</h2>
    <p class="sub">Each row is the median of the runs on each side. “Saved” is total tokens (input, cache reads and writes, output). “List price” is the cost at ${MODEL_NAME} list prices: cache reads 0.05× input, cache writes 1.25× (5-minute) or 2× (1-hour, split per response as logged), output 5×. Quality is the 0–100 score from hidden tests and checks.</p>
    ${resultsTable(undefined, true)}
  </section>

  <section class="card prose" style="margin-top:18px">
    <h2>Planning line A/B (0.9.0)</h2>
    <p>The results above compare TokenForge ${data.tokenforgeVersion} with clean Claude Code. 0.9.0 adds a planning line to the efficiency policy: look at the repo first, plan briefly, never draft code in thinking. It was measured against the same build without it, on the same ${a.tasks} tasks (Claude Code 2.1.295, one run per task on each side):</p>
    <ul>
      <li>List cost −15.5% per task (95% CI −20.8% to −9.8%), −18.8% pooled; lower on 27 of 36 tasks, higher on nine.</li>
      <li>Thinking −44%, total tokens −22%, tool calls −20%, wall-clock −21%.</li>
      <li>Quality −0.26 points (95% CI −1.03 to +0.52); 1215 of 1219 hidden tests passed on both sides.</li>
      <li>The line adds 106 input tokens per session, included in every figure.</li>
    </ul>
    <p><a href="https://github.com/chteau/tokenforge/blob/master/bench/reports/final-comparison.md">Full report →</a></p>
  </section>

  <div class="grid cols-2" style="margin-top:18px;align-items:start">
    <section class="card prose">
      <h2>Method</h2>
      <h3>Two agents, one difference</h3>
      <table><thead><tr><th></th><th>native</th><th>token-forge</th></tr></thead><tbody>
        <tr><td>Claude Code</td><td colspan="2">${data.claudeCodeVersion}, <code>-p</code> mode, same flags</td></tr>
        <tr><td>Model</td><td colspan="2"><code>claude-opus-5-5</code>, pinned with <code>--model</code> and checked against every API response</td></tr>
        <tr><td>Plugins, skills, hooks, MCP, CLAUDE.md</td><td>none</td><td>TokenForge ${data.tokenforgeVersion} only, defaults (lean <code>${data.defaultLean}</code>)</td></tr>
        <tr><td>Task, prompt, repo commit, toolchains, timeout</td><td colspan="2">identical</td></tr>
      </tbody></table>
      <p>Models seen in API responses: ${models}. Runs answered by another model: ${data.runsWithOtherModels}. Contaminated or invalid runs: ${data.contaminatedRuns}.</p>
      <h3>Sandboxing</h3>
      <ul>
        <li>Each run gets a fresh, disposable sandbox. <code>HOME</code> and <code>CLAUDE_CONFIG_DIR</code> are empty directories, so no settings, plugins, skills, memory or history from the machine can leak in.</li>
        <li>The environment is built from an allow-list. <code>--strict-mcp-config</code> means zero MCP servers.</li>
        <li>The repo is a copy at a fixed, verified commit, under a random path that never mentions TokenForge or benchmarks.</li>
        <li>A preflight audit checks every ancestor folder for <code>CLAUDE.md</code>, <code>.claude/</code> and <code>.mcp.json</code>. A native run with any finding is not launched.</li>
        <li>After the run, Claude Code’s own <code>init</code> event and the hook records prove what actually loaded.</li>
        <li>The TokenForge copy has no <code>bench/</code> folder, so hidden tests are out of reach.</li>
      </ul>
      <h3>Token measurement</h3>
      <p>The source of truth is every transcript in the run’s config dir: main session, subagents and nested sessions, deduplicated by request ID. All numbers are exact API <code>usage</code> values. TokenForge’s own overhead is included: its hook text, its skill listing and its nested model calls all count.</p>
      <p>TokenForge’s first request was ${fmtInt(Math.abs(a.firstRequestOverhead))} tokens smaller than clean Claude Code’s (median across tasks): the lean level outweighs the hook text it adds.</p>
      <h3>Quality score</h3>
      <table><thead><tr><th>Component</th><th class="num">Points</th><th>Measured by</th></tr></thead><tbody>
        <tr><td>Correctness</td><td class="num">40</td><td>share of hidden behaviour tests passing</td></tr>
        <tr><td>Regression protection</td><td class="num">20</td><td>original suite still passes; agent added passing tests</td></tr>
        <tr><td>Architecture</td><td class="num">15</td><td>task-specific structural checks</td></tr>
        <tr><td>Completeness</td><td class="num">15</td><td>requirement groups whose hidden tests all pass</td></tr>
        <tr><td>Cleanliness</td><td class="num">10</td><td>no unrelated changes, fmt/lint clean, diff size</td></tr>
      </tbody></table>
      <p>PR review and architecture tracing use their own graders: recall and precision against planted issues, and ground-truth steps found.</p>
    </section>

    <div class="grid">
      <section class="card prose">
        <h2>Caveats, stated plainly</h2>
        <ul>
          <li><strong>Single runs.</strong> Most tasks have one run per side, a few have two or three. Single runs vary by about ±20%. Read per-task numbers as rough and the overall result as solid.</li>
          <li><strong>One task left out.</strong> A Ruby log analyzer was run once per side and is not in these results: TokenForge used 14% more tokens on it (443k vs 390k), quality 96.25 vs 96.83. The exclusion is listed in <code>bench/benchmark.config.json</code> and the runs are kept.</li>
          <li><strong>Session length.</strong> The benchmark covers sessions of roughly 5–30 calls. Long interactive sessions are not measured yet.</li>
          <li><strong>Two small quality drops.</strong> Every hidden test passes on both, but the structural checks score lower: scheduled transfers 94 (design checks 9/15, as in every TokenForge run of that task) and the Perl config merger 97 (its entry script is longer than the 30 lines the spec asks for).</li>
          <li><strong>Hooks rewrite some commands.</strong> Raw build and test commands, broad <code>cat</code> dumps and <code>ssh</code> are rewritten to compact tools. See <a href="#/docs/hooks">Hooks</a> for the exact list and escape hatches.</li>
          <li><strong>First start edits your settings.</strong> TokenForge sets the <code>balanced</code> lean level once, tells you, and writes only its own entries. <code>tforge lean off</code> removes exactly those. Opt out before the first start with <code>TFORGE_LEAN_DEFAULT=off</code>.</li>
          <li><strong>One configuration.</strong> One model, one Claude Code version, one TokenForge version. All three are recorded in every run manifest.</li>
          <li><strong>Strict graders.</strong> Review and architecture graders match keywords and paths. A correct finding phrased unusually can be missed, for either agent equally.</li>
        </ul>
      </section>
      <section class="card prose">
        <h2>Two-session memory task</h2>
        <p>One extra task is a follow-up on the previous session’s feature. With recall, TokenForge used a median of 234k tokens, against 263k with injected snapshots and 413k for clean Claude Code, at full quality (two runs each; rough). It is not part of the ${a.tasks}-task headline.</p>
      </section>
      <section class="card prose">
        <h2>Rerun it</h2>
        <p>Needs Python 3.10+, git, and the task toolchains (Rust, Go 1.22+, Node 22.6+ with <code>tsc</code>, and the from-scratch stacks you run).</p>
        <pre data-copy><code>git clone https://github.com/chteau/tokenforge
cd tokenforge/bench
claude setup-token        <span class="c"># once; export CLAUDE_CODE_OAUTH_TOKEN=…</span>
python3 runner/bench.py env build
python3 runner/bench.py doctor
python3 runner/bench.py run --smoke
python3 runner/bench.py run --all
python3 runner/bench.py report</code></pre>
        <p>More: <code>bench.py list</code>, <code>bench.py run --task go-api --both</code>, and repetitions with <code>--subset-reps go-api,rust-debug --subset-n 3</code>. Reports land in <code>bench/reports/</code>. <code>bench/scripts/charts.py</code> redraws the README charts.</p>
        <p><a href="https://github.com/chteau/tokenforge/tree/master/bench">bench/ on GitHub →</a></p>
      </section>
    </div>
  </div>`;
  bindCopy(view);
}
