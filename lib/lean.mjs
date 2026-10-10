// `tforge lean`: hide Claude Code's agent-orchestration tools from the model.
// Every request carries every enabled tool's definition. Measured on Claude Code 2.1.293 / Opus 5.5, fixed context
// per request: off 16.9k, on 11.9k, balanced 9.7k, max 5.8k, ultra 4.4k.
// That fixed context is most of a short task's cost. Plugins cannot set permissions, so this edits the
// user settings file, and records exactly what it added so `off` removes only those entries.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSetting, readConfig, writeConfig } from './config.mjs';

export const LEAN_DENY = [
  'Workflow', 'Monitor', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger',
  'PushNotification', 'SendMessage', 'ListAgents', 'TaskStop', 'DesignSync', 'ReportFindings',
  'EnterWorktree', 'ExitWorktree', 'NotebookEdit',
];

// `max` also drops skills, subagents and web tools: measured per request on top of LEAN_DENY, Skill (tool plus
// skill listing) -3.0k, Task -1.8k, WebFetch+WebSearch -0.9k. None of them reduced tokens in bench/ runs.
export const LEAN_MAX_EXTRA = ['Skill', 'Task', 'Agent', 'WebFetch', 'WebSearch'];
// `ultra` also drops the Read/Edit/Write tools (-1.4k per request): files are read and edited through Bash
// (sed -n, cat > file, scripts), which models already use for most calls. Loses Read's image/PDF viewing.
export const LEAN_ULTRA_EXTRA = ['Read', 'Edit', 'Write'];
// `balanced` (the default): `on` plus marking Claude Code's built-in skills "user-invocable-only" via
// skillOverrides: they leave the model's skill listing (2.2k tokens per request for all 19, measured on Claude
// Code 2.1.293) but stay typeable as slash commands. Your own and plugin skills are never touched; the Skill
// tool, subagents and web tools stay. An unknown skillOverrides value makes Claude Code ignore the whole
// settings file, so only SKILL_HIDDEN is ever written.
export const BUILTIN_SKILLS = [
  'deep-research', 'design', 'design-sync', 'dataviz', 'update-config', 'verify', 'debug', 'code-review', 'simplify',
  'batch', 'fewer-permission-prompts', 'doctor', 'loop', 'schedule', 'claude-api', 'workflow-authoring', 'run',
  'run-skill-generator', 'plugin-authoring',
];
export const SKILL_HIDDEN = 'user-invocable-only';
// Built-ins Claude may still invoke on its own under `balanced` (Settings page). None by default: typing works.
export const SKILLS_KEEP_DEFAULT = [];
export const LEVELS = ['on', 'balanced', 'max', 'ultra'];
// Fixed context per request in tokens, measured (see the header). Used by the savings estimate (lib/estimate.mjs).
export const FIXED_TOKENS = { off: 16929, on: 11933, balanced: 9738, max: 5755, ultra: 4401 };
// Fixed tokens for a leanStatus(): balanced scales with how many built-in skills are actually hidden; a partial
// deny set counts as off (conservative).
export function fixedTokensOf(st) {
  if (st.level === 'balanced') return Math.round(FIXED_TOKENS.on - (FIXED_TOKENS.on - FIXED_TOKENS.balanced) * (st.skillsOff.length / BUILTIN_SKILLS.length));
  return FIXED_TOKENS[st.level] ?? FIXED_TOKENS.off;
}
// Tools lean never hides (`leanKeep` in the config, or TFORGE_LEAN_KEEP), e.g. TaskStop for a skill that stops its
// own background agents.
export const leanKeep = () => new Set(listSetting('TFORGE_LEAN_KEEP', 'leanKeep'));
const notKept = (xs) => {
  const k = leanKeep();
  return xs.filter((t) => !k.has(t));
};
export const leanSet = (level) =>
  notKept(level === 'ultra' ? [...LEAN_DENY, ...LEAN_MAX_EXTRA, ...LEAN_ULTRA_EXTRA] : level === 'max' ? [...LEAN_DENY, ...LEAN_MAX_EXTRA] : LEAN_DENY);

