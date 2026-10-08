import test from 'node:test';
import assert from 'node:assert/strict';
import { main, parseFlags } from '../cli.ts';

const run = async (argv: string[]) => {
  const lines: string[] = [];
  const code = await main(argv, (l) => lines.push(l));
  return { code, lines };
};

test('flag parsing', () => {
  assert.deepEqual(parseFlags(['a', '--x', '1', '--y']), { flags: { x: '1', y: true }, positional: ['a'] });
});

test('zone command shows uplift', async () => {
  const r = await run(['zone', 'GB', 'IV51', '9XX']);
  assert.equal(r.code, 0);
  assert.match(r.lines[0], /zone R \(uplift 3\.50%\)/);
});

test('legacy tariff quote command', async () => {
  const r = await run(['quote', '--account', '100231', '--kg', '2', '--postcode', 'HS1 2AB']);
  assert.equal(r.code, 0);
  assert.match(r.lines.join('\n'), /RAS\s+Remote area surcharge/);
});

test('codes and usage', async () => {
  assert.match((await run(['codes', '--carrier', 'ISL', '--service', 'express'])).lines.at(-1)!, /\d+ codes/);
  assert.equal((await run(['bogus'])).code, 2);
});
