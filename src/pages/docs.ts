// Docs, derived from the plugin README and CHANGELOG (github.com/chteau/tokenforge). Plain, direct language.
import { leanTable } from '../charts/lean';
import { data } from '../data';
import { bindCopy, fmtK, pct } from '../util';

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
<h2>What you’ll see</h2>
<p>Nothing to learn: it works on its own, in the terminal and in Claude Desktop.</p>
<ul>
  <li>Every new session starts with <code>TokenForge: active · lean balanced · replies full · dashboard …</code>. The first three sessions add a short walkthrough. This line is shown to you only and costs no tokens (<code>TFORGE_BANNER=0</code> hides it).</li>
  <li>After <code>/clear</code>: <code>TokenForge: checkpoint saved (… ago)</code>. Without a fresh handoff, a compact checkpoint (last requests, files changed, start of the last reply; at most 900 characters) is reloaded so Claude continues where you stopped (<code>TFORGE_CLEAR_RELOAD=0</code> turns it off).</li>
  <li>Once a day, in the background, it checks for a newer version and tells you how to update (<code>TFORGE_UPDATE_CHECK=0</code> turns it off).</li>
  <li>No permission prompts for TokenForge’s own read-only tools (<code>tread</code>, <code>tview</code>, <code>tkit ctx</code>/<code>check</code>/<code>test</code>, <code>tforge recall</code>). Network and remote tools still ask; the multi-file edit tools go through only when the session already accepts edits. <code>TFORGE_AUTO_ALLOW=0</code> turns this off.</li>
</ul>

<h2>What happens on first start</h2>
<ul>
  <li><strong>Lean level <code>balanced</code> is set once.</strong> You get a message (shown to you, not to Claude). TokenForge writes only its own entries to <code>~/.claude/settings.json</code>: <code>permissions.deny</code>, <code>skillOverrides</code> and <code>autoCompactWindow</code>. Plugins cannot set permissions themselves, so this is the only way. It never re-applies after you pick a level.</li>
  <li><strong>The local dashboard starts in the background.</strong> It listens on <code>127.0.0.1:7878</code> (or the next free port).</li>
  <li><strong>A small session context is added</strong>: a terse-reply rule of about 60 tokens and an efficiency policy of about 370, plus any instruction files Claude Code left out (see <a href="#/docs/hooks">Hooks</a>).</li>
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
<p>Only TokenForge’s own entries in <code>~/.claude/settings.json</code>: <code>permissions.deny</code>, <code>skillOverrides</code>, <code>autoCompactWindow</code>, and <code>includeGitInstructions</code> at <code>max</code>/<code>ultra</code>. <code>off</code> removes exactly those.</p>

<h2>When sessions compact</h2>
<p>Each level also sets when 1M-context sessions compact (<code>autoCompactWindow</code>): at 400k tokens for <code>on</code> and <code>balanced</code>, 300k for <code>max</code>, 200k for <code>ultra</code>, instead of near 1M. Every request re-reads the whole context; replaying 14 days of sessions, 400k cut main-session input 40% and subagent input 17%, at one compaction per ~340 calls. Models with a 200k window are unaffected. A value you set yourself, or pick with <code>/autocompact</code>, wins, and <code>off</code> removes only TokenForge’s. Installs from before 0.9.0 get it once, with a notice.</p>

