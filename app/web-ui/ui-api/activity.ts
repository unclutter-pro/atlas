/**
 * /ui/api/activity/* — "What happened and why?" (frontend/pages/activity/).
 *
 * Event model. The timeline merges three kinds of events, newest first:
 *
 *  - run      One row per trigger_runs row. trigger-runner inserts it when a
 *             session starts (webhooks without a key insert it earlier to get
 *             `webhook-<id>` as session key) and sets session_id+completed_at
 *             when it ends. Its metrics are the session_metrics row with the
 *             same session_id whose started_at is closest (within 2 min):
 *             persistent sessions reuse one session_id for many runs, and a
 *             run that never captured a session id matches a metrics row with
 *             an empty session_id and the same trigger. Outcome: running
 *             (completed_at NULL and no metrics yet), failed (is_error), ok.
 *             Cause: the trigger type (cron | webhook | manual), or "message"
 *             when an inbound message started it.
 *  - session  A session_metrics row no run matches: direct sessions (claude in
 *             a terminal, session_type=direct) or trigger sessions whose run row
 *             is missing. Detail page: /activity/session/:sessionId.
 *  - message  An inbound message that did NOT start a run. Messages that did
 *             start one are shown as that run's cause instead. A message is
 *             linked to a run by (1) the id in the run payload (signal and
 *             whatsapp `inbox-id="N"`, web and email `"inbox_message_id": N`),
 *             else (2) the first run of a non-cron trigger on the message's
 *             channel whose session_key is the message's session_key or sender,
 *             starting within 10 min after it. A message that arrived while
 *             such a run was already running was injected into that live
 *             session (outcome "injected"); otherwise it is "unhandled".
 *
 * Messages that arrive by IPC injection never get a run row of their own
 * (trigger-runner only inserts trigger_runs for new sessions).
 *
 * List filters (query string, all optional):
 *   trigger, status=running|ok|failed, channel (the trigger's channel, or the
 *   message channel), type=cron|webhook|manual (trigger type) | direct (only
 *   runless direct sessions) | trigger (only trigger activity), from/to
 *   (YYYY-MM-DD, inclusive calendar days in the resolved Atlas zone — see
 *   lib/timezone.ts's resolveTimezone — like Usage and Overview), q (text),
 *   cursor (opaque, from nextCursor), limit.
 */

import { existsSync } from "fs";
import { attachmentDiskPath, getAttachment, getAttachmentsForMessage, type Attachment } from "../../lib/attachments";
import { resolveTimezone, zonedDayStartUtc } from "../../lib/timezone";
import { getDb, home, toIso } from "./shared/env";
import { badRequest, handler, intParam, json, notFound, query, type ApiRoutes } from "./shared/http";
import {
  getMessage,
  getRun,
  linkMessages,
  listActivity,
  listRunRows,
  messagesForRun,
  runToItem,
  type ActivityFilters,
  type ActivityItem,
  type Cause,
  type MessageRow,
  type Outcome,
  type RunRow,
} from "./activity/queries";
import { findSessionFile, lastErrorHint, loadTranscript, SESSION_ID_RE, type Transcript } from "./activity/transcript";

export type { ActivityItem, Cause, Outcome } from "./activity/queries";
export type { Transcript, TranscriptEntry } from "./activity/transcript";

export interface ActivityListResponse {
  items: ActivityItem[];
  /** Pass back as ?cursor= to load older events; null at the end. */
  nextCursor: string | null;
}

export interface ActivityFiltersResponse {
  triggers: Array<{ name: string; type: string; channel: string | null }>;
  channels: string[];
}

export interface Metrics {
  sessionType: string | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
  numTurns: number | null;
  isError: boolean;
}

export interface AttachmentInfo {
  id: string;
  kind: string;
  mimeType: string;
  fileName: string;
  fileSize: number;
  transcription: string | null;
  /** Download URL, or null when the file is gone (attachments live in /tmp). */
  url: string | null;
}

export interface MessageInfo {
  id: number;
  channel: string;
  sender: string | null;
  sessionKey: string | null;
  content: string;
  createdAt: string | null;
  attachments: AttachmentInfo[];
}

