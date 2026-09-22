/**
 * Wire types for the Chat area: /ui/api/chat/* (JSON + SSE).
 *
 * Shared by the server (ui-api/chat*) and the React client (frontend/pages/chat).
 * Pure types and constants, no imports, so the frontend bundle stays free of
 * server code. Timestamps are ISO 8601 with Z (sent through toIso()).
 *
 * The external /api/v1/chat/* contract is NOT described here; it keeps its
 * own legacy shapes (see ui-api/chat/legacy.ts).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Session keys: chat_sessions.session_key, messages.session_key, trigger_sessions.session_key. */
export const SESSION_KEY_PATTERN = "^[a-zA-Z0-9_-]{1,128}$";
export const DEFAULT_SESSION_KEY = "_default";

/**
 * Header the UI must send on multipart uploads (voice messages). Multipart is
 * a CORS-safelisted content type, so a custom header (which forces a preflight
 * the server never answers) is what keeps cross-site forms out.
 */
export const UI_CLIENT_HEADER = "X-Atlas-UI";
export const UI_CLIENT_HEADER_VALUE = "1";

/** Server-side upload cap for one voice message. Larger bodies get 413. */
export const MAX_VOICE_BYTES = 25 * 1024 * 1024;

/** Snapshot keeps at most this many (newest) items; `truncated` tells the client. */
export const SNAPSHOT_MAX_ITEMS = 400;

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface ChatSessionSummary {
  key: string;
  /** Manual or derived title; null = none yet (client shows "Default chat" for _default, else "New chat"). */
  title: string | null;
  createdAt: string;
  /** chat_sessions.updated_at (touched on send, rename, archive). */
  updatedAt: string;
  archivedAt: string | null;
  /** Newest user message, else createdAt. Sort key and Today/Yesterday/Earlier bucket; renames don't move a chat. */
  lastActivityAt: string;
  /** User messages in this chat (messages.channel = 'web'). */
  messageCount: number;
  /** Last user message, one line, max 120 chars; null when empty. */
  preview: string | null;
  /** Current Claude session id (trigger_sessions, trigger 'web-chat'); null before the first reply or after a reset. */
  sessionId: string | null;
  /** True for _default: cannot be archived or deleted. */
  isDefault: boolean;
}

export interface ChatSessionStats {
  /** SUM(session_metrics.cost_usd) for sessionId. */
  costUsd: number;
  /** trigger_runs rows for sessionId. */
  runs: number;
}

export interface ChatSessionDetail extends ChatSessionSummary {
  /** null when sessionId is null. */
  stats: ChatSessionStats | null;
}

/** GET /ui/api/chat/sessions?archived=exclude|only|all&q= */
export interface ChatSessionsQuery {
  /** Default "exclude". */
  archived?: "exclude" | "only" | "all";
  /** Case-insensitive substring over titles and user message text (assistant replies are not searched). */
  q?: string;
}

export interface ChatSessionsResponse {
  /** Sorted by lastActivityAt desc. */
  sessions: ChatSessionSummary[];
}

/** POST /ui/api/chat/sessions */
export interface CreateChatSessionRequest {
  title?: string | null;
}
/** 201 */
export interface CreateChatSessionResponse {
  session: ChatSessionSummary;
}

/**
 * PATCH /ui/api/chat/sessions/:key. Omitted fields are left alone.
 * title: trimmed, max 200 chars, "" or null clears it.
 * archived: 400 for _default.
 */
export interface UpdateChatSessionRequest {
  title?: string | null;
  archived?: boolean;
}
export interface UpdateChatSessionResponse {
  session: ChatSessionDetail;
}

/** DELETE /ui/api/chat/sessions/:key, body {}. 400 for _default, 409 while a turn is starting/running. */
export interface DeleteChatSessionResponse {
  ok: true;
}

// ---------------------------------------------------------------------------
// Conversation items
// ---------------------------------------------------------------------------

