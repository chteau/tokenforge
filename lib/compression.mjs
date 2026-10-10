/**
 * AST-Aware Compression with Vault Retrieval
 * 
 * Compresses large code files to structural skeletons (signatures, types, imports)
 * while vaulting full source for on-demand retrieval. Age-gated and loss-aware.
 * 
 * Integrates with tmap's tree-sitter parsers for supported languages,
 * falls back to indentation-based parsing for others.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { globalCacheRegistry, defaultContentHash, fileContentHashSync } from './cache-invalidation.mjs';

const EXT_TO_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'tsx',
  py: 'python', go: 'go', rs: 'rust', java: 'java',
  rb: 'ruby', kt: 'kotlin', swift: 'swift', c: 'c', cpp: 'cpp',
  cs: 'csharp', php: 'php', lua: 'lua', luau: 'luau',
};

const COMPRESSION_THRESHOLD_LINES = 30;   // Min lines to consider compression
const MAX_BODY_LINES_DEFAULT = 4;         // Lines to keep in function bodies
const MIN_REDUCTION_RATIO = 0.2;          // Must achieve 20% reduction
const AGE_GATE_TURNS = 2;                 // Never compress last N turns

// Session compression cache (content hash → compressed result)
const SESSION_COMPRESS_CACHE = new Map();
const SESSION_COMPRESS_MAX = 50;

/**
 * Quick hash for session cache key
 */
function quickHash(str) {
  let h1 = 0x811c9dc5, h2 = 0x4b9ace2f;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c; h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return `${h1.toString(16).padStart(8,'0')}_${h2.toString(16).padStart(8,'0')}`;
}

/**
 * Language detection from file extension
 */
export function detectLanguage(filePath, hint = '') {
  if (hint) return hint;
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return EXT_TO_LANG[ext] || 'unknown';
}

/**
 * Tree-sitter based AST compression (would use native binding)
 * For now, provides the interface; actual implementation in Rust
 */
let nativeCompressor = null;
try {
  nativeCompressor = require('../native/tmap/build/Release/contextforge_native.node')?.ASTCompressor;
} catch {}

/**
 * Compress code using AST-aware skeletonization
 * 
 * @param {string} text - Source code text
 * @param {string} languageHint - Language hint from file extension
 * @param {Object} policy - Compression policy
 *   @param {number} [policy.maxBodyLines=4] - Lines to keep in function bodies
 *   @param {boolean} [policy.preserveErrorHandlers=true] - Keep try/catch blocks
 *   @param {string} [policy.mode='balanced'] - 'minimal'|'balanced'|'aggressive'
 *   @param {number} [policy.minTokensToCompress=80] - Min tokens before compressing
 * @param {string} [filePath] - File path for vault reference
 * @returns {Promise<Object>} Compression result
 */
