/**
 * Data behind GET /ui/api/overview: what needs attention, what is running,
 * what comes next, and today's totals.
 */

import { getControlStatus } from "../../../lib/kill-switch";
import { resolveTimezone, zonedDateString, zonedDayStartUtc } from "../../../lib/timezone";
import type { HarnessSessionStore, HistoryEntry, SessionRef } from "../../../lib/harness";
import { elapsedMs, getDb, home, sessionStore, storedSession, toIso, toSqlite } from "../shared/env";
import { getIntegrationHealth, type HealthState } from "../shared/integrations";
import { nextRuns, parseCron } from "../shared/cron";
import { RUNS_BASE } from "../shared/runs";

export { toSqlite };

/** A run is stuck when its transcript has been silent this long (trigger-runner treats 10 min as stale). */
export const STUCK_SILENCE_MS = 10 * 60_000;
/** A time reminder this far past fire_at means the minutely reminder check is not running. */
export const OVERDUE_REMINDER_MS = 5 * 60_000;
const ATTENTION_WINDOW_MS = 24 * 3600_000;
/** usage-webhook deliveries are retried while attempts <= 5 (trigger-runner). */
const WEBHOOK_MAX_ATTEMPTS = 5;
const EVENT_FIRE_AT = "9999-12-31 23:59:59";

export interface FailedRun {
  id: number;
  triggerName: string;
  startedAt: string | null;
  durationMs: number | null;
  costUsd: number | null;
  /** Last assistant text of the transcript, truncated. */
  summary: string | null;
}

export interface WebhookFailure {
  id: number;
  url: string;
  attempts: number;
  gaveUp: boolean;
  lastError: string | null;
  createdAt: string | null;
  nextRetryAt: string | null;
}

export interface OverviewRun {
  id: number;
  triggerName: string;
  triggerType: string | null;
  channel: string | null;
  sessionKey: string;
  sessionId: string | null;
  startedAt: string | null;
  elapsedMs: number | null;
  /** mtime of the session transcript; null before the session exists. */
  lastActivityAt: string | null;
  stuck: boolean;
  /** Short payload preview (first line, truncated). */
  payloadPreview: string | null;
}

export interface DownIntegration {
  key: string;
  label: string;
  state: HealthState;
  detail: string;
}

export interface OverdueReminder {
  id: number;
  title: string;
  fireAt: string | null;
}

export interface InvalidSchedule {
  triggerName: string;
  schedule: string;
}

export interface UpcomingItem {
  kind: "cron" | "reminder";
  at: string;
  title: string;
  /** Trigger the item runs (cron trigger, or the reminder's target trigger). */
  triggerName: string | null;
  /** Cron expression, or "every 1h" for recurring reminders. */
  schedule: string | null;
  channel: string | null;
  reminderId: number | null;
}

export interface WaitingReminder {
  id: number;
  title: string;
  /** time | reply | email_reply | script_check | … */
  triggerType: string;
  triggerName: string | null;
  createdAt: string | null;
  timeoutAt: string | null;
}

export interface TodayTotals {
  runs: number;
  failed: number;
  costUsd: number;
  messages: number;
  costYesterdayUsd: number;
}

export interface FullVolume {
  label: string;
  path: string;
  usedPercent: number;
  freeBytes: number;
  status: "warn" | "error";
}

