import './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { blocks, digest, instructionMode, nestedFor } from '../lib/instructions.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'instr-'));
process.env.CLAUDE_CONFIG_DIR = path.join(base, 'config');
process.env.XDG_CACHE_HOME = path.join(base, 'cache');
delete process.env.TFORGE_INSTRUCTIONS;
const [CLAUDE_ONLY, FALLBACK, BOTH, NONE] = ['claude-md', 'claude-md-or-agents-md', 'claude-md-and-agents-md', 'managed-only'];

// A project dir holding `files` ({ relative path: text }).
function project(files) {
  const root = fs.mkdtempSync(path.join(base, 'p-'));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  return root;
}

test('blocks compact markdown and keep code as written', () => {
  assert.deepEqual(blocks('# T\n<!-- hidden -->\n[![b](x)](y)\n\n| a | b |\n|:--|--:|\n\n```js\nx  \n\n```\n'), ['# T', '|a|b|\n|-|-|', '```js\nx  \n\n```']);
  assert.deepEqual(blocks('a\r\n<!-- one\ntwo -->\nb  \n\n\n\nc'), ['a\nb', 'c']);
});

test('instructionMode reads the agents-md plugin options as Claude Code does', () => {
  const settings = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const mode = (options) => {
    fs.writeFileSync(settings, JSON.stringify({ pluginConfigs: { 'cc-plugin-agents-md': { options } } }));
    return instructionMode();
  };
  assert.equal(mode({}), FALLBACK);
  assert.equal(mode({ instructionFiles: BOTH }), BOTH);
  assert.equal(mode({ instructionFiles: 'bogus' }), FALLBACK);
  assert.equal(mode({ projectInstructions: 'none' }), NONE);
  assert.equal(mode({ projectInstructions: 'bogus' }), CLAUDE_ONLY);
  assert.equal(mode({ projectInstructions: 'both', instructionFiles: CLAUDE_ONLY }), CLAUDE_ONLY);
  fs.rmSync(settings);
  assert.equal(instructionMode(), FALLBACK);
});

test('digest gives a session the instruction files Claude Code leaves out', () => {
  const root = project({
    'CLAUDE.md': '# Rules\nUse tabs.\n',
    'AGENTS.md': '# Agents\nRun `make test` before committing. See @docs/style.md\n',
    'docs/style.md': 'Prefer early returns.\n',
    'sub/x.js': '',
  });
  const cwd = path.join(root, 'sub');
  const d = digest(cwd, { mode: FALLBACK });
  assert.match(d, /^tokenforge: project instruction files Claude Code did not load/);
  assert.ok(d.includes(`Contents of ${path.join(root, 'AGENTS.md')}:\n\n# Agents\nRun`) && d.includes('Prefer early returns.'));
  assert.ok(!d.includes('Use tabs'), 'Claude Code loads CLAUDE.md');
  assert.equal(digest(cwd, { mode: BOTH }), '', 'and AGENTS.md too in this mode');
  assert.equal(digest(cwd, { mode: CLAUDE_ONLY }), '');
  assert.equal(digest(cwd, { mode: NONE }), '');
  assert.ok(digest(cwd, { engine: false, mode: FALLBACK }).includes('Use tabs'), 'workers get the whole chain');
  process.env.TFORGE_INSTRUCTIONS = '0';
  try {
    assert.equal(digest(cwd, { mode: FALLBACK }), '');
  } finally {
    delete process.env.TFORGE_INSTRUCTIONS;
  }
});

test('digest follows a short pointer file, not a passing mention, and repeats nothing', () => {
  const stub = project({ 'CLAUDE.md': 'Read AGENTS.md first.\n', 'AGENTS.md': 'Never force-push.\n' });
  assert.match(digest(stub, { mode: CLAUDE_ONLY }), /Never force-push/);
  const long = project({ 'CLAUDE.md': `${'Keep functions small. '.repeat(100)}\n\nEach package has its own AGENTS.md.\n`, 'AGENTS.md': 'Never force-push.\n' });
  assert.equal(digest(long, { mode: CLAUDE_ONLY }), '');
  const rule = 'Every public function needs a doc comment that says what it returns.';
  assert.equal(digest(project({ 'CLAUDE.md': `${rule}\n`, 'AGENTS.md': `${rule}\n` }), { mode: FALLBACK }), '', 'a copy of CLAUDE.md adds nothing');
  const d = digest(project({ 'CLAUDE.md': `${rule}\n`, 'AGENTS.md': `# Agents\n\n${rule}\n\nNever force-push.\n` }), { mode: FALLBACK });
  assert.ok(d.includes('# Agents\n\nNever force-push.') && !d.includes(rule));
});

test('nestedFor gives the instruction files of the directories a call reached, once', () => {
  const root = project({
    'CLAUDE.md': '# Top\n',
    'pkg/CLAUDE.md': 'Pkg rule.\n',
    'pkg/AGENTS.md': 'Pkg agents rule.\n',
    'pkg/src/a.js': '',
    'lib/AGENTS.md': 'Lib agents rule.\n',
    'lib/b.js': '',
    'c.js': '',
  });
  const a = path.join(root, 'pkg', 'src', 'a.js');
  const given = new Set();
  const grep = nestedFor(root, [path.join(root, 'pkg', 'src'), path.join(root, 'lib', 'b.js')], { tool: 'Grep', given, mode: FALLBACK });
  assert.match(grep, /^tokenforge: instruction files of the directories this call reached/);
  assert.ok(['Pkg rule.', 'Pkg agents rule.', 'Lib agents rule.'].every((s) => grep.includes(s)));
  assert.equal(nestedFor(root, [a], { tool: 'Grep', given, mode: FALLBACK }), '', 'already given');
  const read = nestedFor(root, [a], { tool: 'Read', given: new Set(), mode: FALLBACK });
  assert.ok(read.includes('Pkg agents rule.') && !read.includes('Pkg rule.'), 'Read loads nested CLAUDE.md itself');
  assert.equal(nestedFor(root, [a], { tool: 'Read', given: new Set(), mode: BOTH }), '');
  assert.equal(nestedFor(root, [a], { tool: 'Grep', given: new Set(), mode: NONE }), '');
  assert.equal(nestedFor(root, [path.join(root, 'c.js')], { tool: 'Grep', given: new Set(), mode: FALLBACK }), '', 'the root chain is digest()');
});
