import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TERSE_LEVELS = ['full', 'lite', 'off'];

export function configFile() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'tokenforge', 'config.json');
}

export function readConfig() {
  let c = {};
  try {
    c = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {}
  return { terse: 'full', ...c };
}

export function writeConfig(patch) {
  const file = configFile();
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}

// Env wins so one session or CI can override the saved choice.
export function terseLevel() {
  const env = process.env.TFORGE_TERSE;
  if (env) return env === '0' ? 'off' : TERSE_LEVELS.includes(env) ? env : 'full';
  const lvl = readConfig().terse;
  return TERSE_LEVELS.includes(lvl) ? lvl : 'full';
}

const SHARED = 'Code, commands, paths, numbers, errors and anything written to files stay exact and in normal style.';

// Paid on every call, so kept to one or two lines. Prose is a tiny share of tokens; the rules mainly stop
// preambles, praise, recaps and offers between tool calls and in the final answer.
export const TERSE_RULES = {
  full: 'Reply terse: no preamble, praise, recap or offers. Between tool calls at most one short status line ("Fixing X."). Final answer: result in 1-3 lines. ' + SHARED,
  lite: 'Reply briefly: no preamble, praise, recap or offers; final answer short. ' + SHARED,
};