export interface ChatAttachment {
  id: string;
  kind: "audio" | "image" | "video" | "document" | "other";
  mimeType: string;
  fileName: string;
  fileSize: number;
  /** Keyless download URL (/ui/api/activity/attachments/:id); null when the file is gone (attachments live in /tmp). */
  url: string | null;
  /** STT result for audio; null when none or STT failed. */
  transcription: string | null;
}

interface ItemBase {
  /**
   * Stable id, unique within a session, identical across snapshots:
   *   user       "u:<messages.id>"
   *   assistant  "a:<jsonl line uuid>:<block index>"
   *   thinking   "k:<jsonl line uuid>:<block index>"
   *   tool       "t:<tool_use_id>"
   * (lines without uuid use "@<byte offset>" in place of the uuid)
   */
  id: string;
  at: string | null;
}

export interface ChatUserItem extends ItemBase {
  kind: "user";
  /** messages.id */
  messageId: number;
  /** messages.content as stored (not the <webmsg> envelope the agent sees). */
  text: string;
  attachments: ChatAttachment[];
  /**
   * Echo of SendChatMessageRequest.clientId. Only present on the POST response
   * and on the live `item` event of that send, never in snapshots. Used to
   * swap the optimistic bubble for the real one.
   */
  clientId?: string;
}

export interface ChatAssistantItem extends ItemBase {
  kind: "assistant";
  /** Markdown. Clipped at 20 000 chars with a "… (N more characters)" suffix. */
  text: string;
  /** Anthropic message id; equals StreamDraft.streamId of the deltas this text was streamed as. */
  streamId: string | null;
}

export interface ChatThinkingItem extends ItemBase {
  kind: "thinking";
  text: string;
}

export interface ChatToolItem extends ItemBase {
  kind: "tool";
  toolUseId: string | null;
  name: string;
  /** One-line hint: command, file_path, path, pattern, url, query, description or prompt from the input; else "". Max 160 chars. */
  summary: string;
  /** Input as pretty JSON (or raw string). Clipped at 20 000 chars. */
  input: string;
  /** null until the result arrives (then an `item_update`). Clipped at 20 000 chars. */
  result: string | null;
  isError: boolean;
}

export type ChatItem = ChatUserItem | ChatAssistantItem | ChatThinkingItem | ChatToolItem;
export type ChatItemKind = ChatItem["kind"];

/** Assistant text streamed so far that has no final `assistant` item yet. */
export interface StreamDraft {
  streamId: string;
  text: string;
}

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

/**
 * idle      nothing in flight
 * starting  a message was sent and trigger.sh fired, runner not yet reporting
 * running   the runner reported turn start and no turn end yet
 */
export type ChatRunState = "idle" | "starting" | "running";

