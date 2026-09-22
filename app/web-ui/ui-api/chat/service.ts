/**
 * Chat service: every chat mutation and read used by /ui/api/chat/* and the
 * external /api/v1/chat/* routes. Errors are HttpErrors (Hono routes map them
 * with `c.json({ error: e.message }, e.status)`).
 */

import { closeSync, mkdirSync, openSync, readFileSync } from "fs";
import { join } from "path";
import { attachmentUrl, saveAttachment, type Attachment } from "../../../lib/attachments";
import { isAtlasPaused } from "../../../lib/kill-switch";
import { getLockPath, getSocketPath, isPidAlive, readLockPid, trySocketInject } from "../../../lib/trigger-socket";
import { fireTrigger, getDb, home, toIso } from "../shared/env";
import { HttpError } from "../shared/http";
import { toChatAttachment, userItem } from "./conversation";
import { currentRunState, getHub, notifyLocal } from "./hub";
import * as store from "./store";
import { CHAT_TRIGGER } from "./store";
import { sttDeps } from "./stt";
import {
  DEFAULT_SESSION_KEY,
  SESSION_KEY_PATTERN,
  type ChatSessionDetail,
  type ChatSessionSummary,
  type ChatSnapshot,
  type ChatUserItem,
  type StopChatTurnResponse,
} from "./types";

const KEY_RE = new RegExp(SESSION_KEY_PATTERN);
const TITLE_MAX = 200;
/** Audio detection for uploads: MIME, or the name for "video/webm"-tagged voice notes. */
const AUDIO_EXT_RE = /\.(webm|m4a|mp3|ogg|wav|aac|opus)$/i;

export const VOICE_STT_FAILED = "(Voice message, transcription failed)";

export function isValidSessionKey(key: unknown): key is string {
  return typeof key === "string" && KEY_RE.test(key);
}

/** ?sessionKey= for /api/v1: trimmed, valid, else "_default". */
export function sessionKeyFromQuery(value: string | null | undefined): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (isValidSessionKey(trimmed)) return trimmed;
  }
  return DEFAULT_SESSION_KEY;
}

export function isAudioFile(f: File): boolean {
  return f.type.startsWith("audio/") || AUDIO_EXT_RE.test(f.name || "");
}

/** Bun types a multipart part named *.webm as video/webm even when the browser
 *  recorded audio; a UI voice upload is audio by contract. */
function voiceMime(file: File, isVoice: boolean): string {
  const type = file.type || "application/octet-stream";
  return isVoice && type.startsWith("video/") ? `audio/${type.slice("video/".length)}` : type;
}

/** Ensures a chat_sessions row exists. Idempotent. Updates updated_at and,
 *  via COALESCE, backfills the title only when it is still NULL — manual
 *  titles are never overwritten. */
export function touchChatSession(sessionKey: string, opts?: { title?: string }): void {
  getDb()
    .prepare(
      `INSERT INTO chat_sessions (session_key, channel, title)
       VALUES (?, 'web', ?)
       ON CONFLICT(session_key) DO UPDATE SET
         updated_at = datetime('now'),
         title = COALESCE(chat_sessions.title, excluded.title)`,
    )
    .run(sessionKey, opts?.title ?? null);
}

/** Generates a placeholder title from first user message content. */
export function deriveSessionTitle(content: string): string {
  const clean = content.replace(/\s+/g, " ").trim();
  if (clean.length <= 60) return clean;
  return clean.slice(0, 57).trimEnd() + "…";
}

/**
 * Wraps web-channel message content in a `<webmsg>` envelope.
 *
 * Every message arriving via the web channel is wrapped so that the agent
 * can identify the source and any caller-supplied metadata without Atlas
 * needing to embed multi-tenant semantics in its own schema.
 *
 * Attribute values are XML-escaped. Empty / whitespace-only attrs are omitted.
 * Supported attrs: userMail → user-mail, userName → user-name.
 *
 * @example
 * wrapWebMessage("hi")
 * // "<webmsg>\nhi\n</webmsg>"
 *
 * wrapWebMessage("hi", { userMail: "alice@example.com", userName: "Alice" })
 * // '<webmsg user-mail="alice@example.com" user-name="Alice">\nhi\n</webmsg>'
 */
