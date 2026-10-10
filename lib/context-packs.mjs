/**
 * Context Packs System
 * 
 * Generates reusable, task-specific context packs for workflows like:
 * - Bug investigation
 * - Feature implementation
 * - Refactoring
 * - Pull-request review
 * - Architecture exploration
 * - Test generation
 * - Security audits
 * - Cross-module debugging
 * 
 * Packs contain only relevant information with source references for retrieval.
 * Generated dynamically, cached, and invalidated on source changes.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { globalCacheRegistry, createFileStore, fileContentHashSync } from './cache-invalidation.mjs';
import { buildIndex, recall } from './memory.mjs';
import { projectRoot } from './util.mjs';

const PACK_DIR = '.forge/packs';
const PACK_CACHE_DIR = 'packs';
const PACK_VERSION = 2;

// Task type definitions with their retrieval strategies
export const PACK_TEMPLATES = {
  'bug-investigation': {
    name: 'Bug Investigation',
    description: 'Find root cause, affected code paths, and fix verification',
    queries: [
      { type: 'error', weight: 1.0 },           // Error messages, stack traces
      { type: 'recent_changes', weight: 0.9 },  // Recent edits in area
      { type: 'callers', weight: 0.8 },         // Who calls the failing function
      { type: 'tests', weight: 0.7 },           // Related tests
      { type: 'similar_errors', weight: 0.6 },  // Past similar bugs
    ],
    maxFiles: 15,
    maxTokens: 8000,
  },
  'feature-implementation': {
    name: 'Feature Implementation',
    description: 'Understand existing patterns, contracts, and integration points',
    queries: [
      { type: 'contracts', weight: 1.0 },       // Type definitions, interfaces
      { type: 'similar_features', weight: 0.9 },// Existing similar features
      { type: 'integration_points', weight: 0.8 }, // Where new code connects
      { type: 'patterns', weight: 0.7 },        // Code patterns in codebase
      { type: 'tests', weight: 0.6 },           // Test patterns
    ],
    maxFiles: 20,
    maxTokens: 10000,
  },
  'refactoring': {
    name: 'Refactoring',
    description: 'Analyze impact, find all callers, verify behavior preservation',
    queries: [
      { type: 'impact', weight: 1.0 },          // Change impact analysis
      { type: 'callers', weight: 0.9 },         // All callers (multi-hop)
      { type: 'tests', weight: 0.8 },           // Tests to preserve
      { type: 'dependencies', weight: 0.7 },    // Dependent modules
      { type: 'patterns', weight: 0.6 },        // Refactoring patterns used
    ],
    maxFiles: 25,
    maxTokens: 12000,
  },
  'pr-review': {
    name: 'Pull Request Review',
    description: 'Understand changes, assess risk, verify correctness',
    queries: [
      { type: 'diff', weight: 1.0 },            // Changed files and symbols
      { type: 'impact', weight: 0.9 },          // Impact of changes
      { type: 'tests', weight: 0.8 },           // Test coverage of changes
      { type: 'contracts', weight: 0.7 },       // Affected interfaces
      { type: 'similar_changes', weight: 0.6 }, // Past similar PRs
    ],
    maxFiles: 20,
    maxTokens: 10000,
  },
  'architecture-exploration': {
    name: 'Architecture Exploration',
    description: 'Understand system structure, data flow, and key components',
    queries: [
      { type: 'entry_points', weight: 1.0 },    // Main entry points
      { type: 'core_modules', weight: 0.9 },    // Core modules/classes
      { type: 'data_flow', weight: 0.8 },       // Data flow paths
      { type: 'external_deps', weight: 0.7 },   // External dependencies
      { type: 'patterns', weight: 0.6 },        // Architectural patterns
    ],
    maxFiles: 30,
    maxTokens: 15000,
  },
  'test-generation': {
    name: 'Test Generation',
    description: 'Find test patterns, edge cases, and coverage gaps',
    queries: [
      { type: 'test_patterns', weight: 1.0 },   // Existing test patterns
      { type: 'untested_code', weight: 0.9 },   // Code without tests
      { type: 'edge_cases', weight: 0.8 },      // Error paths, boundaries
      { type: 'contracts', weight: 0.7 },       // Types to test
      { type: 'similar_tests', weight: 0.6 },   // Similar feature tests
    ],
    maxFiles: 15,
    maxTokens: 8000,
  },
  'security-audit': {
    name: 'Security Audit',
    description: 'Find vulnerabilities, auth issues, and data exposure',
    queries: [
      { type: 'auth', weight: 1.0 },            // Authentication/authorization
      { type: 'input_validation', weight: 0.9 }, // Input handling
      { type: 'secrets', weight: 0.8 },         // Hardcoded secrets
      { type: 'crypto', weight: 0.7 },          // Crypto usage
      { type: 'external_calls', weight: 0.6 },  // External API calls
    ],
    maxFiles: 20,
    maxTokens: 10000,
  },
  'cross-module-debugging': {
    name: 'Cross-Module Debugging',
    description: 'Trace issues across module boundaries',
    queries: [
      { type: 'call_chain', weight: 1.0 },      // Full call chains
      { type: 'data_flow', weight: 0.9 },       // Data flow across modules
      { type: 'shared_state', weight: 0.8 },    // Shared state/memory
      { type: 'async_boundaries', weight: 0.7 }, // Async/await boundaries
      { type: 'error_propagation', weight: 0.6 }, // Error handling
    ],
    maxFiles: 25,
    maxTokens: 12000,
  },
};

/**
 * Generate a context pack for a task type
 * @param {string} cwd - Project root
 * @param {string} taskType - One of PACK_TEMPLATES keys
 * @param {Object} options
 *   @param {string} [options.focus] - Specific symbol, file, or error to focus on
 *   @param {string[]} [options.includeFiles] - Files to definitely include
 *   @param {string[]} [options.excludeFiles] - Files to exclude
 *   @param {boolean} [options.forceRefresh] - Regenerate even if cached
 * @returns {Promise<Object>} Context pack
 */
