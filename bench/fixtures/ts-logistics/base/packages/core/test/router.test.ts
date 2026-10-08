import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Router, compose, type RequestContext, json } from '../src/index.ts';

function ctx(method: string, path: string): RequestContext {
  return {
    req: {} as RequestContext['req'],
    res: {} as RequestContext['res'],
    method,
    path,
    query: new URLSearchParams(),
    params: {},
    headers: {},
    body: undefined,
    requestId: 'r',
    services: new Container(),
    state: {},
    status: 404,
    responseBody: undefined,
    responseHeaders: {},
  };
}

test('router matches params and runs middleware in order', async () => {
  const order: string[] = [];
  const r = new Router();
  r.use(async (_c, next) => {
    order.push('global');
    await next();
  });
  r.use('/api', async (_c, next) => {
    order.push('scoped');
    await next();
  });
  r.get('/api/items/:id', async (c) => {
    order.push('handler');
    json(c, 200, { id: c.params.id });
  }, [async (_c, next) => { order.push('route'); await next(); }]);
  const c = ctx('GET', '/api/items/42');
  await r.dispatch(c);
  assert.deepEqual(order, ['global', 'scoped', 'route', 'handler']);
  assert.deepEqual(c.responseBody, { id: '42' });
});

test('router 404 and 405', async () => {
  const r = new Router().post('/x', async () => {});
  await assert.rejects(r.dispatch(ctx('GET', '/y')), /no route/);
  await assert.rejects(r.dispatch(ctx('GET', '/x')), /not allowed/);
});

test('prefix middleware does not run outside its prefix', async () => {
  let ran = false;
  const r = new Router().use('/v2', async (_c, next) => { ran = true; await next(); }).get('/healthz', async () => {});
  await r.dispatch(ctx('GET', '/healthz'));
  assert.equal(ran, false);
});

test('compose rejects double next()', async () => {
  const h = compose([async (_c, next) => { await next(); await next(); }], async () => {});
  await assert.rejects(h(ctx('GET', '/')), /multiple times/);
});