export interface RunSummary {
  id: number;
  triggerName: string;
  startedAt: string | null;
  outcome: Outcome;
  durationMs: number | null;
  costUsd: number | null;
}

export interface RunDetailResponse {
  run: {
    id: number;
    triggerName: string;
    sessionKey: string;
    sessionMode: string;
    sessionId: string | null;
    startedAt: string | null;
    completedAt: string | null;
    outcome: Outcome;
    durationMs: number | null;
    costUsd: number | null;
    payload: string | null;
    summary: string;
  };
  trigger: { name: string; type: string | null; channel: string | null; description: string | null; exists: boolean };
  cause: Cause;
  message: MessageInfo | null;
  /** Messages that arrived while the run was live and went into its session. */
  injected: MessageInfo[];
  metrics: Metrics | null;
  /** Last assistant words / failing tool result for failed runs. */
  error: string | null;
  transcript: Transcript | null;
  /** Web chat session key (for the Chat link) when the run belongs to web chat. */
  chatSessionKey: string | null;
  /** Other runs in the same session (persistent sessions), newest first. */
  sessionRuns: RunSummary[];
}

export interface SessionDetailResponse {
  sessionId: string;
  sessionType: string | null;
  triggerName: string | null;
  triggerExists: boolean;
  /** One metrics row per invocation of this session. */
  metrics: Metrics[];
  totals: { costUsd: number; durationMs: number; runs: number };
  runs: RunSummary[];
  transcript: Transcript | null;
  chatSessionKey: string | null;
}

export interface MessageDetailResponse {
  message: MessageInfo;
  link: { mode: "caused" | "injected" | "none"; run: RunSummary | null };
  /** Trigger that normally handles this channel, if any. */
  handler: string | null;
}

// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseFilters(q: URLSearchParams, timeZone = "UTC"): ActivityFilters {
  const f: ActivityFilters = {};
  const trigger = q.get("trigger")?.trim();
  if (trigger) f.trigger = trigger;
  const status = q.get("status");
  if (status) {
    if (status !== "running" && status !== "ok" && status !== "failed") badRequest("status must be running, ok or failed");
    f.status = status;
  }
  const channel = q.get("channel")?.trim();
  if (channel) f.channel = channel;
  const type = q.get("type");
  if (type) {
    if (!["cron", "webhook", "manual", "direct", "trigger"].includes(type)) badRequest("type must be cron, webhook, manual, direct or trigger");
    f.type = type;
  }
  for (const key of ["from", "to"] as const) {
    const v = q.get(key);
    if (!v) continue;
    if (!DATE_RE.test(v) || Number.isNaN(Date.parse(v))) badRequest(`${key} must be YYYY-MM-DD`);
    if (key === "from") f.fromSec = zonedDayStartUtc(v, timeZone).getTime() / 1000;
    else f.toSec = zonedDayStartUtc(v, timeZone, 1).getTime() / 1000;
  }
  const text = q.get("q")?.trim();
  if (text) f.q = text.slice(0, 200);
  return f;
}

function metricsOf(r: {
  session_type: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_usd: number | null;
  num_turns: number | null;
  is_error: number | null;
}): Metrics {
  return {
    sessionType: r.session_type,
    startedAt: toIso(r.started_at),
    endedAt: toIso(r.ended_at),
    durationMs: r.duration_ms,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
    cacheReadTokens: r.cache_read_tokens ?? 0,
    cacheCreationTokens: r.cache_creation_tokens ?? 0,
    costUsd: r.cost_usd,
    numTurns: r.num_turns,
    isError: !!r.is_error,
  };
}

function attachmentInfo(a: Attachment): AttachmentInfo {
  let present = false;
  try {
    present = existsSync(attachmentDiskPath(a));
  } catch {}
  return {
    id: a.id,
    kind: a.kind,
    mimeType: a.mime_type,
    fileName: a.file_name,
    fileSize: a.file_size,
    transcription: a.transcription,
    url: present ? `/ui/api/activity/attachments/${encodeURIComponent(a.id)}` : null,
  };
}

