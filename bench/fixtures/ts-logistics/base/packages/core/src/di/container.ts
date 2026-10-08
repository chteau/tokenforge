/**
 * Minimal service container. Services are registered under string keys and
 * created lazily on first lookup. Keys are namespaced by package, e.g.
 * `shipping.quotes`, `rates.calculator`, `adjuster.fuel`.
 */
export type Factory<T> = (c: Container) => T;

interface Entry {
  factory: Factory<unknown>;
  singleton: boolean;
  instance?: unknown;
  tags: string[];
}

export class Container {
  private entries = new Map<string, Entry>();
  private resolving: string[] = [];

  register<T>(key: string, factory: Factory<T>, opts: { singleton?: boolean; tags?: string[] } = {}): this {
    this.entries.set(key, { factory, singleton: opts.singleton ?? true, tags: opts.tags ?? [] });
    return this;
  }

  value<T>(key: string, value: T): this {
    this.entries.set(key, { factory: () => value, singleton: true, instance: value, tags: [] });
    return this;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get<T>(key: string): T {
    const e = this.entries.get(key);
    if (!e) throw new Error(`container: no service registered for "${key}"`);
    if (e.singleton && e.instance !== undefined) return e.instance as T;
    if (this.resolving.includes(key)) {
      throw new Error(`container: circular dependency ${[...this.resolving, key].join(' -> ')}`);
    }
    this.resolving.push(key);
    try {
      const inst = e.factory(this);
      if (e.singleton) e.instance = inst;
      return inst as T;
    } finally {
      this.resolving.pop();
    }
  }

  tagged<T>(tag: string): Array<[string, T]> {
    const out: Array<[string, T]> = [];
    for (const [k, e] of this.entries) if (e.tags.includes(tag)) out.push([k, this.get<T>(k)]);
    return out;
  }

  keys(prefix = ''): string[] {
    return [...this.entries.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}