// Skills to switch off for a level: balanced uses the saved keep-list (Settings), the others leave skills alone
// (max/ultra deny the Skill tool itself).
export function skillsOffFor(level) {
  if (level !== 'balanced') return [];
  const keep = new Set(readConfig().skillsKeep || SKILLS_KEEP_DEFAULT);
  return BUILTIN_SKILLS.filter((s) => !keep.has(s));
}

// max/ultra also drop Claude Code's built-in git instructions (-537 tokens per request, measured in a git repo;
// a third-party claim of ~2.2k did not hold). They carry commit/PR habits and git safety rules, so balanced keeps them.
const NO_GIT_LEVELS = new Set(['max', 'ultra']);
function applyGit(s, level) {
  const mine = readConfig().leanGitAdded;
  if (NO_GIT_LEVELS.has(level)) {
    if (s.includeGitInstructions === undefined) {
      s.includeGitInstructions = false;
      writeConfig({ leanGitAdded: true });
    }
  } else if (mine && s.includeGitInstructions === false) {
    delete s.includeGitInstructions;
    writeConfig({ leanGitAdded: false });
  }
}

// Compaction point per level. Claude Code compacts a 1M-context session only near 1M (sessions here peaked at ~966k),
// and every request re-reads the whole context. Replaying 14 days of sessions: 400k cut main-session input 40% and
// subagents' 17% (one compaction per ~340 calls); 300k -49%/-22%; 200k -58%/-30%. Models with a smaller window keep
// theirs. A value the user set stays, and /autocompact's per-model choice overrides this one.
export const LEAN_WINDOW = { on: 400000, balanced: 400000, max: 300000, ultra: 200000 };
function applyWindow(s, level) {
  const ours = s.autoCompactWindow === undefined || s.autoCompactWindow === readConfig().leanWindowAdded;
  const want = ours ? LEAN_WINDOW[level] : undefined;
  if (want) s.autoCompactWindow = want;
  else if (ours) delete s.autoCompactWindow;
  writeConfig({ leanWindowAdded: want ?? null });
}

function applySkills(s, off) {
  const mine = new Set(readConfig().skillsOffAdded || []);
  const ov = { ...(s.skillOverrides || {}) };
  for (const k of mine) if (ov[k] === SKILL_HIDDEN && !off.includes(k)) delete ov[k]; // ours, no longer wanted
  const added = off.filter((k) => ov[k] === undefined);
  for (const k of added) ov[k] = SKILL_HIDDEN;
  if (Object.keys(ov).length) s.skillOverrides = ov;
  else delete s.skillOverrides;
  writeConfig({ skillsOffAdded: [...new Set([...[...mine].filter((k) => off.includes(k)), ...added])] });
}

export const settingsFile = () =>
  path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');

export function readSettings(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`lean: cannot parse ${file}; not touching it`);
  }
}