export async function compressCode(text, languageHint = '', policy = {}, filePath = null) {
  const mode = policy.mode || 'balanced';
  const maxBodyLines = policy.maxBodyLines ?? (mode === 'aggressive' ? 2 : mode === 'minimal' ? 8 : 4);
  const preserveErrorHandlers = policy.preserveErrorHandlers ?? true;
  const minTokensToCompress = policy.minTokensToCompress ?? 80;
  

  // Skip trivial content (1 line or less)
  const lineCount = text.split('\n').length;
  if (lineCount <= 1) {
    return { kept: text, vaulted: false, reason: 'below_threshold' };
  }
  
  // Skip content with too few lines
  if (lineCount < COMPRESSION_THRESHOLD_LINES) {
    return { kept: text, vaulted: false, reason: 'too_few_lines' };
  }
  
  // Skip small content
  if (typeof text !== 'string' || text.length < minTokensToCompress * 4) {
    return { kept: text, vaulted: false, reason: 'below_threshold' };
  }
  
  // Check session cache
  const contentHash = quickHash(text);
  const cached = SESSION_COMPRESS_CACHE.get(contentHash);
  if (cached) {
    return { ...cached, cached: true };
  }
  
  let result;
  
  if (nativeCompressor) {
    try {
      const compressor = new nativeCompressor({
        preserveImports: true,
        preserveSignatures: true,
        preserveTypeAnnotations: true,
        preserveDecorators: true,
        vaultOnCompress: true,
        docstringMode: 1,
        preserveErrorHandlers,
        maxBodyLines,
        minTokensToCompress,
      });
      
      result = compressor.compress(text, languageHint);
    } catch (err) {
      console.warn('[AST Compressor] Native error:', err.message);
      result = null;
    }
  }
  
  if (!result) {
    // Fallback to regex-based compression
    result = regexFallbackCompress(text, languageHint, maxBodyLines, preserveErrorHandlers, skipTrivialCheck);
  }
  
  // Check reduction ratio
  const reductionRatio = result.compressedLines / result.originalLines;
  if (reductionRatio > (1 - MIN_REDUCTION_RATIO) || result.nodesCompressed === 0) {
    return { kept: text, vaulted: false, reason: 'insufficient_reduction' };
  }
  
  // Vault the original content
  const vaultId = `cf_vault_${crypto.randomBytes(4).toString('hex')}`;
  await saveToVault(vaultId, text);
  
  // Build compressed output with vault reference
  const fileRef = filePath ? filePath.replace(/\\/g, '/') : 'this file';
  const compressionHeader = [
    `[CF_COMPRESSED_FILE vault_id:"${vaultId}"]`,
    `⚠️  AST skeleton — ${result.originalLines} lines compressed to ${result.compressedLines}.`,
    `To read full source: use tool call contextforge_retrieve with vault_id="${vaultId}".`,
    `To explore without reading full file:`,
    `  - what_does_this_export("${fileRef}") — list all exports`,
    `  - find_symbol("functionName") — get specific function body`,
    `  Search for function names, NOT class names.`,
    ``,
  ].join('\n');
  
  const keptWithVault = result.compressedSource.replace(
    /· vault_retrieve to expand/g,
    `Use tool call contextforge_retrieve with vault_id="${vaultId}" to read this content.`
  );
  
  const finalKept = compressionHeader + keptWithVault;
  
  const output = {
    kept: finalKept,
    vaulted: true,
    vaultId,
    originalText: text,
    removedChars: text.length - finalKept.length,
    originalLines: result.originalLines,
    compressedLines: result.compressedLines,
    language: result.languageDetected || languageHint,
    nodesFound: result.nodesFound,
    nodesCompressed: result.nodesCompressed,
    syntaxValid: result.syntaxValid,
    highComplexityNodes: result.highComplexityNodes || [],
    reductionRatio,
  };
  
  // Cache in session
  if (SESSION_COMPRESS_CACHE.size >= SESSION_COMPRESS_MAX) {
    SESSION_COMPRESS_CACHE.delete(SESSION_COMPRESS_CACHE.keys().next().value);
  }
  SESSION_COMPRESS_CACHE.set(contentHash, output);
  
  return output;
}

/**
 * Regex fallback compression for unsupported languages or native failures
 */
