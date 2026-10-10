/**
 * Usage Receipts & Observability
 * 
 * Provides per-task receipts showing what Token Forge saved, what it cost locally,
 * and whether the result was equivalent in quality. Distinguishes measured data
 * from estimates.
 */

import fs from 'node:fs';
import path from 'node:path';
import { projectRoot } from './util.mjs';

const RECEIPT_DIR = '.forge/receipts';
const RECEIPT_VERSION = 1;

export class UsageReceipt {
  constructor(taskId, sessionId) {
    this.taskId = taskId;
    this.sessionId = sessionId;
    this.startTime = Date.now();
    this.endTime = null;
    
    // Measured provider data (from API responses)
    this.provider = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalCostUsd: 0,
      model: null,
      requests: 0,
    };
    
    // Local measurements
    this.local = {
      cpuMs: 0,
      peakMemoryMb: 0,
      toolCalls: 0,
      fileReads: 0,
      cacheHits: 0,
      cacheMisses: 0,
      compressions: 0,
      deduplications: 0,
      vaultRetrieves: 0,
    };
    
    // Token Forge optimizations applied
    this.optimizations = {
      leanLevel: null,
      terseMode: null,
      answerCacheHits: 0,
      semanticDedupHits: 0,
      astCompressions: 0,
      contextPacksUsed: 0,
      vectorMemoryHits: 0,
      promptRouterPreloads: 0,
      bashRewrites: 0,
    };
    
    // Context tracking
    this.context = {
      includedFiles: [],
      omittedFiles: [],
      compressedFiles: [],
      deduplicatedBlocks: [],
      retrievedVaults: [],
    };
    
    // Quality indicators
    this.quality = {
      testsPassed: false,
      buildPassed: false,
      lintPassed: false,
      hiddenTestsPassed: 0,
      hiddenTestsTotal: 0,
      qualityScore: null,
    };
    
