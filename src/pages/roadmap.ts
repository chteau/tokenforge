// Roadmap, mirrored from the plugin's ROADMAP.md (github.com/chteau/tokenforge). Plain, direct language.

interface Item { prio: 'P0' | 'P1' | 'P2'; title: string; why?: string; today: string; plan: string[]; note?: string }

const RULES = [
  '<strong>Prefer a missed reuse to a wrong one.</strong> A cache that skips a reusable answer costs tokens. One that replays a stale answer, or skips a check that was needed, costs correctness.',
  '<strong>Optimize how output is shown, never what a command does.</strong>',
  '<strong>One validity policy for every cache</strong>, with rules for each kind of artifact, not one algorithm for all.',
  '<strong>Measure each optimization on its own.</strong>',
];

const STEPS: [string, string][] = [
  ['Validate 0.9.1 on real data.', 'Regenerate the reports from 0.9.1 runs, check the version each run recorded, fix any page that mixes versions.'],
  ['Audit the answer cache and cache invalidation.', 'Adversarial tests, a visible bypass, freshness checks.'],
  ['Differential tests for the Bash router and <code>tkit</code>.', 'Exit codes, cut logs and rewritten commands first.'],
  ['Benchmark lean levels and orchestration strategies.', 'Find where each one really wins, instead of tuning one scenario.'],
  ['Profile the system.', 'CPU, memory, I/O, hook time, worker startup and index cost. Optimize only confirmed bottlenecks.'],
];

