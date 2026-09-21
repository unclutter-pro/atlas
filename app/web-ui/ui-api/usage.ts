/**
 * /ui/api/usage/* — cost and token aggregates from session_metrics
 * (frontend/pages/usage/). Aggregates only; individual sessions live in Activity.
 *
 *   GET /ui/api/usage?range=7d|30d|90d|custom&from=&to=&trigger=&type=
 *   GET /ui/api/usage/export.csv?(same filters)&status=ok|failed
 *
 * `type` is the cause of the session: the trigger's type (cron | webhook |
 * manual), `direct` for sessions started outside a trigger, `other` for
 * trigger sessions whose trigger no longer exists.
 */

import { resolveTimezone, zonedDateString, zonedDayStartUtc } from "../../lib/timezone";
import { getDb, home, toIso } from "./shared/env";
import { badRequest, csv, handler, json, query, type ApiRoutes } from "./shared/http";

export const USAGE_RANGES = ["7d", "30d", "90d"] as const;
export type UsageRangeKey = (typeof USAGE_RANGES)[number] | "custom";
export const USAGE_TYPES = ["cron", "webhook", "manual", "direct", "other"] as const;
export type UsageType = (typeof USAGE_TYPES)[number];

const DEFAULT_RANGE = "30d";
const MAX_DAYS = 366;
const DAY_MS = 86_400_000;

export interface UsageTotals {
  costUsd: number;
  runs: number;
  errors: number;
  /** errors / runs, null without runs. */
  errorRate: number | null;
  avgCostUsd: number | null;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** input + output (cache tokens reported separately). */
  tokens: number;
}

export interface UsageDay {
  date: string;
  costUsd: number;
  runs: number;
  errors: number;
  tokens: number;
}

export interface UsageBreakdownRow {
  costUsd: number;
  runs: number;
  errors: number;
  tokens: number;
  avgDurationMs: number | null;
  /** Share of the period's total cost (0..1). */
  share: number;
}