    // Baseline comparison (if available)
    this.baseline = {
      estimatedTokensWithoutTF: 0,
      estimatedCostWithoutTF: 0,
      source: 'estimate', // 'estimate' | 'paired_run' | 'historical'
    };
  }

  /**
   * Record provider usage from API response
   */
  recordProviderUsage(usage, model, costUsd = 0) {
    this.provider.inputTokens += usage.input_tokens || 0;
    this.provider.outputTokens += usage.output_tokens || 0;
    this.provider.cacheReadTokens += usage.cache_read_input_tokens || 0;
    this.provider.cacheWriteTokens += usage.cache_creation_input_tokens || 0;
    this.provider.totalCostUsd += costUsd;
    this.provider.requests++;
    if (model) this.provider.model = model;
  }

  /**
   * Record local resource usage
   */
  recordLocalUsage({ cpuMs, memoryMb, toolCalls, fileReads }) {
    this.local.cpuMs += cpuMs || 0;
    this.local.peakMemoryMb = Math.max(this.local.peakMemoryMb, memoryMb || 0);
    this.local.toolCalls += toolCalls || 0;
    this.local.fileReads += fileReads || 0;
  }

  /**
   * Record cache hit/miss
   */
  recordCache(hit) {
    if (hit) this.local.cacheHits++; else this.local.cacheMisses++;
  }

  /**
   * Record optimization event
   */
  recordOptimization(type, metadata = {}) {
    switch (type) {
      case 'compression':
        this.local.compressions++;
        this.optimizations.astCompressions++;
        if (metadata.file) this.context.compressedFiles.push(metadata.file);
        break;
      case 'deduplication':
        this.local.deduplications++;
        this.optimizations.semanticDedupHits++;
        if (metadata.block) this.context.deduplicatedBlocks.push(metadata.block);
        break;
      case 'answer_cache':
        this.optimizations.answerCacheHits++;
        break;
      case 'context_pack':
        this.optimizations.contextPacksUsed++;
        if (metadata.pack) this.context.includedFiles.push(...(metadata.files || []));
        break;
      case 'vector_memory':
        this.optimizations.vectorMemoryHits++;
        break;
      case 'prompt_router':
        this.optimizations.promptRouterPreloads++;
        break;
      case 'bash_rewrite':
        this.optimizations.bashRewrites++;
        break;
      case 'vault_retrieve':
        this.local.vaultRetrieves++;
        if (metadata.vaultId) this.context.retrievedVaults.push(metadata.vaultId);
        break;
    }
  }

  /**
   * Record context inclusion/omission
   */
  recordContext({ included, omitted, compressed, deduplicated }) {
    if (included) this.context.includedFiles.push(...included);
    if (omitted) this.context.omittedFiles.push(...omitted);
    if (compressed) this.context.compressedFiles.push(...compressed);
    if (deduplicated) this.context.deduplicatedBlocks.push(...deduplicated);
  }

  /**
   * Record quality results
   */
  recordQuality({ testsPassed, buildPassed, lintPassed, hiddenTestsPassed, hiddenTestsTotal, qualityScore }) {
    this.quality.testsPassed = testsPassed ?? this.quality.testsPassed;
    this.quality.buildPassed = buildPassed ?? this.quality.buildPassed;
    this.quality.lintPassed = lintPassed ?? this.quality.lintPassed;
    if (hiddenTestsPassed !== undefined) this.quality.hiddenTestsPassed = hiddenTestsPassed;
    if (hiddenTestsTotal !== undefined) this.quality.hiddenTestsTotal = hiddenTestsTotal;
    if (qualityScore !== undefined) this.quality.qualityScore = qualityScore;
  }

  /**
   * Set baseline comparison data
   */
  setBaseline(estimatedTokens, estimatedCost, source = 'estimate') {
    this.baseline.estimatedTokensWithoutTF = estimatedTokens;
    this.baseline.estimatedCostWithoutTF = estimatedCost;
    this.baseline.source = source;
  }

  /**
   * Finalize receipt
   */
  finalize(config = {}) {
    this.endTime = Date.now();
    this.config = {
      leanLevel: config.leanLevel,
      terseMode: config.terseMode,
      model: config.model,
    };
    this.optimizations.leanLevel = config.leanLevel;
    this.optimizations.terseMode = config.terseMode;
  }

  /**
   * Compute savings estimates
   */
  computeSavings() {
    const totalProviderTokens = this.provider.inputTokens + this.provider.outputTokens;
    const cachedRatio = this.provider.inputTokens > 0 
      ? this.provider.cacheReadTokens / this.provider.inputTokens 
      : 0;
    
    // Input-equivalent tokens (cache reads count as 0.1x, writes as 1.25x, output as 5x)
    const inputEquivalent = 
      (this.provider.inputTokens - this.provider.cacheReadTokens) +
      1.25 * this.provider.cacheWriteTokens +
      0.1 * this.provider.cacheReadTokens +
      5 * this.provider.outputTokens;
    
    let savings = null;
    if (this.baseline.estimatedTokensWithoutTF > 0) {
      const tokenSavings = this.baseline.estimatedTokensWithoutTF - inputEquivalent;
      const pct = this.baseline.estimatedTokensWithoutTF > 0 
        ? (tokenSavings / this.baseline.estimatedTokensWithoutTF * 100).toFixed(1)
        : 0;
      savings = {
        tokens: tokenSavings,
        percent: parseFloat(pct),
        costUsd: this.baseline.estimatedCostWithoutTF - this.provider.totalCostUsd,
        costPercent: this.baseline.estimatedCostWithoutTF > 0
          ? ((this.baseline.estimatedCostWithoutTF - this.provider.totalCostUsd) / this.baseline.estimatedCostWithoutTF * 100).toFixed(1)
          : 0,
      };
    }
    
    return {
      totalProviderTokens,
      inputEquivalent: Math.round(inputEquivalent),
      cachedRatio: (cachedRatio * 100).toFixed(1) + '%',
      savings,
      localOverhead: {
        cpuMs: this.local.cpuMs,
        peakMemoryMb: this.local.peakMemoryMb,
      },
    };
  }

  /**
   * Export as JSON
   */
  toJSON() {
    const savings = this.computeSavings();
    return {
      version: RECEIPT_VERSION,
      taskId: this.taskId,
      sessionId: this.sessionId,
      timestamp: new Date(this.startTime).toISOString(),
      durationMs: this.endTime ? this.endTime - this.startTime : null,
      provider: this.provider,
      local: this.local,
      optimizations: this.optimizations,
      context: this.context,
      quality: this.quality,
      baseline: this.baseline,
      savings,
      config: this.config,
    };
  }

  /**
   * Generate human-readable summary
   */
  toSummary() {
    const savings = this.computeSavings();
    const lines = [
      `═══ Token Forge Receipt ═══`,
      `Task: ${this.taskId}`,
      `Session: ${this.sessionId?.slice(0, 8)}`,
      `Duration: ${this.endTime ? ((this.endTime - this.startTime) / 1000).toFixed(1) + 's' : 'running'}`,
      ``,
      `📊 Provider Usage:`,
      `  Input: ${this.provider.inputTokens.toLocaleString()} (${this.provider.cacheReadTokens.toLocaleString()} cached)`,
      `  Output: ${this.provider.outputTokens.toLocaleString()}`,
      `  Cost: $${this.provider.totalCostUsd.toFixed(4)}`,
      `  Model: ${this.provider.model || 'unknown'}`,
      `  Requests: ${this.provider.requests}`,
      ``,
      `⚡ Local Overhead:`,
      `  CPU: ${this.local.cpuMs}ms`,
      `  Peak Memory: ${this.local.peakMemoryMb}MB`,
      `  Tool Calls: ${this.local.toolCalls}`,
      `  File Reads: ${this.local.fileReads}`,
      `  Cache Hit Rate: ${this.local.cacheHits + this.local.cacheMisses > 0 ? (this.local.cacheHits / (this.local.cacheHits + this.local.cacheMisses) * 100).toFixed(1) + '%' : 'N/A'}`,
      ``,
      `🔧 Optimizations Applied:`,
      `  Lean Level: ${this.optimizations.leanLevel || 'N/A'}`,
      `  Terse Mode: ${this.optimizations.terseMode || 'N/A'}`,
      `  Answer Cache Hits: ${this.optimizations.answerCacheHits}`,
      `  Semantic Dedup: ${this.optimizations.semanticDedupHits}`,
      `  AST Compressions: ${this.optimizations.astCompressions}`,
      `  Context Packs: ${this.optimizations.contextPacksUsed}`,
      `  Vector Memory: ${this.optimizations.vectorMemoryHits}`,
      `  Prompt Router: ${this.optimizations.promptRouterPreloads}`,
      `  Bash Rewrites: ${this.optimizations.bashRewrites}`,
      `  Vault Retrieves: ${this.optimizations.vaultRetrieves}`,
      ``,
      `📝 Context:`,
      `  Files Included: ${this.context.includedFiles.length}`,
      `  Files Omitted: ${this.context.omittedFiles.length}`,
      `  Files Compressed: ${this.context.compressedFiles.length}`,
      `  Blocks Deduped: ${this.context.deduplicatedBlocks.length}`,
      `  Vault Retrieves: ${this.context.retrievedVaults.length}`,
      ``,
      `✅ Quality:`,
      `  Tests: ${this.quality.testsPassed ? 'PASS' : 'FAIL'}`,
      `  Build: ${this.quality.buildPassed ? 'PASS' : 'FAIL'}`,
      `  Lint: ${this.quality.lintPassed ? 'PASS' : 'FAIL'}`,
      `  Hidden Tests: ${this.quality.hiddenTestsPassed}/${this.quality.hiddenTestsTotal}`,
      `  Score: ${this.quality.qualityScore !== null ? this.quality.qualityScore : 'N/A'}`,
    ];
    
    if (savings.savings) {
      lines.push(``, `💰 Estimated Savings (vs ${this.baseline.source}):`);
      lines.push(`  Tokens: ${savings.savings.tokens.toLocaleString()} (${savings.savings.percent}%)`);
      lines.push(`  Cost: $${savings.savings.costUsd.toFixed(4)} (${savings.savings.costPercent}%)`);
    }
    
    lines.push(`═══════════════════════════`);
    return lines.join('\n');
  }
}