<h2>Which one to use</h2>
<p>Keep <code>balanced</code> unless you have a reason. On short tasks this fixed floor is most of the cost, so going lower helps. <code>ultra</code> is the smallest, but Claude loses image and PDF viewing.</p>
<p><code>max</code> and <code>ultra</code> hide the Skill and subagent tools that skill plugins such as <a href="https://github.com/magicmoux/SpecAudit">SpecAudit</a> run on: use <code>balanced</code> with them.</p>`,
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
  <li><strong><code>tkit &lt;tool&gt;</code></strong>: one call with short output instead of multi-step shell work. <code>check</code> and <code>test</code> (build/lint and test summaries; <code>test --failed</code> reruns only what failed), <code>run</code> (any command, compacted, full log saved), <code>batch</code> (independent commands in one call), <code>eval</code> (throwaway py/js/sh code, sandboxed, leaves no files), <code>diff</code>, <code>debug</code>, <code>ctx</code>, <code>deps</code>, <code>edit</code> and more. Every tool has <code>--help</code>.</li>
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
  <li><strong>A <code>grep</code> or <code>rg</code> whose output is not piped</strong> goes through <code>tkit run --group</code>: each file’s path once above its lines, lines over 500 characters cut, at most 200 lines with the full output saved. A recursive <code>grep</code> also skips <code>.git</code>, <code>node_modules</code>, <code>.venv</code>, <code>__pycache__</code> and a cargo <code>target</code> it does not name. File lists, counts and quiet greps run unchanged.</li>
  <li><strong>Noisy commands</strong> go through <code>tkit run</code> (colours and progress stripped, repeats collapsed, capped, full log saved): package installs, <code>cargo build</code>, <code>docker</code>/<code>kubectl</code> logs, <code>journalctl</code>, and <code>gh run view --log</code> (log lines differing only in numbers merged). Recursive <code>ls</code>, <code>tree</code> and <code>find</code> are capped at 150 lines; <code>git diff</code>/<code>git show</code> get one line of context and a 300-line cap. A bare <code>git status</code>/<code>git log</code> becomes one line per item, a plain <code>curl</code> becomes <code>tkit http</code>. <code>TFORGE_CAP_ALL=1</code> caps any other plain command. Plain one-line PowerShell commands are routed too.</li>
  <li><strong>Polling loops</strong>: where the prompt cache expires after 5 idle minutes (subagents), a loop that only sleeps and reads gets at most 4 minutes instead of up to 10, with a one-time note to run it again. A longer wait lets the cache expire, and the next call rewrites the whole context at 12.5× the price of reading it (394 such waits cost 112M input-equivalent tokens in 14 days). Builds, tests, writes and background commands keep their timeout.</li>
</ul>
<p>A rewrite happens only when every segment of the command line becomes a tkit/tview call or is read-only (<code>grep</code>, <code>sed -n</code>, <code>ls</code>, <code>git status</code>…), or the session already bypasses permissions. Otherwise the line runs unchanged, so a rewrite never adds a permission prompt. Lines with a heredoc are never touched.</p>
<h3>Refused, with the tkit command to use instead</h3>
<ul>
  <li>Interactive <code>ssh HOST</code>.</li>
  <li>Reading a saved tool output of 8k+ (<code>tool-results/*.txt</code>) whole. It points to <code>grep -n</code> / <code>sed -n</code>.</li>
  <li>Whole-file dumps (<code>cat</code>, <code>less</code>, whole-file Read) inside <code>node_modules</code>, <code>~/.cargo/registry</code>, Go <code>pkg/mod</code>, <code>~/.m2</code>, <code>~/.nuget</code>, wally and pub caches. Use <code>tkit deps api</code>. Focused <code>grep</code>/<code>sed -n</code>/<code>head</code> slices there go through.</li>
  <li>Whole-file Reads of lockfiles, minified bundles, source maps and build output, once. It points to <code>grep</code> or a Read with offset/limit; repeating the Read loads the whole file.</li>
  <li>A command that would stop to ask a question (<code>npm init</code>, <code>apt install</code> or <code>pip uninstall</code> without <code>-y</code>): it points to the non-interactive form.</li>
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
<p>Three lines, about 270 tokens, plus a planning line in main sessions (about 100 more). Results are re-read on every call, so read code in one call (<code>tread</code>), batch reads and independent commands (<code>tkit batch</code>), edit each file in one call, run throwaway code with <code>tkit eval</code> instead of scratch files, and run checks once and only after code changes. Plus the scope rule: every stated requirement and nothing extra (no unasked features, docs, refactors, dependencies or abstractions), reuse existing code, concise but readable code, fix shared code once, infer instead of asking, stop once the checks pass. <code>TFORGE_LAZY=0</code> drops the scope rule.</p>
<p>The planning line: thinking is billed as output and re-read on every later call, so look at the repo first, plan briefly, and never draft code in thinking. Over 36 paired bench tasks it cut thinking 44% and list cost 15% per task (95% CI 10–21%), with the same hidden tests passed (<a href="#/benchmark">Benchmark</a>). <code>TFORGE_PLAN=0</code> drops it; <code>TFORGE_PLAN=brief</code> swaps in a shorter line that only asks for a brief plan. Subagents get the rest of the policy, and a planning line only when <code>TFORGE_PLAN</code> names one.</p>
<p>A skill or agent definition being followed, such as <a href="https://github.com/magicmoux/SpecAudit">SpecAudit</a>’s, wins where they differ: its output format, whole-document reads, scripts, re-runs and questions.</p>

<h2>Instruction files</h2>
<p><strong>Events:</strong> SessionStart, SubagentStart, PostToolUse. <strong>Off:</strong> <code>TFORGE_INSTRUCTIONS=0</code>.</p>
<p>Claude Code loads the <code>CLAUDE.md</code> chain, but by default skips <code>AGENTS.md</code> in a project that has a <code>CLAUDE.md</code>, loads nested files only when Read reaches their directory, and gives tforge workers none. TokenForge adds what it left out, following your <code>instructionFiles</code> setting: the <code>AGENTS.md</code> chain with its <code>@imports</code>, the file a short pointer <code>CLAUDE.md</code> names (“Read AGENTS.md first”), and the nested files of directories a tool call reaches, once per session and agent.</p>
<p>Text already loaded is not repeated; HTML comments and badges are dropped, tables compacted, 20k characters at most. Compacted files are cached in <code>~/.cache/tokenforge/instr/</code> (keyed by size and modification time), and the injected text stays identical until a file changes, so it stays in the prompt cache. Workers get the whole chain; Explore and Plan get none, as Claude Code gives them no <code>CLAUDE.md</code>.</p>

<h2>Terse rule</h2>
<p><strong>Events:</strong> startup, <code>/clear</code>, after compaction. One reply-style rule of about 60 tokens; nothing per prompt. Answers lead with the result. Code, paths, commands, numbers and negations stay exact. Security warnings and irreversible steps stay in full sentences. Files Claude writes keep their normal style. Switch with <code>/tokenforge:terse full|lite|off</code> or <code>TFORGE_TERSE</code>.</p>

<h2>Memory hint and handoff reload</h2>
<p><strong>Events:</strong> startup and <code>/clear</code>. One line pointing to <code>tforge recall</code> (see <a href="#/docs/memory">Memory</a>), and <code>.forge/HANDOFF.md</code> if it is under 72 hours old.</p>

<h2>Repeated questions</h2>
<p><strong>Event:</strong> UserPromptSubmit. <strong>Off:</strong> <code>TFORGE_ANSWER_CACHE=0</code>. See <a href="#/docs/repeated">Repeated questions</a>.</p>

<h2>Context budget</h2>
<p><strong>Events:</strong> PostToolUse, UserPromptSubmit. <strong>Off:</strong> <code>TFORGE_WATCH=0</code>.</p>
<p>The budget is 50k tokens of context per call, or the session’s fixed part plus 15k if that is larger. The alert is shown to you; notes reach Claude, after tool calls, only with <code>TFORGE_WATCH_INJECT=1</code>. Over the budget your messages are never held: your next message gets an alert, and again each time the context doubles, and <code>.forge/HANDOFF.md</code> is written automatically from the session’s snapshots (no model call), so <code>/clear</code> at any moment loses nothing. A handoff you wrote yourself is never overwritten. The automatic one is deleted once used (when a session started after it saves its first snapshot) or after 72 hours. <code>TFORGE_AUTO_HANDOFF=0</code> turns it off.</p>

<h2>Snapshots</h2>
<p><strong>Event:</strong> Stop (after every reply). Writes <code>.forge/snapshots/</code> from the transcript; costs no tokens. <strong>Off:</strong> <code>TFORGE_CHECKPOINT=0</code>.</p>
<p>Each chunk holds its requests, with what each one changed, read, searched, ran and concluded, and closes after 6 requests or at a compaction. Chunks are kept by use, with no model call: a chunk’s score adds up its writing and every later read (Claude reading it, the reload after <code>/clear</code>, the dashboard), each weighted 1/√(hours since + 1), and is lowered when files it changed are gone or a later chunk changed most of the same files. The newest 6 always stay; at most 50 are kept per project.</p>

<h2>Disk cleanup</h2>
<p><strong>Events:</strong> session start and Stop, in the background, at most every 6 hours (every 10 minutes on a nearly full disk); never in unattended sessions. <strong>Off:</strong> <code>TFORGE_GC=0</code>.</p>
<p>Claude Code keeps each session’s scratch (scratchpad, task output, images) in <code>/tmp/claude-&lt;uid&gt;/</code> and never deletes it, so a few heavy sessions can fill the disk until transcript writes fail (ENOSPC). <code>tforge gc</code> frees, by rules with no model call: the scratch of ended sessions, TokenForge’s own leftovers (hook state of ended sessions, old tmap binaries and logs, indexes of deleted projects), snapshot chunks scored out and used-up automatic handoffs.</p>
<ul>
  <li>A session’s scratch is never touched while Claude Code’s session registry lists its process as running, while a process has its working directory or an open file inside it, or within 12 hours of its last change or transcript write (1 hour on a nearly full disk). Without the registry, none is.</li>
  <li>Ended sessions’ scratch idle for over 7 days goes; the rest stays up to 2 GB, the oldest and largest going first.</li>
  <li>On a nearly full disk (under 5% free, within 2–10 GB) it frees until twice that is free.</li>
</ul>
${pre('tforge gc --dry-run     # list what it would free')}

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
tforge meter [--last N | --all | files...] [--json]
tforge meter --commands     <span class="c"># rank Bash commands by what their results cost</span>
tforge gc [--dry-run]       <span class="c"># free disk (see Hooks › Disk cleanup)</span>`)}

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
        ['TFORGE_SNAPSHOT_PROMPTS / _KEEP', '6 / 50', 'Requests per snapshot chunk; most chunks kept per project'],
        ['TFORGE_HANDOFF_MAX_AGE_H', '72', 'Ignore older handoffs; an older automatic one is deleted'],
        ['TFORGE_RECALL', '', '<code>inject</code> restores snapshot loading at start; <code>0</code> turns the recall hint off'],
        ['TFORGE_ANSWER_CACHE', '', '<code>0</code> turns off repeated-question answers'],
        ['TFORGE_LAZY', '', '<code>0</code> drops the scope rules from the policy'],
        ['TFORGE_TERSE', '', '<code>full</code>, <code>lite</code> or <code>off</code>; overrides the saved choice'],
        ['TFORGE_MAP', '', '<code>1</code> adds the tmap hint at session start'],
        ['TFORGE_REDIRECT', '', '<code>1</code> answers identifier Grep calls, identifier greps in Bash, and big whole-file reads from tmap'],
        ['TFORGE_KIT_HOOKS', '', '<code>0</code> disables all tkit hooks (policy, Bash router, prompt router, MCP distill)'],
        ['TFORGE_KIT_POLICY / _ROUTE / _DISTILL', '', '<code>0</code> disables that one hook'],
        ['TFORGE_PLAN', '', '<code>0</code> drops the policy’s planning line, <code>brief</code> uses a shorter one; when set, subagents get it too'],
        ['TFORGE_KIT_PROMPT', '', '<code>1</code> enables the prompt router (off by default)'],
        ['TFORGE_RAW', '', '<code>TFORGE_RAW=1 cmd</code> runs a Bash command unchanged (<code>TS_RAW=1</code> works too)'],
        ['TFORGE_CAP_ALL', '', '<code>1</code> caps the output of any other plain Bash command (<code>tkit run</code>)'],
        ['TFORGE_ROUTE_MAX_LINES / _TIMEOUT_MS', '300 / 8000', 'Prompt router: lines pre-loaded, time per tkit call'],
        ['TFORGE_DISTILL_MCP_BYTES', '6000', 'MCP results at least this large are distilled'],
        ['TFORGE_DISTILL_MODEL / _TIMEOUT / _MAX_BYTES', 'haiku / 120 / 480000', 'Model, timeout in seconds (60 in the MCP hook) and input cap for <code>tkit distill</code> and <code>web --ask</code>'],
        ['TMAP_BIN', '', 'Use this tmap binary'],
        ['TFORGE_NO_DOWNLOAD', '', '<code>1</code> never downloads tmap; build with cargo instead'],
        ['TFORGE_GC', '', '<code>0</code> stops the automatic background <code>tforge gc</code>'],
        ['TFORGE_INSTRUCTIONS', '', '<code>0</code> stops adding the instruction files Claude Code did not load'],
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
  <dt>Why is the saving at list prices (${pct(data.aggregate.medianPriceWeighted)}) smaller than the token saving (${pct(data.aggregate.medianSavings)})?</dt>
  <dd>Most of the saved tokens are cache reads, which cost 0.05× of normal input, and the 1-hour cache writes Claude Code makes cost 2×. List prices are roughly what usage limits count. TokenForge cost less on ${data.aggregate.tasksCheaper} of ${data.aggregate.tasks} tasks; <code>c-cli</code> and <code>perl-cli</code> cost more, both from long up-front plans. The planning line added in 0.9.0 cuts those two by about a third.</dd>
  <dt>Claude ran a different command than it wrote. Why?</dt>
  <dd>The Bash router rewrote it to a compact tool (for example <code>cargo test</code> → <code>tkit test</code>). Prefix the command with <code>TFORGE_RAW=1</code>, or repeat the identical call, to run it unchanged. See <a href="#/docs/hooks">Hooks</a>.</dd>
  <dt>I installed it but nothing changed.</dt>
  <dd>Plugins load only when Claude Code starts; <code>/clear</code> does not reload them. Start a new session. The dashboard’s Settings page shows which recent sessions actually loaded TokenForge.</dd>
  <dt>Does it work with a subscription login?</dt>
  <dd>Yes. Subscription (OAuth) logins and API keys both work.</dd>
  <dt>Which platforms?</dt>
  <dd>Linux, macOS and Windows. You need Node.js 18 or newer.</dd>
  <dt>I use another reply-style plugin.</dt>
  <dd>Disable one of them. Both rules would load. TokenForge’s terse rule is about 60 tokens; switch it with <code>/tokenforge:terse off</code>.</dd>
  <dt>How long were the benchmark sessions?</dt>
  <dd>Roughly 5–30 calls each. Long interactive sessions are not measured yet.</dd>
  <dt>Can I check the numbers?</dt>
  <dd>Yes. The raw report is in <code>bench/reports/</code> and <code>bench/</code> reruns everything. This site’s charts are generated from that report. The default fixed context is ${fmtK(data.lean.find((l) => l.level === 'balanced')?.tokens ?? 0, true)} per request.</dd>
