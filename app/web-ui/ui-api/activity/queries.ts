/**
 * Activity timeline queries. See the event model at the top of ui-api/activity.ts.
 */

import { getDb, toIso } from "../shared/env";
import { firstUserText, lastErrorHint } from "./transcript";
import { MATCH_WINDOW_SEC, RUNS_BASE } from "../shared/runs";

export type EventKind = "run" | "session" | "message";
export type Cause = "message" | "cron" | "webhook" | "manual" | "direct" | "unknown";
export type Outcome = "running" | "ok" | "failed" | "injected" | "unhandled";

export interface ActivityItem {
  /** "<kind>:<id>" — unique across the timeline. */
  key: string;
  kind: EventKind;
  /** When the cause happened (run start, session start, message received). ISO. */
  at: string | null;
  cause: Cause;
  channel: string | null;
  trigger: string | null;
  /** False when the trigger row was deleted since. */
  triggerExists: boolean;
  summary: string;
  outcome: Outcome;
  /** Short failure reason for failed runs (best effort, from the transcript). */
  error: string | null;
  durationMs: number | null;
  costUsd: number | null;
  runId: number | null;
  sessionId: string | null;
  sessionKey: string | null;
  messageId: number | null;
  sender: string | null;
  /** Message events: the run the message was injected into. */
  relatedRunId: number | null;
}

export interface ActivityFilters {
  trigger?: string;
  status?: "running" | "ok" | "failed";
  channel?: string;
  /** cron | webhook | manual (trigger type), direct (sessions without trigger), trigger (all runs) */
  type?: string;
  /** Unix seconds, inclusive lower / exclusive upper bound. */
  fromSec?: number;
  toSec?: number;
  q?: string;
}

/** Position in the timeline order: ts DESC, rank ASC, id DESC. */
interface Cursor {
  ts: number;
  rank: number;
  id: number;
}

const RANK: Record<EventKind, number> = { run: 0, session: 1, message: 2 };

export function encodeCursor(c: Cursor): string {
  return `${c.ts}.${c.rank}.${c.id}`;
}

export function decodeCursor(s: string | null | undefined): Cursor | null {
  const m = s?.match(/^(\d+)\.(\d)\.(\d+)$/);
  return m ? { ts: Number(m[1]), rank: Number(m[2]), id: Number(m[3]) } : null;
}

/** A message causes a run that starts within this time after it. */
const CAUSE_WINDOW_SEC = 600;

// ---------------------------------------------------------------------------
// Runs (trigger_runs + nearest session_metrics row)
// ---------------------------------------------------------------------------

export interface RunRow {
  id: number;
  trigger_name: string;
  session_key: string;
  session_mode: string;
  session_id: string | null;
  payload: string | null;
  started_at: string | null;
  completed_at: string | null;
  t_type: string | null;
  t_channel: string | null;
  t_description: string | null;
  t_exists: number;
  m_id: number | null;
  session_type: string | null;
  m_started_at: string | null;
  m_ended_at: string | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_usd: number | null;
  num_turns: number | null;
  is_error: number | null;
  outcome: "running" | "ok" | "failed";
  ts: number;
}

function afterCursor(cursor: Cursor | null, kind: EventKind, idCol: string, params: unknown[]): string {
  if (!cursor) return "1";
  const rank = RANK[kind];
  params.push(cursor.ts, cursor.ts);
  // Same second: later rank, or same rank and lower id, comes after the cursor.
  const tie = rank > cursor.rank ? "1" : rank < cursor.rank ? "0" : `${idCol} < ${cursor.id}`;
  return `(ts < ? OR (ts = ? AND ${tie}))`;
}

