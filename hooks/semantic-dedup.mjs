/**
 * PostToolUse Hook: Semantic Deduplication
 * 
 * Deduplicates repeated tool results using FNV-1a exact matching
 * and SimHash near-duplicate detection. Implements "keep newest, stub oldest".
 * 
 * Enable with: TFORGE_SEMANTIC_DEDUP=1
 */

import { applySemanticDedup, invalidateDedupRegistry } from '../lib/semantic-dedup.mjs';
import { isMain, readInput } from '../lib/hookutil.mjs';

export function decide(input) {
  if (!input.payload || !input.payload.messages) return null;
  
  const payload = applySemanticDedup(input.payload, { policy: input.payload.__policy });
  
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      payload,
    },
  };
}

/**
 * PreToolUse Hook: Invalidate dedup registry on patches
 * Called when a patch tool succeeds
 */
export function onPatchSuccess(filePath) {
  if (filePath) invalidateDedupRegistry(filePath);
}

if (isMain(import.meta.url)) {
  if (process.env.TFORGE_SEMANTIC_DEDUP !== '0') {
    const input = readInput();
    if (input) {
      try {
        const out = decide(input);
        if (out) process.stdout.write(JSON.stringify(out));
      } catch (err) {
        console.error('[SemanticDedup Hook] Error:', err.message);
      }
    }
  }
}