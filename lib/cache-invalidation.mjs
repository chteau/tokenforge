/**
 * Formal Cache Invalidation Framework
 * 
 * Provides a unified cache registry with dependency tracking, content-hash invalidation,
 * and bounded storage. Every cache declares its dependencies explicitly.
 * 
 * Design goals:
 * - Prevent stale data from silently influencing sessions
 * - Content-hash based invalidation (not just timestamps)
 * - Concurrency-safe operations
 * - Explicit cache registration with declared dependencies
 * - Statistics for monitoring hit rates and invalidation correctness
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cacheBase } from './usage.mjs';

export class CacheRegistry {
  constructor() {
    this.caches = new Map(); // name → CacheEntry
    this.stats = {
      hits: new Map(),
      misses: new Map(),
      invalidations: new Map(),
      errors: new Map(),
    };
  }

  /**
   * Register a cache with explicit dependency declaration
   * @param {string} name - Unique cache name
   * @param {Object} config
   *   @param {Object} config.store - Backing store (Map, file, etc.) with get/set/delete/clear
   *   @param {Function} config.keyFn - (input) => cache key string
   *   @param {Function} config.depsFn - (input) => array of dependency identifiers (file paths, symbols, etc.)
   *   @param {Function} config.invalidateFn - (dep, contentHash) => void (removes stale entries)
   *   @param {Function} [config.contentHashFn] - (input) => content hash for validation
   *   @param {number} [config.maxSize=1000] - Maximum entries
   *   @param {number} [config.ttlMs=0] - Time-to-live in ms (0 = no expiry)
   *   @param {Function} [config.onEvict] - (key, value) => void
   */
  register(name, config) {
    if (this.caches.has(name)) {
      throw new Error(`Cache '${name}' already registered`);
    }
    
    const entry = {
      name,
      store: config.store,
      keyFn: config.keyFn,
      depsFn: config.depsFn,
      invalidateFn: config.invalidateFn,
      contentHashFn: config.contentHashFn || defaultContentHash,
      maxSize: config.maxSize ?? 1000,
      ttlMs: config.ttlMs ?? 0,
      onEvict: config.onEvict,
      createdAt: Date.now(),
    };
    
    this.caches.set(name, entry);
    this.stats.hits.set(name, 0);
    this.stats.misses.set(name, 0);
    this.stats.invalidations.set(name, 0);
    this.stats.errors.set(name, 0);
    
    return entry;
  }

  /**
   * Get a value from cache, recording hit/miss
   */
  get(name, input) {
    const entry = this.caches.get(name);
    if (!entry) throw new Error(`Cache '${name}' not registered`);
    
    const key = entry.keyFn(input);
    const now = Date.now();
    
    try {
      const stored = entry.store.get(key);
      
      if (stored === undefined || stored === null) {
        this.stats.misses.set(name, this.stats.misses.get(name) + 1);
        return { hit: false, value: null, key };
      }
      
      // Check TTL
      if (entry.ttlMs > 0 && stored.timestamp && (now - stored.timestamp) > entry.ttlMs) {
        entry.store.delete(key);
        this.stats.misses.set(name, this.stats.misses.get(name) + 1);
        return { hit: false, value: null, key };
      }
      
      // Validate content hash if provided
      if (stored.contentHash && input !== undefined) {
        const currentHash = entry.contentHashFn(input);
        if (stored.contentHash !== currentHash) {
          entry.store.delete(key);
          this.stats.misses.set(name, this.stats.misses.get(name) + 1);
          this.stats.invalidations.set(name, this.stats.invalidations.get(name) + 1);
          return { hit: false, value: null, key, reason: 'content_hash_mismatch' };
        }
      }
      
      this.stats.hits.set(name, this.stats.hits.get(name) + 1);
      return { hit: true, value: stored.value, key, timestamp: stored.timestamp };
    } catch (err) {
      this.stats.errors.set(name, this.stats.errors.get(name) + 1);
      throw err;
    }
  }

  /**
   * Set a value in cache with content hash and timestamp
   */
  set(name, input, value) {
    const entry = this.caches.get(name);
    if (!entry) throw new Error(`Cache '${name}' not registered`);
    
    const key = entry.keyFn(input);
    const contentHash = entry.contentHashFn(input);
    const now = Date.now();
    
    // Evict if over capacity (LRU by timestamp)
    if (entry.store.size >= entry.maxSize) {
      this._evictLRU(entry);
    }
    
    try {
      entry.store.set(key, {
        value,
        contentHash,
        timestamp: now,
        key, // Store key for debugging
      });
    } catch (err) {
      this.stats.errors.set(name, this.stats.errors.get(name) + 1);
      throw err;
    }
    
    return { key, contentHash };
  }

  /**
   * Invalidate cache entries related to a dependency
   * @param {string} dep - Dependency identifier (file path, symbol, etc.)
   * @param {string} [contentHash] - New content hash (entries with different hash are invalidated)
   */
  invalidate(dep, contentHash = null) {
    let totalInvalidated = 0;
    
    for (const [name, entry] of this.caches) {
      try {
        const count = entry.invalidateFn(dep, contentHash);
        totalInvalidated += count;
        this.stats.invalidations.set(name, this.stats.invalidations.get(name) + count);
      } catch (err) {
        this.stats.errors.set(name, this.stats.errors.get(name) + 1);
        console.error(`[CacheRegistry] Invalidation error for '${name}':`, err.message);
      }
    }
    
    return totalInvalidated;
  }

  /**
   * Invalidate by file path - convenience for file-based dependencies
   */
  invalidateFile(filePath, contentHash = null) {
    const normalized = path.resolve(filePath);
    return this.invalidate(`file:${normalized}`, contentHash);
  }

  /**
   * Invalidate by symbol - for symbol-based caches
   */
  invalidateSymbol(symbol, filePath = null) {
    const dep = filePath ? `symbol:${filePath}:${symbol}` : `symbol:*:${symbol}`;
    return this.invalidate(dep);
  }

  /**
   * Clear a specific cache entirely
   */
  clear(name) {
    const entry = this.caches.get(name);
    if (!entry) throw new Error(`Cache '${name}' not registered`);
    
    entry.store.clear();
    this.stats.hits.set(name, 0);
    this.stats.misses.set(name, 0);
    this.stats.invalidations.set(name, 0);
  }

  /**
   * Get statistics for all caches
   */
  getStats() {
    const result = {};
    for (const [name, entry] of this.caches) {
      const hits = this.stats.hits.get(name) || 0;
      const misses = this.stats.misses.get(name) || 0;
      const total = hits + misses;
      result[name] = {
        size: entry.store.size ?? 'unknown',
        maxSize: entry.maxSize,
        hits,
        misses,
        hitRate: total > 0 ? (hits / total).toFixed(3) : '0.000',
        invalidations: this.stats.invalidations.get(name) || 0,
        errors: this.stats.errors.get(name) || 0,
        ttlMs: entry.ttlMs,
        uptimeMs: Date.now() - entry.createdAt,
      };
    }
    return result;
  }

  /**
   * Get cache entry for direct access (e.g., for custom operations)
   */
  getCache(name) {
    return this.caches.get(name);
  }

  // Private: LRU eviction by oldest timestamp
  _evictLRU(entry) {
    let oldestKey = null;
    let oldestTime = Infinity;
    
    for (const [key, value] of entry.store) {
      if (value.timestamp && value.timestamp < oldestTime) {
        oldestTime = value.timestamp;
        oldestKey = key;
      }
    }
    
    if (oldestKey) {
      const evicted = entry.store.get(oldestKey);
      entry.store.delete(oldestKey);
      if (entry.onEvict) entry.onEvict(oldestKey, evicted);
    }
  }
}