function likeParam(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function getRun(id: number): RunRow | null {
  return (getDb().query(`SELECT * FROM (${RUNS_BASE}) WHERE id = ?`).get(id) as RunRow | null) ?? null;
}

export function listRunRows(where: string, params: unknown[], limit: number): RunRow[] {
  return getDb()
    .query(`SELECT * FROM (${RUNS_BASE}) WHERE ${where} ORDER BY ts DESC, id DESC LIMIT ?`)
    .all(...(params as never[]), limit) as RunRow[];
}

function fetchRuns(f: ActivityFilters, cursor: Cursor | null, limit: number): RunRow[] {
  if (f.type === "direct") return [];
  const params: unknown[] = [];
  const where: string[] = [afterCursor(cursor, "run", "id", params)];
  if (f.trigger) where.push("trigger_name = ?"), params.push(f.trigger);
  if (f.status) where.push("outcome = ?"), params.push(f.status);
  if (f.channel) where.push("t_channel = ?"), params.push(f.channel);
  if (f.type && f.type !== "trigger") where.push("t_type = ?"), params.push(f.type);
  if (f.fromSec != null) where.push("ts >= ?"), params.push(f.fromSec);
  if (f.toSec != null) where.push("ts < ?"), params.push(f.toSec);
  if (f.q) {
    const like = likeParam(f.q);
    where.push(`(payload LIKE ? ESCAPE '\\' OR trigger_name LIKE ? ESCAPE '\\' OR session_key LIKE ? ESCAPE '\\' OR session_id LIKE ? ESCAPE '\\')`);
    params.push(like, like, like, like);
  }
  return listRunRows(where.join(" AND "), params, limit);
}

// ---------------------------------------------------------------------------
// Sessions without a run (direct sessions, runs whose row is gone)
// ---------------------------------------------------------------------------

export interface SessionRow {
  id: number;
  session_type: string;
  session_id: string | null;
  trigger_name: string | null;
  started_at: string;
  ended_at: string;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_usd: number | null;
  num_turns: number | null;
  is_error: number | null;
  t_type: string | null;
  t_channel: string | null;
  t_exists: number;
  ts: number;
}

const ORPHAN_SESSIONS_BASE = `
  SELECT m.*, t.type AS t_type, t.channel AS t_channel, (t.name IS NOT NULL) AS t_exists,
    CAST(strftime('%s', m.started_at) AS INTEGER) AS ts
  FROM session_metrics m
  LEFT JOIN triggers t ON t.name = m.trigger_name
  WHERE NOT EXISTS (
    SELECT 1 FROM trigger_runs r
    WHERE ((m.session_id != '' AND r.session_id = m.session_id)
        OR (m.session_id = '' AND (r.session_id IS NULL OR r.session_id = '') AND r.trigger_name = m.trigger_name))
      AND abs(julianday(m.started_at) - julianday(r.started_at)) * 86400 <= ${MATCH_WINDOW_SEC}
  )`;

function fetchSessions(f: ActivityFilters, cursor: Cursor | null, limit: number): SessionRow[] {
  if (f.status === "running") return [];
  const params: unknown[] = [];
  const where: string[] = [afterCursor(cursor, "session", "id", params)];
  if (f.trigger) where.push("trigger_name = ?"), params.push(f.trigger);
  if (f.status === "failed") where.push("is_error = 1");
  if (f.status === "ok") where.push("COALESCE(is_error, 0) = 0");
  if (f.channel) where.push("t_channel = ?"), params.push(f.channel);
  if (f.type === "direct") where.push("session_type = 'direct'");
  else if (f.type === "trigger") where.push("session_type != 'direct'");
  else if (f.type) where.push("t_type = ?"), params.push(f.type);
  if (f.fromSec != null) where.push("ts >= ?"), params.push(f.fromSec);
  if (f.toSec != null) where.push("ts < ?"), params.push(f.toSec);
  if (f.q) {
    const like = likeParam(f.q);
    where.push(`(trigger_name LIKE ? ESCAPE '\\' OR session_id LIKE ? ESCAPE '\\' OR session_type LIKE ? ESCAPE '\\')`);
    params.push(like, like, like);
  }
  return getDb()
    .query(`SELECT * FROM (${ORPHAN_SESSIONS_BASE}) WHERE ${where.join(" AND ")} ORDER BY ts DESC, id DESC LIMIT ?`)
    .all(...(params as never[]), limit) as SessionRow[];
}

// ---------------------------------------------------------------------------
// Messages and their runs
// ---------------------------------------------------------------------------

export interface MessageRow {
  id: number;
  channel: string;
  sender: string | null;
  content: string;
  created_at: string;
  session_key: string | null;
  ts: number;
}

/** Inbox ids referenced by a run payload (signal/whatsapp `inbox-id="N"`, JSON `inbox_message_id`). */
export function payloadMessageIds(payload: string | null): number[] {
  if (!payload) return [];
  const ids = new Set<number>();
  for (const m of payload.matchAll(/inbox-id=\\?"(\d+)\\?"|"inbox_message_id"\s*:\s*(\d+)/g)) ids.add(Number(m[1] ?? m[2]));
  return [...ids];
}

interface RunCandidate {
  id: number;
  trigger_name: string;
  session_key: string;
  payload: string | null;
  t_channel: string | null;
  t_type: string | null;
  start: number;
  end: number | null;
}

function keyMatches(run: RunCandidate, msg: MessageRow): boolean {
  return run.t_channel === msg.channel && run.t_type !== "cron" && (run.session_key === msg.session_key || run.session_key === msg.sender);
}

export type MessageLink = { mode: "caused" | "injected"; runId: number } | { mode: "none"; runId: null };

/**
 * Which run did this message start (or land in)?
 *  1. a run whose payload names the message id;
 *  2. the first run of a trigger on the message's channel with the sender /
 *     session key as session key, starting within 10 minutes after it;
 *  3. otherwise a matching run that was already running: the message was
 *     injected into that live session.
 */
function linkMessage(msg: MessageRow, runs: RunCandidate[], referenced: Map<number, number>): MessageLink {
  const byPayload = referenced.get(msg.id);
  if (byPayload != null) return { mode: "caused", runId: byPayload };
  const t = msg.ts;
  let caused: RunCandidate | null = null;
  let injected: RunCandidate | null = null;
  for (const r of runs) {
    if (!keyMatches(r, msg)) continue;
    const ids = payloadMessageIds(r.payload);
    if (r.start >= t && r.start <= t + CAUSE_WINDOW_SEC && ids.length === 0) {
      if (!caused || r.start < caused.start) caused = r;
    } else if (r.start <= t && (r.end == null || r.end >= t)) {
      if (!injected || r.start > injected.start) injected = r;
    }
  }
  if (caused) return { mode: "caused", runId: caused.id };
  if (injected) return { mode: "injected", runId: injected.id };
  return { mode: "none", runId: null };
}

function runCandidates(fromSec: number, toSec: number): RunCandidate[] {
  const rows = getDb()
    .query(
      `SELECT r.id, r.trigger_name, r.session_key, r.payload, t.channel AS t_channel, t.type AS t_type,
         CAST(strftime('%s', r.started_at) AS INTEGER) AS start, CAST(strftime('%s', r.completed_at) AS INTEGER) AS end
       FROM trigger_runs r LEFT JOIN triggers t ON t.name = r.trigger_name
       WHERE r.started_at >= datetime(?, 'unixepoch') AND r.started_at <= datetime(?, 'unixepoch')`,
    )
    .all(fromSec, toSec) as RunCandidate[];
  return rows;
}

/** Link a batch of messages to runs. */
export function linkMessages(msgs: MessageRow[]): Map<number, MessageLink> {
  const out = new Map<number, MessageLink>();
  if (msgs.length === 0) return out;
  const minTs = Math.min(...msgs.map((m) => m.ts));
  const maxTs = Math.max(...msgs.map((m) => m.ts));
  // Long-running persistent sessions can start well before a message lands in them.
  const runs = runCandidates(minTs - 86400, maxTs + CAUSE_WINDOW_SEC);
  const referenced = new Map<number, number>();
  for (const r of runs) for (const id of payloadMessageIds(r.payload)) if (!referenced.has(id)) referenced.set(id, r.id);
  for (const m of msgs) out.set(m.id, linkMessage(m, runs, referenced));
  return out;
}

const MESSAGE_COLS = "id, channel, sender, content, created_at, session_key, CAST(strftime('%s', created_at) AS INTEGER) AS ts";

export function getMessage(id: number): MessageRow | null {
  return (getDb().query(`SELECT ${MESSAGE_COLS} FROM messages WHERE id = ?`).get(id) as MessageRow | null) ?? null;
}

/**
 * Messages of a run: the one that caused it plus any that arrived while it
 * ran (injected into the live session).
 */
export function messagesForRun(run: RunRow): { cause: MessageRow | null; injected: MessageRow[] } {
  const db = getDb();
  const ids = payloadMessageIds(run.payload);
  let cause: MessageRow | null = ids.length ? getMessage(ids[0]!) : null;
  const channel = run.t_channel;
  if (!channel || channel === "internal" || run.t_type === "cron") return { cause, injected: [] };

  const start = run.ts;
  const end = Math.floor((run.completed_at ? Date.parse(toIso(run.completed_at)!) : Date.now()) / 1000);
  const rows = db
    .query(
      `SELECT ${MESSAGE_COLS} FROM messages
       WHERE channel = ? AND created_at >= datetime(?, 'unixepoch') AND created_at <= datetime(?, 'unixepoch')
         AND (session_key = ? OR sender = ?)
       ORDER BY created_at ASC, id ASC`,
    )
    .all(channel, start - CAUSE_WINDOW_SEC, end, run.session_key, run.session_key) as MessageRow[];

  if (!cause && ids.length === 0) {
    // Nearest message before the start — only if it doesn't belong to an earlier run.
    const before = rows.filter((m) => m.ts <= start).reverse();
    for (const m of before) {
      const link = linkMessages([m]).get(m.id);
      if (link?.mode === "caused" && link.runId === run.id) {
        cause = m;
        break;
      }
    }
  }
  const injected = rows.filter((m) => m.ts >= start && m.id !== cause?.id && !ids.includes(m.id));
  return { cause, injected };
}

function fetchMessages(f: ActivityFilters, cursor: Cursor | null, limit: number): MessageRow[] {
  // Messages carry no status or trigger type of their own.
  if (f.status || f.type) return [];
  const params: unknown[] = [];
  const where: string[] = [afterCursor(cursor, "message", "id", params)];
  if (f.channel) where.push("channel = ?"), params.push(f.channel);
  if (f.fromSec != null) where.push("ts >= ?"), params.push(f.fromSec);
  if (f.toSec != null) where.push("ts < ?"), params.push(f.toSec);
  if (f.q) {
    const like = likeParam(f.q);
    where.push(`(content LIKE ? ESCAPE '\\' OR sender LIKE ? ESCAPE '\\')`);
    params.push(like, like);
  }
  return getDb()
    .query(`SELECT * FROM (SELECT ${MESSAGE_COLS} FROM messages) WHERE ${where.join(" AND ")} ORDER BY ts DESC, id DESC LIMIT ?`)
    .all(...(params as never[]), limit) as MessageRow[];
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

function oneLine(s: string, max = 160): string {
  const line = s
    .replace(/<\/?[a-z][a-z-]*(\s[^>]*)?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Short human summary of a webhook/manual payload. */
export function payloadSummary(payload: string | null): string {
  if (!payload) return "";
  const t = payload.trim();
  if (t.startsWith("{")) {
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      if (typeof obj.message === "string") return oneLine(obj.message);
      if (typeof obj.subject === "string") return oneLine(obj.subject);
      const parts = Object.entries(obj)
        .filter(([, v]) => v != null && typeof v !== "object")
        .slice(0, 4)
        .map(([k, v]) => `${k}: ${String(v)}`);
      if (parts.length) return oneLine(parts.join(" · "));
    } catch {}
  }
  return oneLine(t);
}

export function causeOf(triggerType: string | null, hasMessage: boolean): Cause {
  if (hasMessage) return "message";
  if (triggerType === "cron" || triggerType === "webhook" || triggerType === "manual") return triggerType;
  return "unknown";
}

function runDurationMs(r: RunRow): number | null {
  if (r.duration_ms) return r.duration_ms;
  const start = r.started_at ? Date.parse(toIso(r.started_at)!) : NaN;
  const end = r.completed_at ? Date.parse(toIso(r.completed_at)!) : r.outcome === "running" ? Date.now() : NaN;
  return Number.isNaN(start) || Number.isNaN(end) ? null : Math.max(0, end - start);
}

export function runToItem(r: RunRow, cause: MessageRow | null): ActivityItem {
  const summary = cause
    ? oneLine(cause.content)
    : r.t_type === "cron"
      ? r.t_description || "Scheduled run"
      : payloadSummary(r.payload) || r.t_description || "";
  return {
    key: `run:${r.id}`,
    kind: "run",
    at: toIso(r.started_at),
    cause: causeOf(r.t_type, !!cause),
    channel: cause?.channel ?? r.t_channel,
    trigger: r.trigger_name,
    triggerExists: !!r.t_exists,
    summary,
    outcome: r.outcome,
    error: r.outcome === "failed" ? oneLine(lastErrorHint(r.session_id, toIso(r.m_started_at ?? r.started_at), toIso(r.m_ended_at ?? r.completed_at)) ?? "", 200) || null : null,
    durationMs: runDurationMs(r),
    costUsd: r.cost_usd,
    runId: r.id,
    sessionId: r.session_id || null,
    sessionKey: r.session_key,
    messageId: cause?.id ?? null,
    sender: cause?.sender ?? null,
    relatedRunId: null,
  };
}

function sessionToItem(s: SessionRow): ActivityItem {
  const direct = s.session_type === "direct" || !s.trigger_name || s.trigger_name === "direct";
  const first = firstUserText(s.session_id);
  return {
    key: `session:${s.id}`,
    kind: "session",
    at: toIso(s.started_at),
    cause: direct ? "direct" : causeOf(s.t_type, false),
    channel: s.t_channel,
    trigger: direct ? null : s.trigger_name,
    triggerExists: !!s.t_exists,
    summary: first ? oneLine(first) : direct ? "Direct session" : "Session without run record",
    outcome: s.is_error ? "failed" : "ok",
    error: s.is_error ? oneLine(lastErrorHint(s.session_id, toIso(s.started_at), toIso(s.ended_at)) ?? "", 200) || null : null,
    durationMs: s.duration_ms,
    costUsd: s.cost_usd,
    runId: null,
    sessionId: s.session_id || null,
    sessionKey: null,
    messageId: null,
    sender: null,
    relatedRunId: null,
  };
}

function messageToItem(m: MessageRow, link: MessageLink, trigger: string | null): ActivityItem {
  return {
    key: `message:${m.id}`,
    kind: "message",
    at: toIso(m.created_at),
    cause: "message",
    channel: m.channel,
    trigger,
    triggerExists: true,
    summary: oneLine(m.content),
    outcome: link.mode === "injected" ? "injected" : "unhandled",
    error: null,
    durationMs: null,
    costUsd: null,
    runId: null,
    sessionId: null,
    sessionKey: m.session_key,
    messageId: m.id,
    sender: m.sender,
    relatedRunId: link.runId,
  };
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

interface Sourced {
  item: ActivityItem;
  cursor: Cursor;
}

function cmp(a: Cursor, b: Cursor): number {
  // Negative when a comes first in timeline order.
  return b.ts - a.ts || a.rank - b.rank || b.id - a.id;
}

/**
 * One page of the timeline, merged from three sources. Each source reads at
 * most `fetch` rows after the cursor; when a source is not exhausted, events
 * older than the last row it read are deferred to the next page so nothing
 * is skipped.
 */
export function listActivity(f: ActivityFilters, cursorStr: string | null, limit: number): { items: ActivityItem[]; nextCursor: string | null } {
  const cursor = decodeCursor(cursorStr);
  const runs = fetchRuns(f, cursor, limit);
  const sessions = fetchSessions(f, cursor, limit);
  const msgFetch = limit * 3;
  const msgs = fetchMessages(f, cursor, msgFetch);

  const out: Sourced[] = [];
  const boundaries: Cursor[] = [];

  // Runs: attach their causing message.
  for (const r of runs) {
    const { cause } = messagesForRun(r);
    out.push({ item: runToItem(r, cause), cursor: { ts: r.ts, rank: RANK.run, id: r.id } });
  }
  if (runs.length === limit) boundaries.push({ ts: runs.at(-1)!.ts, rank: RANK.run, id: runs.at(-1)!.id });

  for (const s of sessions) out.push({ item: sessionToItem(s), cursor: { ts: s.ts, rank: RANK.session, id: s.id } });
  if (sessions.length === limit) boundaries.push({ ts: sessions.at(-1)!.ts, rank: RANK.session, id: sessions.at(-1)!.id });

  // Messages: only those that did not start a run (those show up as the run's cause).
  const links = linkMessages(msgs);
  const injectedInto = new Map<number, string>();
  const relatedIds = [...new Set([...links.values()].map((l) => l.runId).filter((id): id is number => id != null))];
  if (relatedIds.length) {
    const rows = getDb().query(`SELECT id, trigger_name FROM trigger_runs WHERE id IN (${relatedIds.map(() => "?").join(",")})`).all(...relatedIds) as Array<{ id: number; trigger_name: string }>;
    for (const r of rows) injectedInto.set(r.id, r.trigger_name);
  }
  for (const m of msgs) {
    const link = links.get(m.id)!;
    if (link.mode === "caused") continue;
    const trigger = link.runId != null ? (injectedInto.get(link.runId) ?? null) : null;
    if (f.trigger && trigger !== f.trigger) continue;
    out.push({ item: messageToItem(m, link, trigger), cursor: { ts: m.ts, rank: RANK.message, id: m.id } });
  }
  if (msgs.length === msgFetch) boundaries.push({ ts: msgs.at(-1)!.ts, rank: RANK.message, id: msgs.at(-1)!.id });

  out.sort((a, b) => cmp(a.cursor, b.cursor));
  // The earliest-in-order boundary among truncated sources: nothing past it is complete.
  const boundary = boundaries.sort(cmp)[0] ?? null;
  const complete = boundary ? out.filter((s) => cmp(s.cursor, boundary) <= 0) : out;
  const page = complete.slice(0, limit);

  let next: Cursor | null = null;
  if (complete.length > limit) next = page.at(-1)!.cursor;
  else if (boundary) next = boundary;
  return { items: page.map((s) => s.item), nextCursor: next ? encodeCursor(next) : null };
}
