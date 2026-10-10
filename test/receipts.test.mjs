/**
 * Tests for Usage Receipts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  UsageReceipt,
  ReceiptManager,
  getReceiptManager,
  startReceipt,
  getCurrentReceipt,
  finalizeReceipt,
  listReceipts,
  getReceipt,
  getReceiptStats,
  recordProviderUsage,
  recordLocalUsage,
  recordCacheHit,
  recordOptimization,
  recordContext,
  recordQuality,
  setBaseline,
} from '/mnt/data/Documents/Dev/tokenforge/lib/receipts.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('UsageReceipt', () => {
  let receipt;

  beforeEach(() => {
    receipt = new UsageReceipt('task-123', 'session-abc');
  });

  it('initializes with correct defaults', () => {
    assert.strictEqual(receipt.taskId, 'task-123');
    assert.strictEqual(receipt.sessionId, 'session-abc');
    assert.ok(receipt.startTime > 0);
    assert.strictEqual(receipt.provider.inputTokens, 0);
    assert.strictEqual(receipt.local.cacheHits, 0);
    assert.strictEqual(receipt.optimizations.answerCacheHits, 0);
  });

  it('records provider usage', () => {
    receipt.recordProviderUsage({
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 50,
    }, 'claude-opus-5.5', 0.01);
    
    assert.strictEqual(receipt.provider.inputTokens, 1000);
    assert.strictEqual(receipt.provider.outputTokens, 500);
    assert.strictEqual(receipt.provider.cacheReadTokens, 200);
    assert.strictEqual(receipt.provider.cacheWriteTokens, 50);
    assert.strictEqual(receipt.provider.totalCostUsd, 0.01);
    assert.strictEqual(receipt.provider.model, 'claude-opus-5.5');
    assert.strictEqual(receipt.provider.requests, 1);
  });

  it('accumulates provider usage across calls', () => {
    receipt.recordProviderUsage({ input_tokens: 1000, output_tokens: 500 }, 'model', 0.01);
    receipt.recordProviderUsage({ input_tokens: 500, output_tokens: 200 }, 'model', 0.005);
    
    assert.strictEqual(receipt.provider.inputTokens, 1500);
    assert.strictEqual(receipt.provider.outputTokens, 700);
    assert.strictEqual(receipt.provider.totalCostUsd, 0.015);
    assert.strictEqual(receipt.provider.requests, 2);
  });

  it('records local usage', () => {
    receipt.recordLocalUsage({ cpuMs: 100, memoryMb: 50, toolCalls: 5, fileReads: 3 });
    
    assert.strictEqual(receipt.local.cpuMs, 100);
    assert.strictEqual(receipt.local.peakMemoryMb, 50);
    assert.strictEqual(receipt.local.toolCalls, 5);
    assert.strictEqual(receipt.local.fileReads, 3);
  });

  it('tracks peak memory', () => {
    receipt.recordLocalUsage({ memoryMb: 50 });
    receipt.recordLocalUsage({ memoryMb: 100 });
    receipt.recordLocalUsage({ memoryMb: 75 });
    
    assert.strictEqual(receipt.local.peakMemoryMb, 100);
  });

  it('records cache hits/misses', () => {
    receipt.recordCache(true);
    receipt.recordCache(true);
    receipt.recordCache(false);
    
    assert.strictEqual(receipt.local.cacheHits, 2);
    assert.strictEqual(receipt.local.cacheMisses, 1);
  });

  it('records optimizations', () => {
    receipt.recordOptimization('compression', { file: 'src/a.js' });
    receipt.recordOptimization('deduplication', { block: 'tool_result_1' });
    receipt.recordOptimization('answer_cache');
    receipt.recordOptimization('context_pack', { pack: 'bug-investigation', files: ['src/a.js'] });
    receipt.recordOptimization('vault_retrieve', { vaultId: 'cf_vault_abc' });
    
    assert.strictEqual(receipt.optimizations.astCompressions, 1);
    assert.strictEqual(receipt.optimizations.semanticDedupHits, 1);
    assert.strictEqual(receipt.optimizations.answerCacheHits, 1);
    assert.strictEqual(receipt.optimizations.contextPacksUsed, 1);
    assert.strictEqual(receipt.optimizations.vaultRetrieves, 1);
    assert.strictEqual(receipt.context.compressedFiles.length, 1);
    assert.strictEqual(receipt.context.deduplicatedBlocks.length, 1);
    assert.strictEqual(receipt.context.includedFiles.length, 1);
    assert.strictEqual(receipt.context.retrievedVaults.length, 1);
  });

  it('records context', () => {
    receipt.recordContext({
      included: ['src/a.js', 'src/b.js'],
      omitted: ['src/c.js'],
      compressed: ['src/large.js'],
      deduplicated: ['tool_result_1'],
    });
    
    assert.strictEqual(receipt.context.includedFiles.length, 2);
    assert.strictEqual(receipt.context.omittedFiles.length, 1);
    assert.strictEqual(receipt.context.compressedFiles.length, 1);
    assert.strictEqual(receipt.context.deduplicatedBlocks.length, 1);
  });

  it('records quality', () => {
    receipt.recordQuality({
      testsPassed: true,
      buildPassed: true,
      lintPassed: false,
      hiddenTestsPassed: 8,
      hiddenTestsTotal: 10,
      qualityScore: 95,
    });
    
    assert.strictEqual(receipt.quality.testsPassed, true);
    assert.strictEqual(receipt.quality.buildPassed, true);
    assert.strictEqual(receipt.quality.lintPassed, false);
    assert.strictEqual(receipt.quality.hiddenTestsPassed, 8);
    assert.strictEqual(receipt.quality.hiddenTestsTotal, 10);
    assert.strictEqual(receipt.quality.qualityScore, 95);
  });

  it('sets baseline', () => {
    receipt.setBaseline(100000, 0.50, 'estimate');
    
    assert.strictEqual(receipt.baseline.estimatedTokensWithoutTF, 100000);
    assert.strictEqual(receipt.baseline.estimatedCostWithoutTF, 0.50);
    assert.strictEqual(receipt.baseline.source, 'estimate');
  });

  it('computes savings', () => {
    receipt.recordProviderUsage({ 
      input_tokens: 5000, 
      output_tokens: 1000,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 100,
    }, 'model', 0.10);
    receipt.setBaseline(20000, 0.40, 'estimate');
    
    const savings = receipt.computeSavings();
    
    assert.ok(savings.inputEquivalent > 0);
    assert.ok(savings.savings);
    assert.ok(savings.savings.tokens > 0);
    assert.ok(savings.savings.percent > 0);
  });

  it('generates JSON', () => {
    receipt.recordProviderUsage({ input_tokens: 1000, output_tokens: 500 }, 'model', 0.01);
    receipt.finalize({ leanLevel: 'balanced', terseMode: 'full' });
    
    const json = receipt.toJSON();
    
    assert.strictEqual(json.version, 1);
    assert.strictEqual(json.taskId, 'task-123');
    assert.ok(json.provider.inputTokens > 0);
    assert.ok(json.optimizations.leanLevel === 'balanced');
  });

  it('generates summary', () => {
    receipt.recordProviderUsage({ input_tokens: 1000, output_tokens: 500 }, 'model', 0.01);
    receipt.finalize({ leanLevel: 'balanced' });
    
    const summary = receipt.toSummary();
    
    assert.ok(summary.includes('Token Forge Receipt'));
    assert.ok(summary.includes('task-123'));
    assert.ok(summary.includes('Provider Usage'));
    assert.ok(summary.includes('Optimizations Applied'));
  });
});

describe('ReceiptManager', () => {
  let tmpDir;
  let testProject;
  let manager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-test-'));
    testProject = path.join(tmpDir, 'project');
    fs.mkdirSync(testProject, { recursive: true });
    manager = new ReceiptManager(testProject);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts and finalizes receipt', async () => {
    const receipt = manager.startReceipt('task-1', 'session-1');
    receipt.recordProviderUsage({ input_tokens: 1000, output_tokens: 500 }, 'model', 0.01);
    
    const result = await manager.finalizeReceipt({ leanLevel: 'balanced' });
    
    assert.ok(result.receipt);
    assert.ok(result.filePath);
    assert.ok(result.summaryPath);
    
    // Verify files exist
    assert.ok(fs.existsSync(result.filePath));
    assert.ok(fs.existsSync(result.summaryPath));
  });

  it('lists receipts', async () => {
    manager.startReceipt('task-1', 'session-1');
    await manager.finalizeReceipt();
    
    manager.startReceipt('task-2', 'session-2');
    await manager.finalizeReceipt();
    
    const receipts = await manager.listReceipts();
    
    assert.strictEqual(receipts.length, 2);
    assert.strictEqual(receipts[0].taskId, 'task-2'); // Newest first
    assert.strictEqual(receipts[1].taskId, 'task-1');
  });

  it('gets receipt by file', async () => {
    manager.startReceipt('task-1', 'session-1');
    const result = await manager.finalizeReceipt();
    
    const receipt = await manager.getReceipt(path.basename(result.filePath));
    
    assert.ok(receipt);
    assert.strictEqual(receipt.taskId, 'task-1');
  });

  it('computes aggregate stats', async () => {
    for (let i = 0; i < 3; i++) {
      const r = manager.startReceipt(`task-${i}`, `session-${i}`);
      r.recordProviderUsage({ input_tokens: 1000, output_tokens: 500 }, 'model', 0.01);
      r.setBaseline(5000, 0.05, 'estimate');
      r.recordQuality({ qualityScore: 90 + i });
      await manager.finalizeReceipt();
    }
    
    const stats = await manager.getAggregateStats();
    
    assert.strictEqual(stats.totalReceipts, 3);
    assert.ok(stats.avgSavingsTokens > 0);
    assert.ok(stats.avgSavingsPercent > 0);
    assert.ok(stats.avgQualityScore > 0);
  });
});

describe('Global Receipt Functions', () => {
  let tmpDir;
  let testProject;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipt-global-'));
    testProject = path.join(tmpDir, 'project');
    fs.mkdirSync(testProject, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts and gets current receipt', () => {
    startReceipt(testProject, 'task-1', 'session-1');
    const receipt = getCurrentReceipt(testProject);
    
    assert.ok(receipt);
    assert.strictEqual(receipt.taskId, 'task-1');
  });

  it('records provider usage globally', () => {
    startReceipt(testProject, 'task-1', 'session-1');
    recordProviderUsage(testProject, { input_tokens: 1000, output_tokens: 500 }, 'model', 0.01);
    
    const receipt = getCurrentReceipt(testProject);
    assert.strictEqual(receipt.provider.inputTokens, 1000);
  });

  it('records local usage globally', () => {
    startReceipt(testProject, 'task-1', 'session-1');
    recordLocalUsage(testProject, { cpuMs: 100, memoryMb: 50 });
    
    const receipt = getCurrentReceipt(testProject);
    assert.strictEqual(receipt.local.cpuMs, 100);
  });

  it('records cache hits globally', () => {
    startReceipt(testProject, 'task-1', 'session-1');
    recordCacheHit(testProject, true);
    recordCacheHit(testProject, false);
    
    const receipt = getCurrentReceipt(testProject);
    assert.strictEqual(receipt.local.cacheHits, 1);
    assert.strictEqual(receipt.local.cacheMisses, 1);
  });

  it('records optimizations globally', () => {
    startReceipt(testProject, 'task-1', 'session-1');
    recordOptimization(testProject, 'compression', { file: 'src/a.js' });
    
    const receipt = getCurrentReceipt(testProject);
    assert.strictEqual(receipt.optimizations.astCompressions, 1);
  });

  it('records context globally', () => {
    startReceipt(testProject, 'task-1', 'session-1');
    recordContext(testProject, { included: ['src/a.js'] });
    
    const receipt = getCurrentReceipt(testProject);
    assert.strictEqual(receipt.context.includedFiles.length, 1);
  });

  it('records quality globally', () => {
    startReceipt(testProject, 'task-1', 'session-1');
    recordQuality(testProject, { testsPassed: true, qualityScore: 95 });
    
    const receipt = getCurrentReceipt(testProject);
    assert.strictEqual(receipt.quality.testsPassed, true);
    assert.strictEqual(receipt.quality.qualityScore, 95);
  });

  it('sets baseline globally', () => {
    startReceipt(testProject, 'task-1', 'session-1');
    setBaseline(testProject, 10000, 0.05, 'paired_run');
    
    const receipt = getCurrentReceipt(testProject);
    assert.strictEqual(receipt.baseline.estimatedTokensWithoutTF, 10000);
    assert.strictEqual(receipt.baseline.source, 'paired_run');
  });

  it('finalizes receipt globally', async () => {
    startReceipt(testProject, 'task-1', 'session-1');
    recordProviderUsage(testProject, { input_tokens: 1000, output_tokens: 500 }, 'model', 0.01);
    
    const result = await finalizeReceipt(testProject, { leanLevel: 'balanced' });
    
    assert.ok(result.receipt);
    assert.ok(result.filePath);
    
    // Should be cleared after finalize
    const receipt = getCurrentReceipt(testProject);
    assert.strictEqual(receipt, null);
  });
});