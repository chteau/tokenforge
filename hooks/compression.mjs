/**
 * PostToolUse Hook: AST-Aware Compression
 * 
 * Compresses large tool results (Read, Bash output) using tree-sitter AST
 * skeletonization with vault retrieval. Age-gated and loss-aware.
 * 
 * Enable with: TFORGE_COMPRESSION=1
 */

import { compressToolResults, pruneStaleRetrieves } from '../lib/compression.mjs';
import { isMain, readInput } from '../lib/hookutil.mjs';

export function decide(input) {
  if (!input.payload || !input.payload.messages) return null;
  
  const policy = input.payload.__policy ?? null;
  const payload = compressToolResults(input.payload, policy);
  
  // Also prune stale vault retrieves
  const pruned = pruneStaleRetrieves(payload);
  
  // Return modified payload
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      payload: pruned,
    },
  };
}

if (isMain(import.meta.url)) {
  if (process.env.TFORGE_COMPRESSION !== '0') {
    const input = readInput();
    if (input) {
      try {
        const out = decide(input);
        if (out) process.stdout.write(JSON.stringify(out));
      } catch (err) {
        console.error('[Compression Hook] Error:', err.message);
      }
    }
  }
}