function regexFallbackCompress(text, languageHint, maxBodyLines, preserveErrorHandlers, skipTrivialCheck = false) {
  console.log('[DEBUG] Input text:', JSON.stringify(text.substring(0, 100)));
  // Trim leading/trailing empty lines to avoid line mapping issues with template literals
  const trimmedText = text.trim();
  const lines = trimmedText.split(/\r?\n/);
  console.log('[DEBUG] lines:', lines.length, lines);
  const linesToKeep = new Set();
  
  // Patterns for structural elements to preserve
  const patterns = [
    // Imports/requires
    /^(import\s+[\s\S]*?from\s+['"][^'"]+['"]|const\s+\w+\s*=\s*require\s*\(.*\)|require\s*\(.*\))/gm,
    // Exports
    /^export\s+(default\s+)?(class|function|const|let|var|async\s+function|interface|type|enum)\s+\w+/gm,
    // Function signatures
    /^(?:\/\*\*[\s\S]*?\*\/\s*)*\s*(?:(?:export\s+)?(?:async\s+)?function\s+\w+\s*\([^)]*\)\s*(?::\s*\w+)?(?:\s*\{)?)/gm,
    // Class declarations
    /^(?:\/\*\*[\s\S]*?\*\/\s*)*\s*(?:export\s+)?(?:abstract\s+)?class\s+\w+/gm,
    // Type definitions (TS)
    /^(export\s+)?(interface|type)\s+\w+/gm,
    // Decorators
    /^@\w+/gm,
  ];
  
  // Also preserve error handlers if enabled
  if (preserveErrorHandlers) {
    patterns.push(
      /^\s*(try|catch|finally)\s*\{/gm,
      /^\s*\}\s*catch\s*\(/gm,
      /^\s*\}\s*finally\s*\{/gm,
    );
  }
  
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(trimmedText)) !== null) {
      const startIdx = match.index;
      let charCount = 0;
      for (let i = 0; i < lines.length; i++) {
        // Check if match falls within this line's character range
        const lineStart = charCount;
        const lineEnd = charCount + lines[i].length;
        if (startIdx >= lineStart && startIdx < lineEnd) {
          linesToKeep.add(i);
          break;
        }
        charCount += lines[i].length + 1; // +1 for newline
      }
    }
  }
  
  console.log('[DEBUG regexFallbackCompress] linesToKeep:', [...linesToKeep].sort((a,b)=>a-b));
  console.log('[DEBUG regexFallbackCompress] keepRatio:', linesToKeep.size / lines.length);
  
  const keepRatio = linesToKeep.size / lines.length;
  if (keepRatio > 0.6 || linesToKeep.size === 0) {
    return { compressedSource: text, originalLines: lines.length, compressedLines: lines.length, nodesFound: 0, nodesCompressed: 0, languageDetected: languageHint, syntaxValid: true };
  }
  
  // Build compressed output
  const resultLines = [];
  let braceDepth = 0;
  let inVaultedBody = false;
  let vaultedBodyStart = -1;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    
    if (linesToKeep.has(i)) {
      if (inVaultedBody) {
        resultLines.push(`  // ... ${i - vaultedBodyStart} lines compressed`);
        inVaultedBody = false;
      }
      resultLines.push(line);
    } else {
      if (!inVaultedBody && braceDepth > 0) {
        inVaultedBody = true;
        vaultedBodyStart = i;
      } else if (!inVaultedBody) {
        if (resultLines.length > 0 && resultLines[resultLines.length - 1].trim() !== '') {
          resultLines.push('');
        }
      }
    }
    braceDepth = Math.max(0, braceDepth + opens - closes);
  }
  
  // Close any open vaulted body at the end
  if (inVaultedBody) {
    resultLines.push(`  // ... ${lines.length - vaultedBodyStart} lines compressed`);
  }
  
  const compressedSource = resultLines.join('\n').replace(/\n{3,}/g, '\n\n');
  
  return {
    compressedSource,
    originalLines: lines.length,
    compressedLines: compressedSource.split('\n').length,
    nodesFound: linesToKeep.size,
    nodesCompressed: lines.length - linesToKeep.size,
    languageDetected: languageHint,
    syntaxValid: true,
  };
}

/**
 * Save content to vault (content-addressed storage)
 */
const VAULT_DIR = path.join(path.dirname(globalCacheRegistry.caches.get('instructions')?.store?.flush?.() || ''), '../vaults');
// Use a simpler vault directory
const VAULT_BASE = path.join(process.env.HOME || '/tmp', '.cache', 'tokenforge', 'vaults');

export async function saveToVault(vaultId, content) {
  const vaultDir = path.join(VAULT_BASE, vaultId.slice(0, 2));
  await fs.promises.mkdir(vaultDir, { recursive: true });
  const vaultPath = path.join(vaultDir, vaultId);
  await fs.promises.writeFile(vaultPath, content, 'utf8');
  
  // Also store content hash for deduplication
  const hashPath = vaultPath + '.hash';
  const contentHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  await fs.promises.writeFile(hashPath, contentHash, 'utf8');
  
  return vaultId;
}