/**
 * Default content hash function using SHA-256 truncated to 16 chars
 */
export function defaultContentHash(input) {
  if (input === undefined || input === null) return '';
  const str = typeof input === 'string' ? input : JSON.stringify(input);
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

/**
 * File content hash - reads file and hashes content
 */
export async function fileContentHash(filePath) {
  try {
    const content = await fs.promises.readFile(filePath, 'utf8');
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch {
    return null; // File doesn't exist or can't read
  }
}

/**
 * Synchronous file content hash
 */
export function fileContentHashSync(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/**
 * Create a simple Map-based store with size tracking
 */
export function createMapStore() {
  const map = new Map();
  return {
    get: (key) => map.get(key),
    set: (key, value) => map.set(key, value),
    delete: (key) => map.delete(key),
    clear: () => map.clear(),
    get size() { return map.size; },
    *[Symbol.iterator]() { yield* map.entries(); },
  };
}

/**
 * Create a file-backed store with JSON serialization
 */
export function createFileStore(filePath, { maxSize = 1000 } = {}) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  
  let map = new Map();
  let dirty = false;
  
  // Load existing
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const [k, v] of Object.entries(data)) map.set(k, v);
  } catch {}
  
  const flush = () => {
    if (!dirty) return;
    const obj = Object.fromEntries(map);
    fs.writeFileSync(filePath, JSON.stringify(obj));
    dirty = false;
  };
  
  // Periodic flush
  const interval = setInterval(flush, 30000);
  interval.unref();
  
  return {
    get: (key) => map.get(key),
    set: (key, value) => { map.set(key, value); dirty = true; },
    delete: (key) => { map.delete(key); dirty = true; },
    clear: () => { map.clear(); dirty = true; },
    get size() { return map.size; },
    flush,
    close: () => { clearInterval(interval); flush(); },
  };
}

/**
 * Global registry instance
 */
export const globalCacheRegistry = new CacheRegistry();

/**
 * Register Token Forge's core caches
 * Call this during initialization
 */
export function registerCoreCaches() {
  // Instruction files cache (already uses content hash)
  globalCacheRegistry.register('instructions', {
    store: createMapStore(),
    keyFn: (cwd) => path.resolve(cwd),
    depsFn: (cwd) => {
      // Depend on all instruction files in the chain
      const dirs = [];
      for (let d = path.resolve(cwd); d !== path.parse(d).root; d = path.dirname(d)) {
        dirs.push(d);
      }
      return dirs.flatMap(d => [
        path.join(d, 'CLAUDE.md'),
        path.join(d, 'AGENTS.md'),
        path.join(d, '.claude', 'CLAUDE.md'),
        path.join(d, '.claude', 'AGENTS.md'),
      ].filter(fs.existsSync));
    },
    invalidateFn: (dep) => {
      // Invalidate all entries where dep is in their dependency chain
      let count = 0;
      for (const [key, value] of entry.store) {
        // Would need to track deps per entry; simplified for now
        entry.store.delete(key);
        count++;
      }
      return count;
    },
    maxSize: 50,
  });
  
  // Note: Actual integration with existing caches happens in their respective files
  // This just provides the framework
}

export { CacheRegistry as default };