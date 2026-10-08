import type { AppConfig, Container, EventBus, Logger } from '../../core/src/index.ts';
import { isEnabled } from '../../core/src/index.ts';
import { EmailChannel } from './channels/email.ts';
import { WebhookChannel } from './channels/webhook.ts';
import { Notifier, noSubscriptions, type Subscriptions } from './Notifier.ts';

export function registerNotify(container: Container, config: AppConfig): void {
  container.register('notify.email', () => new EmailChannel(config.notify.senders.email));
  container.register(
    'notify.webhooks',
    () => new WebhookChannel({ secret: isEnabled(config, 'webhookSigning') ? (process.env.KESTREL_WEBHOOK_SECRET ?? 'dev-secret') : undefined }),
  );
  if (!container.has('notify.subscriptions')) container.value<Subscriptions>('notify.subscriptions', noSubscriptions);
  container.register(
    'notify.notifier',
    (c) =>
      new Notifier({
        bus: c.get<EventBus>('core.bus'),
        email: c.get('notify.email'),
        webhooks: c.get('notify.webhooks'),
        subs: c.get('notify.subscriptions'),
        logger: c.get<Logger>('core.logger'),
      }),
  );
}
