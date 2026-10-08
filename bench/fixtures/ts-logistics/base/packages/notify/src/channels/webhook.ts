import { createHmac } from 'node:crypto';

export interface WebhookDelivery {
  url: string;
  body: string;
  signature?: string;
  attempts: number;
}

export class WebhookChannel {
  readonly pending: WebhookDelivery[] = [];
  private readonly secret?: string;
  constructor(opts: { secret?: string } = {}) {
    this.secret = opts.secret;
  }
  sign(body: string): string | undefined {
    return this.secret ? createHmac('sha256', this.secret).update(body).digest('hex') : undefined;
  }
  enqueue(url: string, payload: unknown): WebhookDelivery {
    const body = JSON.stringify(payload);
    const d = { url, body, signature: this.sign(body), attempts: 0 };
    this.pending.push(d);
    return d;
  }
}
