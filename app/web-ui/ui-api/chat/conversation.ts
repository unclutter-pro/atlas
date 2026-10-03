/**
 * Chat conversation model: stored session history + web user messages → ChatItem[].
 *
 * History is read incrementally (TranscriptCursor over the session store's
 * cursor) so a live chat never re-reads the whole session. User turns come
 * from the messages table (the history only holds the wrapped inject template).
 */

import type { HistoryCursor, HistoryPosition } from "../../../lib/harness";
import { attachmentDiskPath, type Attachment } from "../../../lib/attachments";
import { getDb, sessionStore, storedSession, toIso } from "../shared/env";
import type { ChatAssistantItem, ChatAttachment, ChatItem, ChatThinkingItem, ChatToolItem, ChatUserItem } from "./types";
import { getMappedSessionId } from "./store";

const MAX_TEXT = 20_000;
const SUMMARY_MAX = 160;
const SUMMARY_KEYS = ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"] as const;

/** Same clip rule as activity/transcript.ts. */
export function clip(s: string, max = MAX_TEXT): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${(s.length - max).toLocaleString("en-US")} more characters)` : s;
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function toolSummary(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const o = input as Record<string, unknown>;
  for (const k of SUMMARY_KEYS) {
    if (typeof o[k] === "string" && (o[k] as string).trim()) return oneLine(o[k] as string, SUMMARY_MAX);
  }
  return "";
}

// ---------------------------------------------------------------------------
// Incremental history reader
// ---------------------------------------------------------------------------

export interface CursorRead {
  added: ChatItem[];
  /** Items from earlier reads that changed (a tool result arrived). */
  updated: ChatItem[];
  /** The history was rewritten: state was dropped and `added` is the whole (tail of the) history. */
  reset: boolean;
}

/** Chat items of the main conversation; pairs tool results with their calls. */
export class TranscriptCursor {
  /** Tool calls still waiting for their result, by call id. */
  private pendingTools = new Map<string, ChatToolItem>();

  constructor(private readonly history: HistoryCursor) {}

  /** Pass as `until` to read the same view again (loadConversation). */
  get position(): HistoryPosition {
    return this.history.position;
  }

  /** The first read started at the tail of a large history. */
  get truncated(): boolean {
    return this.history.truncated;
  }

  readNew(): CursorRead {
    const { entries, reset } = this.history.read();
    const out: CursorRead = { added: [], updated: [], reset };
    if (reset) this.pendingTools.clear();
    const addedIds = new Set<string>();
    for (const e of entries) {
      if (e.nested) continue;
      if (e.kind === "assistant-text") {
        const item: ChatAssistantItem = { kind: "assistant", id: `a:${e.id}`, at: e.at, text: e.text, streamId: e.messageId };
        out.added.push(item);
      } else if (e.kind === "reasoning") {
        const item: ChatThinkingItem = { kind: "thinking", id: `k:${e.id}`, at: e.at, text: clip(e.text) };
        out.added.push(item);
      } else if (e.kind === "tool-call") {
        const input = typeof e.input === "string" ? e.input : JSON.stringify(e.input ?? {}, null, 2);
        const item: ChatToolItem = {
          kind: "tool",
          id: e.callId ? `t:${e.callId}` : `t:${e.id}`,
          at: e.at,
          toolUseId: e.callId,
          name: e.name,
          summary: toolSummary(e.input),
          input: clip(input),
          result: null,
          isError: false,
        };
        if (e.callId) this.pendingTools.set(e.callId, item);
        addedIds.add(item.id);
        out.added.push(item);
      } else if (e.kind === "tool-result" && e.callId) {
        const tool = this.pendingTools.get(e.callId);
        if (!tool) continue;
        this.pendingTools.delete(e.callId);
        tool.result = clip(e.content);
        tool.isError = e.isError;
        if (!addedIds.has(tool.id)) out.updated.push(tool);
      }
      // user-text is the inject template; the chat shows the messages table instead.
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// User items (messages table)
// ---------------------------------------------------------------------------

export function attachmentUiUrl(a: Attachment): string | null {
  try {
    attachmentDiskPath(a); // throws when the file is gone
    return `/ui/api/activity/attachments/${encodeURIComponent(a.id)}`;
  } catch {
    return null;
  }
}

export function toChatAttachment(a: Attachment): ChatAttachment {
  return {
    id: a.id,
    kind: a.kind,
    mimeType: a.mime_type,
    fileName: a.file_name,
    fileSize: a.file_size,
    url: attachmentUiUrl(a),
    transcription: a.transcription,
  };
}

export function userItem(row: { id: number; content: string; created_at: string }, attachments: ChatAttachment[]): ChatUserItem {
  return { kind: "user", id: `u:${row.id}`, at: toIso(row.created_at), messageId: row.id, text: row.content, attachments };
}

/** Web user messages of a chat with id > afterId, oldest first, with attachments. */
export function loadUserItems(key: string, afterId = 0): ChatUserItem[] {
  const db = getDb();
  const rows = db
    .query("SELECT id, content, created_at FROM messages WHERE channel = 'web' AND session_key = ? AND id > ? ORDER BY id ASC")
    .all(key, afterId) as { id: number; content: string; created_at: string }[];
  if (rows.length === 0) return [];
  const atts = db
    .query(
      `SELECT a.id, a.message_id, a.kind, a.mime_type, a.file_name, a.file_size, a.transcription, a.created_at
         FROM message_attachments a JOIN messages m ON m.id = a.message_id
        WHERE m.channel = 'web' AND m.session_key = ? AND m.id > ?
        ORDER BY a.created_at ASC, a.id ASC`,
    )
    .all(key, afterId) as Attachment[];
  const byMessage = new Map<number, ChatAttachment[]>();
  for (const a of atts) {
    const list = byMessage.get(a.message_id) ?? [];
    list.push(toChatAttachment(a));
    byMessage.set(a.message_id, list);
  }
  return rows.map((r) => userItem(r, byMessage.get(r.id) ?? []));
}

/** Merge two chronological lists; user items go first on equal timestamps. */
export function mergeByTime(userItems: ChatItem[], storedItems: ChatItem[]): ChatItem[] {
  const out: ChatItem[] = [];
  let u = 0;
  let j = 0;
  while (u < userItems.length || j < storedItems.length) {
    if (j >= storedItems.length) out.push(userItems[u++]!);
    else if (u >= userItems.length) out.push(storedItems[j++]!);
    else {
      const tu = Date.parse(userItems[u]!.at ?? "");
      const tj = Date.parse(storedItems[j]!.at ?? "");
      if (Number.isNaN(tj) || (!Number.isNaN(tu) && tu > tj)) out.push(storedItems[j++]!);
      else out.push(userItems[u++]!);
    }
  }
  return out;
}

/**
 * Whole conversation of a chat (all user messages + full history up to
 * `until`, a live cursor's position). For /api/v1 reads and the legacy
 * stream's init when the live snapshot is truncated.
 */
export function loadConversation(key: string, opts: { until?: HistoryPosition } = {}): { items: ChatItem[]; sessionId: string | null } {
  const sessionId = getMappedSessionId(key);
  const sessions = sessionStore();
  const ref = storedSession(sessions, sessionId);
  const history = ref ? sessions.cursor(ref, { initialBytes: Infinity, until: opts.until }) : null;
  const items = history ? new TranscriptCursor(history).readNew().added : [];
  return { items: mergeByTime(loadUserItems(key), items), sessionId };
}
