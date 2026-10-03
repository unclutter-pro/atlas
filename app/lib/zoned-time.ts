/**
 * Pure zone math (Intl only, no I/O): wall-clock parts, day boundaries and
 * wall-clock → UTC in an arbitrary IANA zone, independent of the process's
 * ambient zone. Kept free of Node imports so browser code can use it too
 * (the trigger form validates cron expressions client-side).
 */

/** True when `tz` is a name Intl (and therefore the rest of the platform) recognizes as an IANA zone. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Zone math (pure, Intl-only — no I/O)
// ---------------------------------------------------------------------------

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
}

/** Wall-clock date/time components of `d` as observed in `timeZone`. */
export function zonedParts(d: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(d);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

/** "YYYY-MM-DD" calendar date of `d` as observed in `timeZone`. */
export function zonedDateString(d: Date, timeZone: string): string {
  const p = zonedParts(d, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function offsetMsAt(utcMs: number, timeZone: string): number {
  const p = zonedParts(new Date(utcMs), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - utcMs;
}

/**
 * UTC instant for the wall-clock time (y, moZeroBased, d, h, mi) as written
 * in `timeZone`, plus the hour that instant actually lands on in that zone
 * (compare to `h` to detect a DST spring-forward gap, where the requested
 * wall time never occurred). On a fall-back (ambiguous hour), the standard
 * (pre-transition) offset is used, matching the lower of the two UTC instants.
 */
export function zonedWallClockToUtc(y: number, moZeroBased: number, d: number, h: number, mi: number, timeZone: string): { date: Date; hour: number } {
  const guess = Date.UTC(y, moZeroBased, d, h, mi);
  const offset = offsetMsAt(guess, timeZone);
  let utcMs = guess - offset;
  // Re-check near a transition: the offset at the resulting instant can differ from the guess's.
  const offset2 = offsetMsAt(utcMs, timeZone);
  if (offset2 !== offset) utcMs = guess - offset2;
  const actual = zonedParts(new Date(utcMs), timeZone);
  return { date: new Date(utcMs), hour: actual.hour };
}

/** UTC instant of local midnight for `date` ("YYYY-MM-DD") in `timeZone`, `offsetDays` applied to the calendar date first. */
export function zonedDayStartUtc(date: string, timeZone: string, offsetDays = 0): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const base = new Date(Date.UTC(y, m - 1, d + offsetDays));
  return zonedWallClockToUtc(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 0, 0, timeZone).date;
}