export interface ChatRun {
  state: ChatRunState;
  /** When the current state began (turn start for "running"); null for idle. */
  since: string | null;
  /** True when POST .../stop can interrupt (state "running" and the runner's control socket exists). */
  canStop: boolean;
  /** Set on "idle" when the turn ended because it was stopped; open drafts will never be finalized. */
  interrupted?: boolean;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/** GET /ui/api/chat/sessions/:key, and the first `snapshot` event of every stream connection. */
export interface ChatSnapshot {
  session: ChatSessionDetail;
  /** Chronological. At most SNAPSHOT_MAX_ITEMS (newest kept). */
  items: ChatItem[];
  /** In-flight streamed text (only while a turn is running). */
  drafts: StreamDraft[];
  run: ChatRun;
  /** Older items exist that are not included (item cap, or only the transcript tail was read). Full transcript: Activity. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Send / stop
// ---------------------------------------------------------------------------

/**
 * POST /ui/api/chat/sessions/:key/messages
 *
 * JSON (Content-Type: application/json):  SendChatMessageRequest
 * Voice (multipart/form-data + UI_CLIENT_HEADER): fields
 *   file      required, one audio blob (audio/webm, audio/ogg, audio/mp4, …), <= MAX_VOICE_BYTES
 *   message   optional caption; when empty the transcription becomes the message text
 *   clientId  optional, as below
 * The server runs STT inline (may take many seconds). When STT fails the text is
 * "(Voice message, transcription failed)" and the audio is still attached.
 *
 * Creates the chat_sessions row if missing (derived title). 409 when the chat is
 * archived or Atlas is paused; 400 on empty content; 413 over MAX_VOICE_BYTES.
 * Sending while a turn runs is allowed: the runner steers the running turn.
 */
export interface SendChatMessageRequest {
  content: string;
  /** Client-generated id (e.g. crypto.randomUUID()) echoed back on the created item. */
  clientId?: string;
}

/** 201 */
export interface SendChatMessageResponse {
  item: ChatUserItem;
  /** False when trigger.sh could not be started (e.g. outside the container): the message is saved but no agent will answer. */
  triggered: boolean;
}

/** POST /ui/api/chat/sessions/:key/stop, body {} — interrupts the current turn only (the session stays alive). */
export interface StopChatTurnResponse {
  stopped: boolean;
  /** Set when stopped is false. */
  reason?: "not_running" | "unreachable";
}

// ---------------------------------------------------------------------------
// Live stream: GET /ui/api/chat/sessions/:key/stream (text/event-stream)
// ---------------------------------------------------------------------------

/**
 * SSE events, `event: <name>\ndata: <json>\n\n`.
 *
 * - The first event of every connection is `snapshot`; a later `snapshot`
 *   (e.g. after the Claude session was reset or replaced) replaces all state.
 * - Heartbeat: `: keepalive` comment lines, no data.
 * - No time cap: the server never closes a healthy stream. `retry: 2000` is
 *   sent up front; on reconnect the client gets a fresh snapshot.
 * - 404 (JSON) instead of a stream when the session does not exist.
 *
 * Order guarantees within one connection: a `delta` for a streamId arrives
 * before the `item` that finalises it; items arrive in conversation order.
 */
export interface ChatStreamEventMap {
  snapshot: ChatSnapshot;
  /** New item: append (or replace when the id is already present). */
  item: { item: ChatItem };
  /** Existing item changed (tool result arrived): replace by id; ignore unknown ids. */
  item_update: { item: ChatItem };
  /** Append text to the draft `streamId` (create it at the end if missing). Coalesced: one event per streamId per server flush. */
  delta: { streamId: string; text: string };
  /** Run state changed. */
  run: ChatRun;
  /** Title / archive / sessionId / stats changed. */
  session: ChatSessionDetail;
  /** The chat was deleted (possibly from another tab). The server closes the stream after this. */
  session_deleted: { key: string };
}

export type ChatStreamEventName = keyof ChatStreamEventMap;

export type ChatStreamEvent = {
  [K in ChatStreamEventName]: { event: K; data: ChatStreamEventMap[K] };
}[ChatStreamEventName];

export const CHAT_STREAM_EVENTS = [
  "snapshot",
  "item",
  "item_update",
  "delta",
  "run",
  "session",
  "session_deleted",
] as const satisfies readonly ChatStreamEventName[];

// ---------------------------------------------------------------------------
// Endpoint index (documentation; paths relative to the origin)
// ---------------------------------------------------------------------------
//
// GET    /ui/api/chat/sessions?archived&q        ChatSessionsResponse
// POST   /ui/api/chat/sessions                   CreateChatSessionRequest → 201 CreateChatSessionResponse
// GET    /ui/api/chat/sessions/:key              ChatSnapshot | 404
// PATCH  /ui/api/chat/sessions/:key              UpdateChatSessionRequest → UpdateChatSessionResponse
// DELETE /ui/api/chat/sessions/:key              {} → DeleteChatSessionResponse
// POST   /ui/api/chat/sessions/:key/messages     SendChatMessageRequest | multipart → 201 SendChatMessageResponse
// POST   /ui/api/chat/sessions/:key/stop         {} → StopChatTurnResponse
// GET    /ui/api/chat/sessions/:key/stream       text/event-stream of ChatStreamEvent
//
// Errors are { error: string } with 400/404/409/413/415/403 as documented above.
