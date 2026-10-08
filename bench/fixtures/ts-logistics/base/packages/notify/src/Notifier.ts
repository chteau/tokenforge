import type { DomainEvent, EventBus, Logger } from '../../core/src/index.ts';
import type { EmailChannel } from './channels/email.ts';
import type { WebhookChannel } from './channels/webhook.ts';
import { render } from './templates.ts';

export interface Subscriptions {
  emailFor(tenantId: string): string | undefined;
  webhooksFor(tenantId: string, type: string): string[];
}

/** Fans domain events out to tenant email addresses and webhooks. */
export class Notifier {
  private readonly d: { bus: EventBus; email: EmailChannel; webhooks: WebhookChannel; subs: Subscriptions; logger: Logger };
  constructor(d: Notifier['d']) {
    this.d = d;
  }

  attach(): void {
    this.d.bus.on('*', (e) => this.handle(e));
  }

  handle(e: DomainEvent): void {
    if (!e.tenantId) return;
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    const msg = render(e.type, payload);
    const to = this.d.subs.emailFor(e.tenantId);
    if (msg && to) this.d.email.send(to, msg);
    for (const url of this.d.subs.webhooksFor(e.tenantId, e.type)) {
      this.d.webhooks.enqueue(url, { type: e.type, at: e.at, data: payload });
    }
  }
}

export const noSubscriptions: Subscriptions = {
  emailFor: () => undefined,
  webhooksFor: () => [],
};