const ITEMS: Item[] = [
  {
    prio: 'P0', title: 'Every result names the version that produced it',
    today: 'Every benchmark run records the TokenForge and Claude Code versions, and the environment a hash of the plugin files. But the site’s headline figures come from 0.8.0 runs while its pages show the current version, 0.9.1. The benchmarked version is named only further down the benchmark page.',
    plan: [
      'Show the TokenForge version, build hash and Claude Code version next to every published figure: site, README, reports.',
      'Refuse to build a report from runs of different versions, unless it labels each one.',
    ],
  },
  {
    prio: 'P0', title: 'A safer answer cache',
    why: 'An unchanged project does not prove an answer still holds. “Do the tests pass?” asked again after a dependency or environment change is the same text, and may need a different answer.',
    today: 'An earlier answer is replayed only for the same question, from a turn that edited nothing, when no project file (tracked, or untracked and not ignored) has changed since. Prompts that ask to review, verify, check or audit (English and French) skip it. Sending the message again asks Claude; <code>TFORGE_ANSWER_CACHE=0</code> turns it off.',
    plan: [
      'Never replay an answer to a request to run, test, build or verify something, to a security question, or to a question about the current state (“is it up”, “latest”, “now”).',
      'Tell questions that ask for information from requests that need an action or a fresh observation. When unsure, ask Claude.',
      'Include the repo’s identity, the model, the configuration and the relevant dependencies in the cache’s validity, where they affect the answer.',
      'An explicit, visible bypass that works before sending, not only by sending again.',
      'Adversarial tests for false positives: the same words with another intent, other languages, a changed environment with unchanged files.',
    ],
  },
  {
    prio: 'P0', title: 'Formal cache invalidation',
    why: 'The <code>tmap</code> index, compacted instructions, cross-session memory, snapshots and answers depend on different things and stay valid for different times.',
    today: 'The <code>tmap</code> index and the instruction cache trust a file whose size and modification time are unchanged, and the answer cache compares modification times.',
    plan: [
      'Content hashes where correctness needs them; size and mtime only as a fast pre-check.',
      'Each cached artifact declares what it depends on.',
      'Tests for renames, deletions, edits within the mtime resolution, configuration changes and git branch switches.',
      'Concurrency tests, and invalidation after an interrupted write.',
      'Keep local computation caches, working memory and the provider’s prompt cache clearly apart.',
    ],
  },
  {
    prio: 'P1', title: 'Benchmark 0.9.1 properly',
    today: 'The headline results are 83 runs of 0.8.0 over 36 tasks, mostly one run per side. The 0.9.0 planning-line A/B is paired, with 95% intervals, one run per task on each side.',
    plan: [
      'Regenerate a full report from 0.9.1 runs only.',
      'Keep per-task comparisons, not only aggregates.',
      '3 to 5 repetitions on representative tasks.',
      'Separate the first call, a warm cache, an expired cache and a resume after <code>/clear</code>.',
      'Analyze quality regressions and the tasks that cost more.',
      'Publish commit hashes, versions, configurations and raw reports.',
      'Paired comparisons, medians and uncertainty intervals, not a single mean.',
    ],
  },
  {
    prio: 'P1', title: 'Test command rewrites',
    why: 'The Bash router turns some commands into <code>tkit</code> calls or compacts their output. That saves a lot, and it is also where an optimization could change what a command does.',
    today: 'The tests check the rewritten command line. Build and test commands are rewritten only when their flags are fully understood, heredocs are never touched, and a <code>TFORGE_RAW=1</code> prefix runs a command as typed.',
    plan: [
      'Differential tests: run the original and the rewritten command, compare exit codes and outputs.',
      'Property tests over quoting, pipes, redirections, substitutions, paths with spaces, environment variables and exit codes.',
      'Check that output caps never hide an error at the end of a log.',
      'Compare <code>tkit test</code> with the native test command.',
      'A diagnostic mode that shows the exact rewrite before it runs.',
    ],
  },
  {
    prio: 'P1', title: 'Harden permissions and cleanup',
    why: 'TokenForge touches permissions, hooks, detached processes and temporary files.',
    today: '<code>tforge gc</code> does not follow symlinks. It keeps a session’s scratch while Claude Code lists the session as running, while a process works in it or holds a file open there, and for 12 hours after its last change. When it can’t tell (no session registry, or <code>lsof</code> fails on macOS), it removes no scratch.',
    plan: [
      'Audit races between a check and the deletion that follows.',
      'Audit symlinks and canonical paths.',
      'Audit PID reuse when deciding whether a process is still alive.',
      'Audit file permissions and ownership.',
      'Every case where a process can’t be detected: keep the files, as macOS does now.',
      'Audit the effects of the <code>permissions.deny</code> entries lean levels write to your settings.',
    ],
  },
  {
    prio: 'P1', title: 'Workers: the plan is a trust boundary',
    why: 'Workers can’t run commands: the driver runs each task’s <code>verify</code> command from the plan.',
    today: 'Checks run in your checkout with a time limit (<code>verifyTimeoutMin</code>, 10 minutes by default). The docs say to read a plan before running it and to build on a branch or a worktree.',
    plan: [
      'Stricter validation of <code>verify</code> commands.',
      'Time limits and working directories enforced for every check.',
      'Side effects of checks isolated.',
      'For sensitive tasks, checks run in a git worktree or a sandbox, never in the current environment without inspection.',
    ],
  },
  {
    prio: 'P2', title: 'Adaptive orchestration',
    why: 'Plan, split, then run disposable workers pays off on multi-file work. On a two-file change, a small fix or an investigation that needs a lot of shared context, it can cost more.',
    today: 'The <code>forge</code> skill works inline below about 5 files.',
    plan: ['Pick the strategy from the estimated number of files, the coupling between modules, the planning cost, the verification and integration cost, the size of the starting context and the risk of conflicts between workers.'],
    note: 'The goal is the cheapest setup for the actual task, not workers by default.',
  },
  {
    prio: 'P2', title: 'Lean levels: measure the whole cost',
    why: '<code>balanced</code>, <code>max</code> and <code>ultra</code> hide tools: <code>max</code> and <code>ultra</code> hide skills and subagents, <code>ultra</code> also the native Read, Edit and Write. If <code>ultra</code> saves tool definitions but causes more Bash calls, quoting errors or failed edits, the saving can vanish.',
    today: 'Each level’s fixed context per request is measured.',
    plan: ['A report per level: tokens, cost, quality, time, attempts and regressions, not only the starting context.'],
  },
];