function messageInfo(m: MessageRow): MessageInfo {
  let attachments: AttachmentInfo[] = [];
  try {
    attachments = getAttachmentsForMessage(getDb(), m.id).map(attachmentInfo);
  } catch {}
  return { id: m.id, channel: m.channel, sender: m.sender, sessionKey: m.session_key, content: m.content, createdAt: toIso(m.created_at), attachments };
}

function runSummary(r: RunRow): RunSummary {
  const item = runToItem(r, null);
  return { id: r.id, triggerName: r.trigger_name, startedAt: toIso(r.started_at), outcome: r.outcome, durationMs: item.durationMs, costUsd: r.cost_usd };
}

function runsOfSession(sessionId: string): RunRow[] {
  return listRunRows("session_id = ?", [sessionId], 200);
}

function parseId(raw: string | undefined, what: string): number {
  if (!raw || !/^\d+$/.test(raw)) badRequest(`Invalid ${what} id`);
  return Number(raw);
}

async function runDetail(id: number): Promise<RunDetailResponse> {
  const r = getRun(id) ?? notFound(`Run #${id} not found`);
  const { cause, injected } = messagesForRun(r);
  const item = runToItem(r, cause);
  const from = toIso(r.m_started_at ?? r.started_at);
  const to = toIso(r.m_ended_at ?? r.completed_at);
  // Ephemeral sessions have one run per file; persistent ones need the time window.
  const transcript = await loadTranscript(r.session_id, r.session_mode === "persistent" ? { from, to } : undefined);
  const others = r.session_id ? runsOfSession(r.session_id).filter((x) => x.id !== r.id) : [];
  const isWeb = (r.t_channel ?? cause?.channel) === "web";
  return {
    run: {
      id: r.id,
      triggerName: r.trigger_name,
      sessionKey: r.session_key,
      sessionMode: r.session_mode,
      sessionId: r.session_id || null,
      startedAt: toIso(r.started_at),
      completedAt: toIso(r.completed_at ?? r.m_ended_at),
      outcome: r.outcome,
      durationMs: item.durationMs,
      costUsd: r.cost_usd,
      payload: r.payload,
      summary: item.summary,
    },
    trigger: { name: r.trigger_name, type: r.t_type, channel: r.t_channel, description: r.t_description, exists: !!r.t_exists },
    cause: item.cause,
    message: cause ? messageInfo(cause) : null,
    injected: injected.map(messageInfo),
    metrics: r.m_id != null ? metricsOf({ ...r, started_at: r.m_started_at, ended_at: r.m_ended_at }) : null,
    error: r.outcome === "failed" ? lastErrorHint(r.session_id, from, to) : null,
    transcript,
    chatSessionKey: isWeb ? r.session_key : null,
    sessionRuns: others.map(runSummary),
  };
}

async function sessionDetail(sessionId: string): Promise<SessionDetailResponse> {
  if (!SESSION_ID_RE.test(sessionId)) badRequest("Invalid session id");
  const db = getDb();
  const rows = db.query("SELECT * FROM session_metrics WHERE session_id = ? ORDER BY started_at ASC").all(sessionId) as Array<
    Parameters<typeof metricsOf>[0] & { trigger_name: string | null }
  >;
  const runs = runsOfSession(sessionId);
  const hasFile = !!findSessionFile(sessionId);
  if (rows.length === 0 && runs.length === 0 && !hasFile) notFound("Session not found");

  const triggerName = runs[0]?.trigger_name ?? rows.find((m) => m.trigger_name && m.trigger_name !== "direct")?.trigger_name ?? null;
  const triggerExists = triggerName ? !!db.query("SELECT 1 FROM triggers WHERE name = ?").get(triggerName) : false;
  const metrics = rows.map(metricsOf);
  const chatRun = runs.find((r) => r.t_channel === "web");
  return {
    sessionId,
    sessionType: rows[0]?.session_type ?? (runs.length ? "trigger" : null),
    triggerName,
    triggerExists,
    metrics,
    totals: {
      costUsd: metrics.reduce((s, m) => s + (m.costUsd ?? 0), 0),
      durationMs: metrics.reduce((s, m) => s + (m.durationMs ?? 0), 0),
      runs: runs.length,
    },
    runs: runs.map(runSummary),
    transcript: await loadTranscript(sessionId),
    chatSessionKey: chatRun?.session_key ?? null,
  };
}

