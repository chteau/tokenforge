import test from 'node:test';
import assert from 'node:assert/strict';
import { Container } from '../src/index.ts';

test('container creates singletons lazily', () => {
  let made = 0;
  const c = new Container().register('a', () => ({ n: ++made }));
  assert.equal(made, 0);
  assert.equal(c.get<{ n: number }>('a'), c.get('a'));
  assert.equal(made, 1);
});

test('container transient services are rebuilt', () => {
  const c = new Container().register('t', () => ({}), { singleton: false });
  assert.notEqual(c.get('t'), c.get('t'));
});

test('container detects cycles', () => {
  const c = new Container();
  c.register('x', (k) => k.get('y'));
  c.register('y', (k) => k.get('x'));
  assert.throws(() => c.get('x'), /circular dependency x -> y -> x/);
});

test('container reports unknown keys', () => {
  assert.throws(() => new Container().get('nope'), /no service registered for "nope"/);
});

test('container tagged and keys', () => {
  const c = new Container().register('p.a', () => 1, { tags: ['t'] }).register('p.b', () => 2).value('q', 3);
  assert.deepEqual(c.tagged('t'), [['p.a', 1]]);
  assert.deepEqual(c.keys('p.'), ['p.a', 'p.b']);
});
