/**
 * Semantic Deduplication for Tool Results
 * 
 * Implements dual-lane FNV-1a (exact match) + SimHash (near-duplicate detection)
 * with LRU session registry and "keep newest, stub oldest" invariant.
 * 
 * Based on ContextForge's semanticDedup.js with adaptations for Token Forge's
 * hook-based architecture.
 */

import crypto from 'node:crypto';
import { globalCacheRegistry, defaultContentHash } from './cache-invalidation.mjs';

const DEDUPABLE_TYPES = new Set(['code', 'text', 'markdown', 'json']);
const MIN_EXACT_DEDUP_CHARS = 100;
const MIN_NEARDUP_DEDUP_CHARS = 500;
const MAX_REGISTRY_SIZE = 200;
const SIMHASH_BITS = 64;

// Session registry with LRU eviction
class SessionDedupRegistry {
  constructor() {
    this._seen = new Map(); // key -> { fingerprint, contentHash, vaultId, contentLength, turnIndex, accessTime }
    this._turnIndex = 0;
  }

  incrementTurn() {
    this._turnIndex++;
  }

  get(key) {
    const entry = this._seen.get(key);
    if (entry) {
      entry.accessTime = Date.now(); // LRU update
    }
    return entry ?? null;
  }

  set(key, entry) {
    // Evict LRU if at capacity and this is a new key
    if (!this._seen.has(key) && this._seen.size >= MAX_REGISTRY_SIZE) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [k, v] of this._seen) {
        if (v.accessTime < oldestTime) {
          oldestTime = v.accessTime;
          oldestKey = k;
        }
      }
      if (oldestKey) this._seen.delete(oldestKey);
    }
    
    this._seen.set(key, { 
      ...entry, 
      turnIndex: this._turnIndex,
      accessTime: Date.now(),
    });
  }

  get size() { return this._seen.size; }
  get currentTurn() { return this._turnIndex; }

  clear() {
    this._seen.clear();
    this._turnIndex = 0;
  }

  getStats() {
    return {
      trackedEntries: this._seen.size,
      currentTurn: this._turnIndex,
      keys: [...this._seen.keys()],
    };
  }
}

export const sessionDedupRegistry = new SessionDedupRegistry();

/**
 * FNV-1a 64-bit hash with two independent 32-bit lanes
 * Fixed implementation: both lanes process every character with different seeds
 */
export function fnv1a64(str) {
  let h1 = 0x811c9dc5; // Standard FNV-1a 32-bit offset basis
  let h2 = 0x4b9ace2f; // Independent seed for second lane
  
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  
  return `${h1.toString(16).padStart(8, '0')}_${h2.toString(16).padStart(8, '0')}`;
}

/**
 * Normalize content for fingerprinting - strips volatile elements
 * that change every turn but don't affect semantic content
 */
export function normalizeForFingerprint(content) {
  return String(content)
    // Vault references - order matters: specific patterns first
    .replace(/cf_vault_[a-f0-9]+/g, 'VAULT_ID')
    // Use RegExp constructor to avoid regex literal parsing issues with quotes/brackets
    .replace(new RegExp('vault_id:"[^"]+"', 'g'), 'vault_id="STABLE"')
    // Compressed file marker - replace entire wrapper
    .replace(/\[CF_COMPRESSED_FILE [^\]]+\]/g, '[CF_COMPRESSED]')
    // Timestamps
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, 'TIMESTAMP')
    .replace(/\bat\s+\d{2}:\d{2}:\d{2}\b/g, 'at TIMESTAMP')
    // Call IDs
    .replace(/call_cf_\d+_\d+/g, 'CALL_ID')
    // Index UUIDs
    .replace(/IDX_[0-9a-f-]{36}/g, 'IDX_ID')
    // Size fields
    .replace(/"size":\s*\d+/g, '"size": SIZE')
    .replace(/"lastPatchedAt":\s*"[^"]+"/g, '"lastPatchedAt": TIMESTAMP');
}

/**
 * SimHash implementation using native binding if available, JS fallback otherwise
 */
let nativeSimhash = null;
try {
  // Try to load native module (would need to be built)
  nativeSimhash = require('../native/tmap/build/Release/contextforge_native.node')?.simhash;
} catch {}

export function computeSimHash(text) {
  if (nativeSimhash) {
    try {
      return nativeSimhash(normalizeForFingerprint(text));
    } catch {}
  }
  
  // JS fallback: simplified SimHash using word-level features
  return jsSimHash(normalizeForFingerprint(text));
}

