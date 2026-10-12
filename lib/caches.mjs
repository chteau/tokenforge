// Every cache tokenforge keeps, with what it depends on. One validity policy: an entry is reused only while everything
// it depends on is unchanged, compared by content where correctness needs it; size and mtime are a fast pre-check
// at most. When unsure, rebuild. Writes are atomic (lib/util.mjs writeFileAtomic): a reader sees the old file or the
// new one, and a torn or foreign file is ignored and rebuilt. `tforge caches` prints this table.
//
// Three kinds, kept apart:
//   computation: derived from files; deleting it costs only time.
//   memory:      what earlier sessions did or said; reused as context, never as fact without its source.
//   provider:    the model provider's prompt cache. tokenforge stores none of it, only keeps prefixes stable.
export const CACHES = [
  {
    name: 'tmap index', kind: 'computation', where: '~/.cache/tokenforge/tmap/<project>-<hash>.bin',
    dependsOn: ['each source file\'s content', 'the file list (.gitignore and skip rules, walked every time)', 'tmap version and extraction format'],
    check: 'size, mtime, ctime and inode trusted only for entries indexed 2 s or more after the file\'s last write; otherwise a content hash',
  },
  {
    name: 'instruction blocks', kind: 'computation', where: '~/.cache/tokenforge/instr/<hash>.json',
    dependsOn: ['the instruction file\'s content', 'the parser version (BLOCKS_VERSION)'],
    check: 'keyed by a hash of both: an entry cannot go stale, only unused',
  },
  {
    name: 'dashboard usage', kind: 'computation', where: '~/.cache/tokenforge/usage-v2.json',
    dependsOn: ['Claude Code transcripts (append-only)', 'cache format version'],
    check: 'size and mtime; a file that shrank or whose first 4 KB changed is read again from the start',
  },
  {
    name: 'proxy result memo', kind: 'computation', where: '~/.cache/tokenforge/proxy/memo.jsonl, proxy/out/',
    dependsOn: ['the tool result\'s content'],
    check: 'a memo hit needs the same content hash; full outputs are named by their hash; 14 days',
  },
  {
    name: 'project memory index', kind: 'memory', where: '~/.cache/tokenforge/memory/<project>.json',
    dependsOn: ['Claude Code transcripts of the project (append-only)', 'index format version'],
    check: 'resumes at the last offset; a file that shrank or whose first 4 KB changed is scanned again',
  },
  {
    name: 'answer cache', kind: 'memory', where: 'transcripts + ~/.cache/tokenforge/memory/<project>.asked.json',
    dependsOn: ['the question', 'repo identity (top level, remotes)', 'branch and commit', 'contents of changed and untracked files', 'dependency manifests and lockfiles', 'terse level', 'model'],
    check: 'all compared by content; anything unknown means no replay',
  },
  {
    name: 'snapshots and handoffs', kind: 'memory', where: '<project>/.forge/snapshots/, .forge/HANDOFF.md',
    dependsOn: ['the session that wrote them'],
    check: 'reloaded as notes of what happened, with their time; newest 10 handoffs kept',
  },
  {
    name: 'provider prompt cache', kind: 'provider', where: 'Anthropic API (not stored by tokenforge)',
    dependsOn: ['the exact request prefix: system prompt, tools, earlier messages'],
    check: 'injected text stays identical until its source changes; the proxy rewrites old messages only when the saving beats the cache rewrite',
  },
];

export function cachesTable() {
  const out = [];
  for (const kind of ['computation', 'memory', 'provider']) {
    out.push(`${kind}:`);
    for (const c of CACHES.filter((x) => x.kind === kind)) {
      out.push(`  ${c.name}  (${c.where})`, `    depends on: ${c.dependsOn.join('; ')}`, `    reused when: ${c.check}`);
    }
  }
  return out.join('\n');
}
