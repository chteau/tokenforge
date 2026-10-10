// opencode plugin (v1 plugin API). It runs the same hook scripts Claude Code and Codex run, with Claude-shaped
// input on stdin, and maps their answers onto opencode's hooks:
//   bash calls     -> hooks/kit-router.mjs: a rewrite replaces args.command, a refusal throws (opencode shows the
//                     message to the model), a note is put in front of the command's output
//   system prompt  -> hooks/session-start.mjs once per session: the efficiency policy, instruction digest, reloads
// TFORGE_HOST=opencode tells the scripts they are not under Claude Code (no lean level, status line or banner).
// Installed by `tforge opencode install`, which writes a one-line plugin file that re-exports TokenForge.
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

export const TokenForge = async ({ directory, worktree } = {}) => {
  const cwd = directory || worktree || process.cwd();
  const notes = new Map(); // callID -> note for the model, shown with the command's output
  const starts = new Map(); // sessionID -> Promise<session-start text | null>
  return {
    'tool.execute.before': async (input, output) => {
      if (input?.tool !== 'bash' || typeof output?.args?.command !== 'string') return;
      const out = await runHook('kit-router.mjs', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        session_id: input.sessionID,
        cwd,
        tool_input: { command: output.args.command },
      });
      const d = bashDecision(out);
      if (d.deny) throw new Error(d.deny);
      if (d.command) output.args.command = d.command;
      if (d.note && input.callID) notes.set(input.callID, d.note);
    },
    'tool.execute.after': async (input, output) => {
      const n = notes.get(input?.callID);
      if (!n) return;
      notes.delete(input.callID);
      if (typeof output?.output === 'string') output.output = `${n}\n\n${output.output}`;
    },
    // Same text on every request of a session, so the prompt cache keeps it.
    'experimental.chat.system.transform': async (input, output) => {
      const sid = input?.sessionID || '';
      if (!starts.has(sid))
        starts.set(
          sid,
          runHook('session-start.mjs', { hook_event_name: 'SessionStart', source: 'startup', session_id: sid, cwd }).then((o) => o?.hookSpecificOutput?.additionalContext || null),
        );
      const text = await starts.get(sid);
      if (text && Array.isArray(output?.system)) output.system.push(text);
    },
  };
};

// The plugin file opencode loads: global (~/.config/opencode/plugins) or, with project, <root>/.opencode/plugins.
export function opencodePluginFile({ project = false, root = process.cwd() } = {}) {
  const base = project ? path.join(root, '.opencode') : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'opencode');
  return path.join(base, 'plugins', 'tokenforge.js');
}

const MARK = '// tokenforge opencode plugin (written by tforge opencode install)';

// Writes a one-line re-export of TokenForge from this checkout. A file there that tforge did not write is left alone.
export function installOpencode(opts) {
  const file = opencodePluginFile(opts);
  if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').startsWith(MARK)) throw new Error(`${file} exists and was not written by tforge; not touching it`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${MARK}\nexport { TokenForge } from ${JSON.stringify(import.meta.url)};\n`);
  return file;
}

export function removeOpencode(opts) {
  const file = opencodePluginFile(opts);
  if (!fs.existsSync(file) || !fs.readFileSync(file, 'utf8').startsWith(MARK)) return null;
  fs.unlinkSync(file);
  return file;
}
