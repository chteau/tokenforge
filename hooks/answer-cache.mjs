// UserPromptSubmit: don't pay for a question that was already answered.
// - Same question as an earlier turn that changed no files: the prompt is held (no model call, zero tokens) and the
//   earlier answer is shown to you. Sending the same message again goes to Claude as usual.
// - A closely similar earlier question: Claude gets the earlier answer as one short hint instead of searching for it.
// Reads the project's memory index (lib/memory.mjs). If it doesn't exist yet it is built in the background, so this
// hook never scans transcripts itself. Off: TFORGE_ANSWER_CACHE=0.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain, readInput, seenBefore } from '../lib/hookutil.mjs';
import { earlierAnswer, hasIndex } from '../lib/memory.mjs';
import { cacheBase } from '../lib/usage.mjs';

const answersFile = () => path.join(cacheBase(), 'answers.jsonl'); // read by lib/estimate.mjs

const TFORGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'tforge');
const day = (t) => (t ? String(t).slice(0, 16).replace('T', ' ') : 'an earlier session');
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

export function decide(input) {
  const prompt = String(input.prompt || '');
  const cwd = input.cwd || process.cwd();
  if (!hasIndex(cwd)) {
    try {
      spawn(process.execPath, [TFORGE, 'recall', '--refresh', '-C', cwd], { detached: true, stdio: 'ignore' }).unref();
    } catch {}
    return null;
  }
  const r = earlierAnswer(cwd, prompt, { exclude: input.session_id });
  if (!r) return null;
  if (r.kind === 'same') {
    if (seenBefore(input.session_id, `answer\0${prompt.trim()}`, 'answer')) return null; // re-sent: ask Claude
    return {
      decision: 'block',
      reason: `tokenforge: you asked this on ${day(r.ts)}, so it wasn't sent to Claude (0 tokens). The answer then, from your transcripts, not re-checked:\n\n${r.a}\n\nSend the same message again to ask Claude anyway.`,
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `tokenforge memory: a similar question was answered on ${day(r.ts)}: "${clip(r.q, 160)}" -> ${clip(r.a.replace(/\s+/g, ' '), 400)} (check it still holds before relying on it)`,
    },
  };
}

if (isMain(import.meta.url)) {
  if (process.env.TFORGE_ANSWER_CACHE !== '0') {
    const input = readInput();
    try {
      const out = input && decide(input);
      if (out) process.stdout.write(JSON.stringify(out));
      // A held prompt cost 0 tokens: log it for the savings estimate (lib/estimate.mjs).
      if (out?.decision === 'block') {
        fs.mkdirSync(path.dirname(answersFile()), { recursive: true });
        fs.appendFileSync(answersFile(), JSON.stringify({ t: Math.round(Date.now() / 1000), session: input.session_id || null, cwd: input.cwd || '' }) + '\n');
      }
    } catch {
      // never block a prompt on the cache's own errors
    }
  }
}