export function writeSettings(file, s) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.tokenforge-lean.bak`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function leanStatus(file = settingsFile()) {
  const deny = readSettings(file).permissions?.deny || [];
  const added = readConfig().leanAdded || [];
  const base = notKept(LEAN_DENY);
  const active = base.filter((t) => deny.includes(t));
  const on = active.length === base.length;
  const has = (xs) => notKept(xs).every((t) => deny.includes(t));
  const mineSk = new Set(readConfig().skillsOffAdded || []);
  const skillsOff = Object.entries(readSettings(file).skillOverrides || {}).filter(([k, v]) => v === SKILL_HIDDEN && mineSk.has(k)).map(([k]) => k);
  const level = !on ? (active.length ? 'partial' : 'off') : has(LEAN_MAX_EXTRA) ? (has(LEAN_ULTRA_EXTRA) ? 'ultra' : 'max') : skillsOff.length ? 'balanced' : 'on';
  return { on, level, active, added, file, skillsOff, skillsKeep: readConfig().skillsKeep || SKILLS_KEEP_DEFAULT };
}

// First run: apply the default level once (balanced: keeps skills you are likely to use, subagents and web). Any explicit
// choice (tforge lean ..., dashboard) marks it done, so a level the user picked is never overridden.
export const DEFAULT_LEVEL = 'balanced';
export function applyDefaultOnce(file = settingsFile()) {
  const want = process.env.TFORGE_LEAN_DEFAULT || DEFAULT_LEVEL;
  if (readConfig().leanDefaultDone) return null;
  writeConfig({ leanDefaultDone: true });
  if (want === 'off' || !LEVELS.includes(want)) return null;
  if (leanStatus(file).level !== 'off') return null; // the user already set something up
  leanOn(file, want, { explicit: false });
  return want;
}

// Installs from before LEAN_WINDOW: the active level gets its window once; nothing else changes.
export function applyWindowOnce(file = settingsFile()) {
  if (readConfig().leanWindowAdded !== undefined) return null;
  const { level } = leanStatus(file);
  if (!LEAN_WINDOW[level]) return null; // lean off or partial: `tforge lean <level>` sets it
  const s = readSettings(file);
  applyWindow(s, level);
  if (!readConfig().leanWindowAdded) return null; // the user's own value stays
  writeSettings(file, s);
  return { level, window: s.autoCompactWindow };
}

export function leanOn(file = settingsFile(), level = 'on', { explicit = true } = {}) {
  if (explicit) writeConfig({ leanDefaultDone: true });
  const s = readSettings(file);
  s.permissions = s.permissions || {};
  const deny = (s.permissions.deny = s.permissions.deny || []);
  const added = leanSet(level).filter((t) => !deny.includes(t));
  deny.push(...added);
  // stepping down a level: drop the extras this tool added that the new level does not include (never the user's own)
  const mine = new Set(readConfig().leanAdded || []);
  const keep = new Set(leanSet(level));
  const dropped = [...LEAN_DENY, ...LEAN_MAX_EXTRA, ...LEAN_ULTRA_EXTRA].filter((t) => !keep.has(t) && mine.has(t) && deny.includes(t));
  if (dropped.length) s.permissions.deny = deny.filter((t) => !dropped.includes(t));
  applySkills(s, skillsOffFor(level));
  applyGit(s, level);
  applyWindow(s, level);
  writeSettings(file, s);
  writeConfig({ leanAdded: [...new Set([...mine, ...added])].filter((t) => !dropped.includes(t)), leanChangedAt: Date.now() });
  return added;
}

export function leanOff(file = settingsFile()) {
  writeConfig({ leanDefaultDone: true });
  const s = readSettings(file);
  const mine = new Set(readConfig().leanAdded || []);
  const deny = s.permissions?.deny || [];
  const kept = deny.filter((t) => !mine.has(t));
  const removed = deny.filter((t) => mine.has(t));
  if (removed.length) {
    s.permissions.deny = kept;
    if (!kept.length) delete s.permissions.deny;
    if (!Object.keys(s.permissions).length) delete s.permissions;
  }
  applySkills(s, []);
  applyGit(s, 'off');
  applyWindow(s, 'off');
  writeSettings(file, s);
  writeConfig({ leanAdded: [], leanChangedAt: Date.now() });
  return removed;
}

// A tool added to leanKeep after lean was applied: lift the deny entry lean wrote (never one the user wrote).
// Run at startup; returns the tools lifted.
export function applyKeep(file = settingsFile()) {
  const keep = leanKeep();
  const mine = readConfig().leanAdded || [];
  const s = readSettings(file);
  const deny = s.permissions?.deny || [];
  const lift = deny.filter((t) => keep.has(t) && mine.includes(t));
  if (!lift.length) return [];
  s.permissions.deny = deny.filter((t) => !lift.includes(t));
  if (!s.permissions.deny.length) delete s.permissions.deny;
  if (!Object.keys(s.permissions).length) delete s.permissions;
  writeSettings(file, s);
  writeConfig({ leanAdded: mine.filter((t) => !lift.includes(t)) });
  return lift;
}

// Settings page: which built-in skills stay listed under `balanced`. Re-applies if balanced is active.
export function setSkillsKeep(keep, file = settingsFile()) {
  const k = keep.filter((s) => BUILTIN_SKILLS.includes(s));
  writeConfig({ skillsKeep: k, leanDefaultDone: true });
  if (leanStatus(file).level === 'balanced') leanOn(file, 'balanced');
  return k;
}