function messageDetail(id: number): MessageDetailResponse {
  const m = getMessage(id) ?? notFound(`Message #${id} not found`);
  const link = linkMessages([m]).get(m.id)!;
  const run = link.runId != null ? getRun(link.runId) : null;
  const handlerRow = getDb().query("SELECT name FROM triggers WHERE channel = ? AND type != 'cron' ORDER BY instr(name, ?) = 1 DESC, run_count DESC, name LIMIT 1").get(m.channel, m.channel) as { name: string } | null;
  return {
    message: messageInfo(m),
    link: { mode: run ? link.mode : "none", run: run ? runSummary(run) : null },
    handler: handlerRow?.name ?? null,
  };
}

function filterOptions(): ActivityFiltersResponse {
  const db = getDb();
  const triggers = db.query("SELECT name, type, channel FROM triggers ORDER BY name").all() as ActivityFiltersResponse["triggers"];
  // Triggers that were deleted but still have history.
  const known = new Set(triggers.map((t) => t.name));
  for (const r of db.query("SELECT DISTINCT trigger_name AS name FROM trigger_runs ORDER BY trigger_name").all() as Array<{ name: string }>) {
    if (!known.has(r.name)) triggers.push({ name: r.name, type: "", channel: null });
  }
  const channels = new Set<string>();
  for (const t of triggers) if (t.channel) channels.add(t.channel);
  for (const r of db.query("SELECT DISTINCT channel FROM messages").all() as Array<{ channel: string }>) if (r.channel) channels.add(r.channel);
  return { triggers, channels: [...channels].sort() };
}

export const routes: ApiRoutes = {
  "/ui/api/activity": {
    GET: handler((req) => {
      const q = query(req);
      const filters = parseFilters(q, resolveTimezone(home()).timeZone);
      const limit = intParam(q.get("limit"), 50, 1, 200);
      const cursor = q.get("cursor");
      if (cursor && !/^\d+\.\d\.\d+$/.test(cursor)) badRequest("Invalid cursor");
      return json(listActivity(filters, cursor, limit) satisfies ActivityListResponse);
    }),
  },
  "/ui/api/activity/filters": {
    GET: handler(() => json(filterOptions() satisfies ActivityFiltersResponse)),
  },
  "/ui/api/activity/runs/:id": {
    GET: handler(async (req) => json((await runDetail(parseId(req.params.id, "run"))) satisfies RunDetailResponse)),
  },
  "/ui/api/activity/sessions/:sessionId": {
    GET: handler(async (req) => json((await sessionDetail(req.params.sessionId ?? "")) satisfies SessionDetailResponse)),
  },
  "/ui/api/activity/messages/:id": {
    GET: handler((req) => json(messageDetail(parseId(req.params.id, "message")) satisfies MessageDetailResponse)),
  },
  "/ui/api/activity/attachments/:id": {
    GET: handler((req) => {
      const id = req.params.id ?? "";
      if (!/^[a-zA-Z0-9-]+$/.test(id)) badRequest("Invalid attachment id");
      const a = getAttachment(getDb(), id) ?? notFound("Attachment not found");
      let path: string;
      try {
        path = attachmentDiskPath(a);
      } catch {
        notFound("Attachment file is no longer on disk");
      }
      // Only inert media types render inline; anything else (html, svg, …) downloads.
      const inline = /^(audio|video)\/|^image\/(png|jpeg|gif|webp)$|^application\/pdf$|^text\/plain$/.test(a.mime_type);
      return new Response(Bun.file(path), {
        headers: {
          "Content-Type": inline ? a.mime_type : "application/octet-stream",
          "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${a.file_name.replace(/["\\\r\n]/g, "")}"`,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, max-age=3600",
        },
      });
    }),
  },
};
