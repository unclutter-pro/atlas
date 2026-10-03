/**
 * Cron schedules for cron triggers: validation, next fire times and a
 * plain-English description.
 *
 * Only the numeric 5-field syntax is accepted (minute hour day-of-month
 * month day-of-week; `*`, lists, ranges, steps; 7 = Sunday). That is what
 * triggers/manage.ts and triggers/sync-crontab.ts allow: sync-crontab
 * silently drops schedules that fail `^[\d\s*\/,-]+$`, so names and
 * @macros must be rejected here too.
 *
 * nextRuns() takes an optional IANA `timeZone`: pass the value from
 * lib/timezone.ts's resolveTimezone() so previews match what supercronic
 * (via sync-crontab's CRON_TZ) actually schedules. Without it, times are
 * evaluated in the process's ambient zone (process.env.TZ) — correct as
 * long as the entrypoint called applyProcessTimeZone() at startup. Does no
 * I/O itself (only Intl for the zoned path).
 */
import { zonedParts, zonedWallClockToUtc } from "../../../lib/zoned-time";

/** The exact filter sync-crontab.ts applies before writing a crontab line. */
export const CRONTAB_SAFE = /^[\d\s*/,-]+$/;

interface Field {
  name: string;
  min: number;
  max: number;
}

const FIELDS: Field[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
];