</dl>`,
  },
  {
    slug: 'changelog', title: 'Changelog',
    lead: 'What changed in the latest releases.',
    body: () => `
<h2>0.9.1</h2>
<ul>
  <li><strong>Quieter context alert</strong>: your next message gets it once the context passes the budget, then each time the context doubles, instead of every 10k tokens and after tool calls. A session started on 0.7.0–0.7.2 keeps that version’s blocking alert (“A hook blocked your prompt”) until it ends: after updating, start a new session.</li>
  <li><strong><code>tforge gc</code> on macOS</strong> finds the scratch a process works in with <code>lsof</code>; when that can’t be told, no scratch is removed.</li>
</ul>
<h2>0.9.0</h2>
<p>Disk cleanup, instruction files for every agent, a planning line, leaner shell output, SpecAudit compatibility.</p>
<ul>
  <li><strong>Planning line</strong>, on by default in main sessions: look at the repo first, plan briefly, never draft code in thinking. Against the same build without it, over 36 paired tasks: list cost −15% per task (95% CI −21% to −10%), thinking −44%, wall-clock −21%, the same hidden tests passed. <code>TFORGE_PLAN=0</code> turns it off (<a href="#/docs/hooks">Hooks</a>).</li>
  <li><strong>Disk cleanup</strong>: <code>tforge gc</code> removes the per-session scratch Claude Code never deletes from <code>/tmp/claude-&lt;uid&gt;/</code>, TokenForge’s own leftovers, stale snapshots and used-up handoffs, by rules, with no model call. It runs in the background.</li>
  <li><strong>Instruction files for every agent</strong>: sessions, subagents and workers get the <code>AGENTS.md</code>/<code>CLAUDE.md</code> text Claude Code leaves out, compacted.</li>
  <li><strong>Earlier compaction in 1M-context sessions</strong>: lean levels set <code>autoCompactWindow</code> (400k at <code>balanced</code>). Replaying 14 days of sessions, main-session input −40% (<a href="#/docs/lean">Lean levels</a>).</li>
  <li><strong>Leaner shell output</strong> (tmap 0.5.0): <code>tkit run</code>, <code>tkit batch</code>, <code>tkit eval</code> and <code>tkit test --failed</code>. Greps, installs, logs, diffs, recursive listings and plain <code>curl</code> are routed through them, and polling loops in subagents wait at most 4 minutes, within the cache lifetime.</li>
  <li><strong>Fewer refusals</strong>: Bash reads, <code>cat &gt; file</code> writes, python edit scripts and definition greps are no longer refused, as each refusal cost a round trip. Interactive commands are, with their non-interactive form.</li>
  <li><strong>Snapshots</strong> hold one node per request and are kept by use; the automatic handoff is deleted once used.</li>
  <li><strong>Works with <a href="https://github.com/magicmoux/SpecAudit">SpecAudit</a></strong> and other skill plugins that bring their own workflow (use <code>balanced</code>).</li>
  <li><strong>Dashboard</strong>: a “Skills and MCP servers” card lists long skill descriptions and skills or servers unused in 30 days. <code>tforge meter --commands</code> ranks Bash commands by what their results cost.</li>
  <li><strong>Documents</strong>: <code>cat</code> of a document no longer cuts long lines, and the opt-in prompt router gives document work no code-mode context.</li>
  <li><strong>Benchmark cost at list prices</strong>: TokenForge cost less on ${data.aggregate.tasksCheaper} of ${data.aggregate.tasks} tasks (median ${pct(data.aggregate.medianPriceWeighted)}). The “36 of 36 cheaper” in 0.8.0 counted tokens.</li>
