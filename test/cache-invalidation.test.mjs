/**
 * Tests for Cache Invalidation Framework
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { CacheRegistry, createMapStore, defaultContentHash, fileContentHashSync } from '../lib/cache-invalidation.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('CacheRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new CacheRegistry();
  });

  it('registers a cache with dependencies', () => {
    const store = createMapStore();
    registry.register('test', {
      store,
      keyFn: (input) => input.key,
      depsFn: (input) => [`file:${input.file}`],
      invalidateFn: (dep) => { store.delete(dep); return 1; },
    });
    
    assert.ok(registry.getCache('test'));
  });

  it('gets and sets values with content hash validation', () => {
    const store = createMapStore();
    registry.register('test', {
      store,
      keyFn: (input) => input.key,
      depsFn: () => [],
      invalidateFn: () => 0,
      contentHashFn: (input) => input.hash,
    });
    
    registry.set('test', { key: 'k1', hash: 'abc' }, 'value1');
    const result = registry.get('test', { key: 'k1', hash: 'abc' });
    assert.strictEqual(result.hit, true);
    assert.strictEqual(result.value, 'value1');
  });

  it('misses on content hash mismatch', () => {
    const store = createMapStore();
    registry.register('test', {
      store,
      keyFn: (input) => input.key,
      depsFn: () => [],
      invalidateFn: () => 0,
      contentHashFn: (input) => input.hash,
    });
    
    registry.set('test', { key: 'k1', hash: 'abc' }, 'value1');
    const result = registry.get('test', { key: 'k1', hash: 'def' });
    assert.strictEqual(result.hit, false);
    assert.strictEqual(result.reason, 'content_hash_mismatch');
  });

  it('invalidates by dependency', () => {
    const store = createMapStore();
    let invalidateCount = 0;
    registry.register('test', {
      store,
      keyFn: (input) => input.key,
      depsFn: (input) => [`file:${input.file}`],
      invalidateFn: (dep) => { invalidateCount++; store.delete(dep); return 1; },
    });
    
    registry.set('test', { key: 'k1', file: 'a.js' }, 'value1');
    registry.set('test', { key: 'k2', file: 'b.js' }, 'value2');
    
    registry.invalidate('file:a.js');
    assert.strictEqual(invalidateCount, 1);
  });

  it('tracks hit/miss statistics', () => {
    const store = createMapStore();
    registry.register('test', {
      store,
      keyFn: (input) => input.key,
      depsFn: () => [],
      invalidateFn: () => 0,
    });
    
    registry.get('test', { key: 'missing' });
    registry.set('test', { key: 'k1' }, 'v1');
    registry.get('test', { key: 'k1' });
    registry.get('test', { key: 'k1' });
    
    const stats = registry.getStats();
    assert.strictEqual(stats.test.hits, 2);
    assert.strictEqual(stats.test.misses, 1);
    assert.strictEqual(stats.test.hitRate, '0.667');
  });

  it('evicts LRU when over capacity', () => {
    const store = createMapStore();
    registry.register('test', {
      store,
      keyFn: (input) => input.key,
      depsFn: () => [],
      invalidateFn: () => 0,
      maxSize: 2,
    });
    
    registry.set('test', { key: 'k1' }, 'v1');
    registry.set('test', { key: 'k2' }, 'v2');
    registry.set('test', { key: 'k3' }, 'v3'); // Should evict k1
    
    assert.strictEqual(store.size, 2);
    assert.strictEqual(registry.get('test', { key: 'k1' }).hit, false);
    assert.strictEqual(registry.get('test', { key: 'k2' }).hit, true);
    assert.strictEqual(registry.get('test', { key: 'k3' }).hit, true);
  });

  it('respects TTL', async () => {
    const store = createMapStore();
    registry.register('test', {
      store,
      keyFn: (input) => input.key,
      depsFn: () => [],
      invalidateFn: () => 0,
      ttlMs: 50,
    });
    
    registry.set('test', { key: 'k1' }, 'v1');
    assert.strictEqual(registry.get('test', { key: 'k1' }).hit, true);
    
    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(registry.get('test', { key: 'k1' }).hit, false);
  });
});

describe('defaultContentHash', () => {
  it('produces consistent hashes', () => {
    const h1 = defaultContentHash('test content');
    const h2 = defaultContentHash('test content');
    assert.strictEqual(h1, h2);
    assert.strictEqual(h1.length, 16);
  });

  it('produces different hashes for different content', () => {
    const h1 = defaultContentHash('content 1');
    const h2 = defaultContentHash('content 2');
    assert.notStrictEqual(h1, h2);
  });

  it('handles objects', () => {
    const h1 = defaultContentHash({ a: 1, b: 2 });
    const h2 = defaultContentHash({ a: 1, b: 2 });
    assert.strictEqual(h1, h2);
  });
});

describe('fileContentHashSync', () => {
  let tmpDir;
  let testFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-test-'));
    testFile = path.join(tmpDir, 'test.txt');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('hashes file content', () => {
    fs.writeFileSync(testFile, 'hello world');
    const hash = fileContentHashSync(testFile);
    assert.strictEqual(hash.length, 16);
  });

  it('returns null for missing file', () => {
    const hash = fileContentHashSync('/nonexistent/file.txt');
    assert.strictEqual(hash, null);
  });

  it('detects content changes', () => {
    fs.writeFileSync(testFile, 'version 1');
    const h1 = fileContentHashSync(testFile);
    fs.writeFileSync(testFile, 'version 2');
    const h2 = fileContentHashSync(testFile);
    assert.notStrictEqual(h1, h2);
  });
});