function jsSimHash(text) {
  const vector = new Array(SIMHASH_BITS).fill(0);
  const words = text.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) || [];
  
  for (const word of words) {
    const hash = fnv1a64(word);
    const hashNum = BigInt('0x' + hash.replace('_', ''));
    
    for (let i = 0; i < SIMHASH_BITS; i++) {
      const bit = (hashNum >> BigInt(i)) & BigInt(1);
      vector[i] += bit ? 1 : -1;
    }
  }
  
  let fingerprint = 0n;
  for (let i = 0; i < SIMHASH_BITS; i++) {
    if (vector[i] > 0) fingerprint |= (1n << BigInt(i));
  }
  
  return fingerprint.toString(16).padStart(16, '0');
}

export function hammingDistance(a, b) {
  if (nativeSimhash) {
    try {
      return nativeSimhash.hammingDistance(a, b);
    } catch {}
  }
  
  // JS fallback
  const aNum = BigInt('0x' + a);
  const bNum = BigInt('0x' + b);
  let diff = aNum ^ bNum;
  let count = 0;
  while (diff > 0) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}

/**
 * Dynamic threshold based on content length
 */
function getDynamicThreshold(contentLength) {
  if (contentLength > 200000) return 24;
  if (contentLength > 100000) return 20;
  if (contentLength > 50000) return 16;
  if (contentLength > 20000) return 12;
  return 14;
}

/**
 * Extract filename from tool result message
 */
