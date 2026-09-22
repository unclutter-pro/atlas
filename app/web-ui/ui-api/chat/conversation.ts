/**
 * Chat conversation model: Claude Code JSONL + web user messages → ChatItem[].
 *
 * The JSONL is read incrementally (TranscriptCursor) so a live chat never
 * re-parses the whole file: each read starts at the last byte offset and only
 * parses complete new lines. User turns come from the messages table (the
 * JSONL only holds the wrapped inject template).
 */

import { closeSync, fstatSync, openSync, readSync } from "fs";
import { attachmentDiskPath, type Attachment } from "../../../lib/attachments";
import { findSessionFile } from "../activity/transcript";
import { getDb, toIso } from "../shared/env";
import type { ChatAssistantItem, ChatAttachment, ChatItem, ChatThinkingItem, ChatToolItem, ChatUserItem } from "./types";
import { getMappedSessionId } from "./store";

const MAX_TEXT = 20_000;
const SUMMARY_MAX = 160;
const SUMMARY_KEYS = ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"] as const;
const READ_CHUNK = 1024 * 1024;
const NL = 0x0a;

/** Same clip rule as activity/transcript.ts. */
export function clip(s: string, max = MAX_TEXT): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${(s.length - max).toLocaleString("en-US")} more characters)` : s;
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function blocksOf(message: unknown): unknown {
  // Old format: message is the content; new format: { role, content }.
  if (message && typeof message === "object" && !Array.isArray(message) && "content" in message) return (message as { content: unknown }).content;
  return message;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === "object" && "text" in c ? String((c as { text: unknown }).text ?? "") : "")).join("\n");
  return content == null ? "" : JSON.stringify(content);
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
// Incremental JSONL reader
// ---------------------------------------------------------------------------

export interface CursorRead {
  added: ChatItem[];
  /** Items from earlier reads that changed (a tool result arrived). */
  updated: ChatItem[];
  /** The file shrank (rewritten): state was dropped and `added` is the whole (tail of the) file. */
  reset: boolean;
}

export class TranscriptCursor {
  /** Bytes consumed so far (a partial last line is buffered, not parsed). */
  offset = 0;
  /** The first read started at the tail of a large file; earlier lines were skipped. */
  truncated = false;
  private partial: Buffer = Buffer.alloc(0);
  private started = false;
  /** Tool calls still waiting for their result, by tool_use_id. */
  private pendingTools = new Map<string, ChatToolItem>();
  private readonly tailBytes: number;
  private readonly endOffset: number | undefined;

  constructor(
    readonly file: string,
    opts: { tailBytes?: number; endOffset?: number } = {},
  ) {
    this.tailBytes = opts.tailBytes ?? 8 * 1024 * 1024;
    this.endOffset = opts.endOffset;
  }

  readNew(): CursorRead {
    const out: CursorRead = { added: [], updated: [], reset: false };
    let fd: number | null = null;
    try {
      fd = openSync(this.file, "r");
      const size = fstatSync(fd).size;
      if (size < this.offset) {
        out.reset = true;
        this.offset = 0;
        this.partial = Buffer.alloc(0);
        this.pendingTools.clear();
        this.started = false;
        this.truncated = false;
      }
      const end = this.endOffset !== undefined ? Math.min(size, this.endOffset) : size;
      let start = this.offset;
      let dropFirst = false;
      if (!this.started) {
        this.started = true;
        if (end - start > this.tailBytes) {
          start = end - this.tailBytes;
          dropFirst = true;
          this.truncated = true;
        }
      }
      if (end <= start) return out;

      const addedIds = new Set<string>();
      let lineStart = start - this.partial.length;
      let pos = start;
      while (pos < end) {
        const len = Math.min(READ_CHUNK, end - pos);
        const buf = Buffer.allocUnsafe(len);
        const n = readSync(fd, buf, 0, len, pos);
        if (n <= 0) break;
        pos += n;
        const data = this.partial.length ? Buffer.concat([this.partial, buf.subarray(0, n)]) : buf.subarray(0, n);
        let from = 0;
        for (let i = data.indexOf(NL); i !== -1; i = data.indexOf(NL, from)) {
          if (dropFirst) dropFirst = false;
          else this.parseLine(data.toString("utf8", from, i), lineStart, out, addedIds);
          lineStart += i + 1 - from;
          from = i + 1;
        }
        this.partial = Buffer.from(data.subarray(from));
      }
      // A cut in the middle of the only line: nothing complete yet.
      if (dropFirst) this.partial = Buffer.alloc(0);
      this.offset = pos;
    } catch {
      // Missing/unreadable file: nothing new.
    } finally {
      if (fd !== null) closeSync(fd);
    }
    return out;
  }

  private parseLine(line: string, lineStart: number, out: CursorRead, addedIds: Set<string>): void {
    if (!line.trim()) return;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (!obj || typeof obj !== "object" || obj.isSidechain === true) return;
    const at = typeof obj.timestamp === "string" ? obj.timestamp : null;
    const lineId = typeof obj.uuid === "string" && obj.uuid ? obj.uuid : `@${lineStart}`;

    if (obj.type === "assistant") {
      const msg = obj.message;
      const streamId = msg && typeof msg === "object" && !Array.isArray(msg) && typeof msg.id === "string" ? msg.id : null;
      const content = blocksOf(msg);
      if (!Array.isArray(content)) return;
      content.forEach((block: any, i: number) => {
        if (!block || typeof block !== "object") return;
        if (block.type === "text" && typeof block.text === "string" && block.text) {
          const item: ChatAssistantItem = { kind: "assistant", id: `a:${lineId}:${i}`, at, text: block.text, streamId };
          out.added.push(item);
        } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
          const item: ChatThinkingItem = { kind: "thinking", id: `k:${lineId}:${i}`, at, text: clip(block.thinking) };
          out.added.push(item);
        } else if (block.type === "tool_use") {
          const toolUseId = typeof block.id === "string" && block.id ? block.id : null;
          const input = typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}, null, 2);
          const item: ChatToolItem = {
            kind: "tool",
            id: toolUseId ? `t:${toolUseId}` : `t:${lineId}:${i}`,
            at,
            toolUseId,
            name: typeof block.name === "string" && block.name ? block.name : "tool",
            summary: toolSummary(block.input),
            input: clip(input),
            result: null,
            isError: false,
          };
          if (toolUseId) this.pendingTools.set(toolUseId, item);
          addedIds.add(item.id);
          out.added.push(item);
        }
      });
    } else if (obj.type === "user") {
      // Only tool results; plain user text is the inject template (the real
      // text comes from the messages table).
      const content = blocksOf(obj.message);
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const tool = this.pendingTools.get(block.tool_use_id);
        if (!tool) continue;
        this.pendingTools.delete(block.tool_use_id);
        tool.result = clip(resultText(block.content));
        tool.isError = !!block.is_error;
        if (!addedIds.has(tool.id)) out.updated.push(tool);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Turn state from the transcript tail
// ---------------------------------------------------------------------------

function readTail(file: string, bytes: number): string {
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.allocUnsafe(len);
    const n = readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8", 0, n);
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function userText(message: unknown): string {
  const content = blocksOf(message);
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content.find((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string");
    return text ? text.text : "";
  }
  return "";
}

/**
 * Whether the agent still owes a response, judged from the last user/assistant
 * line of the file tail: a user line (prompt or tool result) or an assistant
 * line that stopped for tool_use means more work is coming. An interrupt
 * marker ("[Request interrupted …") ends the turn. Unreadable or empty → active
 * (the session is just starting).
 */
export function turnActiveFromTail(file: string, bytes = 64 * 1024): boolean {
  const text = readTail(file, bytes);
  if (!text) return true;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || obj.isSidechain === true) continue;
    if (obj.type === "user") return !userText(obj.message).startsWith("[Request interrupted");
    if (obj.type === "assistant") {
      const msg = obj.message;
      const stop = msg && typeof msg === "object" && !Array.isArray(msg) ? msg.stop_reason : null;
      return stop === "tool_use";
    }
  }
  return true;
}

/** Timestamp of the last assistant/user line in the file tail (null when none). */
export function lastTranscriptAt(file: string, bytes = 64 * 1024): string | null {
  const lines = readTail(file, bytes).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && (obj.type === "assistant" || obj.type === "user") && obj.isSidechain !== true && typeof obj.timestamp === "string") return obj.timestamp;
    } catch {}
  }
  return null;
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
export function mergeByTime(userItems: ChatItem[], jsonlItems: ChatItem[]): ChatItem[] {
  const out: ChatItem[] = [];
  let u = 0;
  let j = 0;
  while (u < userItems.length || j < jsonlItems.length) {
    if (j >= jsonlItems.length) out.push(userItems[u++]!);
    else if (u >= userItems.length) out.push(jsonlItems[j++]!);
    else {
      const tu = Date.parse(userItems[u]!.at ?? "");
      const tj = Date.parse(jsonlItems[j]!.at ?? "");
      if (Number.isNaN(tj) || (!Number.isNaN(tu) && tu > tj)) out.push(jsonlItems[j++]!);
      else out.push(userItems[u++]!);
    }
  }
  return out;
}

/**
 * Whole conversation of a chat (all user messages + full JSONL up to
 * `endOffset`). For /api/v1 reads and the legacy stream's init when the
 * live snapshot is truncated.
 */
export function loadConversation(key: string, opts: { endOffset?: number } = {}): { items: ChatItem[]; sessionId: string | null } {
  const sessionId = getMappedSessionId(key);
  const file = findSessionFile(sessionId);
  const jsonl = file ? new TranscriptCursor(file, { tailBytes: Infinity, endOffset: opts.endOffset }).readNew().added : [];
  return { items: mergeByTime(loadUserItems(key), jsonl), sessionId };
}