export async function retrieveFromVault(vaultId) {
  const vaultPath = path.join(VAULT_BASE, vaultId.slice(0, 2), vaultId);
  try {
    return await fs.promises.readFile(vaultPath, 'utf8');
  } catch {
    return null;
  }
}

export function lookupVaultByContent(content) {
  const contentHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  // Would need to index vaults by hash; simplified for now
  return null;
}

/**
 * Compress tool results in a payload (PostToolUse hook)
 * 
 * @param {Object} payload - Pipeline payload with messages
 * @param {Object} [policy] - Compression policy
 * @returns {Promise<Object>} Modified payload
 */
export async function compressToolResults(payload, policy = null) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;
  
  // Master switch: under LOW pressure with local upstream, skip tool result compression
  if (policy && policy.compressToolResults === false) return payload;
  
  const stats = { compressed: 0, charsSaved: 0, vaults: 0, totalNodes: 0 };
  const newMessages = [];
  
  for (let msgIndex = 0; msgIndex < payload.messages.length; msgIndex++) {
    const msg = payload.messages[msgIndex];
    
    // Only compress tool results tagged as code
    if (msg.role === 'tool' && typeof msg.content === 'string' && msg._cf_type === 'code') {
      // Age gate: never compress fresh results
      if (isRecentToolResult(payload.messages, msgIndex, policy)) {
        newMessages.push(msg);
        continue;
      }
      // Skip editable/verification reads
      if (msg._cf_editable || msg._compressedVaultId || msg._dedupVaultId || msg._cf_deduped || msg.__cf_raw) {
        newMessages.push(msg);
        continue;
      }
      
      // Check vault dedup first
      const existingVaultId = lookupVaultByContent(msg.content);
      if (existingVaultId) {
        const fileRef = (msg._filename || 'this file').replace(/\\/g, '/');
        const stub = `[CF_COMPRESSED_FILE vault_id:"${existingVaultId}"]\n` +
          `⚠️  Previously compressed — content unchanged from prior turn.\n` +
          `To read full source: retrieve vault_id="${existingVaultId}".\n` +
          `To explore: what_does_this_export("${fileRef}") or find_symbol("functionName")\n`;
        
        newMessages.push({ ...msg, content: stub, _compressedVaultId: existingVaultId });
        stats.compressed++; stats.vaults++; stats.charsSaved += msg.content.length - stub.length;
        continue;
      }
      
      // Session cache check
      const contentHash = quickHash(msg.content);
      const cached = SESSION_COMPRESS_CACHE.get(contentHash);
      if (cached) {
        newMessages.push({ ...msg, ...cached });
        stats.compressed++; stats.vaults++; stats.charsSaved += msg.content.length - cached.kept.length;
        continue;
      }
      
      // Line count guard (policy-driven)
      const minLines = policy?.minLinesToCompress ?? 30;
      if (msg.content.split('\n').length < minLines) {
        newMessages.push(msg);
        continue;
      }
      
      const beforeLen = msg.content.length;
      const langHint = msg._filename
        ? (EXT_TO_LANG[msg._filename.split('.').pop()?.toLowerCase()] || '')
        : '';
      
      const result = await compressCode(msg.content, langHint, { ...policy, skipTrivialCheck: true }, msg._filename);
      
      if (result.vaulted) {
        stats.compressed++;
        stats.charsSaved += beforeLen - result.kept.length;
        stats.vaults++;
        if (result.nodesCompressed) stats.totalNodes += result.nodesCompressed;
        
        const compressedMsg = {
          ...msg,
          content: result.kept,
          _compressedVaultId: result.vaultId,
          _astLanguage: result.language,
          _syntaxValid: result.syntaxValid,
        };
        
        newMessages.push(compressedMsg);
        continue;
      }
      
      newMessages.push(msg);
      continue;
    }
    
    newMessages.push(msg);
  }
  
  payload.messages = newMessages;
  
  if (stats.compressed > 0) {
    console.log(
      `[AST Compressor] Compressed ${stats.compressed} files | ` +
      `Chars saved: ${stats.charsSaved} (~${Math.floor(stats.charsSaved / 4)} tokens) | ` +
      `Vaults: ${stats.vaults} | Nodes: ${stats.totalNodes}`
    );
  }
  
  return payload;
}

