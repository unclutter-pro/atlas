/**
 * Value formatting: time, money, duration, numbers. Components for JSX,
 * plain functions for strings (CSV, titles, tooltips).
 */

import { useEffect, useState } from "react";

export type TimeInput = string | number | Date | null | undefined;

// ---------------------------------------------------------------------------
// Atlas time zone
// ---------------------------------------------------------------------------

/**
 * The zone every absolute-time display uses (not the browser's), fetched
 * once from GET /ui/api/meta. `null` until it resolves — callers fall back
 * to the browser's zone for that first render, then re-render once it lands.
 */
let atlasTimeZone: string | null = null;
let timeZoneRequested = false;

function ensureTimeZoneLoaded(): void {
  if (timeZoneRequested) return;
  timeZoneRequested = true;
  fetch("/ui/api/meta")
    .then((r) => r.json())
    .then((data: { timeZone?: unknown }) => {
      if (typeof data?.timeZone === "string" && data.timeZone) {
        atlasTimeZone = data.timeZone;
        listeners.forEach((l) => l());
      }
    })
    .catch(() => {});
}

/** Current resolved Atlas zone, or null before GET /ui/api/meta has answered. */
export function getTimeZone(): string | null {
  return atlasTimeZone;
}

/** Spread into Intl/toLocale* options so a call site follows the Atlas zone once known. */
export function zoneOptions(): { timeZone?: string } {
  return atlasTimeZone ? { timeZone: atlasTimeZone } : {};
}

function zonedParts(d: Date, timeZone: string) {
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
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** "YYYY-MM-DD" in the Atlas zone (browser zone until it loads). */
function zonedYMD(d: Date): string {
  if (!atlasTimeZone) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const p = zonedParts(d, atlasTimeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "YYYY-MM-DD" `offsetDays` from now, in the Atlas zone — for "last N days" quick filters. */
export function todayYMD(offsetDays = 0): string {
  ensureTimeZoneLoaded();
  return zonedYMD(new Date(Date.now() + offsetDays * 86_400_000));
}

/** Parse ISO, SQLite "YYYY-MM-DD HH:MM:SS" (UTC), epoch ms, or Date. */
export function parseTime(v: TimeInput): Date | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === "number") return new Date(v);
  let s = v.trim();
  const day = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])); // local midnight
  if (/^\d{4}-\d{2}-\d{2} \d/.test(s)) s = s.replace(" ", "T");
  if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s += "Z"; // no zone → UTC (SQLite)
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD HH:MM:SS" in the Atlas zone (browser zone until GET /ui/api/meta answers). */
export function formatAbsolute(v: TimeInput): string {
  ensureTimeZoneLoaded();
  const d = parseTime(v);
  if (!d) return "";
  if (atlasTimeZone) {
    const p = zonedParts(d, atlasTimeZone);
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** "just now", "5m ago", "in 3h", "2d ago"; older than a week → "Sep 12" / "Sep 12, 2025" (Atlas zone). */
export function formatRelative(v: TimeInput, now = Date.now()): string {
  ensureTimeZoneLoaded();
  const d = parseTime(v);
  if (!d) return "—";
  const diff = now - d.getTime();
  const future = diff < 0;
  const s = Math.abs(diff) / 1000;
  const wrap = (x: string) => (future ? `in ${x}` : `${x} ago`);
  if (s < 45) return future ? "in a moment" : "just now";
  if (s < 3600) return wrap(`${Math.round(s / 60)}m`);
  if (s < 86400) return wrap(`${Math.round(s / 3600)}h`);
  if (s < 7 * 86400) return wrap(`${Math.round(s / 86400)}d`);
  const sameYear = new Date(d.getTime()).toLocaleDateString("en-US", { year: "numeric", ...zoneOptions() }) === new Date(now).toLocaleDateString("en-US", { year: "numeric", ...zoneOptions() });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), ...zoneOptions() });
}

// One shared ticker so every <Time> re-renders together.
const listeners = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const cb = () => setNow(Date.now());
    listeners.add(cb);
    ticker ??= setInterval(() => listeners.forEach((l) => l()), intervalMs);
    return () => {
      listeners.delete(cb);
      if (listeners.size === 0 && ticker) {
        clearInterval(ticker);
        ticker = null;
      }
    };
  }, [intervalMs]);
  return now;
}

/** Relative time with the absolute time (Atlas zone) as tooltip. `mode="absolute"` shows the full timestamp. */
export function Time(props: { value: TimeInput; mode?: "relative" | "absolute" | "date"; className?: string }) {
  const now = useNow();
  const d = parseTime(props.value);
  if (!d) return <span className={props.className}>—</span>;
  const abs = formatAbsolute(d);
  const text = props.mode === "absolute" ? abs : props.mode === "date" ? abs.slice(0, 10) : formatRelative(d, now);
  return (
    <time dateTime={d.toISOString()} title={abs} className={props.className}>
      {text}
    </time>
  );
}

/** "$0.004", "$0.42", "$12.30", "$1,234". */
export function formatMoney(usd: number | null | undefined): string {
  if (usd == null || isNaN(usd)) return "—";
  if (usd === 0) return "$0.00";
  const abs = Math.abs(usd);
  if (abs < 0.01) return `$${usd.toFixed(3)}`;
  if (abs >= 1000) return `$${Math.round(usd).toLocaleString("en-US")}`;
  return `$${usd.toFixed(2)}`;
}

export function Money(props: { usd: number | null | undefined; className?: string }) {
  return <span className={`num ${props.className ?? ""}`} title={props.usd != null ? `$${props.usd.toFixed(6)}` : undefined}>{formatMoney(props.usd)}</span>;
}

/** "850ms", "12.3s", "4m 05s", "1h 02m", "2d 3h". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || isNaN(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad(Math.floor(s % 60))}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${pad(m % 60)}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function Duration(props: { ms: number | null | undefined; className?: string }) {
  return <span className={`num ${props.className ?? ""}`}>{formatDuration(props.ms)}</span>;
}

/** Thousands separators; `compact` → "12.3k", "1.2M". */
export function formatNumber(n: number | null | undefined, compact = false): string {
  if (n == null || isNaN(n)) return "—";
  if (compact && Math.abs(n) >= 1000) {
    const units = [
      [1e9, "B"],
      [1e6, "M"],
      [1e3, "k"],
    ] as const;
    for (const [v, u] of units) if (Math.abs(n) >= v) return `${(n / v).toFixed(n / v < 10 ? 1 : 0)}${u}`;
  }
  return n.toLocaleString("en-US");
}

export function Num(props: { value: number | null | undefined; compact?: boolean; className?: string }) {
  return (
    <span className={`num ${props.className ?? ""}`} title={props.compact && props.value != null ? props.value.toLocaleString("en-US") : undefined}>
      {formatNumber(props.value, props.compact)}
    </span>
  );
}

/** "12%" from a 0..1 ratio. */
/** File size: "812 B", "4.2 KB", "38 KB", "1.3 MB". */
const BYTE_UNITS = ["KB", "MB", "GB", "TB", "PB"];

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${BYTE_UNITS[unit]}`;
}

export function formatPercent(ratio: number | null | undefined, digits = 0): string {
  if (ratio == null || isNaN(ratio)) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}