/**
 * Receipt Manager - handles persistence and retrieval
 */
export class ReceiptManager {
  constructor(cwd) {
    this.root = projectRoot(cwd);
    this.receiptDir = path.join(this.root, RECEIPT_DIR);
    this.currentReceipt = null;
  }

  /**
   * Start a new receipt for a task
   */
  startReceipt(taskId, sessionId) {
    this.currentReceipt = new UsageReceipt(taskId, sessionId);
    return this.currentReceipt;
  }

  /**
   * Get current receipt
   */
  getReceipt() {
    return this.currentReceipt;
  }

  /**
   * Finalize and save receipt
   */
  async finalizeReceipt(config = {}) {
    if (!this.currentReceipt) return null;
    
    this.currentReceipt.finalize(config);
    const receipt = this.currentReceipt.toJSON();
    
    await fs.promises.mkdir(this.receiptDir, { recursive: true });
    const fileName = `${this.currentReceipt.taskId}_${Date.now()}.json`;
    const filePath = path.join(this.receiptDir, fileName);
    
    await fs.promises.writeFile(filePath, JSON.stringify(receipt, null, 2));
    
    // Also save human-readable summary
    const summaryPath = filePath.replace('.json', '.txt');
    await fs.promises.writeFile(summaryPath, this.currentReceipt.toSummary());
    
    this.currentReceipt = null;
    return { receipt, filePath, summaryPath };
  }

