// Synchronous in-process event bus. Used to decouple domain services from
// cross-cutting concerns such as cache invalidation.

export type Listener<T> = (payload: T) => void;

export interface EventBus<Events extends Record<string, unknown>> {
  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void;
  emit<K extends keyof Events>(event: K, payload: Events[K]): void;
}

export function createEventBus<Events extends Record<string, unknown>>(): EventBus<Events> {
  const listeners = new Map<keyof Events, Set<Listener<never>>>();
  return {
    on(event, listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener as Listener<never>);
      return () => set.delete(listener as Listener<never>);
    },
    emit(event, payload) {
      const set = listeners.get(event);
      if (!set) return;
      for (const listener of set) (listener as Listener<typeof payload>)(payload);
    },
  };
}

/** Events shared by the banking domain packages. */
export interface AccountChange {
  ownerId: string;
  accountId: string;
}

export interface DomainEvents extends Record<string, unknown> {
  accountsChanged: { changes: AccountChange[]; reason: string };
  userLoggedIn: { userId: string; at: string };
}
