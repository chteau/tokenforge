import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus, silentLogger } from '../../core/src/index.ts';
import { EmailChannel, Notifier, WebhookChannel, render } from '../src/index.ts';

test('customs hold wording in booking email', () => {
  assert.match(render('shipment.booked', { shipmentId: 's1', flags: ['HOLD_CUSTOMS'] })!.text, /on hold/);
});

test('events fan out to email and webhooks', async () => {
  const bus = new EventBus();
  const email = new EmailChannel('noreply@x.example');
  const webhooks = new WebhookChannel({ secret: 's' });
  new Notifier({
    bus,
    email,
    webhooks,
    logger: silentLogger,
    subs: { emailFor: () => 'ops@acme.example', webhooksFor: (_t, type) => (type.startsWith('shipment.') ? ['https://acme.example/hook'] : []) },
  }).attach();
  await bus.publish('shipment.delivered', { shipmentId: 's1', at: 'now' }, 'tn_acme');
  await bus.publish('quote.created', { quoteId: 'q1' }, 'tn_acme');
  assert.equal(email.outbox.length, 1);
  assert.equal(webhooks.pending.length, 1);
  assert.ok(webhooks.pending[0].signature);
});
