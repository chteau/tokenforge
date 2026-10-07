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

const SHARED =
  'Keep every negation, number, code span, path, command and error message exact. ' +
  'Use plain full sentences for security warnings, irreversible actions and step-by-step instructions. ' +
  'Anything written to files (code, comments, commits, docs, PRs) uses its normal style.';

export const TERSE_RULES = {
  full:
    'Reply style (tokenforge terse): shortest correct answer, answer first. Answer only what was asked: ' +
    'no unrequested background, alternatives, examples or follow-up offers; give code, steps or warnings only when the task needs them. ' +
    'No greetings, recaps, hedges or filler. Fragments fine; drop articles when meaning stays clear. ' +
    SHARED,
  lite:
    'Reply style (tokenforge terse lite): answer first. No greetings, recaps, hedges, filler or closing offers. Full sentences, short. ' +
    SHARED,
};
