/**
 * Tests for Context Packs
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  PACK_TEMPLATES,
  generatePack,
  listPackTypes,
  listCachedPacks,
  deletePack,
  clearAllPacks,
  getPack,
  trimPack,
  estimateTokens,
} from '/mnt/data/Documents/Dev/tokenforge/lib/context-packs.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('PACK_TEMPLATES', () => {
  it('defines all expected pack types', () => {
    const expected = [
      'bug-investigation',
      'feature-implementation',
      'refactoring',
      'pr-review',
      'architecture-exploration',
      'test-generation',
      'security-audit',
      'cross-module-debugging',
    ];
    for (const type of expected) {
      assert.ok(PACK_TEMPLATES[type], `Missing template: ${type}`);
      assert.ok(PACK_TEMPLATES[type].name);
      assert.ok(PACK_TEMPLATES[type].description);
      assert.ok(PACK_TEMPLATES[type].queries);
      assert.ok(PACK_TEMPLATES[type].maxFiles > 0);
      assert.ok(PACK_TEMPLATES[type].maxTokens > 0);
    }
  });

  it('has queries with weights', () => {
    for (const [, template] of Object.entries(PACK_TEMPLATES)) {
      for (const query of template.queries) {
        assert.ok(query.type);
        assert.ok(query.weight >= 0 && query.weight <= 1);
      }
    }
  });
});

describe('listPackTypes', () => {
  it('returns all pack types with metadata', () => {
    const types = listPackTypes();
    assert.strictEqual(types.length, 8);
    for (const type of types) {
      assert.ok(type.id);
      assert.ok(type.name);
      assert.ok(type.description);
      assert.ok(type.maxFiles > 0);
      assert.ok(type.maxTokens > 0);
    }
  });
});

describe('trimPack', () => {
  it('limits files to maxFiles', () => {
    const files = new Map();
    for (let i = 0; i < 10; i++) {
      files.set(`file${i}.js`, { content: 'x'.repeat(100), reason: 'test', source: 'test', lines: 5 });
    }
    const trimmed = trimPack(files, 3, 10000);
    assert.strictEqual(trimmed.size, 3);
  });

  it('limits tokens to maxTokens', () => {
    const files = new Map();
    for (let i = 0; i < 5; i++) {
      files.set(`file${i}.js`, { content: 'x'.repeat(2000), reason: 'test', source: 'test', lines: 50 });
    }
    const trimmed = trimPack(files, 10, 5000); // ~1250 tokens max
    const totalTokens = Array.from(trimmed.values()).reduce((sum, f) => sum + Math.ceil(f.content.length / 4), 0);
    assert.ok(totalTokens <= 5000);
  });

  it('prioritizes by reason weight', () => {
    const files = new Map([
      ['low.js', { content: 'x'.repeat(100), reason: 'pattern', source: 'test', lines: 5 }],
      ['high.js', { content: 'x'.repeat(100), reason: 'error_handling', source: 'test', lines: 5 }],
      ['medium.js', { content: 'x'.repeat(100), reason: 'caller', source: 'test', lines: 5 }],
    ]);
    const trimmed = trimPack(files, 2, 10000);
    assert.ok(trimmed.has('high.js')); // error_handling = weight 3
    assert.ok(trimmed.has('medium.js')); // caller = weight 2
    assert.ok(!trimmed.has('low.js')); // pattern = weight 1
  });
});

describe('estimateTokens', () => {
  it('estimates tokens from content', () => {
    const pack = {
      files: [
        { content: 'x'.repeat(400) }, // ~100 tokens
        { content: 'y'.repeat(800) }, // ~200 tokens
      ],
    };
    const tokens = estimateTokens(pack);
    // 500 base + 100 + 200 = 800
    assert.strictEqual(tokens, 800);
  });
});

describe('Context Pack Integration', () => {
  let testProject;

  async function setupTestProject() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-test-'));
    const project = path.join(tmpDir, 'project');
    await fs.promises.mkdir(project, { recursive: true });
    
    // Create some test files
    await fs.promises.mkdir(path.join(project, 'src'), { recursive: true });
    await fs.promises.writeFile(path.join(project, 'src', 'utils.js'), 'export function helper() { return 1; }');
    await fs.promises.writeFile(path.join(project, 'src', 'main.js'), 'import { helper } from "./utils"; helper();');
    await fs.promises.writeFile(path.join(project, 'package.json'), '{}');
    
    // Initialize git repo for tmap
    await fs.promises.mkdir(path.join(project, 'src', '..', '.git'), { recursive: true });
    await fs.promises.writeFile(path.join(project, 'src', '..', '.git', 'HEAD'), 'ref: refs/heads/main');
    
    return { tmpDir, project };
  }

  it('generates a pack', async () => {
    const { tmpDir, project } = await setupTestProject();
    console.log('[DEBUG TEST] project:', project);
    console.log('[DEBUG TEST] utils.js exists:', fs.existsSync(path.join(project, 'src', 'utils.js')));
    try {
      const pack = await generatePack(project, 'bug-investigation', { focus: 'helper' });
      assert.ok(pack.files);
      assert.ok(pack.symbols);
      assert.ok(pack.queries);
      assert.ok(pack.stats);
      assert.ok(pack.metadata);
      assert.strictEqual(pack.metadata.taskType, 'bug-investigation');
    } catch (e) {
      console.error('[DEBUG TEST ERROR]', e.message);
      console.error('[DEBUG TEST ERROR STACK]', e.stack);
      throw e;
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('caches packs', async () => {
    const { tmpDir, project } = await setupTestProject();
    try {
      await generatePack(project, 'bug-investigation', { focus: 'helper' });
      const pack2 = await generatePack(project, 'bug-investigation', { focus: 'helper' });
      assert.strictEqual(pack2.cached, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('invalidates on file changes', async () => {
    const { tmpDir, project } = await setupTestProject();
    try {
      const pack1 = await generatePack(project, 'bug-investigation', { 
        focus: 'helper',
        includeFiles: ['src/utils.js'],
      });
      // Modify a file
      await fs.promises.writeFile(path.join(project, 'src', 'utils.js'), 'export function helper() { return 2; }');
      const pack2 = await generatePack(project, 'bug-investigation', { 
        focus: 'helper',
        includeFiles: ['src/utils.js'],
      });
      assert.strictEqual(pack2.cached, false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('respects includeFiles', async () => {
    const { tmpDir, project } = await setupTestProject();
    try {
      const pack = await generatePack(project, 'bug-investigation', { 
        focus: 'helper',
        includeFiles: ['package.json'],
      });
      assert.ok(pack.files.some(f => f.path === 'package.json'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('respects excludeFiles', async () => {
    const { tmpDir, project } = await setupTestProject();
    try {
      const pack = await generatePack(project, 'bug-investigation', { 
        focus: 'helper',
        excludeFiles: ['src/utils.js'],
      });
      assert.ok(!pack.files.some(f => f.path === 'src/utils.js'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('lists cached packs', async () => {
    const { tmpDir, project } = await setupTestProject();
    try {
      await generatePack(project, 'bug-investigation', { focus: 'helper' });
      const packs = await listCachedPacks(project);
      assert.strictEqual(packs.length, 1);
      assert.strictEqual(packs[0].taskType, 'bug-investigation');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('deletes packs', async () => {
    const { tmpDir, project } = await setupTestProject();
    try {
      const pack = await generatePack(project, 'bug-investigation', { focus: 'helper' });
      const deleted = await deletePack(project, pack.key);
      assert.strictEqual(deleted, true);
      const packs = await listCachedPacks(project);
      assert.strictEqual(packs.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('clears all packs', async () => {
    const { tmpDir, project } = await setupTestProject();
    try {
      await generatePack(project, 'bug-investigation', { focus: 'helper' });
      await generatePack(project, 'refactoring', { focus: 'main' });
      const count = await clearAllPacks(project);
      assert.strictEqual(count, 2);
      const packs = await listCachedPacks(project);
      assert.strictEqual(packs.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('gets pack by key', async () => {
    const { tmpDir, project } = await setupTestProject();
    try {
      const pack = await generatePack(project, 'bug-investigation', { focus: 'helper' });
      const retrieved = await getPack(project, pack.key);
      assert.ok(retrieved);
      assert.strictEqual(retrieved.metadata.taskType, 'bug-investigation');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});