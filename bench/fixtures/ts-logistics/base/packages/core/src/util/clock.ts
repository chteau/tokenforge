export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(iso: string): Clock {
  const d = new Date(iso);
  return { now: () => new Date(d.getTime()) };
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addHours(d: Date, h: number): Date {
  return new Date(d.getTime() + h * 3_600_000);
}

export function inWindow(d: Date, fromMmDd: string, toMmDd: string): boolean {
  const md = d.toISOString().slice(5, 10);
  return fromMmDd <= toMmDd ? md >= fromMmDd && md <= toMmDd : md >= fromMmDd || md <= toMmDd;
}
