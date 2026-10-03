/**
 * DB reads for the Chat area (chat_sessions, messages, trigger_sessions,
 * web_chat_stream_chunks, stats). Every query here is indexed.
 */

import { getDb, toIso } from "../shared/env";
import { DEFAULT_SESSION_KEY, type ChatSessionDetail, type ChatSessionStats, type ChatSessionSummary } from "./types";

export const CHAT_TRIGGER = "web-chat";

export interface SessionRow {
  session_key: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  message_count: number;
  last_message_at: string | null;
  last_content: string | null;
  session_id: string | null;
}

export interface ChunkRow {
  id: number;
  streamId: string;
  index: number;
  delta: string;
}

const SUMMARY_SELECT = `
  SELECT cs.session_key, cs.title, cs.created_at, cs.updated_at, cs.archived_at,
    (SELECT COUNT(*) FROM messages m WHERE m.channel = 'web' AND m.session_key = cs.session_key) AS message_count,
    (SELECT MAX(m.created_at) FROM messages m WHERE m.channel = 'web' AND m.session_key = cs.session_key) AS last_message_at,
    (SELECT m.content FROM messages m WHERE m.channel = 'web' AND m.session_key = cs.session_key
      ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_content,
    (SELECT ts.session_id FROM trigger_sessions ts WHERE ts.trigger_name = '${CHAT_TRIGGER}' AND ts.session_key = cs.session_key) AS session_id
  FROM chat_sessions cs`;

export function preview(content: string | null): string | null {
  if (!content) return null;
  const t = content.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > 120 ? `${t.slice(0, 119)}…` : t;
}

export function toSummary(r: SessionRow): ChatSessionSummary {
  const createdAt = toIso(r.created_at)!;
  return {
    key: r.session_key,
    title: r.title,
    createdAt,
    updatedAt: toIso(r.updated_at)!,
    archivedAt: toIso(r.archived_at),
    lastActivityAt: toIso(r.last_message_at) ?? createdAt,
    messageCount: r.message_count,
    preview: preview(r.last_content),
    sessionId: r.session_id,
    isDefault: r.session_key === DEFAULT_SESSION_KEY,
  };
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function listSessionRows(opts: { archived?: "exclude" | "only" | "all"; q?: string } = {}): SessionRow[] {
  const where = ["cs.channel = 'web'"];
  const params: string[] = [];
  if ((opts.archived ?? "exclude") === "exclude") where.push("cs.archived_at IS NULL");
  else if (opts.archived === "only") where.push("cs.archived_at IS NOT NULL");
  const q = opts.q?.trim();
  if (q) {
    const like = `%${escapeLike(q)}%`;
    where.push(`(cs.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages m WHERE m.channel = 'web'
      AND m.session_key = cs.session_key AND m.content LIKE ? ESCAPE '\\'))`);
    params.push(like, like);
  }
  return getDb()
    .query(`SELECT * FROM (${SUMMARY_SELECT} WHERE ${where.join(" AND ")})
            ORDER BY COALESCE(last_message_at, created_at) DESC, session_key ASC`)
    .all(...params) as SessionRow[];
}

export function getSessionRow(key: string): SessionRow | null {
  return (getDb().query(`${SUMMARY_SELECT} WHERE cs.session_key = ? AND cs.channel = 'web'`).get(key) as SessionRow | null) ?? null;
}

export function sessionRowExists(key: string): boolean {
  return !!getDb().query("SELECT 1 FROM chat_sessions WHERE session_key = ? AND channel = 'web'").get(key);
}

export function hasWebMessages(key: string): boolean {
  return !!getDb().query("SELECT 1 FROM messages WHERE channel = 'web' AND session_key = ? LIMIT 1").get(key);
}

export function getStats(sessionId: string | null): ChatSessionStats | null {
  if (!sessionId) return null;
  const db = getDb();
  const cost = db.query("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM session_metrics WHERE session_id = ?").get(sessionId) as { c: number };
  const runs = db.query("SELECT COUNT(*) AS n FROM trigger_runs WHERE session_id = ?").get(sessionId) as { n: number };
  return { costUsd: cost.c ?? 0, runs: runs.n ?? 0 };
}

export function getSessionDetail(key: string): ChatSessionDetail | null {
  const row = getSessionRow(key);
  if (!row) return null;
  const summary = toSummary(row);
  return { ...summary, stats: getStats(summary.sessionId) };
}

export function getMappedSessionId(key: string): string | null {
  const row = getDb()
    .query("SELECT session_id FROM trigger_sessions WHERE trigger_name = ? AND session_key = ? LIMIT 1")
    .get(CHAT_TRIGGER, key) as { session_id: string } | null;
  return row?.session_id ?? null;
}

export function maxUserMessageId(key: string): number {
  const row = getDb()
    .query("SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE channel = 'web' AND session_key = ?")
    .get(key) as { id: number };
  return row.id;
}

/** Newest web user message: id and created_at (ISO). */
export function lastUserMessage(key: string): { id: number; at: string } | null {
  const row = getDb()
    .query("SELECT id, created_at FROM messages WHERE channel = 'web' AND session_key = ? ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(key) as { id: number; created_at: string } | null;
  return row ? { id: row.id, at: toIso(row.created_at)! } : null;
}

export function maxChunkId(sessionId: string): number {
  const row = getDb()
    .query("SELECT COALESCE(MAX(id), 0) AS id FROM web_chat_stream_chunks WHERE session_id = ?")
    .get(sessionId) as { id: number };
  return row.id;
}

export function chunksAfter(sessionId: string, afterId: number, limit = 500): ChunkRow[] {
  const rows = getDb()
    .query(
      `SELECT id, message_uuid, chunk_index, content_delta FROM web_chat_stream_chunks
        WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
    )
    .all(sessionId, afterId, limit) as { id: number; message_uuid: string; chunk_index: number; content_delta: string }[];
  return rows.map((r) => ({ id: r.id, streamId: r.message_uuid, index: r.chunk_index, delta: r.content_delta }));
}

/** All chunks of the newest streamed message of a session (the in-flight draft on cold start). */
export function latestMessageChunks(sessionId: string): ChunkRow[] {
  const last = getDb()
    .query("SELECT message_uuid FROM web_chat_stream_chunks WHERE session_id = ? ORDER BY id DESC LIMIT 1")
    .get(sessionId) as { message_uuid: string } | null;
  if (!last) return [];
  const rows = getDb()
    .query(
      `SELECT id, message_uuid, chunk_index, content_delta FROM web_chat_stream_chunks
        WHERE session_id = ? AND message_uuid = ? ORDER BY id ASC`,
    )
    .all(sessionId, last.message_uuid) as { id: number; message_uuid: string; chunk_index: number; content_delta: string }[];
  return rows.map((r) => ({ id: r.id, streamId: r.message_uuid, index: r.chunk_index, delta: r.content_delta }));
}
