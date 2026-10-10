// opencode plugin. It runs the same hook scripts Claude Code and Codex run, with Claude-shaped input on stdin, and
// maps their answers onto opencode's hooks:
//   shell calls    -> hooks/kit-router.mjs: a rewrite replaces the command, a refusal throws (opencode shows the
//                     message to the model), a note is put in front of the command's output
//   system prompt  -> hooks/session-start.mjs once per session: the efficiency policy, instruction digest, reloads
// Two plugin APIs: opencode 2 loads the default export ({ id, setup }, hooks on ctx.tool / ctx.session, the tool is
// "shell"); opencode 1 calls the named TokenForge export (tool.execute.before/after, the tool is "bash").
// TFORGE_HOST=opencode tells the scripts they are not under Claude Code (no lean level, status line or banner).
// Installed by `tforge opencode install`, which writes a one-line plugin file that re-exports both.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks');

// Runs one hook script; its JSON answer, or null on no output, failure or timeout. Never throws.
export function runHook(name, input, { env = {}, timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(process.env.TFORGE_NODE || 'node', [path.join(HOOKS, name)], {
        env: { ...process.env, TFORGE_HOST: 'opencode', ...env },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        resolve(code === 0 && out ? JSON.parse(out) : null);
      } catch {
        resolve(null);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

// kit-router's answer for a Bash call -> { deny } | { command, note } (fields absent when not set).
export function bashDecision(out) {
  const h = out?.hookSpecificOutput;
  if (!h) return {};
  if (h.permissionDecision === 'deny') return { deny: h.permissionDecisionReason || 'tokenforge: refused' };
  const d = {};
  if (typeof h.updatedInput?.command === 'string') d.command = h.updatedInput.command;
  if (h.additionalContext) d.note = h.additionalContext;
  return d;
}

const SHELL_TOOLS = new Set(['bash', 'shell']);

// One session's state, shared by both APIs: notes by call id, session-start text by session id.
function core(cwd) {
  const notes = new Map();
  const starts = new Map();
  return {
    // -> new command (or undefined); throws on a refusal
    async before(tool, command, sessionID, callID) {
      if (!SHELL_TOOLS.has(tool) || typeof command !== 'string') return undefined;
      const out = await runHook('kit-router.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: sessionID, cwd, tool_input: { command } });
      const d = bashDecision(out);
      if (d.deny) throw new Error(d.deny);
      if (d.note && callID) notes.set(callID, d.note);
      return d.command;
    },
    note(callID) {
      const n = notes.get(callID);
      if (n) notes.delete(callID);
      return n;
    },
    // Same text on every request of a session, so the prompt cache keeps it.
    start(sessionID = '') {
      if (!starts.has(sessionID))
        starts.set(
          sessionID,
          runHook('session-start.mjs', { hook_event_name: 'SessionStart', source: 'startup', session_id: sessionID, cwd }).then((o) => o?.hookSpecificOutput?.additionalContext || null),
        );
      return starts.get(sessionID);
    },
  };
}

// opencode 1
export const TokenForge = async ({ directory, worktree } = {}) => {
  const c = core(directory || worktree || process.cwd());
  return {
    'tool.execute.before': async (input, output) => {
      const cmd = await c.before(input?.tool, output?.args?.command, input?.sessionID, input?.callID);
      if (cmd != null) output.args.command = cmd;
    },
    'tool.execute.after': async (input, output) => {
      const n = c.note(input?.callID);
      if (n && typeof output?.output === 'string') output.output = `${n}\n\n${output.output}`;
    },
    'experimental.chat.system.transform': async (input, output) => {
      const text = await c.start(input?.sessionID);
      if (text && Array.isArray(output?.system)) output.system.push(text);
    },
  };
};

// opencode 2: setup(ctx) registers hooks and returns their cleanup. A failure here must not stop opencode, so
// registration errors are swallowed (tokenforge is then simply absent).
export async function setup(ctx) {
  const cwd = ctx?.location?.directory || ctx?.location?.worktree || process.cwd();
  const c = core(cwd);
  const regs = [];
  const hook = async (group, name, fn) => {
    try {
      if (typeof ctx?.[group]?.hook === 'function') regs.push(await ctx[group].hook(name, fn));
    } catch {}
  };
  await hook('tool', 'execute.before', async (ev) => {
    const cmd = await c.before(ev?.tool, ev?.input?.command, ev?.sessionID, ev?.id);
    if (cmd != null) ev.input = { ...ev.input, command: cmd };
  });
  await hook('tool', 'execute.after', (ev) => {
    const n = c.note(ev?.id);
    if (!n || ev?.status !== 'completed' || !ev.result) return;
    const r = ev.result;
    if (Array.isArray(r.content)) r.content = [{ type: 'text', text: n }, ...r.content];
    else if (typeof r.content === 'string') r.content = `${n}\n\n${r.content}`;
    else if (typeof r.output === 'string') r.output = `${n}\n\n${r.output}`;
  });
  await hook('session', 'context', async (ev) => {
    const text = await c.start(ev?.sessionID);
    if (text && Array.isArray(ev?.system)) ev.system.push({ type: 'text', text });
  });
  return async () => {
    for (const r of regs) await Promise.resolve(r?.dispose?.()).catch(() => {});
  };
}

export default { id: 'tokenforge', server: TokenForge, setup };

// The plugin file opencode loads: global (~/.config/opencode/plugins) or, with project, <root>/.opencode/plugins.
export function opencodePluginFile({ project = false, root = process.cwd() } = {}) {
  const base = project ? path.join(root, '.opencode') : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
  return path.join(base, 'plugins', 'tokenforge.js');
}

const MARK = '// tokenforge opencode plugin (written by tforge opencode install)';

// Writes a re-export of the plugin (default for opencode 2, TokenForge for opencode 1) from this checkout. A file there that tforge did not write is left alone.
export function installOpencode(opts) {
  const file = opencodePluginFile(opts);
  if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').startsWith(MARK)) throw new Error(`${file} exists and was not written by tforge; not touching it`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${MARK}\nexport { default, TokenForge } from ${JSON.stringify(import.meta.url)};\n`);
  return file;
}

export function removeOpencode(opts) {
  const file = opencodePluginFile(opts);
  if (!fs.existsSync(file) || !fs.readFileSync(file, 'utf8').startsWith(MARK)) return null;
  fs.unlinkSync(file);
  return file;
}
