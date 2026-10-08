import type { Container, Logger } from '../../../packages/core/src/index.ts';
import type { EmailChannel, WebhookChannel } from '../../../packages/notify/src/index.ts';

export async function drainOutbox(container: Container): Promise<number> {
  const email = container.get<EmailChannel>('notify.email');
  const hooks = container.get<WebhookChannel>('notify.webhooks');
  const log = container.get<Logger>('core.logger');
  const sent = email.drain();
  for (const m of sent) log.info('email sent', { to: m.to, subject: m.subject });
  const deliveries = hooks.pending.splice(0, hooks.pending.length);
  for (const d of deliveries) log.info('webhook delivered', { url: d.url, signed: Boolean(d.signature) });
  return sent.length + deliveries.length;
}
