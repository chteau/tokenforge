import type { Clock } from "../../shared/src/clock.ts";
import type { OutboxEmail, OutboxRepository } from "./types.ts";

/** Pretend mail transport: "sends" queued emails by recording them. */
export interface MailTransport {
  send(email: OutboxEmail): void;
  sent(): readonly OutboxEmail[];
}

export function createMemoryTransport(): MailTransport {
  const delivered: OutboxEmail[] = [];
  return {
    send(email) {
      delivered.push(email);
    },
    sent: () => delivered,
  };
}

export function drainOutbox(deps: { outbox: OutboxRepository; transport: MailTransport; clock: Clock }): number {
  const pending = deps.outbox.listPending();
  for (const email of pending) {
    deps.transport.send(email);
    deps.outbox.update({ ...email, sentAt: deps.clock.now().toISOString() });
  }
  return pending.length;
}
