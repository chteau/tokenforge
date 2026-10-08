export interface DomainEvent<T = unknown> {
  type: string;
  at: string;
  tenantId?: string;
  payload: T;
}

export type Listener = (e: DomainEvent) => void | Promise<void>;

/** In-process event bus. Listener failures are logged, never rethrown. */
export class EventBus {
  private listeners = new Map<string, Listener[]>();
  private onError: (err: unknown, e: DomainEvent) => void;
  readonly history: DomainEvent[] = [];
  private keep: number;

  constructor(opts: { onError?: (err: unknown, e: DomainEvent) => void; keepHistory?: number } = {}) {
    this.onError = opts.onError ?? (() => {});
    this.keep = opts.keepHistory ?? 100;
  }

  on(type: string, l: Listener): () => void {
    const list = this.listeners.get(type) ?? [];
    list.push(l);
    this.listeners.set(type, list);
    return () => this.listeners.set(type, (this.listeners.get(type) ?? []).filter((x) => x !== l));
  }

  async publish<T>(type: string, payload: T, tenantId?: string): Promise<void> {
    const e: DomainEvent<T> = { type, at: new Date().toISOString(), tenantId, payload };
    this.history.push(e);
    if (this.history.length > this.keep) this.history.shift();
    const targets = [...(this.listeners.get(type) ?? []), ...(this.listeners.get('*') ?? [])];
    for (const l of targets) {
      try {
        await l(e);
      } catch (err) {
        this.onError(err, e);
      }
    }
  }
}
