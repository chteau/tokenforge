/**
 * PreToolUse Hook: Enhanced Interceptor
 * 
 * Brings ghost interceptor benefits to hook-based architecture:
 * - Session tool cache (LRU, avoids repeated calls)
 * - Stall detection (3 identical calls → hint)
 * - Concept cache (caches `find` query results)
 * - Exploration loop breaker (3 read-only rounds → timeout hint)
 * 
 * Enable with: TFORGE_ENHANCED_INTERCEPTOR=1
 */

import { globalCacheRegistry, createMapStore } from '../lib/cache-invalidation.mjs';
import { isMain, readInput, deny, splitSegments, splitPipes, tokenize, exeName, readOnly } from '../lib/hookutil.mjs';

// Session tool cache (LRU, 200 entries)
const SESSION_TOOL_CACHE = globalCacheRegistry.register('tool-results', {
  store: createMapStore(),
  keyFn: (input) => `${input.name}:${JSON.stringify(input.args)}`,
  depsFn: () => [], // Tool results don't have file deps typically
  invalidateFn: () => 0,
  maxSize: 200,
});

// Stall detection
const CALL_FREQUENCY = new Map();
const MAX_IDENTICAL_CALLS = 3;

// Concept cache for `find` queries
const CONCEPT_CACHE = new Map();
const MAX_CONCEPT_CACHE = 100;

// Exploration tracking
const GRAPH_ONLY_ROUNDS = new Map(); // sessionId -> count
const MAX_GRAPH_ONLY_ROUNDS = 3;

/**
 * Normalize concept key for caching
 */
function normalizeConceptKey(target) {
  return String(target).toLowerCase().trim().replace(/[^a-z0-9_]/g, '_');
}

/**
 * Check if tool is a read-only exploration tool
 */
function isExplorationTool(name) {
  const normalized = name?.toLowerCase() || '';
  return normalized.includes('find_symbol') ||
         normalized.includes('read_function') ||
         normalized.includes('what_does_this_export') ||
         normalized.includes('show_callers') ||
         normalized.includes('analyze_impact') ||
         normalized.includes('find_route') ||
         normalized.includes('query_graph') ||
         normalized === 'read_file_chunk' ||
         normalized === 'tread' ||
         normalized === 'tview' ||
         normalized === 'tkit ctx' ||
         normalized === 'tkit diff';
}

/**
 * Check if tool is an action tool (patch, write, etc.)
 */
function isActionTool(name) {
  const normalized = name?.toLowerCase() || '';
  return normalized.includes('patch') ||
         normalized.includes('edit') ||
         normalized.includes('write') ||
         normalized.includes('tkit edit') ||
         normalized.includes('tkit patch');
}

export function decide(input) {
  const { tool_name, tool_input, session_id, payload } = input;
  if (!tool_name) return null;
  
  const argsStr = JSON.stringify(tool_input || {});
  const cacheKey = `${tool_name}:${argsStr}`;
  
  // 1. Session tool cache check
  const cachedResult = SESSION_TOOL_CACHE.get({ name: tool_name, args: tool_input });
  if (cachedResult.hit) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...tool_input, _cf_cached: true },
        additionalContext: `[Cached] Using cached result for ${tool_name}`,
      },
    };
  }
  
  // 2. Stall detection
  const freqKey = `${session_id}:${cacheKey}`;
  const count = (CALL_FREQUENCY.get(freqKey) || 0) + 1;
  CALL_FREQUENCY.set(freqKey, count);
  
  if (count >= MAX_IDENTICAL_CALLS) {
    const hintMessage = JSON.stringify({
      error: 'STALL_DETECTED',
      tool: tool_name,
      call_count: count,
      hint: `You have called ${tool_name} with these exact arguments ${count} times. The result will not change. Stop calling this tool and proceed with what you already know, or try a different approach.`,
    });
    
    // Don't block, just inject hint
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: hintMessage,
      },
    };
  }
  
  // 3. Concept cache for graph queries
  if (tool_name?.includes('find') && tool_input?.target) {
    const conceptKey = normalizeConceptKey(tool_input.target);
    const cached = CONCEPT_CACHE.get(conceptKey);
    if (cached) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { ...tool_input, _cf_concept_cached: true },
          additionalContext: `[Concept Cached] "${tool_input.target}" was resolved previously. Use the cached result or refine your query.`,
        },
      };
    }
  }
  
  // 4. Exploration loop detection
  const isExplore = isExplorationTool(tool_name);
  const isAction = isActionTool(tool_name);
  
  if (isExplore || isAction) {
    const rounds = GRAPH_ONLY_ROUNDS.get(session_id) || 0;
    
    if (isExplore) {
      GRAPH_ONLY_ROUNDS.set(session_id, rounds + 1);
      
      if (rounds + 1 > MAX_GRAPH_ONLY_ROUNDS) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: `You have spent ${rounds + 1} consecutive rounds on read-only exploration without taking action. You have enough context to proceed. Stop exploring and either: (1) apply a patch, (2) create the file, or (3) report what you found.`,
          },
        };
      }
    } else if (isAction) {
      // Reset on action
      GRAPH_ONLY_ROUNDS.set(session_id, 0);
    }
  }
  
  return null;
}

/**
 * PostToolUse: Cache successful tool results and update concept cache
 */
export function onToolResult(input) {
  const { tool_name, tool_input, tool_result, session_id, payload } = input;
  if (!tool_name || !tool_result) return null;
  
  const argsStr = JSON.stringify(tool_input || {});
  const cacheKey = `${tool_name}:${argsStr}`;
  
  // Cache successful read-only results
  if (isExplorationTool(tool_name) && typeof tool_result === 'string' && !tool_result.includes('error')) {
    SESSION_TOOL_CACHE.set({ name: tool_name, args: tool_input }, tool_result);
  }
  
  // Update concept cache for find queries
  if (tool_name?.includes('find') && tool_input?.target && typeof tool_result === 'string') {
    const conceptKey = normalizeConceptKey(tool_input.target);
    try {
      const parsed = JSON.parse(tool_result);
      if (parsed.count > 0 || parsed.results?.length > 0) {
        if (CONCEPT_CACHE.size >= MAX_CONCEPT_CACHE) {
          CONCEPT_CACHE.delete(CONCEPT_CACHE.keys().next().value);
        }
        CONCEPT_CACHE.set(conceptKey, tool_result);
      }
    } catch {}
  }
  
  // Reset stall counter on success
  const freqKey = `${session_id}:${cacheKey}`;
  CALL_FREQUENCY.delete(freqKey);
  
  return null;
}

if (isMain(import.meta.url)) {
  if (process.env.TFORGE_ENHANCED_INTERCEPTOR !== '0') {
    const input = readInput();
    if (input) {
      try {
        let out = null;
        if (input.hook_event_name === 'PreToolUse') out = decide(input);
        else if (input.hook_event_name === 'PostToolUse') out = onToolResult(input);
        if (out) process.stdout.write(JSON.stringify(out));
      } catch (err) {
        console.error('[EnhancedInterceptor Hook] Error:', err.message);
      }
    }
  }
}