function extractFilename(msg) {
  if (msg._filename && typeof msg._filename === 'string') return msg._filename;
  if (msg._args && typeof msg._args === 'object') {
    for (const field of ['file_path', 'path', 'filepath', 'filename', 'file', 'source', 'target', 'uri']) {
      if (typeof msg._args[field] === 'string') return msg._args[field];
    }
  }
  const content = typeof msg.content === 'string' ? msg.content.slice(0, 500) : '';
  const patterns = [
    /^(?:File|Path|Filename|Reading):\s*(.+\.\w+)/im,
    /^```[\w]*\s+([\w\/\\.\-]+\.\w+)/m,
    /\b(?:reading|opened?|loaded?|viewing?|cat)\s+['"]?([\w\/\\.\-]+\.\w+)['"]?/im,
  ];
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

/**
 * Normalize file path for consistent keying
 */
function normalizeFilePath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return null;
  let p = rawPath.trim().replace(/\\/g, '/').toLowerCase();
  p = p.replace(/^[a-z]:\//i, '').replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\/+/g, '/');
  // Strip common prefixes
  for (const prefix of ['src/', 'lib/', 'app/']) {
    if (p.startsWith(prefix)) { p = p.slice(prefix.length); break; }
  }
  return p.length > 0 ? p : null;
}

/**
 * Build deduplication key for a message
 * Priority: filename-based > content-prefix hash
 */
export function buildDedupKey(msg) {
  const filename = extractFilename(msg);
  if (filename) {
    const normalized = normalizeFilePath(filename);
    if (normalized) return `file:${normalized}`;
  }
  
  const cfType = msg._cf_type;
  if (DEDUPABLE_TYPES.has(cfType) && typeof msg.content === 'string' && msg.content.length >= 100) {
    const prefix = msg.content.slice(0, 200);
    return `${cfType}:${fnv1a64(prefix)}`;
  }
  
  return null;
}

/**
 * Check if content looks like a vault stub (already compressed/deduped)
 */
export function looksLikeStub(content) {
  if (typeof content !== 'string') return false;
  return content.includes('[CF_VAULT:') || 
         content.includes('[CF_COMPRESSED_FILE') ||
         content.includes('vault_id="') ||
         content.match(/^\[CF_VAULT:cf_vault_[a-f0-9]+\]/);
}

/**
 * Check if a tool result is recent (age gate - don't dedup fresh results)
 * This prevents the self-defeating loop: read → stub → retrieve → dedup → re-read
 * Returns true if the result is within the recent turn exemption (<= exemption)
 */
export function isRecentToolResult(messages, msgIndex, policy = null) {
  const recentTurnExemption = policy?.recentTurnExemption ?? 2;
  let assistantTurnsSince = 0;
  
  for (let i = msgIndex + 1; i < messages.length; i++) {
    if (messages[i].role === 'assistant') assistantTurnsSince++;
  }
  
  return assistantTurnsSince <= recentTurnExemption;
}

/**
 * Main deduplication function - implements "keep newest, stub oldest" invariant
 * 
 * @param {Object} payload - Full pipeline payload with messages array
 * @param {Object} [options] - Options
 *   @param {Object} [options.policy] - Compression policy from upstream
 * @returns {Promise<Object>} Modified payload with deduplicated messages
 */
export async function applySemanticDedup(payload, options = {}) {
  if (!payload.messages || !Array.isArray(payload.messages)) return payload;
  
  const policy = payload.__policy ?? options.policy ?? null;
  if (policy && policy.dedupEnabled === false) return payload;
  
  sessionDedupRegistry.incrementTurn();
  
  const stats = {
    checked: 0,
    skippedType: 0,
    skippedNoKey: 0,
    deduplicated: 0,
    exactDups: 0,
    nearDups: 0,
    charsSaved: 0,
  };
  
  // Pre-pass: find NEWEST occurrence of each dedup key in current payload
  const newestByKey = new Map();
  
  function isDedupableType(msg) {
    if (DEDUPABLE_TYPES.has(msg._cf_type)) return true;
    const filename = extractFilename(msg);
    if (filename) {
      const ext = filename.split('.').pop()?.toLowerCase();
      const SOURCE_EXTENSIONS = new Set(['js','ts','jsx','tsx','mjs','cjs','py','rb','go','rs','java','kt','swift','c','cpp','h','hpp','cs','json','yaml','yml','toml','xml','md','mdx','txt','rst','css','scss','less','html','htm','vue','svelte','sh','bash','zsh','fish','sql','graphql','proto','env','gitignore','dockerignore']);
      if (ext && SOURCE_EXTENSIONS.has(ext)) return true;
    }
    return false;
  }
  
  for (let msgIndex = 0; msgIndex < payload.messages.length; msgIndex++) {
    const msg = payload.messages[msgIndex];
    
    // OpenAI format: role:"tool"
    if (msg.role === 'tool' && typeof msg.content === 'string' && isDedupableType(msg)) {
      const key = buildDedupKey(msg);
      if (key) newestByKey.set(key, { msgIndex, blockIndex: -1, content: msg.content });
    }
    // Anthropic format: role:"user" with tool_result blocks
    else if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (let blockIndex = 0; blockIndex < msg.content.length; blockIndex++) {
        const block = msg.content[blockIndex];
        if (block.type === 'tool_result' && typeof block.content === 'string' && isDedupableType(block)) {
          const key = buildDedupKey(block);
          if (key) newestByKey.set(key, { msgIndex, blockIndex, content: block.content });
        }
      }
    }
  }
  
  /**
   * Deduplicate an occurrence against the NEWEST occurrence in this payload
   * (not against cross-request registry state)
   */
  async function dedupKeepNewest(msg, key, msgIndex, blockIndex = -1) {
    const newest = newestByKey.get(key);
    const isNewest = newest && newest.msgIndex === msgIndex && newest.blockIndex === blockIndex;
    
    // Register the newest copy in session registry (for vault reuse + stats)
    if (isNewest) {
      const existing = sessionDedupRegistry.get(key);
      const contentHash = fnv1a64(msg.content);
      if (!existing || existing.contentHash !== contentHash) {
        // Vault would be created here in full implementation
        sessionDedupRegistry.set(key, {
          fingerprint: msg.content.length >= MIN_NEARDUP_DEDUP_CHARS ? computeSimHash(msg.content) : null,
          contentHash,
          vaultId: null, // Would be created by vault system
          contentLength: msg.content.length,
        });
      }
      return { deduplicated: false, msg };
    }
    
    // Age gate: content the model hasn't acted on yet stays readable
    if (isRecentToolResult(payload.messages, msgIndex, policy)) {
      return { deduplicated: false, msg };
    }
    
    // Never dedup toward a stub - the pointer would dangle
    if (!newest || looksLikeStub(newest.content)) {
      return { deduplicated: false, msg };
    }
    
    const content = msg.content;
    if (!content || content.length < MIN_EXACT_DEDUP_CHARS) {
      return { deduplicated: false, msg };
    }
    
    // Exact match with newest copy → stub this older one
    if (fnv1a64(content) === fnv1a64(newest.content)) {
      const vaultId = `cf_vault_${crypto.randomBytes(4).toString('hex')}`; // Would use real vault
      stats.deduplicated++;
      stats.exactDups++;
      stats.charsSaved += content.length - 100; // Approximate stub size
      return {
        deduplicated: true,
        msg: {
          ...msg,
          _cf_deduped: true,
          content: `[CF_VAULT:${vaultId}] (identical to current copy shown later, ~${Math.round(content.length / 4)} tokens)`,
          _dedupVaultId: vaultId,
          _dedupSimilarity: 100,
        },
      };
    }
    
    // Near-duplicate with newest copy
    if (content.length >= MIN_NEARDUP_DEDUP_CHARS && newest.content.length >= MIN_NEARDUP_DEDUP_CHARS) {
      const fp = computeSimHash(content);
      const newestFp = computeSimHash(newest.content);
      if (fp && newestFp) {
        const distance = hammingDistance(fp, newestFp);
        const threshold = getDynamicThreshold(content.length);
        
        // Under keep-newest, SimHash blind spot (distance=0, FNV differs) is safe to stub:
        // the authoritative full version is present later in this payload
        if (distance <= threshold) {
          const similarityPct = Math.round(((SIMHASH_BITS - distance) / SIMHASH_BITS) * 100);
          const vaultId = `cf_vault_${crypto.randomBytes(4).toString('hex')}`;
          stats.deduplicated++;
          stats.nearDups++;
          stats.charsSaved += content.length - 100;
          return {
            deduplicated: true,
            msg: {
              ...msg,
              _cf_deduped: true,
              content: `[CF_VAULT:${vaultId}] (outdated copy — ${similarityPct}% similar to current version)`,
              _dedupVaultId: vaultId,
              _dedupSimilarity: similarityPct,
            },
          };
        }
      }
    }
    
    return { deduplicated: false, msg };
  }
  
  const newMessages = [];
  
  for (let msgIndex = 0; msgIndex < payload.messages.length; msgIndex++) {
    const msg = payload.messages[msgIndex];
    
    // OpenAI format
    if (msg.role === 'tool' && typeof msg.content === 'string') {
      if (msg._cf_vaulted || msg._cf_pruned || msg._cf_editable) {
        newMessages.push(msg);
        continue;
      }
      if (!isDedupableType(msg)) {
        stats.skippedType++;
        newMessages.push(msg);
        continue;
      }
      const key = buildDedupKey(msg);
      if (!key) {
        stats.skippedNoKey++;
        newMessages.push(msg);
        continue;
      }
      stats.checked++;
      const { deduplicated, msg: updatedMsg } = await dedupKeepNewest(msg, key, msgIndex);
      if (deduplicated) {
        newMessages.push(updatedMsg);
      } else {
        newMessages.push(msg);
      }
      continue;
    }
    
    // Anthropic format
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      let modified = false;
      const newBlocks = [];
      for (let blockIndex = 0; blockIndex < msg.content.length; blockIndex++) {
        const block = msg.content[blockIndex];
        if (block.type === 'tool_result' && typeof block.content === 'string') {
          if (block._cf_vaulted || block._cf_pruned || block._cf_editable) {
            newBlocks.push(block);
            continue;
          }
          if (!isDedupableType(block)) {
            stats.skippedType++;
            newBlocks.push(block);
            continue;
          }
          const key = buildDedupKey(block);
          if (!key) {
            stats.skippedNoKey++;
            newBlocks.push(block);
            continue;
          }
          stats.checked++;
          const { deduplicated, msg: updatedBlock } = await dedupKeepNewest(block, key, msgIndex, blockIndex);
          if (deduplicated) {
            stats.deduplicated++;
            modified = true;
            newBlocks.push(updatedBlock);
          } else {
            newBlocks.push(block);
          }
        } else {
          newBlocks.push(block);
        }
      }
      newMessages.push(modified ? { ...msg, content: newBlocks } : msg);
      continue;
    }
    
    newMessages.push(msg);
  }
  
  payload.messages = newMessages;
  
  if (stats.checked > 0 || stats.deduplicated > 0) {
    console.log(
      `[SemanticDedup] Checked ${stats.checked} | Deduped ${stats.deduplicated} ` +
      `(${stats.exactDups} exact, ${stats.nearDups} near-dup) | ` +
      `Chars saved: ${stats.charsSaved} (~${Math.floor(stats.charsSaved / 4)} tokens) | ` +
      `Skipped: ${stats.skippedType} wrong-type, ${stats.skippedNoKey} no-key`
    );
  }
  
  return payload;
}

/**
 * Invalidate registry entries for a file (called after patches)
 */
export function invalidateDedupRegistry(filePath) {
  if (!filePath) return false;
  
  const normalized = normalizeFilePath(filePath);
  const basename = filePath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  if (!normalized && !basename) return false;
  
  let invalidated = 0;
  for (const key of sessionDedupRegistry._seen.keys()) {
    if (!key.startsWith('file:')) continue;
    const keyPath = key.slice(5);
    const keyBasename = keyPath.split('/').pop() ?? '';
    
    if ((normalized && keyPath === normalized) || (basename && keyBasename === basename)) {
      sessionDedupRegistry._seen.delete(key);
      invalidated++;
    }
  }
  
  if (invalidated) {
    console.log(`[SemanticDedup] Invalidated ${invalidated} entries for ${filePath}`);
  }
  return invalidated > 0;
}

export { sessionDedupRegistry as dedupRegistry };