export function wrapWebMessage(content: string, attrs: { userMail?: string | null; userName?: string | null } = {}): string {
  const xmlEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const parts: string[] = [];
  const mail = (attrs.userMail ?? "").trim();
  const name = (attrs.userName ?? "").trim();
  if (mail) parts.push(`user-mail="${xmlEscape(mail)}"`);
  if (name) parts.push(`user-name="${xmlEscape(name)}"`);
  const attrStr = parts.length > 0 ? " " + parts.join(" ") : "";
  return `<webmsg${attrStr}>\n${content}\n</webmsg>`;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function listSessions(opts: { archived?: "exclude" | "only" | "all"; q?: string } = {}): ChatSessionSummary[] {
  return store.listSessionRows(opts).map(store.toSummary);
}

export function getSessionDetail(key: string): ChatSessionDetail | null {
  return store.getSessionDetail(key);
}

/**
 * True when the chat exists. A chat with web messages but no chat_sessions
 * row (older data) gets its row here; `_default` always exists.
 */
export function ensureSession(key: string): boolean {
  if (store.sessionRowExists(key)) return true;
  if (key !== DEFAULT_SESSION_KEY && !store.hasWebMessages(key)) return false;
  getDb().prepare("INSERT OR IGNORE INTO chat_sessions (session_key, channel, title) VALUES (?, 'web', NULL)").run(key);
  return true;
}

/** `max`: the UI caps titles; /api/v1 never did, so it passes Infinity. */
function normalizeTitle(title: unknown, max = TITLE_MAX): string | null {
  if (title == null) return null;
  if (typeof title !== "string") throw new HttpError(400, "title must be a string or null");
  const t = title.trim().slice(0, max);
  return t || null;
}

export function createSession(title?: unknown, opts: { titleMax?: number } = {}): ChatSessionSummary {
  const key = crypto.randomUUID();
  getDb().prepare("INSERT INTO chat_sessions (session_key, channel, title) VALUES (?, 'web', ?)").run(key, normalizeTitle(title, opts.titleMax));
  return store.toSummary(store.getSessionRow(key)!);
}

/** `allowDefaultArchive`: /api/v1 always allowed archiving _default; the UI refuses it. */
export function updateSession(
  key: string,
  body: { title?: unknown; archived?: unknown },
  opts: { allowDefaultArchive?: boolean; titleMax?: number } = {},
): ChatSessionDetail {
  if (!store.sessionRowExists(key)) throw new HttpError(404, "Chat not found");
  const sets = ["updated_at = datetime('now')"];
  const params: (string | null)[] = [];
  if ("title" in body) {
    sets.push("title = ?");
    params.push(normalizeTitle(body.title, opts.titleMax));
  }
  if ("archived" in body && body.archived !== undefined) {
    if (typeof body.archived !== "boolean") throw new HttpError(400, "archived must be a boolean");
    if (body.archived && key === DEFAULT_SESSION_KEY && !opts.allowDefaultArchive) throw new HttpError(400, "The default chat cannot be archived");
    sets.push(body.archived ? "archived_at = COALESCE(archived_at, datetime('now'))" : "archived_at = NULL");
  }
  getDb().prepare(`UPDATE chat_sessions SET ${sets.join(", ")} WHERE session_key = ?`).run(...params, key);
  notifyLocal(key, { kind: "session" });
  return store.getSessionDetail(key)!;
}

/** Remove a chat and everything attached to it; open streams get `session_deleted`. */
export function purgeSession(key: string): void {
  const db = getDb();
  const sessionId = store.getMappedSessionId(key);
  db.prepare("DELETE FROM trigger_sessions WHERE trigger_name = ? AND session_key = ?").run(CHAT_TRIGGER, key);
  db.prepare("DELETE FROM messages WHERE channel = 'web' AND session_key = ?").run(key);
  if (sessionId) db.prepare("DELETE FROM web_chat_stream_chunks WHERE session_id = ?").run(sessionId);
  db.prepare("DELETE FROM chat_sessions WHERE session_key = ?").run(key);
  notifyLocal(key, { kind: "deleted" });
}

export function deleteSession(key: string, opts: { refuseWhileRunning: boolean }): void {
  if (key === DEFAULT_SESSION_KEY) throw new HttpError(400, "The default chat cannot be deleted");
  if (!store.sessionRowExists(key)) throw new HttpError(404, "Chat not found");
  if (opts.refuseWhileRunning && currentRunState(key) !== "idle") throw new HttpError(409, "Stop the current turn first");
  purgeSession(key);
}

/**
 * Retire the chat's Claude session (like Signal /new): the agent gets a
 * farewell prompt to save context to memory, then the mapping, the user
 * messages and stream chunks are dropped so the next message starts fresh.
 */
export async function resetSession(sessionKey: string): Promise<{ farewellSent: boolean }> {
  const db = getDb();
  const session = db
    .prepare("SELECT session_id FROM trigger_sessions WHERE trigger_name = ? AND session_key = ? LIMIT 1")
    .get(CHAT_TRIGGER, sessionKey) as { session_id: string } | null;

  let farewellSent = false;
  if (session) {
    // Load farewell prompt (same as Signal /new)
    const today = new Date().toISOString().slice(0, 10);
    let farewell: string;
    try {
      farewell = readFileSync("/atlas/app/prompts/trigger-channel-signal-farewell.md", "utf-8")
        .replace(/{{today}}/g, today)
        .replace(/Signal/g, "chat"); // Adapt channel reference
    } catch {
      farewell =
        `<session-ending reason="user-requested-new-session">\n` +
        `The user started a new chat. This session is being retired.\n\n` +
        `Save important context to memory/journal/${today}.md (create or append):\n` +
        `- Summary of this conversation's key topics\n` +
        `- Decisions made and tasks created/completed\n` +
        `- Open questions or commitments\n` +
        `- Context the next session should know\n\n` +
        `Update memory/MEMORY.md only for genuinely new long-term information.\n\n` +
        `IMPORTANT: Do NOT send any messages. Save to memory silently.\n` +
        `</session-ending>`;
    }

    // A live runner owns this session: hand it the farewell over its control
    // socket. Never start a second Claude process on the same session while
    // the runner is alive, even if its socket doesn't answer.
    if (await trySocketInject(getSocketPath(CHAT_TRIGGER, sessionKey), farewell, "web", sessionKey)) {
      farewellSent = true;
    } else if (isPidAlive(readLockPid(getLockPath(CHAT_TRIGGER, sessionKey)))) {
      // Runner alive but unreachable — skip the farewell rather than race it.
    } else {
      // Session not running — resume it with farewell
      try {
        const env = { ...process.env, ATLAS_TRIGGER: CHAT_TRIGGER, ATLAS_TRIGGER_CHANNEL: "web", ATLAS_TRIGGER_SESSION_KEY: sessionKey };
        delete (env as Record<string, string | undefined>).CLAUDECODE;
        const proc = Bun.spawn(
          ["/atlas/app/triggers/trigger-runner", "--direct", farewell, "--channel", "web", "--resume", session.session_id],
          { stdout: "ignore", stderr: "ignore", env },
        );
        // Kill farewell after 5min max (runs in background, doesn't block the response)
        setTimeout(() => {
          try {
            proc.kill();
          } catch {}
        }, 300_000);
        farewellSent = true;
      } catch {
        // Resume failed — proceed with cleanup
      }
    }
  }

  // Delete the mapping so the next message creates a fresh session (immediately — don't wait for the farewell)
  db.prepare("DELETE FROM trigger_sessions WHERE trigger_name = ? AND session_key = ?").run(CHAT_TRIGGER, sessionKey);
  db.prepare("DELETE FROM messages WHERE channel = ? AND session_key = ?").run("web", sessionKey);
  // Drop persisted stream chunks of the retired session
  if (session) db.prepare("DELETE FROM web_chat_stream_chunks WHERE session_id = ?").run(session.session_id);
  db.prepare("UPDATE chat_sessions SET updated_at = datetime('now'), title = NULL WHERE session_key = ?").run(sessionKey);

  notifyLocal(sessionKey, { kind: "reset" });
  return { farewellSent };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface SendMessageInput {
  content: string;
  files?: File[];
  /** Caller-provided transcript for the audio file (skips STT). */
  transcription?: string | null;
  userMail?: string | null;
  userName?: string | null;
  clientId?: string;
  /** "ui": refuses paused/archived chats, one voice file. "v1": legacy /api/v1 rules. */
  surface: "ui" | "v1";
}

export interface SentMessage {
  id: number;
  content: string;
  createdAt: string;
  attachments: Attachment[];
  triggered: boolean;
}

function isArchived(key: string): boolean {
  const row = getDb().query("SELECT archived_at FROM chat_sessions WHERE session_key = ?").get(key) as { archived_at: string | null } | null;
  return !!row?.archived_at;
}

/**
 * Store a user message, attach files (STT for audio), wake the agent through
 * trigger.sh and tell the chat's live hub.
 */
export async function sendMessage(key: string, input: SendMessageInput): Promise<SentMessage> {
  const db = getDb();
  const files = input.files ?? [];
  if (input.surface === "ui") {
    if (isAtlasPaused(home())) throw new HttpError(409, "Atlas is paused");
    if (isArchived(key)) throw new HttpError(409, "Chat is archived");
  }

  let content = (input.content ?? "").trim();
  const audioIdx = files.findIndex(isAudioFile);
  let transcript = input.transcription?.trim() || null;
  if (audioIdx >= 0 && !transcript) transcript = await sttDeps.transcribe(files[audioIdx]!);

  // No text: use the transcript, else a placeholder naming the file(s).
  if (!content) {
    if (transcript) content = transcript;
    else if (input.surface === "ui" && audioIdx >= 0) content = VOICE_STT_FAILED;
    else if (files.length === 1) content = `(Datei: ${files[0]!.name || "ohne Namen"})`;
    else if (files.length > 1) content = `(${files.length} Dateien)`;
  }
  if (!content) throw new HttpError(400, input.surface === "ui" ? "Message is empty" : "Missing 'message' field");

  touchChatSession(key, { title: deriveSessionTitle(content) });
  const msg = db
    .prepare("INSERT INTO messages (channel, sender, content, session_key) VALUES ('web', 'web-ui', ?, ?) RETURNING id, content, created_at")
    .get(content, key) as { id: number; content: string; created_at: string };

  const attachments: Attachment[] = [];
  for (const [idx, file] of files.entries()) {
    try {
      attachments.push(
        await saveAttachment(db, {
          messageId: msg.id,
          file,
          mimeType: voiceMime(file, input.surface === "ui" && idx === audioIdx),
          fileName: file.name,
          transcription: idx === audioIdx ? transcript : null,
        }),
      );
    } catch (e) {
      // Non-fatal: the message goes through without that attachment.
      console.error("[chat] failed to save attachment:", e);
    }
  }

  // Touch wake file
  try {
    mkdirSync(join(home(), "inbox"), { recursive: true });
    closeSync(openSync(join(home(), ".index", ".wake"), "w"));
  } catch {}

  const createdAt = toIso(msg.created_at)!;
  // Attachment metadata lets the agent fetch voice notes / files via /api/v1/attachments/<id>.
  const payload = JSON.stringify({
    inbox_message_id: msg.id,
    sender: "web-ui",
    message: wrapWebMessage(content.slice(0, 20000), { userMail: input.userMail, userName: input.userName }),
    timestamp: createdAt,
    attachments: attachments.map((a) => ({
      id: a.id,
      kind: a.kind,
      mime_type: a.mime_type,
      file_name: a.file_name,
      file_size: a.file_size,
      transcription: a.transcription,
      url: attachmentUrl(a.id),
    })),
  });
  const triggered = fireTrigger(CHAT_TRIGGER, payload, key);

  notifyLocal(key, { kind: "user_message", userMessageId: msg.id, clientId: input.clientId, triggered });
  return { id: msg.id, content: msg.content, createdAt, attachments, triggered };
}

/** The /ui item for a sent message (clientId echoed). */
export function sentMessageItem(m: SentMessage, clientId?: string): ChatUserItem {
  const item = userItem({ id: m.id, content: m.content, created_at: m.createdAt }, m.attachments.map(toChatAttachment));
  return clientId ? { ...item, clientId } : item;
}

/** Interrupt the running turn (the session stays alive). */
export async function stopTurn(key: string): Promise<StopChatTurnResponse> {
  if (currentRunState(key) === "idle") return { stopped: false, reason: "not_running" };
  const ok = await trySocketInject(getSocketPath(CHAT_TRIGGER, key), "", "web", key, "interrupt");
  return ok ? { stopped: true } : { stopped: false, reason: "unreachable" };
}

export function snapshot(key: string): ChatSnapshot {
  if (!ensureSession(key)) throw new HttpError(404, "Chat not found");
  return getHub(key).snapshot();
}
