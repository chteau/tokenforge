import type { Rendered } from '../templates.ts';

export interface OutboundEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
}

/** Outbox-style email channel: messages are queued and drained by the worker. */
export class EmailChannel {
  readonly outbox: OutboundEmail[] = [];
  private readonly from: string;
  constructor(from: string) {
    this.from = from;
  }
  send(to: string, msg: Rendered): void {
    this.outbox.push({ from: this.from, to, subject: msg.subject, text: msg.text });
  }
  drain(): OutboundEmail[] {
    return this.outbox.splice(0, this.outbox.length);
  }
}
