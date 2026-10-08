// Calendar helpers. Instants are `Date` objects (UTC internally); calendar
// dates are "YYYY-MM-DD" strings interpreted in a user's IANA time zone.
// Customers see dates in their profile time zone (User.timezone), so any
// "today" / "this month" logic must go through these helpers.

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = partFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partFormatters.set(timeZone, fmt);
  }
  return fmt;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== "string" || timeZone.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** The calendar date of `instant` in `timeZone`, as "YYYY-MM-DD". */
export function localDateString(instant: Date, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** "HH:mm" wall-clock time of `instant` in `timeZone`. */
export function localTimeString(instant: Date, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds (e.g. +3600000 for CET). */
export function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(instant.getTime() / 1000) * 1000;
  return asUtc - truncated;
}

export interface IsoDate {
  year: number;
  month: number;
  day: number;
}

/** Strict "YYYY-MM-DD" parser that rejects impossible dates such as 2026-02-30. */
export function parseIsoDate(value: string): IsoDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return null;
  return { year, month, day };
}

export function isValidIsoDate(value: string): boolean {
  return parseIsoDate(value) !== null;
}

/** Strict "HH:mm" parser (00:00-23:59). */
export function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/** Add whole calendar days to a "YYYY-MM-DD" date. */
export function addDays(date: string, days: number): string {
  const parsed = parseIsoDate(date);
  if (!parsed) throw new Error(`Invalid ISO date: ${date}`);
  const d = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days));
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Negative when a < b, 0 when equal, positive when a > b (lexicographic on ISO dates). */
export function compareIsoDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The instant at which the wall clock in `timeZone` shows `date` `time`.
 * Example: zonedDateTimeToInstant("2026-03-10", "09:00", "Europe/Paris")
 * -> 2026-03-10T08:00:00.000Z. Wall times that do not exist (DST gap) are
 * moved forward by the size of the gap.
 */
export function zonedDateTimeToInstant(date: string, time: string, timeZone: string): Date {
  const d = parseIsoDate(date);
  const t = parseTimeOfDay(time);
  if (!d) throw new Error(`Invalid ISO date: ${date}`);
  if (!t) throw new Error(`Invalid time of day: ${time}`);
  const wall = Date.UTC(d.year, d.month - 1, d.day, t.hour, t.minute);
  const guess = wall - timeZoneOffsetMs(new Date(wall), timeZone);
  const corrected = wall - timeZoneOffsetMs(new Date(guess), timeZone);
  const showsWall = (instant: number): boolean => {
    const p = localParts(new Date(instant), timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) === wall;
  };
  if (showsWall(guess)) return new Date(guess);
  if (showsWall(corrected)) return new Date(corrected);
  return new Date(Math.max(guess, corrected));
}

/** Start (00:00 local) of the calendar day containing `instant` in `timeZone`. */
export function startOfLocalDay(instant: Date, timeZone: string): Date {
  return zonedDateTimeToInstant(localDateString(instant, timeZone), "00:00", timeZone);
}

/** Start (00:00 local on the 1st) of the calendar month containing `instant`. */
export function startOfLocalMonth(instant: Date, timeZone: string): Date {
  const p = localParts(instant, timeZone);
  return zonedDateTimeToInstant(`${pad(p.year, 4)}-${pad(p.month)}-01`, "00:00", timeZone);
}

/** "Oct 7, 2026" in the user's time zone. */
export function formatLocalDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "short", day: "numeric" }).format(instant);
}

/** "Oct 7, 2026, 14:05" in the user's time zone. */
export function formatLocalDateTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
}