const COLS = ['Today', 'Optimize for', 'Risk to test'];

const LAYERS = [
  ['Provider prompt cache', 'Policy and instruction text stay identical between calls', 'Stable prefixes and configuration, no needless prefix changes', 'Missed or expired cache'],
  ['<code>tmap</code> index', 'Re-parses files whose size or mtime changed', 'Incremental index with explicit dependencies', 'Stale index'],
  ['Instruction cache', 'Compacted text keyed by size and mtime', 'Reuse with reliable invalidation', 'File changed, cache didn’t'],
  ['Cross-session memory', '<code>tforge recall</code>, on demand', 'On-demand retrieval with provenance', 'An old assumption taken as fact'],
  ['Snapshots and handoffs', 'Chunks kept by use; the automatic handoff is deleted once used', 'Compact storage, selective retrieval', 'Incomplete or contradictory state'],
  ['Answer cache', 'Same question, no project file changed since', 'Reuse only while the answer still holds', 'Stale answer, or a check skipped'],
];

const METRICS = [
  'the share of hits that were actually useful',
  'the cost to build, to invalidate, and of a miss',
  'the time to retrieve',
  'the number of stale results detected',
  'the cost of errors caused by a wrong reuse',
];

const list = (xs: string[]) => `<ul>${xs.map((x) => `<li>${x}</li>`).join('')}</ul>`;

const card = (it: Item) => `<article class="card ritem">
  <h3><span class="prio ${it.prio.toLowerCase()}">${it.prio}</span>${it.title}</h3>
  ${it.why ? `<p>${it.why}</p>` : ''}
  <p class="today"><b>Today.</b> ${it.today}</p>
  ${list(it.plan)}
  ${it.note ? `<p>${it.note}</p>` : ''}
</article>`;

export function roadmap(view: HTMLElement): void {
  view.innerHTML = `
  <header class="page-head">
    <div class="crumb">Roadmap · updated 2026-10-09</div>
    <h1>What comes next</h1>
    <p>0.9.2 adds no features. It makes the savings safe and checkable: a cache reuses an answer only while it still holds, a rewritten command behaves like the original, and every published number names the version that produced it. This plan follows an external review of the public repo, which read the docs and the benchmark method, not the code or the test suite.</p>
  </header>

  <div class="grid cols-2" style="align-items:start">
    <section class="card prose"><h2>Rules</h2>${list(RULES)}</section>
    <section class="card prose"><h2>0.9.2, in order</h2>
      <ol class="rsteps">${STEPS.map(([t, d], i) => `<li><span class="step-num">${i + 1}</span><span><b>${t}</b> ${d}</span></li>`).join('')}</ol>
    </section>
  </div>

  <section class="section">
    <div class="section-head"><div class="eyebrow">By priority</div><h2>The work</h2>
      <p>P0: what TokenForge reuses and reports must be right. P1: the boundaries where an optimization could change behavior. P2: the cheapest strategy for each task, measured.</p></div>
    <div class="grid cols-2">${ITEMS.map(card).join('')}</div>
  </section>

  <section class="card prose" style="margin-top:18px">
    <h2>Caching</h2>
    <p>Six layers with six sets of dependencies. They share one validity policy, with rules for each layer.</p>
    <div class="scroll"><table class="stack">
      <thead><tr><th>Layer</th>${COLS.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
      <tbody>${LAYERS.map(([layer, ...r]) => `<tr><td><strong>${layer}</strong></td>${r.map((c, i) => `<td data-l="${COLS[i]}">${c}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>
    <h3>Measured for each cache</h3>
    ${list(METRICS)}
    <div class="callout">A cache with 99% hits that sometimes serves a wrong answer can be worse than a more cautious one with 85%.</div>
    <p><a href="https://github.com/chteau/tokenforge/blob/master/ROADMAP.md">ROADMAP.md on GitHub →</a></p>
  </section>`;
}