export async function generatePack(cwd, taskType, options = {}) {
  const template = PACK_TEMPLATES[taskType];
  if (!template) throw new Error(`Unknown pack type: ${taskType}`);
  
  const root = projectRoot(cwd);
  const packDir = path.join(root, PACK_DIR);
  const cacheDir = path.join(packDir, PACK_CACHE_DIR);
  await fs.promises.mkdir(cacheDir, { recursive: true });
  
  // Build cache key from task type, focus, and relevant file hashes
  const focusHash = options.focus ? crypto.createHash('sha256').update(options.focus).digest('hex').slice(0, 8) : 'general';
  const key = `${taskType}_${focusHash}`;
  const packFile = path.join(cacheDir, `${key}.json`);
  
  // Check cache validity
  if (!options.forceRefresh && await isPackValid(packFile, root, options)) {
    const cached = JSON.parse(await fs.promises.readFile(packFile, 'utf8'));
    return { ...cached, cached: true, key };
  }
  
  // Generate new pack
  const pack = await buildPack(root, template, options);
  
  // Save with metadata
  const metadata = {
    version: PACK_VERSION,
    taskType,
    focus: options.focus || null,
    generatedAt: new Date().toISOString(),
    sourceHashes: await computeSourceHashes(root, pack.files),
    tokenEstimate: estimateTokens(pack),
  };
  
  const fullPack = { ...pack, metadata };
  await fs.promises.writeFile(packFile, JSON.stringify(fullPack, null, 2));
  
  return { ...fullPack, cached: false, key };
}

/**
 * Check if cached pack is still valid
 */
async function isPackValid(packFile, root, options) {
  try {
    const stat = await fs.promises.stat(packFile);
    const pack = JSON.parse(await fs.promises.readFile(packFile, 'utf8'));
    
    // Version check
    if (pack.metadata?.version !== PACK_VERSION) return false;
    
    // Check if any source files have changed
    const sourceHashes = pack.metadata?.sourceHashes || {};
    for (const [file, hash] of Object.entries(sourceHashes)) {
      const currentHash = fileContentHashSync(path.join(root, file));
      if (currentHash !== hash) return false;
    }
    
    // Check focus hasn't changed
    if (options.focus && pack.metadata?.focus !== options.focus) return false;
    
    // Age check (optional: invalidate after 24h)
    const ageHours = (Date.now() - new Date(pack.metadata.generatedAt).getTime()) / 3600000;
    if (ageHours > 24) return false;
    
    return true;
  } catch {
    return false;
  }
}

/**
 * Build pack by executing retrieval queries
 */