</ul>

<h2>0.8.0</h2>
<p>Academic work and automation.</p>
<ul>
  <li><code>tkit pdf</code>: PDF text with page markers.</li>
  <li>Notebooks are read as cells, with outputs trimmed.</li>
  <li>LaTeX builds are compacted to errors, undefined references and a box summary.</li>
  <li>The status line shows the savings.</li>
</ul>
<p><a href="https://github.com/chteau/tokenforge/blob/master/CHANGELOG.md">Every release in CHANGELOG.md →</a></p>`,
  },
];

export function docs(view: HTMLElement, slug: string): void {
  const i = Math.max(0, DOCS.findIndex((d) => d.slug === slug));
  const d = DOCS[i] as Doc;
  const prev = DOCS[i - 1], next = DOCS[i + 1];
  view.innerHTML = `<div class="docs-wrap">
  <nav class="docs-toc" aria-label="Docs pages">${DOCS.map((x) => `<a href="#/docs/${x.slug}"${x.slug === d.slug ? ' class="on" aria-current="page"' : ''}>${x.title}</a>`).join('')}</nav>
  <div>
  <header class="page-head"><div class="crumb">Docs</div><h1>${d.title}</h1><p>${d.lead}</p></header>
  <article class="card prose">${d.body()}</article>
  <nav class="pager" aria-label="Previous and next">
    ${prev ? `<a href="#/docs/${prev.slug}"><small>Previous</small>${prev.title}</a>` : '<span></span>'}
    ${next ? `<a class="next" href="#/docs/${next.slug}"><small>Next</small>${next.title}</a>` : '<span></span>'}
  </nav>
  </div></div>`;
  bindCopy(view);
}