export interface OverviewResponse {
  serverTime: string;
  /** Calendar date (YYYY-MM-DD) in `timeZone` that `totals` cover; use it for activity/usage links. */
  today: string;
  /** IANA zone `today` and every cron/reminder time is computed in (lib/timezone.ts's resolveTimezone). */
  timeZone: string;
  paused: boolean;
  attention: {
    failedRuns: FailedRun[];
    /** Total failed runs in the last 24h (failedRuns is capped). */
    failedRunsTotal: number;
    webhookFailures: WebhookFailure[];
    integrationsDown: DownIntegration[];
    stuckRuns: OverviewRun[];
    overdueReminders: OverdueReminder[];
    invalidSchedules: InvalidSchedule[];
    /** Filesystems at or above the storage warn threshold. */
    volumesFull: FullVolume[];
  };
  running: OverviewRun[];
  upcoming: UpcomingItem[];
  waiting: WaitingReminder[];
  totals: TodayTotals;
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function formatInterval(seconds: number): string {
  if (seconds % 86400 === 0) return `every ${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `every ${seconds / 3600}h`;
  if (seconds % 60 === 0) return `every ${seconds / 60}m`;
  return `every ${seconds}s`;
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

/** Last assistant message text of a session, from the history tail only. */
function lastAssistantText(sessions: HarnessSessionStore, ref: SessionRef, maxBytes = 64 * 1024): string | null {
  const texts = (sessions.excerpt(ref, { from: "end", maxBytes })?.entries ?? []).filter(
    (e): e is Extract<HistoryEntry, { kind: "assistant-text" }> => e.kind === "assistant-text" && !!e.text.trim(),
  );
  const last = texts.at(-1);
  if (!last) return null;
  // One message can store several text blocks.
  const message = last.messageId ? texts.filter((e) => e.messageId === last.messageId) : [last];
  return truncate(message.map((e) => e.text).join(" ").trim().replace(/\s+/g, " "), 200);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function tableColumns(table: string): Set<string> {
  const rows = getDb().query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function failedRuns(now: Date, limit: number): { items: FailedRun[]; total: number } {
  const sessions = sessionStore();
  const since = toSqlite(new Date(now.getTime() - ATTENTION_WINDOW_MS));
  const db = getDb();
  const where = `FROM (${RUNS_BASE}) WHERE outcome = 'failed' AND started_at >= ?`;
  const total = (db.query(`SELECT COUNT(*) AS c ${where}`).get(since) as { c: number }).c;
  const rows = db
    .query(
      `SELECT id, trigger_name, session_id, started_at, completed_at, duration_ms, cost_usd
       ${where} ORDER BY started_at DESC LIMIT ?`,
    )
    .all(since, limit) as Array<{
    id: number;
    trigger_name: string;
    session_id: string;
    started_at: string | null;
    completed_at: string | null;
    duration_ms: number | null;
    cost_usd: number | null;
  }>;
  return {
    total,
    items: rows.map((r) => {
      const history = storedSession(sessions, r.session_id);
      return {
        id: r.id,
        triggerName: r.trigger_name,
        startedAt: toIso(r.started_at),
        durationMs: r.duration_ms ?? elapsedMs(r.started_at, r.completed_at),
        costUsd: r.cost_usd,
        summary: history ? lastAssistantText(sessions, history) : null,
      };
    }),
  };
}

function webhookFailures(): WebhookFailure[] {
  const rows = getDb()
    .query(`SELECT id, url, attempts, last_error, created_at, next_retry_at FROM webhook_queue ORDER BY created_at DESC LIMIT 20`)
    .all() as Array<{ id: number; url: string; attempts: number; last_error: string | null; created_at: string; next_retry_at: string }>;
  return rows.map((r) => ({
    id: r.id,
    // Never leak credentials embedded in the URL
    url: r.url.replace(/\/\/[^/@]*@/, "//"),
    attempts: r.attempts,
    gaveUp: r.attempts > WEBHOOK_MAX_ATTEMPTS,
    lastError: r.last_error,
    createdAt: toIso(r.created_at),
    nextRetryAt: toIso(r.next_retry_at),
  }));
}

export function runningRuns(now: Date): OverviewRun[] {
  const sessions = sessionStore();
  const rows = getDb()
    .query(
      `SELECT r.id, r.trigger_name, r.session_key, r.session_id, r.payload, r.started_at, t.type, t.channel
       FROM trigger_runs r LEFT JOIN triggers t ON t.name = r.trigger_name
       WHERE r.completed_at IS NULL ORDER BY r.started_at DESC`,
    )
    .all() as Array<{
    id: number;
    trigger_name: string;
    session_key: string;
    session_id: string | null;
    payload: string | null;
    started_at: string | null;
    type: string | null;
    channel: string | null;
  }>;
  return rows.map((r) => {
    const ref = sessions.ref(r.session_id);
    const lastActivityAt = ref ? sessions.metadata(ref)?.lastActivityAt : null;
    const lastActivity = lastActivityAt ? Date.parse(lastActivityAt) : null;
    const startedIso = toIso(r.started_at);
    const startedMs = startedIso ? Date.parse(startedIso) : null;
    const lastSignal = lastActivity ?? startedMs;
    const preview = r.payload ? truncate(r.payload.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), 120) : null;
    return {
      id: r.id,
      triggerName: r.trigger_name,
      triggerType: r.type,
      channel: r.channel,
      sessionKey: r.session_key,
      sessionId: r.session_id,
      startedAt: startedIso,
      elapsedMs: startedMs != null ? now.getTime() - startedMs : null,
      lastActivityAt: lastActivity != null ? new Date(lastActivity).toISOString() : null,
      stuck: lastSignal != null && now.getTime() - lastSignal > STUCK_SILENCE_MS,
      payloadPreview: preview || null,
    };
  });
}

function schedule(now: Date, limit: number, timeZone: string) {
  const db = getDb();
  const upcoming: UpcomingItem[] = [];
  const invalidSchedules: InvalidSchedule[] = [];

  const crons = db
    .query(`SELECT name, schedule, channel, description FROM triggers WHERE type = 'cron' AND enabled = 1 ORDER BY name`)
    .all() as Array<{ name: string; schedule: string | null; channel: string | null; description: string | null }>;
  for (const t of crons) {
    // parseCron rejects what sync-crontab.ts would drop, so an invalid schedule never runs.
    const parsed = parseCron(t.schedule ?? "");
    if (!parsed.ok) {
      invalidSchedules.push({ triggerName: t.name, schedule: t.schedule ?? "" });
      continue;
    }
    const next = nextRuns(parsed.spec, 1, now, timeZone)[0];
    if (next) {
      upcoming.push({
        kind: "cron",
        at: next.toISOString(),
        title: t.description || t.name,
        triggerName: t.name,
        schedule: t.schedule,
        channel: t.channel,
        reminderId: null,
      });
    }
  }

  const cols = tableColumns("reminders");
  const opt = (c: string, alias = c) => (cols.has(c) ? c : `NULL AS ${alias}`);
  const reminders = db
    .query(
      `SELECT id, title, fire_at, channel, created_at, ${opt("trigger_name")}, ${opt("trigger_type")},
              ${opt("recurring_interval_seconds")}, ${opt("timeout_at")}
       FROM reminders WHERE status = 'pending' ORDER BY fire_at ASC`,
    )
    .all() as Array<{
    id: number;
    title: string;
    fire_at: string;
    channel: string | null;
    created_at: string | null;
    trigger_name: string | null;
    trigger_type: string | null;
    recurring_interval_seconds: number | null;
    timeout_at: string | null;
  }>;

  const waiting: WaitingReminder[] = [];
  const overdueReminders: OverdueReminder[] = [];
  const overdueBefore = toSqlite(new Date(now.getTime() - OVERDUE_REMINDER_MS));
  for (const r of reminders) {
    const type = r.trigger_type || "time";
    if (type !== "time" || r.fire_at >= EVENT_FIRE_AT) {
      waiting.push({
        id: r.id,
        title: r.title,
        triggerType: type,
        triggerName: r.trigger_name,
        createdAt: toIso(r.created_at),
        timeoutAt: toIso(r.timeout_at),
      });
      continue;
    }
    if (r.fire_at < overdueBefore) {
      overdueReminders.push({ id: r.id, title: r.title, fireAt: toIso(r.fire_at) });
      continue;
    }
    upcoming.push({
      kind: "reminder",
      at: toIso(r.fire_at)!,
      title: r.title,
      triggerName: r.trigger_name,
      schedule: r.recurring_interval_seconds ? formatInterval(r.recurring_interval_seconds) : null,
      channel: r.channel,
      reminderId: r.id,
    });
  }

  upcoming.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return { upcoming: upcoming.slice(0, limit), waiting, overdueReminders, invalidSchedules };
}

function totals(now: Date, timeZone: string): TodayTotals {
  const db = getDb();
  const todayDate = zonedDateString(now, timeZone);
  const today = toSqlite(zonedDayStartUtc(todayDate, timeZone));
  const yesterday = toSqlite(zonedDayStartUtc(todayDate, timeZone, -1));
    const failed = (
    db
      .query(
        `SELECT COUNT(*) AS c FROM (${RUNS_BASE}) WHERE started_at >= ? AND outcome = 'failed'`,
      )
      .get(today) as { c: number }
  ).c;
  const runCount = (db.query(`SELECT COUNT(*) AS c FROM trigger_runs WHERE started_at >= ?`).get(today) as { c: number }).c;
  const cost = db
    .query(
      `SELECT COALESCE(SUM(CASE WHEN julianday(started_at) >= julianday(?1) THEN cost_usd END), 0) AS today,
              COALESCE(SUM(CASE WHEN julianday(started_at) < julianday(?1) THEN cost_usd END), 0) AS yesterday
       FROM session_metrics WHERE julianday(started_at) >= julianday(?2)`,
    )
    .get(today, yesterday) as { today: number; yesterday: number };
  const messages = (db.query(`SELECT COUNT(*) AS c FROM messages WHERE created_at >= ?`).get(today) as { c: number }).c;
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return { runs: runCount, failed, costUsd: round(cost.today), costYesterdayUsd: round(cost.yesterday), messages };
}

export function getOverview(
  now = new Date(),
  opts: { upcomingLimit?: number; failedLimit?: number; volumesFull?: FullVolume[] } = {},
): OverviewResponse {
  const timeZone = resolveTimezone(home()).timeZone;
  const running = runningRuns(now);
  const failed = failedRuns(now, opts.failedLimit ?? 5);
  const sched = schedule(now, opts.upcomingLimit ?? 8, timeZone);
  const paused = getControlStatus(getDb(), home()).paused;

  const integrationsDown = getIntegrationHealth()
    .filter((i) => i.configured && (i.state === "stopped" || i.state === "degraded"))
    .map((i) => ({ key: i.key, label: i.label, state: i.state, detail: i.detail }));

  return {
    serverTime: now.toISOString(),
    today: zonedDateString(now, timeZone),
    timeZone,
    paused,
    attention: {
      failedRuns: failed.items,
      failedRunsTotal: failed.total,
      webhookFailures: webhookFailures(),
      integrationsDown,
      stuckRuns: running.filter((r) => r.stuck),
      overdueReminders: sched.overdueReminders,
      invalidSchedules: sched.invalidSchedules,
      volumesFull: opts.volumesFull ?? [],
    },
    running,
    upcoming: sched.upcoming,
    waiting: sched.waiting,
    totals: totals(now, timeZone),
  };
}