/**
 * Age gate helper (shared with semantic-dedup)
 */
function isRecentToolResult(messages, msgIndex, policy) {
  const recentTurnExemption = policy?.recentTurnExemption ?? AGE_GATE_TURNS;
  let assistantTurnsSince = 0;
  for (let i = msgIndex + 1; i < messages.length; i++) {
    if (messages[i].role === 'assistant') assistantTurnsSince++;
  }
  return assistantTurnsSince < recentTurnExemption;
}

/**
 * Prune stale vault retrieve results from history (like ContextForge's historyPruner)
 * Replaces retrieve results before last user message with short stubs
 */
export function pruneStaleRetrieves(payload) {
  if (!payload.messages || !Array.isArray(payload.messages) || payload.messages.length < 3) return payload;
  
  // Find last human user message
  let lastUserIdx = -1;
  for (let i = payload.messages.length - 1; i >= 0; i--) {
    const msg = payload.messages[i];
    if (msg.role !== 'user') continue;
    if (Array.isArray(msg.content) && msg.content.every(b => b.type === 'tool_result')) continue;
    lastUserIdx = i;
    break;
  }
  if (lastUserIdx < 0) return payload;
  
  // Track vault retrieves
  const retrieveCallIds = new Set();
  const vaultToFilePath = new Map();
  
  for (const msg of payload.messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.function?.name?.includes('retrieve') || tc.function?.name?.includes('contextforge_retrieve')) {
          retrieveCallIds.add(tc.id);
        }
        if (tc.function?.arguments) {
          try {
            const args = JSON.parse(tc.function.arguments);
            if (args.vault_id && args.file_path) {
              vaultToFilePath.set(args.vault_id, args.file_path);
            }
          } catch {}
        }
      }
    } else if (msg.role === 'tool' && msg.tool_call_id && retrieveCallIds.has(msg.tool_call_id)) {
      // This is a retrieve result
    }
  }
  
  // Find most recent retrieve (never prune it)
  let mostRecentRetrieveIdx = -1;
  for (let i = payload.messages.length - 1; i >= 0; i--) {
    const msg = payload.messages[i];
    if (msg.role === 'tool' && msg.tool_call_id && retrieveCallIds.has(msg.tool_call_id)) {
      mostRecentRetrieveIdx = i;
      break;
    }
  }
  
  const PRUNE_STUB = '[ContextForge: Vault content retrieved in prior turn. Source omitted. Call retrieve again if needed.]';
  let pruned = 0, charsSaved = 0;
  const newMessages = [];
  
  for (let i = 0; i < payload.messages.length; i++) {
    const msg = payload.messages[i];
    
    // Target retrieve results
    if (!(msg.role === 'tool' && msg.tool_call_id && retrieveCallIds.has(msg.tool_call_id))) {
      newMessages.push(msg);
      continue;
    }
    
    // Never prune most recent
    if (i === mostRecentRetrieveIdx) {
      newMessages.push(msg);
      continue;
    }
    if (msg._cf_pruned) { newMessages.push(msg); continue; }
    if (typeof msg.content !== 'string' || msg.content.length <= 500) { newMessages.push(msg); continue; }
    
    // Prune if historical (before last user message)
    if (i < lastUserIdx) {
      charsSaved += msg.content.length - PRUNE_STUB.length;
      pruned++;
      newMessages.push({ ...msg, content: PRUNE_STUB, _cf_pruned: true });
      continue;
    }
    
    newMessages.push(msg);
  }
  
  if (pruned > 0) {
    console.log(`[HistoryPruner] Pruned ${pruned} stale retrieves — saved ~${Math.floor(charsSaved / 4)} tokens`);
    payload._cf_historyPrunedTokens = Math.floor(charsSaved / 4);
  }
  
  return { ...payload, messages: newMessages };
}

export { SESSION_COMPRESS_CACHE, regexFallbackCompress };