async function buildPack(root, template, options) {
  const { buildIndex, recall } = await import('./memory.mjs');
  const { queryGraph } = await import('./tmap-client.mjs');
  
  const index = buildIndex(root);
  const packFiles = new Map(); // file -> { content, reason, source }
  const packSymbols = new Set();
  const packQueries = [];
  
  for (const query of template.queries) {
    const results = await executePackQuery(root, index, query, options);
    packQueries.push({ type: query.type, weight: query.weight, results: results.length });
    
    for (const result of results) {
      if (result.file && !packFiles.has(result.file)) {
        // Read file content (limited)
        const content = await readFileLimited(root, result.file, template.maxTokens);
        packFiles.set(result.file, {
          content,
          reason: result.reason || query.type,
          source: result.source || 'graph',
          lines: content.split('\n').length,
        });
      }
      if (result.symbol) packSymbols.add(result.symbol);
    }
  }
  
  // Add explicitly included files
  if (options.includeFiles) {
    for (const file of options.includeFiles) {
      if (!packFiles.has(file)) {
        const content = await readFileLimited(root, file, template.maxTokens);
        packFiles.set(file, { content, reason: 'explicit_include', source: 'user', lines: content.split('\n').length });
      }
    }
  }
  
  // Remove excluded files
  if (options.excludeFiles) {
    for (const file of options.excludeFiles) packFiles.delete(file);
  }
  
  // Trim to max files/tokens
  const files = trimPack(packFiles, template.maxFiles, template.maxTokens);
  
  return {
    taskType: template.name,
    description: template.description,
    focus: options.focus || 'general',
    files: Array.from(files.entries()).map(([file, data]) => ({
      path: file,
      reason: data.reason,
      source: data.source,
      lines: data.lines,
      content: data.content,
    })),
    symbols: Array.from(packSymbols),
    queries: packQueries,
    stats: {
      fileCount: files.size,
      symbolCount: packSymbols.size,
      estimatedTokens: estimateTokens({ files }),
    },
  };
}

/**
 * Execute a single pack query type
 */
async function executePackQuery(root, index, query, options) {
  const results = [];
  const focus = options.focus || '';
  
  switch (query.type) {
    case 'error':
      // Search for error-related symbols and recent error-handling code
      if (focus) {
        const mem = recall(root, focus, { limit: 5 });
        for (const session of mem.sessions) {
          for (const file of session.edited) results.push({ file, reason: `Edited in session about "${session.prompts[0]}"`, symbol: null });
        }
        for (const file of mem.files) results.push({ file, reason: `Memory: tied to "${focus}"`, symbol: null });
      }
      break;
      
    case 'recent_changes':
      // Get recently edited files from memory
      const mem = recall(root, focus || 'recent', { limit: 10 });
      for (const session of mem.sessions.slice(0, 5)) {
        for (const file of session.edited) results.push({ file, reason: `Recent edit in session`, symbol: null });
      }
      break;
      
    case 'callers':
    case 'impact':
      // Use tmap to find callers
      if (focus) {
        try {
          const callers = await queryGraph('callers', focus, { cwd: root });
          for (const c of callers) results.push({ file: c.file, symbol: c.symbol, reason: `Calls ${focus}` });
        } catch {}
      }
      break;
      
    case 'tests':
      // Find test files related to focus
      const testPatterns = ['test', 'spec', '__tests__', '__mocks__'];
      for (const file of index.sessions.flatMap(s => s.edited)) {
        if (testPatterns.some(p => file.includes(p))) {
          results.push({ file, reason: 'Test file', symbol: null });
        }
      }
      break;
      
    case 'contracts':
      // Find type definitions and interfaces
      if (focus) {
        try {
          const exports = await queryGraph('exports', focus, { cwd: root });
          for (const e of exports) results.push({ file: e.file, symbol: e.symbol, reason: 'Contract/interface' });
        } catch {}
      }
      break;
      
    case 'similar_features':
    case 'similar_errors':
    case 'similar_changes':
    case 'similar_tests':
      // Use memory recall
      const mem2 = recall(root, focus, { limit: 5 });
      for (const session of mem2.sessions) {
        for (const file of session.edited) results.push({ file, reason: `Similar: ${session.prompts[0]}`, symbol: null });
      }
      break;
      
    case 'integration_points':
      // Find where modules connect (imports, exports, events)
      break;
      
    case 'patterns':
      // Find common patterns in codebase
      break;
      
    case 'dependencies':
      // Find dependent modules
      break;
      
    case 'entry_points':
      // Find main entry points
      const entries = ['main', 'index', 'app', 'server', 'cli', 'entry'];
      for (const file of index.sessions.flatMap(s => s.edited)) {
        if (entries.some(e => file.toLowerCase().includes(e))) {
          results.push({ file, reason: 'Entry point', symbol: null });
        }
      }
      break;
      
    case 'core_modules':
      // Most edited/imported modules
      break;
      
    case 'data_flow':
      // Trace data flow
      break;
      
    case 'external_deps':
      // External dependencies
      break;
      
    case 'test_patterns':
      // Test patterns
      break;
      
    case 'untested_code':
      // Code without tests
      break;
      
    case 'edge_cases':
      // Error paths, boundaries
      break;
      
    case 'auth':
    case 'input_validation':
    case 'secrets':
    case 'crypto':
    case 'external_calls':
    case 'call_chain':
    case 'shared_state':
    case 'async_boundaries':
    case 'error_propagation':
      // Security and cross-module specific queries
      break;
  }
  
  return results;
}