export interface UsageResponse {
  range: { key: UsageRangeKey; from: string; to: string; days: number };
  previous: { from: string; to: string };
  filter: { trigger: string | null; type: UsageType | null };
  totals: UsageTotals;
  previousTotals: UsageTotals;
  /** One entry per day from..to (UTC), gaps filled with zeros. */
  series: UsageDay[];
  /** trigger null = sessions without a trigger (direct). */
  byTrigger: Array<UsageBreakdownRow & { trigger: string | null; type: UsageType }>;
  byType: Array<UsageBreakdownRow & { type: UsageType }>;
  /** First day with any metrics, for the empty state. */
  firstDate: string | null;
  /** IANA zone `range`, `previous` and `series` dates are bucketed in (lib/timezone.ts's resolveTimezone). */
  timeZone: string;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export interface UsageFilter {
  key: UsageRangeKey;
  from: string;
  to: string;
  days: number;
  trigger: string | null;
  type: UsageType | null;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

function parseDay(v: string, name: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(dayMs(v)) || isoDay(dayMs(v)) !== v) badRequest(`Invalid ${name}: expected YYYY-MM-DD`);
  return v;
}

/** Resolve range/from/to/trigger/type from the query string (dates are calendar days in `timeZone`, inclusive). */
export function parseUsageFilter(q: URLSearchParams, now = Date.now(), timeZone = "UTC"): UsageFilter {
  const rawFrom = q.get("from") || "";
  const rawTo = q.get("to") || "";
  const key = (q.get("range") || (rawFrom || rawTo ? "custom" : DEFAULT_RANGE)) as UsageRangeKey;
  const today = zonedDateString(new Date(now), timeZone);
  let from: string;
  let to: string;

  if (key === "custom") {
    to = rawTo ? parseDay(rawTo, "to") : today;
    from = rawFrom ? parseDay(rawFrom, "from") : isoDay(dayMs(to) - 29 * DAY_MS);
    if (from > to) badRequest("from must not be after to");
  } else if ((USAGE_RANGES as readonly string[]).includes(key)) {
    const n = Number.parseInt(key, 10);
    to = today;
    from = isoDay(dayMs(today) - (n - 1) * DAY_MS);
  } else {
    return badRequest(`Invalid range: expected ${[...USAGE_RANGES, "custom"].join(", ")}`);
  }
  const days = Math.round((dayMs(to) - dayMs(from)) / DAY_MS) + 1;
  if (days > MAX_DAYS) badRequest(`Range too long (max ${MAX_DAYS} days)`);

  const trigger = q.get("trigger") || null;
  const rawType = q.get("type") || null;
  if (rawType && !(USAGE_TYPES as readonly string[]).includes(rawType)) badRequest(`Invalid type: expected ${USAGE_TYPES.join(", ")}`);
  return { key, from, to, days, trigger, type: rawType as UsageType | null };
}

// session_metrics joined with triggers to classify each session by cause.
const TYPE_EXPR = `CASE WHEN m.session_type = 'direct' THEN 'direct'
  WHEN t.type IN ('cron', 'webhook', 'manual') THEN t.type ELSE 'other' END`;
const FROM = `FROM session_metrics m LEFT JOIN triggers t ON t.name = m.trigger_name`;

function where(f: { from: string; to: string; trigger: string | null; type: string | null }, timeZone: string, status?: "ok" | "failed" | null) {
  // Bucket by session start, like Activity. SQLite has no tz database, so the
  // from/to calendar days (in `timeZone`) are converted to UTC instant bounds
  // here rather than compared with SQLite's date() (which would read the
  // stored UTC timestamp as if it were already a `timeZone` calendar date).
  // strftime('%s', ...) accepts both stored formats (SQLite space, ISO 'T'/'Z').
  const fromSec = Math.floor(zonedDayStartUtc(f.from, timeZone).getTime() / 1000);
  const toSecExclusive = Math.floor(zonedDayStartUtc(f.to, timeZone, 1).getTime() / 1000);
  const parts = ["CAST(strftime('%s', m.started_at) AS INTEGER) >= ?", "CAST(strftime('%s', m.started_at) AS INTEGER) < ?"];
  const values: (string | number)[] = [fromSec, toSecExclusive];
  if (f.trigger) {
    parts.push("m.trigger_name = ?");
    values.push(f.trigger);
  }
  if (f.type) {
    parts.push(`(${TYPE_EXPR}) = ?`);
    values.push(f.type);
  }
  if (status === "ok") parts.push("m.is_error = 0");
  if (status === "failed") parts.push("m.is_error = 1");
  return { sql: `WHERE ${parts.join(" AND ")}`, values };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const AGG = `COUNT(*) AS runs,
  COALESCE(SUM(m.cost_usd), 0) AS cost,
  COALESCE(SUM(m.is_error), 0) AS errors,
  COALESCE(SUM(m.duration_ms), 0) AS duration,
  COALESCE(SUM(m.input_tokens), 0) AS input,
  COALESCE(SUM(m.output_tokens), 0) AS output,
  COALESCE(SUM(m.cache_read_tokens), 0) AS cache_read,
  COALESCE(SUM(m.cache_creation_tokens), 0) AS cache_create`;

interface AggRow {
  runs: number;
  cost: number;
  errors: number;
  duration: number;
  input: number;
  output: number;
  cache_read: number;
  cache_create: number;
}

function toTotals(r: AggRow): UsageTotals {
  return {
    costUsd: r.cost,
    runs: r.runs,
    errors: r.errors,
    errorRate: r.runs ? r.errors / r.runs : null,
    avgCostUsd: r.runs ? r.cost / r.runs : null,
    durationMs: r.duration,
    inputTokens: r.input,
    outputTokens: r.output,
    cacheReadTokens: r.cache_read,
    cacheCreationTokens: r.cache_create,
    tokens: r.input + r.output,
  };
}

function breakdown(r: AggRow, total: number): UsageBreakdownRow {
  return {
    costUsd: r.cost,
    runs: r.runs,
    errors: r.errors,
    tokens: r.input + r.output,
    avgDurationMs: r.runs ? r.duration / r.runs : null,
    share: total > 0 ? r.cost / total : 0,
  };
}

export function loadUsage(f: UsageFilter, timeZone = "UTC"): UsageResponse {
  const db = getDb();
  const w = where(f, timeZone);
  const prevTo = isoDay(dayMs(f.from) - DAY_MS);
  const prevFrom = isoDay(dayMs(f.from) - f.days * DAY_MS);
  const pw = where({ ...f, from: prevFrom, to: prevTo }, timeZone);

  const totals = toTotals(db.query(`SELECT ${AGG} ${FROM} ${w.sql}`).get(...w.values) as AggRow);
  const previousTotals = toTotals(db.query(`SELECT ${AGG} ${FROM} ${pw.sql}`).get(...pw.values) as AggRow);

  // Group by zone-local day in JS: SQLite has no tz database, so date()
  // can only bucket by UTC calendar day, which would misplace rows near
  // midnight in any other zone (and across DST).
  const rawRows = db
    .query(
      `SELECT m.started_at AS started_at, m.cost_usd AS cost, m.is_error AS errors, m.duration_ms AS duration,
              m.input_tokens AS input, m.output_tokens AS output, m.cache_read_tokens AS cache_read, m.cache_creation_tokens AS cache_create
       ${FROM} ${w.sql}`,
    )
    .all(...w.values) as Array<{ started_at: string; cost: number | null; errors: number | null; duration: number | null; input: number | null; output: number | null; cache_read: number | null; cache_create: number | null }>;
  const byDay = new Map<string, AggRow>();
  for (const r of rawRows) {
    const iso = toIso(r.started_at);
    const day = iso ? zonedDateString(new Date(iso), timeZone) : null;
    if (!day) continue;
    const acc = byDay.get(day) ?? { runs: 0, cost: 0, errors: 0, duration: 0, input: 0, output: 0, cache_read: 0, cache_create: 0 };
    acc.runs += 1;
    acc.cost += r.cost ?? 0;
    acc.errors += r.errors ?? 0;
    acc.duration += r.duration ?? 0;
    acc.input += r.input ?? 0;
    acc.output += r.output ?? 0;
    acc.cache_read += r.cache_read ?? 0;
    acc.cache_create += r.cache_create ?? 0;
    byDay.set(day, acc);
  }
  const series: UsageDay[] = [];
  for (let i = 0; i < f.days; i++) {
    const date = isoDay(dayMs(f.from) + i * DAY_MS);
    const r = byDay.get(date);
    series.push({ date, costUsd: r?.cost ?? 0, runs: r?.runs ?? 0, errors: r?.errors ?? 0, tokens: r ? r.input + r.output : 0 });
  }

  const byTrigger = (
    db
      .query(`SELECT m.trigger_name AS trigger, ${TYPE_EXPR} AS type, ${AGG} ${FROM} ${w.sql} GROUP BY m.trigger_name, type ORDER BY cost DESC, runs DESC`)
      .all(...w.values) as Array<AggRow & { trigger: string | null; type: UsageType }>
  ).map((r) => ({ trigger: r.trigger, type: r.type, ...breakdown(r, totals.costUsd) }));

  const byType = (
    db.query(`SELECT ${TYPE_EXPR} AS type, ${AGG} ${FROM} ${w.sql} GROUP BY type ORDER BY cost DESC, runs DESC`).all(...w.values) as Array<
      AggRow & { type: UsageType }
    >
  ).map((r) => ({ type: r.type, ...breakdown(r, totals.costUsd) }));

  const first = db.query(`SELECT MIN(started_at) AS d FROM session_metrics`).get() as { d: string | null };
  const firstIso = first.d ? toIso(first.d) : null;

  return {
    range: { key: f.key, from: f.from, to: f.to, days: f.days },
    previous: { from: prevFrom, to: prevTo },
    filter: { trigger: f.trigger, type: f.type },
    totals,
    previousTotals,
    series,
    byTrigger,
    byType,
    firstDate: firstIso ? zonedDateString(new Date(firstIso), timeZone) : null,
    timeZone,
  };
}

// Same columns as the legacy /analytics.csv export.
const CSV_COLUMNS = [
  "session_type",
  "session_id",
  "trigger_name",
  "started_at",
  "ended_at",
  "duration_ms",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "cost_usd",
  "num_turns",
  "is_error",
  "created_at",
];
const CSV_LIMIT = 10_000;

function exportCsv(req: Request): Response {
  const q = query(req);
  const timeZone = resolveTimezone(home()).timeZone;
  const f = parseUsageFilter(q, Date.now(), timeZone);
  const rawStatus = q.get("status") || "";
  // "err" is the legacy spelling
  const status = rawStatus === "ok" ? "ok" : rawStatus === "failed" || rawStatus === "err" ? "failed" : rawStatus ? badRequest("Invalid status: expected ok or failed") : null;
  const w = where(f, timeZone, status);
  const rows = getDb()
    .query(`SELECT ${CSV_COLUMNS.map((c) => `m.${c}`).join(", ")} ${FROM} ${w.sql} ORDER BY m.started_at DESC LIMIT ${CSV_LIMIT}`)
    .all(...w.values) as Record<string, unknown>[];
  return csv(
    `usage-${f.from}-${f.to}.csv`,
    CSV_COLUMNS,
    rows.map((r) => CSV_COLUMNS.map((c) => r[c])),
  );
}

export const routes: ApiRoutes = {
  "/ui/api/usage": {
    GET: handler((req) => {
      const timeZone = resolveTimezone(home()).timeZone;
      return json(loadUsage(parseUsageFilter(query(req), Date.now(), timeZone), timeZone));
    }),
  },
  "/ui/api/usage/export.csv": { GET: handler(exportCsv) },
};