export interface CronSpec {
  fields: string[];
  minute: number[];
  hour: number[];
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

export type CronParse = { ok: true; spec: CronSpec } | { ok: false; error: string };

function parseField(src: string, f: Field): Set<number> | string {
  const out = new Set<number>();
  for (const part of src.split(",")) {
    const m = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!m) return `invalid ${f.name} "${part}"`;
    let lo: number;
    let hi: number;
    if (m[1] === "*") {
      lo = f.min;
      hi = f.max;
    } else {
      lo = Number(m[2]);
      // "5/15" means 5, 20, 35, 50 (start at 5, run to the end of the range).
      hi = m[3] != null ? Number(m[3]) : m[4] != null ? f.max : lo;
    }
    const step = m[4] != null ? Number(m[4]) : 1;
    if (lo < f.min || hi > f.max) return `${f.name} must be between ${f.min} and ${f.max}`;
    if (lo > hi) return `invalid ${f.name} range "${part}"`;
    if (step < 1) return `${f.name} step must be at least 1`;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronParse {
  const trimmed = (expr ?? "").trim();
  if (!trimmed) return { ok: false, error: "Schedule is required" };
  if (!CRONTAB_SAFE.test(trimmed)) return { ok: false, error: "Use digits, *, /, - and , only (no names or @macros)" };
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return { ok: false, error: `Expected 5 fields (minute hour day month weekday), got ${fields.length}` };
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const r = parseField(fields[i]!, FIELDS[i]!);
    if (typeof r === "string") return { ok: false, error: r };
    sets.push(r);
  }
  const dow = sets[4]!;
  if (dow.has(7)) {
    dow.delete(7);
    dow.add(0);
  }
  return {
    ok: true,
    spec: {
      fields,
      minute: [...sets[0]!].sort((a, b) => a - b),
      hour: [...sets[1]!].sort((a, b) => a - b),
      dom: sets[2]!,
      month: sets[3]!,
      dow,
      domRestricted: !fields[2]!.startsWith("*"),
      dowRestricted: !fields[4]!.startsWith("*"),
    },
  };
}

/** Month/day-of-month/day-of-week match for a calendar date given as separate fields (no Date/zone involved beyond weekday arithmetic, which is zone-agnostic). */
function dayMatchesYMD(spec: CronSpec, year: number, monthZeroBased: number, day: number): boolean {
  if (!spec.month.has(monthZeroBased + 1)) return false;
  const domOk = spec.dom.has(day);
  const dow = new Date(Date.UTC(year, monthZeroBased, day)).getUTCDay();
  const dowOk = spec.dow.has(dow);
  // Vixie cron: when both are restricted, either one matching is enough.
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  if (spec.domRestricted) return domOk;
  if (spec.dowRestricted) return dowOk;
  return true;
}

function dayMatches(spec: CronSpec, d: Date): boolean {
  return dayMatchesYMD(spec, d.getFullYear(), d.getMonth(), d.getDate());
}

/** The next `count` fire times strictly after `from`, in the ambient process zone. */
function nextRunsAmbient(spec: CronSpec, count: number, from: Date): Date[] {
  const out: Date[] = [];
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  for (let i = 0; i < 1500 && out.length < count; i++) {
    if (dayMatches(spec, day)) {
      for (const h of spec.hour) {
        for (const m of spec.minute) {
          const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
          // DST gaps shift the hour; skip times that do not exist as written.
          if (t.getHours() !== h || t < start) continue;
          out.push(t);
          if (out.length >= count) return out;
        }
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return out;
}

/** Same search as nextRunsAmbient, but every wall-clock time is interpreted in an explicit IANA zone via Intl instead of the ambient process zone. */
function nextRunsZoned(spec: CronSpec, count: number, from: Date, timeZone: string): Date[] {
  const out: Date[] = [];
  const startP = zonedParts(from, timeZone);
  let { date: minuteStart } = zonedWallClockToUtc(startP.year, startP.month - 1, startP.day, startP.hour, startP.minute, timeZone);
  minuteStart = new Date(minuteStart.getTime() + 60_000);
  if (minuteStart.getTime() <= from.getTime()) minuteStart = new Date(minuteStart.getTime() + 60_000);
  const startYmd = zonedParts(minuteStart, timeZone);
  let y = startYmd.year;
  let mo = startYmd.month - 1;
  let d = startYmd.day;
  for (let i = 0; i < 1500 && out.length < count; i++) {
    if (dayMatchesYMD(spec, y, mo, d)) {
      for (const h of spec.hour) {
        for (const m of spec.minute) {
          const { date: t, hour } = zonedWallClockToUtc(y, mo, d, h, m, timeZone);
          // DST gaps shift the hour; skip times that do not exist as written.
          if (hour !== h || t < minuteStart) continue;
          out.push(t);
          if (out.length >= count) return out;
        }
      }
    }
    const next = new Date(Date.UTC(y, mo, d + 1));
    y = next.getUTCFullYear();
    mo = next.getUTCMonth();
    d = next.getUTCDate();
  }
  return out;
}

/** The next `count` fire times strictly after `from`, searching up to ~4 years ahead. `timeZone` (IANA) evaluates wall-clock times in that zone; omitted, it uses the ambient process zone. */
export function nextRuns(spec: CronSpec, count = 1, from: Date = new Date(), timeZone?: string): Date[] {
  return timeZone ? nextRunsZoned(spec, count, from, timeZone) : nextRunsAmbient(spec, count, from);
}

// --- Plain-English description ---------------------------------------------

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number) => String(n).padStart(2, "0");

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
}

const stepOf = (field: string) => field.match(/^\*\/(\d+)$/)?.[1];

function describeDays(spec: CronSpec): { phrase: string | null; everyDay: boolean } {
  const [, , domF, monthF] = spec.fields as [string, string, string, string, string];
  const parts: string[] = [];
  const dows = [...spec.dow].sort((a, b) => a - b);
  let dowText: string | null = null;
  if (spec.dowRestricted) {
    const key = dows.join(",");
    dowText =
      key === "1,2,3,4,5" ? "on weekdays" : key === "0,6" ? "on weekends" : `on ${joinList(dows.map((d) => DAY_NAMES[d]!))}`;
  }
  let domText: string | null = null;
  if (spec.domRestricted) {
    const step = stepOf(domF);
    domText = step ? `every ${step} days` : `on the ${joinList([...spec.dom].sort((a, b) => a - b).map(ordinal))}`;
  }
  if (domText && dowText) parts.push(`${domText} or ${dowText}`);
  else if (domText) parts.push(domText);
  else if (dowText) parts.push(dowText);
  if (!monthF.startsWith("*")) parts.push(`in ${joinList([...spec.month].sort((a, b) => a - b).map((m) => MONTH_NAMES[m - 1]!))}`);
  else if (domText && !dowText) parts[parts.length - 1] += " of every month";
  return { phrase: parts.length ? parts.join(" ") : null, everyDay: !spec.domRestricted && !spec.dowRestricted && monthF.startsWith("*") };
}

/** "Every day at 07:00", "Every 30 minutes", "Weekdays at 09:00", … Falls back to null for shapes it can't phrase. */
export function describeCron(spec: CronSpec): string | null {
  const [minF, hourF] = spec.fields as [string, string];
  const days = describeDays(spec);
  const suffix = days.phrase ? ` ${days.phrase}` : "";
  const minStep = stepOf(minF);
  const hourStep = stepOf(hourF);
  const singleMinute = spec.minute.length === 1 ? spec.minute[0]! : null;

  // Interval shapes: "every N minutes", "every hour at :05", "every 2 hours at :00".
  if (hourF === "*") {
    if (minF === "*") return `Every minute${suffix}`;
    if (minStep) return `Every ${minStep} minutes${suffix}`;
    if (singleMinute != null) return `Every hour at :${pad(singleMinute)}${suffix}`;
    if (spec.minute.length <= 4) return `Every hour at ${joinList(spec.minute.map((m) => `:${pad(m)}`))}${suffix}`;
    return null;
  }
  if (hourStep && singleMinute != null) return `Every ${hourStep} hours at :${pad(singleMinute)}${suffix}`;

  // Hour range with a minute interval: "every 15 minutes from 09:00 to 17:59".
  if (/^\d+-\d+$/.test(hourF) && (minF === "*" || minStep)) {
    const from = spec.hour[0]!;
    const to = spec.hour[spec.hour.length - 1]!;
    return `Every ${minStep ? `${minStep} minutes` : "minute"} from ${pad(from)}:00 to ${pad(to)}:59${suffix}`;
  }

  // Fixed times.
  if (spec.minute.length * spec.hour.length > 6) {
    if (singleMinute != null && /^\d+-\d+$/.test(hourF)) {
      return `Hourly at :${pad(singleMinute)} from ${pad(spec.hour[0]!)}:00 to ${pad(spec.hour[spec.hour.length - 1]!)}:${pad(singleMinute)}${suffix}`;
    }
    return null;
  }
  const times = spec.hour.flatMap((h) => spec.minute.map((m) => `${pad(h)}:${pad(m)}`));
  const at = `at ${joinList(times)}`;
  if (days.everyDay) return `Every day ${at}`;
  const phrase = days.phrase!;
  if (phrase === "on weekdays") return `Weekdays ${at}`;
  if (phrase === "on weekends") return `Weekends ${at}`;
  if (spec.dowRestricted && !spec.domRestricted && spec.dow.size === 1 && spec.fields[3]!.startsWith("*")) {
    return `Every ${DAY_NAMES[[...spec.dow][0]!]} ${at}`;
  }
  return `${phrase[0]!.toUpperCase()}${phrase.slice(1)} ${at}`;
}