/**
 * Read file with token limit
 */
async function readFileLimited(root, file, maxTokens) {
  try {
    const fullPath = path.join(root, file);
    const content = await fs.promises.readFile(fullPath, 'utf8');
    const maxChars = maxTokens * 4;
    return content.length > maxChars ? content.slice(0, maxChars) + '\n... [truncated]' : content;
  } catch {
    return '';
  }
}

/**
 * Trim pack to limits
 */
export function trimPack(files, maxFiles, maxTokens) {
  const sorted = Array.from(files.entries())
    .sort((a, b) => {
      // Prioritize by reason weight
      const weight = (reason) => {
        if (reason.includes('error') || reason.includes('impact') || reason.includes('contract')) return 3;
        if (reason.includes('caller') || reason.includes('test')) return 2;
        return 1;
      };
      return weight(b[1].reason) - weight(a[1].reason);
    });
  
  const result = new Map();
  let totalTokens = 0;
  
  for (const [file, data] of sorted) {
    if (result.size >= maxFiles) break;
    const fileTokens = Math.ceil(data.content.length / 4);
    if (totalTokens + fileTokens > maxTokens) break;
    result.set(file, data);
    totalTokens += fileTokens;
  }
  
  return result;
}

/**
 * Estimate token count for pack
 */
export function estimateTokens(pack) {
  let tokens = 500; // Base overhead
  for (const file of pack.files || []) {
    tokens += Math.ceil((file.content?.length || 0) / 4);
  }
  return tokens;
}

/**
 * Compute content hashes for all files in pack
 */
async function computeSourceHashes(root, files) {
  const hashes = {};
  for (const fileObj of files) {
    const fullPath = path.join(root, fileObj.path);
    hashes[fileObj.path] = fileContentHashSync(fullPath);
  }
  return hashes;
}

/**
 * List available pack types
 */
export function listPackTypes() {
  return Object.entries(PACK_TEMPLATES).map(([key, tmpl]) => ({
    id: key,
    name: tmpl.name,
    description: tmpl.description,
    maxFiles: tmpl.maxFiles,
    maxTokens: tmpl.maxTokens,
  }));
}

/**
 * List cached packs for a project
 */
export async function listCachedPacks(cwd) {
  const root = projectRoot(cwd);
  const cacheDir = path.join(root, PACK_DIR, PACK_CACHE_DIR);
  try {
    const files = await fs.promises.readdir(cacheDir);
    const packs = [];
    for (const file of files.filter(f => f.endsWith('.json'))) {
      const fullPath = path.join(cacheDir, file);
      const stat = await fs.promises.stat(fullPath);
      const pack = JSON.parse(await fs.promises.readFile(fullPath, 'utf8'));
      packs.push({
        key: file.replace('.json', ''),
        taskType: pack.metadata?.taskType,
        focus: pack.metadata?.focus,
        generatedAt: pack.metadata?.generatedAt,
        fileCount: pack.stats?.fileCount,
        tokenEstimate: pack.metadata?.tokenEstimate,
        ageHours: (Date.now() - stat.mtimeMs) / 3600000,
      });
    }
    return packs.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  } catch {
    return [];
  }
}

/**
 * Delete a cached pack
 */
export async function deletePack(cwd, key) {
  const root = projectRoot(cwd);
  const packFile = path.join(root, PACK_DIR, PACK_CACHE_DIR, `${key}.json`);
  try {
    await fs.promises.unlink(packFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear all cached packs
 */
export async function clearAllPacks(cwd) {
  const root = projectRoot(cwd);
  const cacheDir = path.join(root, PACK_DIR, PACK_CACHE_DIR);
  try {
    const files = await fs.promises.readdir(cacheDir);
    await Promise.all(files.map(f => fs.promises.unlink(path.join(cacheDir, f))));
    return files.length;
  } catch {
    return 0;
  }
}

/**
 * Get pack by key
 */
export async function getPack(cwd, key) {
  const root = projectRoot(cwd);
  const packFile = path.join(root, PACK_DIR, PACK_CACHE_DIR, `${key}.json`);
  try {
    return JSON.parse(await fs.promises.readFile(packFile, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Register pack cache with formal invalidation
 */
export function registerPackCache() {
  globalCacheRegistry.register('context-packs', {
    store: createMapStore(),
    keyFn: (input) => `${input.taskType}_${input.focus || 'general'}`,
    depsFn: (input) => input.includeFiles || [],
    invalidateFn: (dep, contentHash) => {
      // Invalidation handled by isPackValid on read
      return 0;
    },
    maxSize: 50,
  });
}