  /**
   * List receipts for project
   */
  async listReceipts() {
    try {
      const files = await fs.promises.readdir(this.receiptDir);
      const receipts = [];
      for (const file of files.filter(f => f.endsWith('.json')).sort().reverse()) {
        const fullPath = path.join(this.receiptDir, file);
        const stat = await fs.promises.stat(fullPath);
        const content = JSON.parse(await fs.promises.readFile(fullPath, 'utf8'));
        receipts.push({
          file,
          taskId: content.taskId,
          sessionId: content.sessionId,
          timestamp: content.timestamp,
          durationMs: content.durationMs,
          savings: content.savings?.savings || null,
          quality: content.quality,
        });
      }
      return receipts;
    } catch {
      return [];
    }
  }

  /**
   * Get receipt by file name
   */
  async getReceipt(fileName) {
    const filePath = path.join(this.receiptDir, fileName);
    try {
      return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Get aggregate statistics across receipts
   */
  async getAggregateStats() {
    const receipts = await this.listReceipts();
    if (receipts.length === 0) return null;
    
    let totalTokens = 0, totalCost = 0, totalSavings = 0, totalSavingsPct = 0;
    let savingsCount = 0;
    let qualityScores = [];
    
    for (const r of receipts) {
      if (r.savings) {
        totalSavings += r.savings.tokens;
        totalSavingsPct += r.savings.percent;
        savingsCount++;
      }
      if (r.quality?.qualityScore !== null) qualityScores.push(r.quality.qualityScore);
    }
    
    return {
      totalReceipts: receipts.length,
      avgSavingsTokens: savingsCount > 0 ? Math.round(totalSavings / savingsCount) : 0,
      avgSavingsPercent: savingsCount > 0 ? (totalSavingsPct / savingsCount).toFixed(1) : '0.0',
      avgQualityScore: qualityScores.length > 0 
        ? (qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length).toFixed(1)
        : 'N/A',
      receiptsWithSavings: savingsCount,
    };
  }
}

/**
 * Global receipt managers per project
 */
const receiptManagers = new Map();

export function getReceiptManager(cwd) {
  const root = projectRoot(cwd);
  if (!receiptManagers.has(root)) {
    receiptManagers.set(root, new ReceiptManager(root));
  }
  return receiptManagers.get(root);
}



// Module-level current receipt (single task at a time)
let _currentReceipt = null;

/**
 * Record provider usage for current task
 */
export function recordProviderUsage(cwd, usage, model, costUsd) {
  if (_currentReceipt) _currentReceipt.recordProviderUsage(usage, model, costUsd);
}

/**
 * Record local usage for current task
 */
export function recordLocalUsage(cwd, usage) {
  if (_currentReceipt) _currentReceipt.recordLocalUsage(usage);
}

/**
 * Record cache hit/miss for current task
 */
export function recordCacheHit(cwd, hit) {
  if (_currentReceipt) _currentReceipt.recordCache(hit);
}

/**
 * Record optimization for current task
 */
export function recordOptimization(cwd, type, metadata) {
  if (_currentReceipt) _currentReceipt.recordOptimization(type, metadata);
}

/**
 * Record context for current task
 */
export function recordContext(cwd, context) {
  if (_currentReceipt) _currentReceipt.recordContext(context);
}

/**
 * Record quality for current task
 */
export function recordQuality(cwd, quality) {
  if (_currentReceipt) _currentReceipt.recordQuality(quality);
}

/**
 * Set baseline for current task
 */
export function setBaseline(cwd, estimatedTokens, estimatedCost, source) {
  if (_currentReceipt) _currentReceipt.setBaseline(estimatedTokens, estimatedCost, source);
}

/**
 * Start a new receipt for a task (global - uses module-level current receipt)
 */
export function startReceipt(cwd, taskId, sessionId) {
  _currentReceipt = new UsageReceipt(taskId, sessionId);
  return _currentReceipt;
}

/**
 * Get current receipt (global)
 */
export function getCurrentReceipt(cwd) {
  return _currentReceipt;
}

/**
 * Finalize and save receipt (uses ReceiptManager for persistence)
 */
export async function finalizeReceipt(cwd, config) {
  if (!_currentReceipt) return null;
  return getReceiptManager(cwd).finalizeReceipt(config);
}

/**
 * List receipts for project
 */
export async function listReceipts(cwd) {
  return getReceiptManager(cwd).listReceipts();
}

/**
 * Get receipt by file name
 */
export async function getReceipt(cwd, fileName) {
  return getReceiptManager(cwd).getReceipt(fileName);
}

/**
 * Get aggregate statistics across receipts
 */
export async function getReceiptStats(cwd) {
  return getReceiptManager(cwd).getAggregateStats();
}