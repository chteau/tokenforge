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
  ['Profile the system.', 'CPU, memory, I/O, hook time, worker startup and index cost. Optimize only confirmed bottlenecks. <span class="done">Done</span> Each hook takes 31–60 ms (22 ms of it Node starting), the <code>tmap</code> index 168 ms cold and 14 ms warm, the proxy 50 ms per request at 1,000 tool calls: none is a bottleneck against model calls of several seconds.'],
];

// A plan item already done in ROADMAP.md ([x]).
const ok = (s: string) => `<span class="done">Done</span> ${s}`;

const ITEMS: Item[] = [
  {
    prio: 'P0', title: 'Every result names the version that produced it',
    today: 'Every benchmark run records the TokenForge and Claude Code versions, and the environment a hash of the plugin files. The README, the reports and the site name them under every figure: the headline results come from 0.7.0 (34 tasks) and 0.8.0 (2 tasks) runs on Claude Code 2.1.293. Each run’s manifest also records the plugin build hash.',
    plan: [
      ok('Show the TokenForge version, build hash and Claude Code version next to every published figure: site, README, reports.'),
      ok('Refuse to build a report from runs of different versions, unless it labels each one.'),
    ],
  },
  {
    prio: 'P0', title: 'A safer answer cache',
    why: 'An unchanged project does not prove an answer still holds. “Do the tests pass?” asked again after a dependency or environment change is the same text, and may need a different answer.',
    today: 'An earlier answer is replayed only for the same question, from a turn that edited nothing, when no project file (tracked, or untracked and not ignored) has changed since. Prompts that ask to review, verify, check or audit (English and French) skip it. Sending the message again asks Claude; <code>TFORGE_ANSWER_CACHE=0</code> turns it off.',
    plan: [
      ok('Never replay an answer to a request to run, test, build or verify something, to a security question, or to a question about the current state (“is it up”, “latest”, “now”).'),
      ok('Tell questions that ask for information from requests that need an action or a fresh observation. When unsure, ask Claude.'),
      ok('Include the repo’s identity, the model, the configuration and the relevant dependencies in the cache’s validity, where they affect the answer.'),
      ok('An explicit, visible bypass that works before sending, not only by sending again.'),
      ok('Adversarial tests for false positives: the same words with another intent, other languages, a changed environment with unchanged files.'),
    ],
  },
  {
    prio: 'P0', title: 'Formal cache invalidation',
    why: 'The <code>tmap</code> index, compacted instructions, cross-session memory, snapshots and answers depend on different things and stay valid for different times.',
    today: 'Every cache declares what it depends on (<code>tforge caches</code>) and is checked by content where correctness needs it: the answer cache compares repo, commit, file contents, dependencies, model and terse level; the <code>tmap</code> index hashes a file unless its size, times and inode are unchanged and were recorded 2 s after its last write; compacted instruction files are keyed by content. Transcript-based indexes notice a replaced file. Cache writes are atomic, with tests for same-second edits, renames, deletions, branch switches, concurrent writers and torn files.',
    plan: [
      ok('Content hashes where correctness needs them; size and mtime only as a fast pre-check.'),
      ok('Each cached artifact declares what it depends on (<code>tforge caches</code>).'),
      ok('Tests for renames, deletions, edits within the mtime resolution, configuration changes and git branch switches.'),
      ok('Concurrency tests, and invalidation after an interrupted write.'),
      ok('Keep local computation caches, working memory and the provider’s prompt cache clearly apart.'),
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
    today: 'Differential and property tests run each rewrite next to the original and compare exit codes, written files and output lines; <code>tkit test</code> is compared with the runner it replaces. Build and test commands are rewritten only when their flags are fully understood, heredocs are never touched, a <code>TFORGE_RAW=1</code> prefix runs a command as typed, and <code>TFORGE_SHOW_REWRITE</code> shows each rewrite.',
    plan: [
      ok('Differential tests: run the original and the rewritten command, compare exit codes and outputs.'),
      ok('Property tests over quoting, pipes, redirections, substitutions, paths with spaces, environment variables and exit codes.'),
      ok('Check that output caps never hide an error at the end of a log, or one in the omitted middle of a failed run.'),
      ok('Compare <code>tkit test</code> with the native test command.'),
      ok('A diagnostic mode that shows the exact rewrite before it runs (<code>TFORGE_SHOW_REWRITE</code>, <code>tforge route</code>).'),
    ],
  },
  {
    prio: 'P1', title: 'Harden permissions and cleanup',
    why: 'TokenForge touches permissions, hooks, detached processes and temporary files.',
    today: '<code>tforge gc</code> deletes only inside real directories you own and never through a symlink. It keeps a session’s scratch while Claude Code lists the session as running (a reused pid does not count), while a process works in it or holds a file open there, and for 12 hours after its last change; a victim is moved aside and checked again before it is deleted. When it can’t tell (no session registry, <code>lsof</code> fails on macOS, a <code>/proc</code> that hides this process’s own files), it removes no scratch. Not seen: processes of yours in another pid namespace (a container) that Claude Code’s registry does not list.',
    plan: [
      ok('Races between a check and the deletion that follows.'),
      ok('Symlinks and canonical paths.'),
      ok('PID reuse when deciding whether a process is still alive.'),
      ok('File permissions and ownership.'),
      'Every case where a process can’t be detected: keep the files, as macOS does now.',
      ok('The effects of the <code>permissions.deny</code> entries lean levels write to your settings.'),
    ],
  },
  {
    prio: 'P1', title: 'Workers: the plan is a trust boundary',
    why: 'Workers can’t run commands: the driver runs each task’s <code>verify</code> command from the plan.',
    today: 'Checks run in the project root with a time limit (<code>verifyTimeoutMin</code>, 10 minutes by default, bounded), and the limit kills the whole process tree. Sensitive tasks and <code>isolateChecks</code> run them in a throwaway worktree; elsewhere, files a check writes are reported, not undone. The docs say to read a plan before running it and to build on a branch or a worktree.',
    plan: [
      ok('Stricter validation of <code>verify</code> commands.'),
      ok('Time limits and working directories enforced for every check.'),
      'Side effects of checks isolated.',
      ok('For sensitive tasks, checks run in a git worktree or a sandbox, never in the current environment without inspection.'),
    ],
  },
  {
    prio: 'P2', title: 'Adaptive orchestration',
    why: 'Plan, split, then run disposable workers pays off on multi-file work. On a two-file change, a small fix or an investigation that needs a lot of shared context, it can cost more.',
    today: '<code>tforge validate</code> recommends a strategy from the plan: inline for fewer than 5 files or 3 tasks, a serial chain of up to 5 tasks, or tasks that each start with most of the planned context; workers otherwise. The thresholds come from earlier measurements, not yet from a strategy benchmark.',
    plan: [
      ok('Pick the strategy from the estimated number of files, the coupling between tasks (dependency chain, shared context) and the size of each worker’s starting context.'),
      'Add the planning, verification and integration cost and the risk of conflicts between workers, and tune the thresholds on the strategy benchmark (needs API runs).',
    ],
    note: 'The goal is the cheapest setup for the actual task, not workers by default.',
  },
  {
    prio: 'P2', title: 'Lean levels: measure the whole cost',
    why: '<code>balanced</code>, <code>max</code> and <code>ultra</code> hide tools: <code>max</code> and <code>ultra</code> hide skills and subagents, <code>ultra</code> also the native Read, Edit and Write, and asks for edits through <code>tkit edit</code>. If <code>ultra</code> saves tool definitions but causes more Bash calls, quoting errors or failed edits, the saving can vanish.',
    today: 'Each level’s fixed context per request is measured.',
    plan: ['A report per level: tokens, cost, quality, time, attempts and regressions, not only the starting context.'],
  },
  {
    prio: 'P2', title: 'Smaller code reads',
    today: 'With lean <code>ultra</code> and the proxy, 6 benchmark tasks save a median 57% of tokens (0.9.2 development builds dc3cea66, ef3ee560 and 0ee08a19 on Claude Code 2.1.296: 9 runs per task against 4 native runs, quality unchanged). Most of what is left is code read through Bash: in 18 runs, <code>cat</code> returned 345k characters and <code>sed -n</code> 229k, read again on every later call until pruned. Architecture and banking-transfers sit at 55-59%; 3 more points on each would put the median past 60%. Replay of the 90 recorded ultra + proxy sessions (<code>node bench/scripts/read-replay.mjs --lean ultra</code>): <code>cat</code> is 64% of all tool-result characters and <code>sed -n</code> 23%, but most reads are short: only 82 <code>cat</code> and 22 <code>sed -n</code> results exceed 4k characters (11% and 3% of the total). After an edit of a file, 174 earlier reads of it (464k characters) were never used again yet re-sent with every later request.',
    plan: [
      ok('Replay the recorded commands (no API calls): which <code>cat</code> and <code>sed -n</code> outputs are long enough to fold, and how often the model reads the same lines again after a fold.'),
      ok('Fold <code>sed -n</code> ranges only where the replay shows no re-read. Decided against: 22 ranges over 4k in 90 sessions, 3% of tool-result characters, and 5% of them read again.'),
      ok('Prune a file’s earlier reads once a later read or an edit of the same file supersedes them. Within a turn too (one <code>claude -p</code> session is one turn): a read of a file edited since goes once the model has not touched the file for 6 calls. Replayed, that removes 5.6% of what reads re-send, and no file was edited again without being read first; at 4 calls it would be 7.0%, with 4 such edits.'),
      'Measure the change on the benchmark tasks (needs API runs).',
    ],
  },
];

const COLS = ['Today', 'Optimize for', 'Risk to test'];

const LAYERS = [
  ['Provider prompt cache', 'Policy and instruction text stay identical between calls', 'Stable prefixes and configuration, no needless prefix changes', 'Missed or expired cache'],
  ['<code>tmap</code> index', 'Re-parses files whose content changed; stat only as a settled pre-check', 'Incremental index with explicit dependencies', 'Stale index'],
  ['Instruction cache', 'Compacted text keyed by content and parser version', 'Reuse with reliable invalidation', 'File changed, cache didn’t'],
  ['Cross-session memory', '<code>tforge recall</code>, on demand', 'On-demand retrieval with provenance', 'An old assumption taken as fact'],
  ['Snapshots and handoffs', 'Chunks kept by use; the automatic handoff is deleted once used', 'Compact storage, selective retrieval', 'Incomplete or contradictory state'],
  ['Answer cache', 'Same question; same repo, commit, file contents, dependencies, model and terse level', 'Reuse only while the answer still holds', 'Stale answer, or a check skipped'],
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
    <div class="crumb">Roadmap · updated 2026-10-12</div>
    <h1>What comes next</h1>
    <p>0.9.2 makes the savings safe and checkable: a cache reuses an answer only while it still holds, a rewritten command behaves like the original, and every published number names the version that produced it. This plan follows an external review of the public repo, which read the docs and the benchmark method, not the code or the test suite.</p>
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
