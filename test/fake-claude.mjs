#!/usr/bin/env node
// Stand-in for `claude -p` in tests. Behaviour per task comes from FAKE_SCRIPT (JSON):
// { "<task id>": [ { "write": { "path": "content" }, "result": "DONE", "error": false, "cost": 0.01 }, ...per attempt ] }
import fs from 'node:fs';
import path from 'node:path';

const prompt = fs.readFileSync(0, 'utf8');
const args = process.argv.slice(2);
const script = JSON.parse(process.env.FAKE_SCRIPT || '{}');
const id = (prompt.match(/^TASK (\S+?):?(?:\s|$)/m) || [])[1] || 'unknown';
const counterFile = path.join(process.env.FAKE_STATE_DIR, `${id}.count`);
const n = fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8')) : 0;
fs.writeFileSync(counterFile, String(n + 1));
fs.appendFileSync(path.join(process.env.FAKE_STATE_DIR, 'calls.jsonl'), JSON.stringify({ id, args, prompt }) + '\n');

const steps = script[id] || [{ result: 'DONE' }];
const step = steps[Math.min(n, steps.length - 1)];
for (const [p, body] of Object.entries(step.write || {})) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}
if (step.sleepMs) await new Promise((r) => setTimeout(r, step.sleepMs));
if (step.crash) {
  process.stderr.write('boom');
  process.exit(1);
}
process.stdout.write(
  JSON.stringify({
    type: 'result',
    subtype: step.error ? 'error_during_execution' : 'success',
    is_error: !!step.error,
    result: step.result ?? 'DONE',
    num_turns: 2,
    total_cost_usd: step.cost ?? 0.01,
    usage: { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 2000, output_tokens: 300 },
  }),
);
