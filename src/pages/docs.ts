// Docs, derived from the plugin README and CHANGELOG (github.com/chteau/tokenforge). Plain, direct language.
import { leanTable } from '../charts/lean';
import { data } from '../data';
import { bindCopy, fmtK } from '../util';

interface Doc { slug: string; title: string; lead: string; body: () => string }

const pre = (code: string) => `<pre data-copy><code>${code}</code></pre>`;

export const DOCS: Doc[] = [
  {
    slug: 'install', title: 'Install & first start',
    lead: 'Two commands inside Claude Code. On first start, TokenForge sets one setting and tells you about it.',
    body: () => `
<h2>Install</h2>
<p>Run these inside Claude Code:</p>
${pre('/plugin marketplace add chteau/tokenforge\n/plugin install tokenforge@tokenforge')}
<p><strong>Requirements:</strong> Claude Code and Node.js 18 or newer. Subscription (OAuth) logins and API keys both work. The <code>tmap</code> indexer needs a release binary for your platform, or Rust to build one.</p>
<p>Plugins load only when Claude Code starts. Start a new session after installing. <code>/clear</code> does not reload plugins.</p>

<h2>What happens on first start</h2>
<ul>
  <li><strong>Lean level <code>balanced</code> is set once.</strong> You get a message (shown to you, not to Claude). TokenForge writes only its own entries to <code>~/.claude/settings.json</code>: <code>permissions.deny</code> and <code>skillOverrides</code>. Plugins cannot set permissions themselves, so this is the only way. It never re-applies after you pick a level.</li>
  <li><strong>The local dashboard starts in the background.</strong> It listens on <code>127.0.0.1:7878</code> (or the next free port).</li>
  <li><strong>A small session context is added</strong>: about 640 characters. One terse-reply rule and a two-line efficiency policy.</li>
  <li><strong>Hooks start working.</strong> Some commands get rewritten to compact tools. See <a href="#/docs/hooks">Hooks</a>.</li>
</ul>
<div class="callout"><b>Opt out of the settings change.</b> Set <code>TFORGE_LEAN_DEFAULT=off</code> before the first start. You can also pick another level the same way: <code>on</code>, <code>max</code> or <code>ultra</code>.</div>
${pre('TFORGE_LEAN_DEFAULT=off claude')}
<p>To undo it later, run <code>tforge lean off</code>. It removes exactly the entries TokenForge added, never your own.</p>

<h2>Updates</h2>
<p>TokenForge is a normal plugin. It never patches Claude Code or wraps the <code>claude</code> binary, so Claude Code’s auto-update keeps working. It edits your settings only for lean levels (above).</p>
<p>To update TokenForge automatically: open <code>/plugin</code>, go to <strong>Marketplaces</strong>, select <code>tokenforge</code> and enable auto-update. Or run this whenever you like:</p>
${pre('/plugin marketplace update tokenforge')}

<h2>Uninstall</h2>
${pre('/plugin uninstall tokenforge@tokenforge')}
<p>Nothing is left behind except <code>.forge/</code> folders in the projects where you used it. If you want the lean entries gone too, run <code>tforge lean off</code> first.</p>`,
  },
  {
    slug: 'lean', title: 'Lean levels',
    lead: 'Every request carries the definition of every enabled tool and skill. Lean levels hide the ones a coding session rarely needs.',
    body: () => `
<h2>The levels</h2>
<p>Measured fixed context per request (Claude Code ${data.claudeCodeVersion}, Opus 5.5):</p>
${leanTable()}
<ul>
  <li><strong><code>on</code></strong> hides agent-orchestration tools: Workflow, Monitor, Cron*, ScheduleWakeup, RemoteTrigger, PushNotification, SendMessage, ListAgents, TaskStop, DesignSync, ReportFindings, worktrees, NotebookEdit.</li>
  <li><strong><code>balanced</code></strong> (default) also marks Claude Code’s 19 built-in skills <code>user-invocable-only</code>. Claude no longer sees them, but you can still type them as slash commands. Your own skills, plugin skills, subagents and web tools stay.</li>
  <li><strong><code>max</code></strong> also hides the Skill tool, subagents (<code>Task</code>), <code>WebFetch</code>/<code>WebSearch</code> and Claude Code’s git instructions.</li>
  <li><strong><code>ultra</code></strong> also hides <code>Read</code>/<code>Edit</code>/<code>Write</code>. Claude reads and edits files with Bash (<code>sed -n</code>, <code>cat &gt; file</code>, scripts). No image or PDF viewing.</li>
</ul>

<h2>Change the level</h2>
<p>Any of these works. Changes apply to sessions started afterwards.</p>
${pre('/tokenforge:lean balanced     # inside Claude Code\ntforge lean max               # in a terminal\ntforge lean off               # remove everything TokenForge added')}
<p>The dashboard’s <strong>Settings</strong> page does the same, and also lets you pick which built-in skills Claude may still use on its own.</p>

<h2>What gets written</h2>
<p>Only TokenForge’s own entries in <code>~/.claude/settings.json</code>: <code>permissions.deny</code>, <code>skillOverrides</code>, and <code>includeGitInstructions</code> at <code>max</code>/<code>ultra</code>. <code>off</code> removes exactly those.</p>

<h2>Which one to use</h2>
<p>Keep <code>balanced</code> unless you have a reason. On short tasks this fixed floor is most of the cost, so going lower helps. <code>ultra</code> is the smallest, but Claude loses image and PDF viewing.</p>`,
  },
  {
    slug: 'dashboard', title: 'Dashboard',
    lead: 'A local web UI that shows where your tokens went. It starts in the background with your first session.',
    body: () => `
<h2>Open it</h2>
${pre('/tokenforge:dashboard     # inside Claude Code\ntforge ui                 # in a terminal')}
<p>The address is <code>http://127.0.0.1:7878/</code>, or the next free port. <code>tforge ui --stop</code> stops it. <code>TFORGE_UI=0</code> stops it from starting with your first session. <code>TFORGE_UI_PORT</code> changes the port.</p>

<h2>Settings</h2>
<ul>
  <li><strong>Health first:</strong> how many recent sessions actually loaded TokenForge, which run an older build, and which still fire hooks of removed plugins.</li>
  <li>The <strong>lean level</strong>, which built-in skills Claude may use on its own, and terse replies.</li>
</ul>
<p>When something needs attention, the overview shows a one-line banner.</p>

<h2>Overview</h2>
<ul>
  <li>Usage limits, with the time left until each reset.</li>
  <li>Today, 7-day and 30-day totals, and a 30-day chart split by token type.</li>
  <li>The last 48 hours, 5-hour windows over the last week, and usage per model.</li>
</ul>

<h2>Projects and “where the tokens went”</h2>
<p>Every folder Claude Code ran in, with sessions, calls and subagent share. Open a session to see its <strong>context-per-call curve</strong>. Every point is re-read by the next call, so the area under the curve is what the session cost. Compactions show up as drops.</p>
<p>Below the curve, <strong>Where the tokens went</strong> ranks the session’s tool results by estimated cost: size × the number of later calls that re-read it. That shows you which reads were expensive.</p>

<h2>Memory</h2>
<p>The project’s past sessions as a graph of sessions, the files they edited and recurring keywords. It has the same search Claude gets through <code>tforge recall</code>. Click a session for its prompts, commits, files and last reply.</p>

<h2>Code graph</h2>
<p>Folders and files as a force-directed graph, colored by language. Pan, zoom and drag. Hover to light up neighbors, switch on call links, filter by path or symbol, and click a file for its callers, callees and outline.</p>

<h2>Exact limits and resets</h2>
<p>Exact 5-hour and weekly usage only exist in the status-line data Claude Code passes to a status-line command. Run:</p>
${pre('tforge statusline --setup')}
<p>It installs a small recorder in <code>~/.config/tokenforge/</code> and prints a <code>statusLine</code> snippet for you to add to <code>~/.claude/settings.json</code>. Your current status line keeps running behind it. Without it, the dashboard estimates the 5-hour window from session timestamps and labels it as an estimate.</p>`,
  },
  {
    slug: 'memory', title: 'Memory & recall',
    lead: 'Past sessions cost tokens only when the task needs them.',
    body: () => `
<h2>tforge recall</h2>
<p><code>tforge recall &lt;words&gt;</code> searches the project’s past sessions: prompts, commit messages, files edited and read, and how each session ended. It returns the few matching sessions and files.</p>
${pre('tforge recall budget alerts\ntforge recall --session &lt;ID&gt;     # one session in full')}
<p>The index is built from your Claude Code transcripts. It lives in <code>~/.cache/tokenforge/memory/</code> and refreshes incrementally.</p>

<h2>What Claude sees at start</h2>
<p>On startup and after <code>/clear</code>, Claude gets <strong>one line</strong>: how many earlier sessions exist, the newest one’s first prompt, and a pointer to <code>tforge recall</code>. Before 0.7.0, the two newest snapshots were loaded instead, and re-read on every call (about 2k tokens each time).</p>
<ul>
  <li><code>TFORGE_RECALL=inject</code> restores the old snapshot loading.</li>
  <li><code>TFORGE_RECALL=0</code> turns the hint off.</li>
</ul>

<h2>Measured</h2>
<p>In the benchmark’s two-session task (a follow-up on the previous session’s feature), recall used a median of 234k tokens, against 263k with injected snapshots and 413k for clean Claude Code, at full quality. Two runs each, so treat it as rough.</p>

<h2>Snapshots</h2>
<p>After every reply, a hook saves the session in chunks to <code>.forge/snapshots/</code>: requests, changed files, last reply and context size. A chunk closes after 6 requests or at a compaction. The last 50 per project are kept. Hooks write them from the transcript, so they cost no tokens. <code>TFORGE_CHECKPOINT=0</code> stops them.</p>

<h2>Handoff</h2>
<p><code>/tokenforge:handoff</code> writes <code>.forge/HANDOFF.md</code>: what is done, decisions, next steps and a file map. Run <code>/clear</code> afterwards. The handoff reloads automatically if it is under 72 hours old (<code>TFORGE_HANDOFF_MAX_AGE_H</code>).</p>`,
  },
  {
    slug: 'repeated', title: 'Repeated questions',
    lead: 'Ask something you already asked, and you get the earlier answer at zero tokens.',
    body: () => `
<h2>How it works</h2>
<ul>
  <li>You ask a question you already asked in this project.</li>
  <li>That earlier turn changed no files.</li>
  <li>The prompt is <strong>not sent to Claude</strong>. You see the earlier answer and its date. Cost: 0 tokens.</li>
</ul>
<p>Want a fresh answer? <strong>Send the same message again</strong>, and it goes to Claude as usual.</p>

<h2>Similar questions</h2>
<p>A closely similar earlier question (for example “I forgot the dev admin password”) is not blocked. Claude gets the earlier answer as one short hint instead of searching for it.</p>

<div class="callout warn"><b>Not re-checked.</b> Answers come from your transcripts. If something changed outside Claude since then, send the message again.</div>

<h2>Turn it off</h2>
${pre('export TFORGE_ANSWER_CACHE=0')}`,
  },
  {
    slug: 'tread', title: 'tread & tview',
    lead: 'Read code in one call, and keep broad dumps small.',
    body: () => `
<h2>tread: several reads, one call</h2>
<p>Every call re-reads the whole context, so “grep, then sed” costs two round trips. <code>tread</code> takes any mix of specs in one call:</p>
<table><thead><tr><th>Spec</th><th>Reads</th></tr></thead><tbody>
  <tr><td><code>NAME</code>, <code>Type.method</code></td><td>definition(s) by name, from the code index</td></tr>
  <tr><td><code>path:40-80</code></td><td>those lines (<code>path:40</code> gives 5 lines around line 40)</td></tr>
  <tr><td><code>path:/regex/</code></td><td>the definition enclosing each match</td></tr>
  <tr><td><code>path</code></td><td>the whole file, long bodies folded when it is large</td></tr>
</tbody></table>
${pre('tread Ledger.add src/cli.rs:40-80 "src/store.rs:/fn save/"')}
<p>The code index covers Rust, TypeScript/TSX, JavaScript, Python and Go. Other languages use a fallback. The session policy tells Claude to use it.</p>

<h2>tview: cat with folding</h2>
<p>When Claude runs a plain <code>cat</code> of project files totalling 12k+ characters, the Bash hook sends it through <code>tview</code>:</p>
<ul>
  <li>Small files and short definitions print in full.</li>
  <li>Bodies longer than 8 lines fold to their signature plus the exact <code>sed -n a,bp</code> command that prints them.</li>
  <li>Lines over 400 characters (minified, generated, serialized) are cut to their first 200, plus the command for the rest.</li>
  <li>When nothing folds, the output is byte-identical to <code>cat</code>.</li>
</ul>
<p class="muted">Illustration of a folded body:</p>
<pre><code>pub fn monthly_totals(&amp;self, m: Month) -&gt; Totals {
<span class="hl">    … 37 lines folded: sed -n '142,178p' src/report.rs</span>
}</code></pre>
<p>Focused reads are never folded: folding the file you are working on would only cost a fetch-back call. Folding works in any language: tmap’s parser for Rust/TS/JS/Python/Go, and an indentation-based fallback for Luau, Lua, Ruby, Java, C#, Kotlin, C/C++, PHP and others.</p>
<p>Tune it with <code>TFORGE_VIEW_CHARS</code> (12000), <code>TFORGE_VIEW_FOLD</code> (8) and <code>TFORGE_VIEW_LINES</code> (40).</p>

<h2>Related tools</h2>
<ul>
  <li><strong><code>tmap</code></strong>: a bundled Rust code indexer. <code>tmap find &lt;words&gt;</code>, <code>tmap tree</code>, <code>tmap sym|callers|callees</code>, <code>tmap slice</code>. On a 1,228-file workspace: 0.9 s to index from scratch, about 25 ms per later command.</li>
  <li><strong><code>tkit &lt;tool&gt;</code></strong>: one call with short output instead of multi-step shell work. <code>check</code> and <code>test</code> (build/lint and test summaries), <code>diff</code>, <code>debug</code>, <code>ctx</code>, <code>deps</code>, <code>edit</code> and more. Every tool has <code>--help</code>.</li>
</ul>`,
  },
  {
    slug: 'hooks', title: 'Hooks',
    lead: 'What each hook does, which commands get rewritten, and how to get the raw behavior back.',
    body: () => `
<h2>Bash router</h2>
<p><strong>Event:</strong> PreToolUse on <code>Bash</code> and <code>Read</code>. <strong>Off:</strong> <code>TFORGE_KIT_ROUTE=0</code>.</p>
<h3>Rewritten</h3>
<ul>
  <li><strong>Raw build and test commands</strong> whose flags it fully understands become <code>tkit check</code> / <code>tkit test</code>: cargo, go, tsc, vitest/jest, npm/pnpm/yarn/bun test, dotnet, pytest, dart/flutter, mvn, gradle, mix, zig, swift, ctest, rspec, phpunit/pest, sbt (<code>.exe</code>/<code>.cmd</code> names included).</li>
  <li><strong><code>ssh HOST CMD</code> and <code>scp</code></strong> become <code>tkit ssh</code>.</li>
  <li><strong>A plain <code>cat</code> of project files totalling 12k+ characters</strong> goes through <code>tview</code> (see <a href="#/docs/tread">tread &amp; tview</a>).</li>
</ul>
<p>A rewrite happens only when every segment of the command line becomes a tkit/tview call or is read-only (<code>grep</code>, <code>sed -n</code>, <code>ls</code>, <code>git status</code>…), or the session already bypasses permissions. Otherwise the line runs unchanged, so a rewrite never adds a permission prompt. Lines with a heredoc are never touched.</p>
<h3>Refused, with the tkit command to use instead</h3>
<ul>
  <li>Interactive <code>ssh HOST</code>.</li>
  <li>Reading a saved tool output of 8k+ (<code>tool-results/*.txt</code>) whole. It points to <code>grep -n</code> / <code>sed -n</code>.</li>
  <li>Reads inside <code>node_modules</code>, <code>~/.cargo/registry</code>, Go <code>pkg/mod</code>, <code>~/.m2</code>, <code>~/.nuget</code>, wally and pub caches. Use <code>tkit deps api</code>.</li>
</ul>
<p>Anything else runs unchanged.</p>
<h3>Escape hatches</h3>
<ul>
  <li>Prefix one command with <code>TFORGE_RAW=1</code> (or <code>TS_RAW=1</code>). An <code>export</code> does not count.</li>
  <li>Repeat the identical call: it goes through.</li>
</ul>
${pre('TFORGE_RAW=1 cargo test')}

<h2>Efficiency policy</h2>
<p><strong>Events:</strong> SessionStart, SubagentStart. <strong>Off:</strong> <code>TFORGE_KIT_POLICY=0</code>.</p>
<p>A few lines, about 210 tokens. Results are re-read on every call, so read code in one call (<code>tread</code>), batch, edit each file in one call, and run checks once and only after code changes. Plus the scope rule: every stated requirement and nothing extra (no unasked features, docs, refactors, dependencies or abstractions), reuse existing code, concise but readable code, fix shared code once, infer instead of asking, stop once the checks pass. <code>TFORGE_LAZY=0</code> drops the scope rule. Subagents get only this policy.</p>

<h2>Terse rule</h2>
<p><strong>Events:</strong> startup, <code>/clear</code>, after compaction. One reply-style rule of about 200 tokens; nothing per prompt. Answers lead with the result. Code, paths, commands, numbers and negations stay exact. Security warnings and irreversible steps stay in full sentences. Files Claude writes keep their normal style. Switch with <code>/tokenforge:terse full|lite|off</code> or <code>TFORGE_TERSE</code>.</p>

<h2>Memory hint and handoff reload</h2>
<p><strong>Events:</strong> startup and <code>/clear</code>. One line pointing to <code>tforge recall</code> (see <a href="#/docs/memory">Memory</a>), and <code>.forge/HANDOFF.md</code> if it is under 72 hours old.</p>

<h2>Repeated questions</h2>
<p><strong>Event:</strong> UserPromptSubmit. <strong>Off:</strong> <code>TFORGE_ANSWER_CACHE=0</code>. See <a href="#/docs/repeated">Repeated questions</a>.</p>

<h2>Context budget</h2>
<p><strong>Events:</strong> PostToolUse, UserPromptSubmit. <strong>Off:</strong> <code>TFORGE_WATCH=0</code>.</p>
<p>The budget is 50k tokens of context per call, or the session’s fixed part plus 15k if that is larger. The warning is shown to you. It reaches Claude only with <code>TFORGE_WATCH_INJECT=1</code>. Over the budget, your next message is held once with a <code>/clear</code> suggestion. Send the same message again, or any slash command, and it goes through.</p>

<h2>Snapshots</h2>
<p><strong>Event:</strong> Stop (after every reply). Writes <code>.forge/snapshots/</code> from the transcript; costs no tokens. <strong>Off:</strong> <code>TFORGE_CHECKPOINT=0</code>.</p>

<h2>MCP distill</h2>
<p><strong>Event:</strong> PostToolUse on <code>mcp__.*</code>. <strong>Off:</strong> <code>TFORGE_KIT_DISTILL=0</code>.</p>
<p>An MCP result over 6000 bytes is read by Haiku (<code>tkit distill</code>) and Claude gets only the facts. Put <code>#raw</code> in the tool input for the exact text. Small results, a missing tmap binary, or a failed or timed-out model call leave the result unchanged.</p>

<h2>Opt-in hooks</h2>
<ul>
  <li><strong>Prompt router</strong> (<code>TFORGE_KIT_PROMPT=1</code>): keywords pick review, debug, write or inspect, and that mode’s first context is pre-loaded with tkit. Off by default since 0.7.0: its mode guess misfired on feature work, and its pre-load is re-read on every call.</li>
  <li><strong>Code redirect</strong> (<code>TFORGE_REDIRECT=1</code>): answers identifier-like Grep calls, Bash greps for one code identifier, and whole-file reads of large source files from the tmap index. Repeating the identical call always goes through.</li>
  <li><strong>tmap hint</strong> (<code>TFORGE_MAP=1</code>): one line at session start.</li>
</ul>
<div class="callout"><b>All tkit hooks at once:</b> <code>TFORGE_KIT_HOOKS=0</code> turns off the efficiency policy, the Bash router, the prompt router and MCP distill.</div>`,
  },
  {
    slug: 'workers', title: 'tforge workers',
    lead: 'For big builds: plan once, then run each task in a fresh, minimal Claude worker checked by your tests.',
    body: () => `
<h2>The idea</h2>
<ul>
  <li><strong>Plan once.</strong> Your session writes the contracts (shared types and signatures), short library cheat sheets, and a task plan with a check command for every task.</li>
  <li><strong>Disposable workers.</strong> <code>tforge</code> runs each task in a fresh <code>claude -p</code> worker with no hooks, plugins, MCP servers or skills, and only <code>Read</code>, <code>Write</code> and <code>Edit</code>. It sees the contracts and its own files, then exits.</li>
  <li><strong>Tests decide.</strong> The driver runs each task’s check itself. Failures go back condensed. The last retry escalates to a stronger model. A final project-wide check runs integration workers.</li>
</ul>
<p>A worker carries 2.5k tokens of fixed context per call. A default <code>claude -p</code> with typical plugins carries 26.2k.</p>

<h2>Start</h2>
${pre('/tokenforge:forge build a browser image editor with layers, three filters, undo/redo and PNG export')}
<p>The skill scaffolds the project, writes the contracts, <code>.forge/cheats/*.md</code> and <code>.forge/plan.json</code>, then runs the workers and reports. For small jobs (under about 5 files) it tells you to work inline instead: planning would cost more than it saves.</p>

<h2>Commands</h2>
${pre(`tforge init                 <span class="c"># example .forge/plan.json</span>
tforge validate             <span class="c"># check the plan, print task order</span>
tforge run [--only a,b] [--force a,b] [-j N] [--dry-run] [--detach]
tforge wait                 <span class="c"># wait for a detached run, print its summary</span>
tforge status               <span class="c"># task states and spend</span>
tforge prompt &lt;id&gt;          <span class="c"># the exact prompt a worker receives</span>
tforge meter [--last N | --all | files...] [--json]`)}

<h2>Plan format</h2>
${pre(`{
  "version": 1,
  "goal": "Browser image editor",
  "context": ["src/contracts.ts", ".forge/cheats/konva.md"],
  "verify": "npx tsc --noEmit &amp;&amp; npx vitest run &amp;&amp; npx vite build",
  "defaults": { "model": "sonnet", "retries": 2 },
  "tasks": [
    { "id": "history-test", "spec": "Vitest tests for History in contracts.ts ...",
      "files": ["src/history.test.ts"], "model": "haiku" },
    { "id": "history", "spec": "Implement History from contracts.ts ...",
      "files": ["src/history.ts"], "reads": ["src/history.test.ts"],
      "deps": ["history-test"], "verify": "npx vitest run src/history.test.ts" }
  ]
}`)}
<table><thead><tr><th>Field</th><th>Meaning</th></tr></thead><tbody>
  <tr><td><code>context</code></td><td>Files every worker sees, in the cached system prompt.</td></tr>
  <tr><td><code>verify</code></td><td>Final project-wide check. If it fails, integration workers fix it, up to <code>retries</code> times.</td></tr>
  <tr><td><code>tasks[].files</code></td><td>Files the task owns. Every file has exactly one owner.</td></tr>
  <tr><td><code>tasks[].reads</code></td><td>Extra files inlined for this task only.</td></tr>
  <tr><td><code>tasks[].deps</code></td><td>Tasks that must pass first.</td></tr>
  <tr><td><code>tasks[].verify</code></td><td>The task’s check. Without one, the task passes once its files exist.</td></tr>
  <tr><td><code>tasks[].model</code></td><td><code>haiku</code>, <code>sonnet</code> or <code>opus</code>.</td></tr>
  <tr><td><code>defaults</code></td><td><code>model</code>, <code>integrateModel</code>, <code>tools</code>, <code>maxTurns</code> (12), <code>retries</code> (2), <code>escalate</code> (true), <code>budgetUsd</code> (1.5 per attempt), <code>timeoutMin</code> (20), <code>verifyTimeoutMin</code> (10), <code>inlineMaxChars</code> (60000).</td></tr>
</tbody></table>

<h2>Safety</h2>
<p>Workers run with <code>--permission-mode acceptEdits</code> and only <code>Read</code>, <code>Write</code> and <code>Edit</code>. They cannot run commands. Check commands come from your plan and run on your machine, so read a plan before running it, as you would a Makefile. Run builds on a branch or a git worktree.</p>

<h2>When it does not pay off</h2>
<p>Small greenfield builds. A strong model writes a fresh small app in a few big batches, so there is little context re-reading to remove. The <code>forge</code> skill tells Claude to work inline in that case.</p>`,
  },
  {
    slug: 'config', title: 'Configuration',
    lead: 'Everything is set with environment variables. Defaults are shown where there is one.',
    body: () => {
      const rows: [string, string, string][] = [
        ['TFORGE_LEAN_DEFAULT', '', 'Level applied on first start instead of <code>balanced</code>: <code>off</code>, <code>on</code>, <code>max</code> or <code>ultra</code>'],
        ['TFORGE_CLAUDE', 'claude', 'Claude Code binary used for workers'],
        ['TFORGE_BUDGET', '50000', 'Context budget per call, in tokens'],
        ['TFORGE_BUDGET_FLOOR', '15000', 'Room always left above the session’s fixed context'],
        ['TFORGE_WATCH', '', '<code>0</code> disables the context budget'],
        ['TFORGE_WATCH_INJECT', '', '<code>1</code> also puts the budget notes into Claude’s context'],
        ['TFORGE_VIEW_CHARS / _FOLD / _LINES', '12000 / 8 / 40', '<code>tview</code>: dump size that folds, body lines that fold, file lines that fold'],
        ['TFORGE_CHECKPOINT', '', '<code>0</code> stops writing snapshots'],
        ['TFORGE_SNAPSHOT_PROMPTS / _KEEP', '6 / 50', 'Requests per snapshot chunk; chunks kept per project'],
        ['TFORGE_HANDOFF_MAX_AGE_H', '72', 'Ignore older handoffs'],
        ['TFORGE_RECALL', '', '<code>inject</code> restores snapshot loading at start; <code>0</code> turns the recall hint off'],
        ['TFORGE_ANSWER_CACHE', '', '<code>0</code> turns off repeated-question answers'],
        ['TFORGE_LAZY', '', '<code>0</code> drops the scope rules from the policy'],
        ['TFORGE_TERSE', '', '<code>full</code>, <code>lite</code> or <code>off</code>; overrides the saved choice'],
        ['TFORGE_MAP', '', '<code>1</code> adds the tmap hint at session start'],
        ['TFORGE_REDIRECT', '', '<code>1</code> answers identifier Grep calls, identifier greps in Bash, and big whole-file reads from tmap'],
        ['TFORGE_KIT_HOOKS', '', '<code>0</code> disables all tkit hooks (policy, Bash router, prompt router, MCP distill)'],
        ['TFORGE_KIT_POLICY / _ROUTE / _DISTILL', '', '<code>0</code> disables that one hook'],
        ['TFORGE_KIT_PROMPT', '', '<code>1</code> enables the prompt router (off by default)'],
        ['TFORGE_RAW', '', '<code>TFORGE_RAW=1 cmd</code> runs a Bash command unchanged (<code>TS_RAW=1</code> works too)'],
        ['TFORGE_ROUTE_MAX_LINES / _TIMEOUT_MS', '300 / 8000', 'Prompt router: lines pre-loaded, time per tkit call'],
        ['TFORGE_DISTILL_MCP_BYTES', '6000', 'MCP results at least this large are distilled'],
        ['TFORGE_DISTILL_MODEL / _TIMEOUT / _MAX_BYTES', 'haiku / 120 / 480000', 'Model, timeout in seconds (60 in the MCP hook) and input cap for <code>tkit distill</code> and <code>web --ask</code>'],
        ['TMAP_BIN', '', 'Use this tmap binary'],
        ['TFORGE_NO_DOWNLOAD', '', '<code>1</code> never downloads tmap; build with cargo instead'],
        ['TFORGE_UI', '', '<code>0</code> stops the dashboard from starting with your first session'],
        ['TFORGE_UI_PORT', '7878', 'Dashboard port (the next free one is used if taken)'],
      ];
      return `
<p>Set them in your shell profile, or for one session: <code>TFORGE_LAZY=0 claude</code>.</p>
<div class="scroll"><table class="stack"><thead><tr><th>Variable</th><th>Default</th><th>What it does</th></tr></thead><tbody>
${rows.map(([k, d, w]) => `<tr><td><code>${k}</code></td><td>${d ? `<code>${d}</code>` : '<span class="muted">—</span>'}</td><td>${w}</td></tr>`).join('\n')}
</tbody></table></div>
<h2>Saved settings</h2>
<p>The terse choice (and the dashboard’s skill picks) are saved in <code>~/.config/tokenforge/config.json</code>. Lean levels live in <code>~/.claude/settings.json</code>, as TokenForge’s own entries only.</p>`;
    },
  },
  {
    slug: 'privacy', title: 'Privacy',
    lead: 'Everything runs on your machine. The dashboard serves numbers, not your text, with three listed exceptions.',
    body: () => `
<h2>Dashboard server</h2>
<ul>
  <li>Listens on <code>127.0.0.1</code> only and rejects other Host headers, which blocks DNS rebinding.</li>
  <li>Answers GET requests, plus one POST for the Settings page, accepted only from its own page (same-origin <code>Origin</code> and a JSON body).</li>
  <li>Loads nothing from the internet.</li>
  <li>Reads your transcripts incrementally (only new bytes), with a cache in <code>~/.cache/tokenforge/</code>.</li>
</ul>

<h2>What it keeps</h2>
<p>From transcripts, it keeps and serves numbers only, never prompt, reply or file text. Three exceptions:</p>
<ol>
  <li>The session page’s “Where the tokens went” table shows the command or file path behind each costly tool result. Read on demand, never cached.</li>
  <li>The Memory page shows prompt and reply snippets and file names from that project’s sessions. The index behind it, in <code>~/.cache/tokenforge/memory/</code>, holds those snippets.</li>
  <li>A project’s own <code>.forge/snapshots/</code>, shown on its project page so you can see what <code>/clear</code> will reload. Only files listed in that folder can be requested.</li>
</ol>

<h2>Network</h2>
<ul>
  <li>The prompt router (opt-in) makes no network calls. For a pull request it tells Claude to run <code>tkit diff --pr N</code> instead.</li>
  <li>On first use, the tmap launcher downloads the prebuilt binary for your platform from the plugin’s GitHub releases and checks it against the published SHA-256. <code>TFORGE_NO_DOWNLOAD=1</code> builds with cargo instead.</li>
  <li>MCP distill and <code>tkit distill</code> send large outputs to Haiku through Claude Code (<code>claude -p</code>), like any other model call in your account. <code>TFORGE_KIT_DISTILL=0</code> turns the hook off.</li>
</ul>

<h2>Turning things off</h2>
<p><code>TFORGE_UI=0</code> disables the dashboard auto-start, and <code>tforge ui --stop</code> stops it. See <a href="#/docs/config">Configuration</a> for every switch.</p>`,
  },
  {
    slug: 'faq', title: 'FAQ',
    lead: 'Short answers to common questions.',
    body: () => `
<dl class="faq">
  <dt>Does it change Claude Code itself?</dt>
  <dd>No. It never patches Claude Code or wraps the <code>claude</code> binary. It edits <code>~/.claude/settings.json</code> only for lean levels, with its own entries, and <code>tforge lean off</code> removes them.</dd>
  <dt>Will quality drop?</dt>
  <dd>In the benchmark, quality was equal or better on ${data.aggregate.tasks - data.aggregate.qualityWorse.length} of ${data.aggregate.tasks} tasks. On scheduled transfers, every hidden test passed, but TokenForge scored 94 on structural design checks. See <a href="#/benchmark">Benchmark</a>.</dd>
  <dt>Why is the price-weighted saving (−${Math.round(data.aggregate.medianPriceWeighted)}%) smaller than the token saving (−${Math.round(data.aggregate.medianSavings)}%)?</dt>
  <dd>Most of the saved tokens are cache reads, which cost 0.1× of normal input. Price-weighted counting is roughly what usage limits count.</dd>
  <dt>Claude ran a different command than it wrote. Why?</dt>
  <dd>The Bash router rewrote it to a compact tool (for example <code>cargo test</code> → <code>tkit test</code>). Prefix the command with <code>TFORGE_RAW=1</code>, or repeat the identical call, to run it unchanged. See <a href="#/docs/hooks">Hooks</a>.</dd>
  <dt>I installed it but nothing changed.</dt>
  <dd>Plugins load only when Claude Code starts; <code>/clear</code> does not reload them. Start a new session. The dashboard’s Settings page shows which recent sessions actually loaded TokenForge.</dd>
  <dt>Does it work with a subscription login?</dt>
  <dd>Yes. Subscription (OAuth) logins and API keys both work.</dd>
  <dt>Which platforms?</dt>
  <dd>Linux, macOS and Windows. You need Node.js 18 or newer.</dd>
  <dt>I use another reply-style plugin.</dt>
  <dd>Disable one of them. Both rules would load. TokenForge’s terse rule is about 200 tokens; switch it with <code>/tokenforge:terse off</code>.</dd>
  <dt>How long were the benchmark sessions?</dt>
  <dd>Roughly 5–30 calls each. Long interactive sessions are not measured yet.</dd>
  <dt>Can I check the numbers?</dt>
  <dd>Yes. The raw report is in <code>bench/reports/</code> and <code>bench/</code> reruns everything. This site’s charts are generated from that report. The default fixed context is ${fmtK(data.lean.find((l) => l.level === 'balanced')?.tokens ?? 0, true)} per request.</dd>
</dl>`,
  },
];

export function docs(view: HTMLElement, slug: string): void {
  const i = Math.max(0, DOCS.findIndex((d) => d.slug === slug));
  const d = DOCS[i] as Doc;
  const prev = DOCS[i - 1], next = DOCS[i + 1];
  view.innerHTML = `
  <nav class="docs-toc" aria-label="Docs pages">${DOCS.map((x) => `<a href="#/docs/${x.slug}"${x.slug === d.slug ? ' class="on" aria-current="page"' : ''}>${x.title}</a>`).join('')}</nav>
  <header class="page-head"><div class="crumb">Docs</div><h1>${d.title}</h1><p>${d.lead}</p></header>
  <article class="card prose">${d.body()}</article>
  <nav class="pager" aria-label="Previous and next">
    ${prev ? `<a href="#/docs/${prev.slug}"><small>Previous</small>${prev.title}</a>` : '<span></span>'}
    ${next ? `<a class="next" href="#/docs/${next.slug}"><small>Next</small>${next.title}</a>` : '<span></span>'}
  </nav>`;
  bindCopy(view);
}
