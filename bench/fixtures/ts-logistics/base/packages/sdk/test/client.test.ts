import test from 'node:test';
import assert from 'node:assert/strict';
import { KestrelClient, ApiRequestError, isQuote } from '../src/index.ts';

function fakeFetch(responses: Array<{ status: number; body: unknown }>, calls: Array<{ url: string; init: unknown }>) {
  return async (url: string, init: unknown) => {
    calls.push({ url, init });
    const r = responses.shift()!;
    return { status: r.status, ok: r.status < 400, json: async () => r.body, text: async () => JSON.stringify(r.body) };
  };
}

test('client builds urls and retries 5xx', async () => {
  const calls: Array<{ url: string; init: unknown }> = [];
  const client = new KestrelClient({
    baseUrl: 'https://api.example/',
    apiKey: 'k',
    fetch: fakeFetch([{ status: 503, body: {} }, { status: 200, body: { data: [] } }], calls),
  });
  const res = await client.quotes.listQuotes({ status: 'open' });
  assert.deepEqual(res, { data: [] });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.example/v2/quotes?status=open');
});

test('client raises ApiRequestError on 4xx', async () => {
  const client = new KestrelClient({ baseUrl: 'https://api.example', apiKey: 'k', fetch: fakeFetch([{ status: 404, body: { error: { code: 'not_found' } } }], []) });
  await assert.rejects(client.shipments.getShipment('sh_1'), ApiRequestError);
});

test('generated guards', () => {
  assert.equal(isQuote({}), false);
});
