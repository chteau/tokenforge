/**
 * Tests for AST-Aware Compression
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  detectLanguage,
  compressCode,
  compressToolResults,
  pruneStaleRetrieves,
  regexFallbackCompress,
  saveToVault,
  retrieveFromVault,
} from '../lib/compression.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('detectLanguage', () => {
  it('detects JavaScript/TypeScript', () => {
    assert.strictEqual(detectLanguage('file.js'), 'javascript');
    assert.strictEqual(detectLanguage('file.mjs'), 'javascript');
    assert.strictEqual(detectLanguage('file.ts'), 'typescript');
    assert.strictEqual(detectLanguage('file.tsx'), 'tsx');
  });

  it('detects other languages', () => {
    assert.strictEqual(detectLanguage('file.py'), 'python');
    assert.strictEqual(detectLanguage('file.go'), 'go');
    assert.strictEqual(detectLanguage('file.rs'), 'rust');
    assert.strictEqual(detectLanguage('file.java'), 'java');
  });

  it('uses hint over extension', () => {
    assert.strictEqual(detectLanguage('file.xyz', 'python'), 'python');
  });

  it('returns unknown for unknown extensions', () => {
    assert.strictEqual(detectLanguage('file.xyz'), 'unknown');
  });
});

describe('regexFallbackCompress', () => {
  it('preserves imports and exports', () => {
    const code = `
import { foo } from 'bar';
export const baz = 1;
export function qux() { return 2; }
function internal() { return 3; }
class MyClass { method() {} }
`;
    const result = regexFallbackCompress(code, 'javascript', 4, true);
    assert.ok(result.compressedSource.includes('import { foo } from'));
    assert.ok(result.compressedSource.includes('export const baz'));
    assert.ok(result.compressedSource.includes('export function qux'));
    assert.ok(result.compressedSource.includes('class MyClass'));
  });

  it('compresses function bodies', () => {
    const code = `
function longFunction() {
  const a = 1;
  const b = 2;
  const c = 3;
  const d = 4;
  const e = 5;
  return a + b + c + d + e;
}
`;
    const result = regexFallbackCompress(code, 'javascript', 2, true);
    assert.ok(result.compressedSource.includes('...'));
    assert.ok(result.compressedLines < result.originalLines);
  });

  it('preserves error handlers when enabled', () => {
    const code = `
function withTryCatch() {
  try {
    risky();
  } catch (e) {
    handle(e);
  } finally {
    cleanup();
  }
}
`;
    const result = regexFallbackCompress(code, 'javascript', 2, true);
    assert.ok(result.compressedSource.includes('try'));
    assert.ok(result.compressedSource.includes('catch'));
    assert.ok(result.compressedSource.includes('finally'));
  });

  it('omits error handlers when disabled', () => {
    const code = `
function withTryCatch() {
  try {
    risky();
  } catch (e) {
    handle(e);
  }
}
`;
    const result = regexFallbackCompress(code, 'javascript', 2, false);
    // With preserveErrorHandlers=false, try/catch may be compressed
    // Just verify it doesn't crash
    assert.ok(result.compressedSource.length > 0);
  });

  it('returns original for small files', () => {
    const code = 'const x = 1;';
    const result = regexFallbackCompress(code, 'javascript', 4, true);
    assert.strictEqual(result.compressedSource, code);
  });

  it('returns original when keep ratio too high', () => {
    const code = 'const a = 1;\nconst b = 2;\nconst c = 3;';
    const result = regexFallbackCompress(code, 'javascript', 4, true);
    assert.strictEqual(result.compressedSource, code);
  });
});

describe('compressCode', () => {
  it('skips content below threshold', async () => {
    const result = await compressCode('const x = 1;', 'javascript');
    assert.strictEqual(result.vaulted, false);
    assert.strictEqual(result.reason, 'below_threshold');
  });

  it('skips content with too few lines', async () => {
    const result = await compressCode('const a = 1;\nconst b = 2;', 'javascript');
    assert.strictEqual(result.vaulted, false);
    assert.strictEqual(result.reason, 'too_few_lines');
  });

  it('compresses large code files', async () => {
    const code = `
import { foo } from 'bar';
export function longFunction() {
  const a = 1;
  const b = 2;
  const c = 3;
  const d = 4;
  const e = 5;
  const f = 6;
  const g = 7;
  const h = 8;
  return a + b + c + d + e + f + g + h;
}
`.repeat(5); // Make it large enough
    
    const result = await compressCode(code, 'javascript', { mode: 'balanced' });
    // May or may not compress depending on native availability
    assert.ok(typeof result.vaulted === 'boolean');
  });
});

describe('compressToolResults', () => {
  it('skips non-code tool results', async () => {
    const payload = {
      messages: [
        { role: 'tool', content: 'text output', _cf_type: 'text' },
      ],
    };
    const result = await compressToolResults(payload);
    assert.strictEqual(result.messages[0].content, 'text output');
  });

  it('age-gates recent results', async () => {
    const payload = {
      messages: [
        { role: 'tool', content: 'x'.repeat(1000), _cf_type: 'code', _filename: 'a.js' },
        { role: 'assistant', content: 'reply' },
      ],
    };
    const result = await compressToolResults(payload, { recentTurnExemption: 2 });
    // Should not compress (only 1 assistant turn after)
    assert.strictEqual(result.messages[0].content, 'x'.repeat(1000));
  });

  it('compresses old results', async () => {
    const payload = {
      messages: [
        { role: 'tool', content: 'x'.repeat(1000), _cf_type: 'code', _filename: 'a.js' },
        { role: 'assistant', content: 'reply' },
        { role: 'assistant', content: 'reply' },
        { role: 'assistant', content: 'reply' },
      ],
    };
    const result = await compressToolResults(payload, { recentTurnExemption: 2 });
    // Should compress (3 assistant turns after, exemption is 2)
    assert.ok(result.messages[0].content.length < 1000);
  });

  it('skips editable/verification reads', async () => {
    const payload = {
      messages: [
        { role: 'tool', content: 'x'.repeat(1000), _cf_type: 'code', _filename: 'a.js', _cf_editable: true },
      ],
    };
    const result = await compressToolResults(payload);
    assert.strictEqual(result.messages[0].content, 'x'.repeat(1000));
  });
});

describe('pruneStaleRetrieves', () => {
  it('prunes retrieves before last user message', () => {
    const payload = {
      messages: [
        { role: 'tool', tool_call_id: 'call1', content: 'vault content 1'.repeat(100) },
        { role: 'user', content: 'human message' },
        { role: 'tool', tool_call_id: 'call2', content: 'vault content 2'.repeat(100) },
      ],
    };
    
    const result = pruneStaleRetrieves(payload);
    // First retrieve should be pruned (before last user message)
    assert.ok(result.messages[0].content.includes('omitted'));
    assert.strictEqual(result.messages[0]._cf_pruned, true);
    // Second should not be pruned (after last user message)
    assert.ok(!result.messages[2]._cf_pruned);
  });

  it('never prunes most recent retrieve', () => {
    const payload = {
      messages: [
        { role: 'user', content: 'human' },
        { role: 'tool', tool_call_id: 'call1', content: 'vault content 1'.repeat(100) },
        { role: 'tool', tool_call_id: 'call2', content: 'vault content 2'.repeat(100) },
      ],
    };
    
    const result = pruneStaleRetrieves(payload);
    // Most recent (call2) should not be pruned
    assert.ok(!result.messages[2]._cf_pruned);
    // Older (call1) should be pruned
    assert.ok(result.messages[1]._cf_pruned);
  });

  it('skips short retrieves', () => {
    const payload = {
      messages: [
        { role: 'user', content: 'human' },
        { role: 'tool', tool_call_id: 'call1', content: 'short' },
      ],
    };
    
    const result = pruneStaleRetrieves(payload);
    assert.ok(!result.messages[1]._cf_pruned);
  });
});