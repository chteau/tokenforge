// Every service receives a Clock instead of calling `new Date()` directly so
// that tests can control time. Use `deps.clock.now()` everywhere.

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export interface ManualClock extends Clock {
  set(instant: Date | string): void;
  advance(ms: number): void;
}

export function createManualClock(initial: Date | string): ManualClock {
  let current = new Date(initial).getTime();
  if (Number.isNaN(current)) throw new Error(`Invalid initial clock value: ${String(initial)}`);
  return {
    now: () => new Date(current),
    set(instant) {
      const next = new Date(instant).getTime();
      if (Number.isNaN(next)) throw new Error(`Invalid clock value: ${String(instant)}`);
      current = next;
    },
    advance(ms) {
      current += ms;
    },
  };
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
