// PostToolUse for MCP tools: when a result is large, a small model reads it (tkit distill) and Claude
// receives only the distilled facts (updatedMCPToolOutput). Otherwise Claude would re-read the full
// result on every later turn.
// Passes the result through unchanged when it is under TFORGE_DISTILL_MCP_BYTES (default 6000), when the
// tool input contains "#raw", when no tmap binary is installed, or when distillation fails or times out.
// Off: TFORGE_KIT_HOOKS=0 or TFORGE_KIT_DISTILL=0. Model and limits: TFORGE_DISTILL_MODEL, TFORGE_DISTILL_TIMEOUT (s, default 60 here).
import { existingBinary } from '../lib/tmapbin.mjs';
import { codexHost, isMain, kitHookOff, readInput, runTmap, skippedAgent } from '../lib/hookutil.mjs';

export function responseText(r) {
  const texts = (arr) => arr.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
  if (Array.isArray(r)) return texts(r);
  if (r && typeof r === 'object' && Array.isArray(r.content)) return texts(r.content);
  if (typeof r === 'string') return r;
  return r == null ? '' : JSON.stringify(r);
}

export function distill(input, bin = existingBinary()) {
  const tool = String(input.tool_name || '');
  if (!tool.startsWith('mcp__') || !bin) return null;
  const text = responseText(input.tool_response);
  const bytes = Buffer.byteLength(text);
  if (bytes < (Number(process.env.TFORGE_DISTILL_MCP_BYTES) || 6000)) return null;
  const ti = JSON.stringify(input.tool_input ?? {}).slice(0, 1500);
  if (ti.includes('#raw')) return null;
  const name = tool.split('__').pop();
  const q =
    `An AI coding agent called ${name} with input ${ti}. Extract what it was looking for: the answers to its queries/intent, ` +
    'with exact file paths, line numbers, names, numbers and error messages. Drop everything irrelevant.';
  const secs = Number(process.env.TFORGE_DISTILL_TIMEOUT) || 60;
  const out = runTmap(bin, ['kit', 'distill', '--min-bytes', '0', '-n', '20', '-q', q], {
    input: text,
    timeout: (secs + 10) * 1000,
    env: { TFORGE_DISTILL_TIMEOUT: String(secs) },
  });
  // Only a real model answer replaces the result; the heuristic excerpt would lose too much.
  if (!out || !out.startsWith('[distilled by')) return null;
  const facts = out.slice(out.indexOf('\n') + 1).trimEnd();
  if (!facts) return null;
  return (
    `[tokenforge: ${bytes} bytes of ${name} output were read by a small model; only the distilled facts below reach you. ` +
    `For exact text, repeat the call with '#raw' in the query/intent, or read the specific file slice.]\n${facts}`
  );
}

function main() {
  if (kitHookOff('TFORGE_KIT_DISTILL')) return;
  const input = readInput();
  if (!input || skippedAgent(input)) return;
  let t = null;
  try {
    t = distill(input);
  } catch {}
  if (t) process.stdout.write(JSON.stringify(distillOut(input, t)));
}

// Codex has no updatedMCPToolOutput; there decision 'block' replaces the tool result with the reason.
export function distillOut(input, t) {
  if (codexHost(input)) return { decision: 'block', reason: t };
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedMCPToolOutput: { content: [{ type: 'text', text: t }] } } };
}

if (isMain(import.meta.url)) main();
