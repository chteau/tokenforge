/**
 * Tests for Semantic Deduplication
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  fnv1a64,
  normalizeForFingerprint,
  computeSimHash,
  hammingDistance,
  buildDedupKey,
  looksLikeStub,
  isRecentToolResult,
  applySemanticDedup,
  invalidateDedupRegistry,
  sessionDedupRegistry,
} from '../lib/semantic-dedup.mjs';

describe('fnv1a64', () => {
  it('produces consistent 64-bit hashes', () => {
    const h1 = fnv1a64('test content');
    const h2 = fnv1a64('test content');
    assert.strictEqual(h1, h2);
    assert.strictEqual(h1.length, 17); // 8 + 1 + 8
  });

  it('has two independent lanes', () => {
    // Strings differing only at odd positions should have different h2
    const h1 = fnv1a64('ababab');
    const h2 = fnv1a64('acacac');
    const [h1a, h1b] = h1.split('_');
    const [h2a, h2b] = h2.split('_');
    // Both lanes should differ
    assert.notStrictEqual(h1a, h2a);
    assert.notStrictEqual(h1b, h2b);
  });

  it('processes all characters in both lanes', () => {
    // If lane 2 skipped odd chars, these would be equal
    const h1 = fnv1a64('a');
    const h2 = fnv1a64('aa');
    const [, h1b] = h1.split('_');
    const [, h2b] = h2.split('_');
    assert.notStrictEqual(h1b, h2b);
  });
});

describe('normalizeForFingerprint', () => {
  it('normalizes vault IDs', () => {
    // Input has: cf_vault_ pattern, compressed file wrapper with vault_id, AND standalone vault_id
    const input = 'code with cf_vault_abc123 and [CF_COMPRESSED_FILE vault_id:"xyz789"] and vault_id:"abc123"';
    const normalized = normalizeForFingerprint(input);
    assert.ok(normalized.includes('VAULT_ID'));
    assert.ok(normalized.includes('[CF_COMPRESSED]'));
    assert.ok(normalized.includes('vault_id="STABLE"'));
  });

  it('normalizes timestamps', () => {
    const input = 'error at 2026-10-10T12:34:56.789Z and at 14:30:00';
    const normalized = normalizeForFingerprint(input);
    assert.ok(normalized.includes('TIMESTAMP'));
    assert.ok(!normalized.includes('2026-10-10'));
  });

  it('normalizes call IDs', () => {
    const input = 'call_cf_123_456';
    const normalized = normalizeForFingerprint(input);
    assert.strictEqual(normalized, 'CALL_ID');
  });

  it('normalizes index UUIDs', () => {
    // Proper UUID: 8-4-4-4-12 format (36 chars after IDX_)
    const input = 'IDX_abcdef12-3456-7890-abcd-ef1234567890';
    const normalized = normalizeForFingerprint(input);
    assert.strictEqual(normalized, 'IDX_ID');
  });

  it('normalizes size fields', () => {
    const input = '"size": 12345';
    const normalized = normalizeForFingerprint(input);
    assert.strictEqual(normalized, '"size": SIZE');
  });
});

describe('SimHash', () => {
  it('computes fingerprint', () => {
    const fp = computeSimHash('function foo() { return 1; }');
    assert.strictEqual(fp.length, 16); // 64 bits = 16 hex chars
  });

  it('produces same fingerprint for same content', () => {
    const fp1 = computeSimHash('function foo() { return 1; }');
    const fp2 = computeSimHash('function foo() { return 1; }');
    assert.strictEqual(fp1, fp2);
  });

  it('computes hamming distance', () => {
    const fp1 = computeSimHash('function foo() { return 1; }');
    const fp2 = computeSimHash('function foo() { return 2; }');
    const dist = hammingDistance(fp1, fp2);
    assert.ok(dist >= 0 && dist <= 64);
  });

  it('distance 0 for identical', () => {
    const fp = computeSimHash('same content');
    const dist = hammingDistance(fp, fp);
    assert.strictEqual(dist, 0);
  });
});

describe('buildDedupKey', () => {
  it('uses filename when available', () => {
    const msg = { _filename: 'src/utils/helper.js', content: 'code' };
    const key = buildDedupKey(msg);
    assert.strictEqual(key, 'file:utils/helper.js');
  });

  it('normalizes file paths', () => {
    const msg = { _filename: 'src\\utils\\helper.js', content: 'code' };
    const key = buildDedupKey(msg);
    assert.strictEqual(key, 'file:utils/helper.js');
  });

  it('uses content prefix for code without filename', () => {
    const msg = { _cf_type: 'code', content: 'function foo() { return 1; }'.repeat(10) };
    const key = buildDedupKey(msg);
    assert.ok(key.startsWith('code:'));
  });

  it('returns null for non-dedupable types', () => {
    const msg = { _cf_type: 'binary', content: 'data' };
    const key = buildDedupKey(msg);
    assert.strictEqual(key, null);
  });
});

describe('looksLikeStub', () => {
  it('detects vault stubs', () => {
    assert.ok(looksLikeStub('[CF_VAULT:cf_vault_abc123] content'));
    assert.ok(looksLikeStub('[CF_COMPRESSED_FILE vault_id:"xyz"]'));
    assert.ok(looksLikeStub('vault_id="abc123"'));
  });

  it('returns false for regular content', () => {
    assert.ok(!looksLikeStub('function foo() { return 1; }'));
    assert.ok(!looksLikeStub('regular text content'));
  });
});

describe('isRecentToolResult', () => {
  it('returns true for recent assistant turns', () => {
    const messages = [
      { role: 'tool', content: 'result' },
      { role: 'assistant', content: 'reply' },
      { role: 'assistant', content: 'reply' },
    ];
    // Tool result at index 0, 2 assistant turns after
    assert.ok(isRecentToolResult(messages, 0, { recentTurnExemption: 2 }));
    assert.ok(!isRecentToolResult(messages, 0, { recentTurnExemption: 1 }));
  });

  it('handles no policy', () => {
    const messages = [
      { role: 'tool', content: 'result' },
      { role: 'assistant', content: 'reply' },
      { role: 'assistant', content: 'reply' },
      { role: 'assistant', content: 'reply' },
    ];
    // Default is 2 turns, 3 turns since = not recent
    assert.ok(!isRecentToolResult(messages, 0));
    // With exemption 3, 3 turns since = recent
    assert.ok(isRecentToolResult(messages, 0, { recentTurnExemption: 3 }));
  });
});

describe('applySemanticDedup', () => {
  beforeEach(() => {
    sessionDedupRegistry.clear();
  });

  it('deduplicates exact matches keeping newest', async () => {
    // Use content longer than MIN_EXACT_DEDUP_CHARS (100)
    const longContent = 'same content '.repeat(10); // 120 chars
    const payload = {
      messages: [
        { role: 'tool', content: longContent, _cf_type: 'code', _filename: 'a.js' },
        { role: 'assistant', content: 'reply' },
        { role: 'assistant', content: 'reply' },
        { role: 'assistant', content: 'reply' },
        { role: 'tool', content: longContent, _cf_type: 'code', _filename: 'a.js' },
      ],
    };
    
    const result = await applySemanticDedup(payload);
    
    // First (oldest) should be stubbed, last (newest) kept
    assert.ok(result.messages[0].content.includes('CF_VAULT'));
    assert.strictEqual(result.messages[4].content, longContent);
  });

  it('does not deduplicate recent results', async () => {
    const payload = {
      messages: [
        { role: 'tool', content: 'same content '.repeat(10), _cf_type: 'code', _filename: 'a.js' },
        { role: 'assistant', content: 'reply' }, // Only 1 assistant turn after
      ],
    };
    
    const result = await applySemanticDedup(payload);
    
    // Should not dedup because only 1 assistant turn since (default exemption is 2, 1 <= 2 = recent)
    assert.strictEqual(result.messages[0].content, 'same content '.repeat(10));
  });

  it('does not deduplicate toward stubs', async () => {
    const longContent = 'original content '.repeat(10);
    const payload = {
      messages: [
        { role: 'tool', content: longContent, _cf_type: 'code', _filename: 'a.js' },
        { role: 'assistant', content: 'reply' },
        { role: 'assistant', content: 'reply' },
        { role: 'tool', content: '[CF_VAULT:cf_vault_abc] stubbed', _cf_type: 'code', _filename: 'a.js' },
      ],
    };
    
    const result = await applySemanticDedup(payload);
    
    // Newest is a stub, so nothing should dedup against it
    assert.strictEqual(result.messages[0].content, longContent);
    assert.strictEqual(result.messages[3].content, '[CF_VAULT:cf_vault_abc] stubbed');
  });

  it('skips non-dedupable types', async () => {
    const payload = {
      messages: [
        { role: 'tool', content: 'binary data', _cf_type: 'binary' },
      ],
    };
    
    const result = await applySemanticDedup(payload);
    assert.strictEqual(result.messages[0].content, 'binary data');
  });
});

describe('invalidateDedupRegistry', () => {
  beforeEach(() => {
    sessionDedupRegistry.clear();
  });

  it('invalidates by file path', () => {
    sessionDedupRegistry.set('file:src/utils/helper.js', { contentHash: 'abc' });
    sessionDedupRegistry.set('file:src/other.js', { contentHash: 'def' });
    
    invalidateDedupRegistry('src/utils/helper.js');
    
    assert.strictEqual(sessionDedupRegistry.get('file:src/utils/helper.js'), null);
    assert.ok(sessionDedupRegistry.get('file:src/other.js'));
  });

  it('falls back to basename match', () => {
    sessionDedupRegistry.set('file:src/utils/helper.js', { contentHash: 'abc' });
    
    invalidateDedupRegistry('other/path/helper.js');
    
    assert.strictEqual(sessionDedupRegistry.get('file:src/utils/helper.js'), null);
  });
});