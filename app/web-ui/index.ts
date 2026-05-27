import { Hono } from "hono";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  closeSync,
  openSync,
  statSync,
  unlinkSync,
  chmodSync,
  renameSync,
} from "fs";
import { join, resolve, relative } from "path";
import { homedir } from "os";
import { getDb } from "../lib/atlas-db";
import { apiKeyAuth } from "../lib/api-auth";
import { resolveConfig, redactConfig, getConfigSources } from "../lib/config";
import { pauseAtlas, resumeAtlas, stopAllSessions, getControlStatus, isAtlasPaused } from "../lib/kill-switch";
import {
  saveAttachment,
  getAttachment,
  getAttachmentsForMessage,
  attachmentDiskPath,
  attachmentExists,
  attachmentUrl,
  type Attachment,
} from "../lib/attachments";

// --- Config ---
const AGENT_NAME = process.env.AGENT_NAME || "Atlas";
const WS = process.env.HOME!;
const MEMORY = `${WS}/memory`;
const IDENTITY = `${WS}/IDENTITY.md`;
const CONFIG = `${WS}/config.yml`;
const EXTENSIONS = `${WS}/user-extensions.sh`;
const WAKE = `${WS}/.index/.wake`;

function syncCrontab(): void {
  try {
    Bun.spawnSync(["bun", "run", "/atlas/app/triggers/sync-crontab.ts"]);
  } catch {}
}

const db = getDb();

// --- Helpers ---
function safe(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readFile(p: string): string {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

function channelIcon(ch: string): string {
  const icons: Record<string, string> = {
    signal: "S",
    email: "@",
    web: "W",
    internal: "I",
  };
  return icons[ch] || "?";
}

function timeAgo(dt: string): string {
  if (!dt) return "";
  const diff = Date.now() - new Date(dt.endsWith("Z") ? dt : dt + "Z").getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Convert SQLite "YYYY-MM-DD HH:MM:SS" UTC timestamp to ISO 8601 with Z marker.
 * SQLite's datetime('now') returns UTC without timezone info; clients (e.g.
 * `new Date(...)` in browsers) interpret unmarked timestamps as local time,
 * which renders user messages 1-2 hours off depending on the viewer's TZ.
 */
export function sqliteToIso(s: string): string {
  if (!s) return s;
  if (s.endsWith("Z")) return s;
  return s.replace(" ", "T") + "Z";
}

// --- Multi-session web-chat helpers ---

/** Reads session key from query param. Defaults to '_default' for backward compatibility. */
export function resolveWebSessionKey(c: any): string {
  const fromQuery = c.req.query("sessionKey");
  if (fromQuery && typeof fromQuery === "string") {
    const trimmed = fromQuery.trim();
    if (trimmed.length > 0 && trimmed.length <= 128 && /^[a-zA-Z0-9_\-]+$/.test(trimmed)) {
      return trimmed;
    }
  }
  return "_default";
}

/** Ensures a chat_sessions row exists. Idempotent. Updates updated_at and,
 *  via COALESCE, backfills the title only when it is still NULL — manual
 *  titles from PATCH /chat/sessions/:key are never overwritten. */
function touchChatSession(sessionKey: string, opts?: { title?: string }): void {
  db.prepare(
    `INSERT INTO chat_sessions (session_key, channel, title)
     VALUES (?, 'web', ?)
     ON CONFLICT(session_key) DO UPDATE SET
       updated_at = datetime('now'),
       title = COALESCE(chat_sessions.title, excluded.title)`
  ).run(sessionKey, opts?.title ?? null);
}

/** Generates a placeholder title from first user message content. */
export function deriveSessionTitle(content: string): string {
  const clean = content.replace(/\s+/g, ' ').trim();
  if (clean.length <= 60) return clean;
  return clean.slice(0, 57).trimEnd() + '…';
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
export function wrapWebMessage(
  content: string,
  attrs: { userMail?: string | null; userName?: string | null } = {},
): string {
  const xmlEscape = (s: string): string =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const parts: string[] = [];
  const mail = (attrs.userMail ?? "").trim();
  const name = (attrs.userName ?? "").trim();
  if (mail) parts.push(`user-mail="${xmlEscape(mail)}"`);
  if (name) parts.push(`user-name="${xmlEscape(name)}"`);

  const attrStr = parts.length > 0 ? " " + parts.join(" ") : "";
  return `<webmsg${attrStr}>\n${content}\n</webmsg>`;
}

/** Row shape returned by the sidebar listing query. Exported for tests. */
export interface ChatSidebarRow {
  session_key: string;
  title: string | null;
  updated_at: string;
  message_count: number;
}

/** Loads all non-archived web chat sessions for the sidebar.
 *  _default is always included (even if no chat_sessions row exists yet)
 *  so the page is never empty on a fresh install. */
export function listSidebarSessions(): ChatSidebarRow[] {
  const rows = db.prepare(`
    SELECT
      cs.session_key,
      cs.title,
      cs.updated_at,
      COUNT(m.id) AS message_count
    FROM chat_sessions cs
    LEFT JOIN messages m ON m.channel = 'web' AND m.session_key = cs.session_key
    WHERE cs.channel = 'web' AND cs.archived_at IS NULL
    GROUP BY cs.session_key
    ORDER BY (cs.session_key = '_default') DESC, cs.updated_at DESC
  `).all() as ChatSidebarRow[];
  if (!rows.some(r => r.session_key === '_default')) {
    rows.unshift({ session_key: '_default', title: null, updated_at: '', message_count: 0 });
  }
  return rows;
}

/** Renders the sidebar HTML fragment, highlighting `activeKey` and showing
 *  a rename form for `editKey` if provided. */
export function renderChatSidebar(activeKey: string, editKey: string | null = null): string {
  const rows = listSidebarSessions();
  const items = rows.map(r => {
    const isActive = r.session_key === activeKey;
    const isEditing = r.session_key === editKey;
    const displayTitle = r.title?.trim() || (r.session_key === '_default' ? 'Default' : 'Untitled chat');
    const cls = isActive ? 'chat-session active' : 'chat-session';
    const sk = safe(r.session_key);
    const meta = r.message_count > 0 ? `${r.message_count} msg` : 'empty';

    if (isEditing) {
      return `<div class="chat-session ${isActive ? 'active' : ''} chat-session-rename">
        <form hx-patch="/chat/sessions/${sk}" hx-target="#chat-sidebar" hx-swap="outerHTML">
          <input type="text" name="title" value="${safe(r.title ?? '')}" placeholder="Title…" autofocus required>
          <div class="row">
            <button type="submit">Save</button>
            <button type="button" class="btn-outline btn-sm" hx-get="/chat/sidebar?session=${sk}" hx-target="#chat-sidebar" hx-swap="outerHTML">Cancel</button>
          </div>
        </form>
      </div>`;
    }

    const editBtn = `<button type="button" title="Rename" hx-get="/chat/sidebar?session=${safe(activeKey)}&edit=${sk}" hx-target="#chat-sidebar" hx-swap="outerHTML">✎</button>`;
    const archiveBtn = `<button type="button" title="Archive" hx-post="/chat/sessions/${sk}/archive" hx-target="#chat-sidebar" hx-swap="outerHTML">📥</button>`;
    const deleteBtn = r.session_key === '_default'
      ? ''
      : `<button type="button" title="Delete" hx-delete="/chat/sessions/${sk}" hx-target="#chat-sidebar" hx-swap="outerHTML" hx-confirm="Delete this chat? This cannot be undone.">🗑</button>`;

    return `<a class="${cls}" href="/chat?session=${sk}">
      <span class="chat-session-title">${safe(displayTitle)}</span>
      <span class="chat-session-meta">${meta}</span>
      <span class="chat-session-actions">${editBtn}${archiveBtn}${deleteBtn}</span>
    </a>`;
  }).join("");

  const list = items.length > 0 ? items : '<div class="chat-session-empty">No chats yet.</div>';

  return `<aside class="chat-sidebar" id="chat-sidebar">
    <div class="chat-sidebar-head">
      <button type="button" hx-post="/chat/sessions/new" hx-swap="none">+ New chat</button>
    </div>
    <div class="chat-sidebar-list">${list}</div>
  </aside>`;
}

// --- Layout ---
function layout(
  title: string,
  content: string,
  active: string = "",
  mainStyle: string = "",
): string {
  const nav = [
    ["/", "Dashboard", "dashboard"],
    ["/inbox", "Inbox", "inbox"],
    ["/triggers", "Triggers", "triggers"],
    ["/analytics", "Analytics", "analytics"],
    ["/sessions", "Sessions", "sessions"],
    ["/memory", "Memory", "memory"],
    ["/journal", "Journal", "journal"],
    ["/chat", "Chat", "chat"],
    ["/settings", "Settings", "settings"],
  ];
  const links = nav
    .map(
      ([href, label, id]) =>
        `<a href="${href}" class="${active === id ? "active" : ""}">${label}</a>`,
    )
    .join("");

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safe(title)} - ${safe(AGENT_NAME)}</title>
<script src="https://unpkg.com/htmx.org@2.0.4"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#1a1b2e;color:#e0e0e0;font:14px/1.5 'SF Mono','Cascadia Code','Consolas',monospace;display:flex;min-height:100vh}
nav{width:180px;background:#151625;padding:16px 0;border-right:1px solid #3a3b55;flex-shrink:0;position:fixed;height:100vh;overflow-y:auto}
nav .logo{padding:12px 16px;font-size:16px;font-weight:700;color:#7c6ef0;border-bottom:1px solid #3a3b55;margin-bottom:8px}
nav a{display:block;padding:8px 16px;color:#999;text-decoration:none;font-size:13px;transition:all .15s}
nav a:hover{color:#e0e0e0;background:#252640}
nav a.active{color:#7c6ef0;background:#252640;border-right:2px solid #7c6ef0}
main{margin-left:180px;flex:1;padding:24px;max-width:960px}
h1{font-size:20px;margin-bottom:16px;color:#e0e0e0;font-weight:600}
.card{background:#252640;border:1px solid #3a3b55;border-radius:6px;padding:16px;margin-bottom:12px}
.card h3{font-size:14px;color:#7c6ef0;margin-bottom:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:16px}
.stat{background:#252640;border:1px solid #3a3b55;border-radius:6px;padding:12px;text-align:center}
.stat .num{font-size:28px;font-weight:700;color:#7c6ef0}
.stat .label{font-size:11px;color:#999;text-transform:uppercase}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #3a3b55;font-size:13px}
th{color:#999;font-size:11px;text-transform:uppercase}
tr:hover{background:#2a2b45}
.ch-icon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:4px;background:#3a3b55;font-size:11px;font-weight:700;color:#7c6ef0}
input,textarea,select{background:#1a1b2e;color:#e0e0e0;border:1px solid #3a3b55;border-radius:4px;padding:8px 10px;font:13px/1.4 inherit;width:100%}
input:focus,textarea:focus{outline:none;border-color:#7c6ef0}
textarea{resize:vertical;min-height:120px}
button,.btn{background:#7c6ef0;color:#fff;border:none;border-radius:4px;padding:8px 16px;font:13px/1 inherit;cursor:pointer;transition:background .15s}
button:hover,.btn:hover{background:#6b5cd9}
.btn-sm{padding:4px 10px;font-size:12px}
.btn-outline{background:transparent;border:1px solid #3a3b55;color:#e0e0e0}
.btn-outline:hover{border-color:#7c6ef0;color:#7c6ef0}
.msg-row{cursor:pointer}
.msg-detail{padding:12px;background:#1e1f35;border-radius:4px;margin-top:8px;white-space:pre-wrap;font-size:13px}
.flash{padding:10px 14px;border-radius:4px;margin-bottom:12px;font-size:13px}
.flash-ok{background:#1b3a1b;border:1px solid #4caf50;color:#4caf50}
.flash-err{background:#3a1b1b;border:1px solid #f44336;color:#f44336}
pre{background:#1a1b2e;border:1px solid #3a3b55;border-radius:4px;padding:12px;overflow-x:auto;font-size:13px;white-space:pre-wrap;word-break:break-word}
.search-box{display:flex;gap:8px;margin-bottom:12px}
.search-box input{flex:1}
.tag{display:inline-block;padding:1px 6px;border-radius:3px;font-size:11px;margin-right:4px;background:#3a3b55;color:#ccc}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.mt-8{margin-top:8px}.mb-8{margin-bottom:8px}.mb-16{margin-bottom:16px}
.flex{display:flex;align-items:center;gap:8px}
.text-muted{color:#999;font-size:12px}
.chat-layout{display:flex;flex-direction:row;height:calc(100vh - 48px)}
.chat-sidebar{width:240px;background:#1e1f35;border-right:1px solid #3a3b55;display:flex;flex-direction:column;flex-shrink:0}
.chat-sidebar-head{padding:12px;border-bottom:1px solid #3a3b55}
.chat-sidebar-head button{width:100%;font-size:13px;padding:8px}
.chat-sidebar-list{flex:1;overflow-y:auto;padding:6px 0}
.chat-session{display:block;padding:10px 12px;border-left:2px solid transparent;color:#ccc;text-decoration:none;font-size:13px;cursor:pointer;position:relative}
.chat-session:hover{background:#252640;color:#e0e0e0}
.chat-session.active{background:#252640;border-left-color:#7c6ef0;color:#e0e0e0}
.chat-session-title{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:28px}
.chat-session-meta{display:block;color:#666;font-size:11px;margin-top:2px}
.chat-session-actions{position:absolute;right:6px;top:8px;display:none;gap:2px}
.chat-session:hover .chat-session-actions,.chat-session.active .chat-session-actions{display:flex}
.chat-session-actions button{padding:2px 6px;font-size:11px;background:transparent;color:#999;border:1px solid #3a3b55;border-radius:3px}
.chat-session-actions button:hover{color:#7c6ef0;border-color:#7c6ef0;background:#1a1b2e}
.chat-session-actions form{display:inline}
.chat-session-rename{padding:8px 12px}
.chat-session-rename input{font-size:12px;padding:6px 8px;width:100%}
.chat-session-rename .row{display:flex;gap:4px;margin-top:4px}
.chat-session-rename button{padding:4px 10px;font-size:11px}
.chat-session-empty{padding:14px 12px;color:#666;font-size:12px;font-style:italic}
.chat-main{flex:1;display:flex;flex-direction:column;min-width:0}
.chat-container{display:flex;flex-direction:column;flex:1;min-height:0}
.chat-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column}
.chat-bubble{max-width:75%;border-radius:12px;padding:10px 14px;margin-bottom:4px;word-break:break-word;white-space:pre-wrap}
.chat-bubble.user{align-self:flex-end;background:#7c6ef0;color:#fff}
.chat-bubble.bot{align-self:flex-start;background:#252640;border-left:2px solid #7c6ef0}
.chat-time{font-size:11px;color:#666;margin-bottom:12px}
.chat-time.user{text-align:right}
.chat-input{border-top:1px solid #3a3b55;padding:12px 16px;display:flex;gap:8px}
.chat-input input{flex:1}
.typing-dots{align-self:flex-start;background:#252640;border-left:2px solid #7c6ef0;border-radius:12px;padding:10px 14px;margin-bottom:4px}
.typing-dots span{display:inline-block;width:8px;height:8px;border-radius:50%;background:#7c6ef0;margin:0 2px;animation:dotPulse 1.4s infinite ease-in-out both}
.typing-dots span:nth-child(1){animation-delay:0s}
.typing-dots span:nth-child(2){animation-delay:.2s}
.typing-dots span:nth-child(3){animation-delay:.4s}
@keyframes dotPulse{0%,80%,100%{opacity:.3;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}
.chat-tool{align-self:flex-start;max-width:85%;margin-bottom:4px}
.chat-tool details{background:#1e1f35;border:1px solid #3a3b55;border-radius:8px;overflow:hidden}
.chat-tool summary{padding:8px 12px;cursor:pointer;color:#999;font-size:12px;user-select:none}
.chat-tool summary:hover{color:#7c6ef0}
.tool-call-item{padding:8px 12px;border-top:1px solid #3a3b55}
.tool-call-name{font-size:12px;color:#7c6ef0;font-weight:600;margin-bottom:4px}
.tool-call-input,.tool-call-result{margin:4px 0;padding:6px 8px;font-size:11px;max-height:200px;overflow-y:auto}
.tool-call-result{border-left:2px solid #4caf50}
.chat-thinking{align-self:flex-start;max-width:85%;margin-bottom:4px}
.chat-thinking details{background:#1a1b2e;border:1px solid #2a2b45;border-radius:8px;overflow:hidden;opacity:0.6}
.chat-thinking summary{padding:6px 12px;cursor:pointer;color:#666;font-size:11px;font-style:italic}
.chat-thinking pre{margin:0;padding:8px 12px;font-size:11px;max-height:200px;overflow-y:auto;color:#888}
</style></head><body>
<nav><div class="logo">${safe(AGENT_NAME).toUpperCase()}</div>${links}</nav>
<main${mainStyle ? ` style="${mainStyle}"` : ""}>${content}</main>
</body></html>`;
}

// --- Session JSONL helpers ---

interface ParsedMessage {
  type: "user-text" | "user-tool-result" | "assistant-text" | "assistant-tool-use" | "assistant-thinking";
  content: string;
  timestamp?: string;
  toolName?: string;
  toolInput?: string;
  /** Anthropic message.id (UUID). Present on assistant blocks; used to stitch
   *  streamed chunks to their final assistant_message on the client side. */
  messageId?: string;
}

function findSessionFile(sessionId: string): string | null {
  const home = homedir();
  const projectsDir = join(home, ".claude", "projects");
  if (!existsSync(projectsDir)) return null;

  try {
    for (const dir of readdirSync(projectsDir)) {
      const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {}
  return null;
}

export function parseSessionMessages(filePath: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return messages;
  }

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = obj.timestamp;

    if (obj.type === "user") {
      // Support both old format (obj.message: string|array) and new format (obj.message: {role,content})
      const rawMsg = obj.message;
      const msgContent = (rawMsg && typeof rawMsg === "object" && !Array.isArray(rawMsg) && rawMsg.content !== undefined)
        ? rawMsg.content : rawMsg;

      if (typeof msgContent === "string") {
        // Try to extract clean user text from inject template payload JSON
        let text = msgContent;
        try {
          const parsed = JSON.parse(text);
          if (parsed.message) text = parsed.message;
        } catch {}
        // Skip if this looks like a system/inject template (starts with "New event for trigger")
        if (/^New event for trigger /.test(text)) {
          const payloadMatch = text.match(/\n\n(\{[\s\S]*\})\n\n/);
          if (payloadMatch) {
            try {
              const payload = JSON.parse(payloadMatch[1]);
              if (payload.message) text = payload.message;
            } catch {}
          }
        }
        messages.push({ type: "user-text", content: text, timestamp: ts });
      } else if (Array.isArray(msgContent)) {
        // Could contain tool_result blocks
        for (const block of msgContent) {
          if (block.type === "tool_result") {
            const resultContent = Array.isArray(block.content)
              ? block.content.map((c: any) => c.text || "").join("\n")
              : typeof block.content === "string"
                ? block.content
                : JSON.stringify(block.content);
            messages.push({
              type: "user-tool-result",
              content: resultContent,
              timestamp: ts,
              toolName: block.tool_use_id,
            });
          }
        }
      }
    } else if (obj.type === "assistant") {
      // Support both old format (obj.message: array) and new format (obj.message: {role,content})
      const rawMsg = obj.message;
      const msgBlocks = (rawMsg && typeof rawMsg === "object" && !Array.isArray(rawMsg) && Array.isArray(rawMsg.content))
        ? rawMsg.content : rawMsg;
      // Anthropic message.id — same id the SDK emits on stream_event.message_start
      // events. We propagate it on every block produced by this turn so the
      // SSE handler can match streamed chunks to the final assistant_message.
      const messageId: string | undefined =
        (rawMsg && typeof rawMsg === "object" && !Array.isArray(rawMsg) && typeof rawMsg.id === "string")
          ? rawMsg.id
          : undefined;
      if (!Array.isArray(msgBlocks)) continue;
      for (const block of msgBlocks) {
        if (block.type === "text" && block.text) {
          messages.push({ type: "assistant-text", content: block.text, timestamp: ts, messageId });
        } else if (block.type === "tool_use") {
          const inputStr = typeof block.input === "string"
            ? block.input
            : JSON.stringify(block.input, null, 2);
          messages.push({
            type: "assistant-tool-use",
            content: block.name || "tool",
            timestamp: ts,
            toolName: block.name,
            toolInput: inputStr.length > 2000 ? inputStr.slice(0, 2000) + "..." : inputStr,
          });
        } else if (block.type === "thinking" && block.thinking) {
          messages.push({
            type: "assistant-thinking",
            content: block.thinking.length > 1000
              ? block.thinking.slice(0, 1000) + "..."
              : block.thinking,
            timestamp: ts,
          });
        }
      }
    }
    // Skip system, progress, file-history-snapshot, etc.
  }

  return messages;
}

/**
 * Check if a Claude Code process is currently running for the given session ID.
 *
 * Why we can't use the IPC socket (`/tmp/claudec-<id>.sock`): customer Atlas
 * deployments invoke `/usr/bin/claude` directly — no `claudec` wrapper, no
 * socket file. So the previous `existsSync(socketPath)` check never returned
 * true on customer pods, which meant `isAgentRunning` was always false and
 * the SSE `agent_started`/`agent_ended` events never fired. The chat frontend
 * relied entirely on its 120s safety timeout to clear the typing indicator.
 *
 * Detect the active process by scanning `/proc/<pid>/cmdline` for the session
 * UUID — `claude --resume <id>` puts the UUID in argv. UUIDs are unique
 * enough that a substring match is reliable.
 */
export function isClaudeProcessRunning(sessionId: string): boolean {
  if (!sessionId) return false;
  let procDirs: string[];
  try {
    procDirs = readdirSync("/proc");
  } catch {
    return false; // not a Linux /proc filesystem
  }
  for (const dir of procDirs) {
    // Skip non-pid entries (kernel threads, version, etc.)
    if (!/^\d+$/.test(dir)) continue;
    try {
      const cmdline = readFileSync(`/proc/${dir}/cmdline`, "utf-8");
      if (cmdline.includes(sessionId)) return true;
    } catch {
      // Process exited between readdir and read — skip
    }
  }
  return false;
}

/**
 * Determine whether a Claude Code session is currently mid-turn (i.e. the
 * agent owes a response) based on the JSONL tail.
 *
 * Used as a secondary signal alongside `isClaudeProcessRunning`. Helps when
 * the process check has a brief gap (e.g. claude just exited but next
 * message is queued) — if the JSONL says the last entry is `user` or an
 * assistant `tool_use`, more work is pending.
 *
 * Rule: the agent is "working" if the last user/assistant entry is either
 *   - a `user` message (fresh prompt or tool_result waiting for response), OR
 *   - an `assistant` message with `stop_reason === "tool_use"` (tool pending)
 * Otherwise (final assistant message with end_turn / stop_sequence / etc.)
 * the turn has completed and the agent is idle.
 *
 * If no JSONL exists yet, the session is just spawning → treat as active.
 */
export function isAgentTurnActive(filePath: string | null): boolean {
  if (!filePath) return true; // session starting up, no JSONL yet
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return true; // unreadable → assume active to avoid stuck-done state
  }
  const lines = content.split("\n");
  // Iterate backwards to find the last user/assistant entry (skip system,
  // last-prompt, pr-link, attachment, etc. which are post-turn metadata).
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj: any;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === "user") {
      // Fresh user message or tool_result — agent will produce a response.
      return true;
    }
    if (obj.type === "assistant") {
      const msg = obj.message;
      const stopReason = (msg && typeof msg === "object" && !Array.isArray(msg))
        ? msg.stop_reason
        : null;
      // Allowlist: only `tool_use` means more model work is coming.
      // Everything else (end_turn / stop_sequence / max_tokens / refusal /
      // null / unknown) is treated as terminal. Erring toward "done" here is
      // safe — if the agent is truly mid-turn, the next JSONL line will land
      // within ~500ms and the next poll will flip back to active.
      return stopReason === "tool_use";
    }
  }
  // No user/assistant entries at all — session just spawned; treat as active.
  return true;
}

function renderConversation(messages: ParsedMessage[]): string {
  let html = "";
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];

    if (msg.type === "user-text") {
      html += `<div class="chat-bubble user">${safe(msg.content)}</div>`;
      if (msg.timestamp) html += `<div class="chat-time user">${timeAgo(msg.timestamp)}</div>`;
      i++;
    } else if (msg.type === "assistant-text") {
      html += `<div class="chat-bubble bot">${safe(msg.content)}</div>`;
      if (msg.timestamp) html += `<div class="chat-time">${timeAgo(msg.timestamp)}</div>`;
      i++;
    } else if (msg.type === "assistant-tool-use") {
      // Aggregate consecutive tool calls and their results
      const toolGroup: { name: string; input: string; result?: string }[] = [];
      while (i < messages.length && (messages[i].type === "assistant-tool-use" || messages[i].type === "user-tool-result")) {
        if (messages[i].type === "assistant-tool-use") {
          toolGroup.push({ name: messages[i].toolName || "tool", input: messages[i].toolInput || "" });
        } else if (messages[i].type === "user-tool-result" && toolGroup.length > 0) {
          // Attach result to the most recent tool call without a result
          const last = toolGroup[toolGroup.length - 1];
          if (!last.result) {
            last.result = messages[i].content;
          }
        }
        i++;
      }
      const summary = toolGroup.length === 1
        ? `${toolGroup[0].name}`
        : `${toolGroup.length} tool calls: ${toolGroup.map(t => t.name).join(", ")}`;
      html += `<div class="chat-tool"><details><summary>${safe(summary)}</summary>`;
      for (const t of toolGroup) {
        html += `<div class="tool-call-item"><div class="tool-call-name">${safe(t.name)}</div>`;
        html += `<pre class="tool-call-input">${safe(t.input.length > 500 ? t.input.slice(0, 500) + "..." : t.input)}</pre>`;
        if (t.result) {
          html += `<pre class="tool-call-result">${safe(t.result.length > 500 ? t.result.slice(0, 500) + "..." : t.result)}</pre>`;
        }
        html += `</div>`;
      }
      html += `</details></div>`;
    } else if (msg.type === "assistant-thinking") {
      html += `<div class="chat-thinking"><details><summary>thinking</summary><pre>${safe(msg.content)}</pre></details></div>`;
      i++;
    } else {
      // user-tool-result without preceding tool call — skip
      i++;
    }
  }
  return html;
}

// --- App ---
export const app = new Hono();

// ============ HEALTH CHECK ============
app.get("/healthz", (c) => {
  try {
    const row = db.prepare("SELECT 1 AS ok").get() as { ok: number } | null;
    if (row?.ok !== 1) throw new Error("unexpected query result");

    // Email integration status
    const config = resolveConfig(WS);
    const emailConfigured = !!config.email?.imap_host;
    let emailPollerRunning = false;
    if (emailConfigured) {
      try {
        // supervisorctl status <name> exits non-zero when not RUNNING, but never throws —
        // stdout contains "RUNNING" only when the process is actively up.
        const result = Bun.spawnSync(["supervisorctl", "status", "email-poller"]);
        emailPollerRunning = result.stdout.toString().includes("RUNNING");
      } catch {
        // supervisorctl not available or poller not registered — treat as not running
      }
    }

    return c.json({
      status: "ok",
      email: {
        configured: emailConfigured,
        poller_running: emailPollerRunning,
      },
    }, 200);
  } catch {
    return c.json({ status: "error" }, 503);
  }
});

// ============ DASHBOARD ============
app.get("/", (c) => {
  // Inbox message count
  const inboxTotal = (db.prepare("SELECT COUNT(*) as c FROM messages").get() as any)?.c || 0;

  // Recent journal files (YYYY-MM-DD.md directly in memory/)
  let journals: string[] = [];
  if (existsSync(MEMORY)) {
    journals = readdirSync(MEMORY)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .slice(0, 5);
  }

  const html = `
    <h1>Dashboard</h1>
    <div class="grid">
      <div class="stat"><div class="num">${inboxTotal}</div><div class="label">Inbox</div></div>
    </div>

    <div class="card"><h3>Recent Journals</h3>
    ${
      journals.length === 0
        ? '<div class="text-muted">No journal entries yet.</div>'
        : `<ul style="list-style:none">${journals
            .map((j) => {
              const d = j.replace(".md", "");
              return `<li style="padding:4px 0"><a href="/journal?date=${d}" style="color:#7c6ef0;text-decoration:none">${d}</a></li>`;
            })
            .join("")}</ul>`
    }
    </div>`;

  return c.html(layout("Dashboard", html, "dashboard"));
});

// ============ INBOX ============
app.get("/inbox", (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const limit = 100;
  const offset = (page - 1) * limit;

  const countSql = "SELECT COUNT(*) as c FROM messages";
  const sql = "SELECT * FROM messages ORDER BY created_at DESC LIMIT ? OFFSET ?";

  const total = (db.prepare(countSql).get() as any)?.c || 0;
  const msgs = db.prepare(sql).all(limit, offset) as any[];
  const totalPages = Math.ceil(total / limit);

  const qs = "";
  const paginationHtml =
    totalPages > 1
      ? `<div class="flex mt-8" style="justify-content:space-between">
    <span class="text-muted">Page ${page} of ${totalPages} (${total} messages)</span>
    <span>${page > 1 ? `<a href="/inbox?page=${page - 1}${qs}" class="btn btn-sm btn-outline">Prev</a> ` : ""}${page < totalPages ? `<a href="/inbox?page=${page + 1}${qs}" class="btn btn-sm btn-outline">Next</a>` : ""}</span>
  </div>`
      : "";

  const html = `
    <h1>Inbox</h1>
    <table>
      <tr><th>Channel</th><th>Sender</th><th>Content</th><th>Time</th></tr>
      ${msgs
        .map(
          (m) => `
        <tr class="msg-row" hx-get="/inbox/${m.id}" hx-target="#detail-${m.id}" hx-swap="innerHTML">
          <td><span class="ch-icon" title="${safe(m.channel)}">${channelIcon(m.channel)}</span></td>
          <td>${safe(m.sender || "-")}</td>
          <td>${safe((m.content || "").slice(0, 80))}${m.content?.length > 80 ? "..." : ""}</td>
          <td class="text-muted">${timeAgo(m.created_at)}</td>
        </tr>
        <tr id="detail-${m.id}"></tr>
      `,
        )
        .join("")}
    </table>
    ${msgs.length === 0 ? '<div class="card text-muted">No messages found.</div>' : ""}
    ${paginationHtml}`;

  return c.html(layout("Inbox", html, "inbox"));
});

app.get("/inbox/:id", (c) => {
  const msg = db
    .prepare("SELECT * FROM messages WHERE id = ?")
    .get(c.req.param("id")) as any;
  if (!msg) return c.html("<td colspan=5>Not found</td>");
  return c.html(`<td colspan="4"><div class="msg-detail">
    <strong>ID:</strong> ${msg.id} | <strong>Channel:</strong> ${msg.channel} | <strong>Sender:</strong> ${safe(msg.sender || "-")} | <strong>Created:</strong> ${msg.created_at}
    <hr style="border-color:#3a3b55;margin:8px 0">
    <strong>Content:</strong>
${safe(msg.content)}
  </div></td>`);
});

// ============ TRIGGERS ============

function triggerTypeIcon(type: string): string {
  return type === "cron"
    ? "&#9200;"
    : type === "webhook"
      ? "&#9889;"
      : "&#9654;";
}

function triggerRow(t: any): string {
  return `<tr>
    <td>${triggerTypeIcon(t.type)} ${safe(t.type)}</td>
    <td><strong>${safe(t.name)}</strong>${t.description ? `<br><span class="text-muted">${safe(t.description)}</span>` : ""}</td>
    <td>${
      t.type === "cron"
        ? `<code>${safe(t.schedule || "-")}</code>`
        : t.type === "webhook"
          ? `<code>/api/webhook/${safe(t.name)}</code>`
          : "-"
    }</td>
    <td><span class="dot" style="background:${t.enabled ? "#4caf50" : "#999"}"></span>${t.enabled ? "On" : "Off"}</td>
    <td class="text-muted">${t.last_run ? timeAgo(t.last_run) : "never"} (${t.run_count || 0}x)</td>
    <td class="flex">
      <button class="btn btn-sm btn-outline" hx-post="/triggers/${t.id}/toggle" hx-target="#trigger-list" hx-swap="innerHTML">
        ${t.enabled ? "Disable" : "Enable"}</button>
      <button class="btn btn-sm btn-outline" hx-post="/triggers/${t.id}/run" hx-target="#trigger-list" hx-swap="innerHTML">
        Run</button>
      <button class="btn btn-sm btn-outline" style="color:#f44336;border-color:#f44336"
        hx-delete="/triggers/${t.id}" hx-target="#trigger-list" hx-swap="innerHTML"
        hx-confirm="Delete trigger '${safe(t.name)}'?">Del</button>
    </td>
  </tr>`;
}

app.get("/triggers", (c) => {
  const flash = c.req.query("msg");
  const triggers = db
    .prepare("SELECT * FROM triggers ORDER BY type, name")
    .all() as any[];

  const html = `
    <h1>Triggers</h1>
    ${flash ? `<div class="flash flash-ok">${safe(flash)}</div>` : ""}
    <div class="card" id="trigger-list">
      ${
        triggers.length === 0
          ? '<div class="text-muted">No triggers configured. Use the AI skill to create one.</div>'
          : `<table>
          <tr><th>Type</th><th>Name</th><th>Schedule / URL</th><th>Status</th><th>Last Run</th><th></th></tr>
          ${triggers.map((t) => triggerRow(t)).join("")}
        </table>`
      }
    </div>

    <div class="card"><h3>How Triggers Work</h3>
      <div class="text-muted" style="font-size:12px;line-height:1.6">
        <strong>Cron:</strong> Runs on schedule via supercronic. Example: <code>0 * * * *</code> = every hour.<br>
        <strong>Webhook:</strong> POST to <code>/api/webhook/&lt;name&gt;</code> with optional <code>X-Webhook-Secret</code> header. Payload replaces <code>{{payload}}</code> in prompt.<br>
        <strong>Manual:</strong> Click "Run" to trigger immediately.<br>
        Triggers are configured via the <strong>triggers</strong> AI skill — ask Claude to create or modify triggers.
      </div>
    </div>`;

  return c.html(layout("Triggers", html, "triggers"));
});

app.post("/triggers/:id/toggle", (c) => {
  const id = c.req.param("id");
  const t = db.prepare("SELECT * FROM triggers WHERE id = ?").get(id) as any;
  if (!t) return c.html('<div class="text-muted">Not found</div>');

  db.prepare("UPDATE triggers SET enabled = ? WHERE id = ?").run(
    t.enabled ? 0 : 1,
    id,
  );
  if (t.type === "cron") syncCrontab();

  const triggers = db
    .prepare("SELECT * FROM triggers ORDER BY type, name")
    .all() as any[];
  return c.html(
    triggers.length === 0
      ? '<div class="text-muted">No triggers.</div>'
      : `<table><tr><th>Type</th><th>Name</th><th>Schedule / URL</th><th>Status</th><th>Last Run</th><th></th></tr>
     ${triggers.map((t) => triggerRow(t)).join("")}</table>`,
  );
});

app.post("/triggers/:id/run", (c) => {
  const id = c.req.param("id");
  const t = db.prepare("SELECT * FROM triggers WHERE id = ?").get(id) as any;
  if (!t) return c.html('<div class="text-muted">Not found</div>');

  // Fire through trigger.sh for consistent behavior (session_mode, prompts, IPC)
  Bun.spawn(["/atlas/app/triggers/trigger.sh", t.name], {
    stdout: "ignore",
    stderr: "ignore",
  });

  const triggers = db
    .prepare("SELECT * FROM triggers ORDER BY type, name")
    .all() as any[];
  return c.html(
    `<table><tr><th>Type</th><th>Name</th><th>Schedule / URL</th><th>Status</th><th>Last Run</th><th></th></tr>
     ${triggers.map((t) => triggerRow(t)).join("")}</table>`,
  );
});

app.delete("/triggers/:id", (c) => {
  const id = c.req.param("id");
  const t = db.prepare("SELECT * FROM triggers WHERE id = ?").get(id) as any;
  if (t) {
    db.prepare("DELETE FROM triggers WHERE id = ?").run(id);
    if (t.type === "cron") syncCrontab();
  }

  const triggers = db
    .prepare("SELECT * FROM triggers ORDER BY type, name")
    .all() as any[];
  return c.html(
    triggers.length === 0
      ? '<div class="text-muted">No triggers configured.</div>'
      : `<table><tr><th>Type</th><th>Name</th><th>Schedule / URL</th><th>Status</th><th>Last Run</th><th></th></tr>
     ${triggers.map((t) => triggerRow(t)).join("")}</table>`,
  );
});

// ============ WEBHOOK API ============
app.post("/api/webhook/:name", async (c) => {
  const name = c.req.param("name");
  const t = db
    .prepare("SELECT * FROM triggers WHERE name = ? AND type = 'webhook'")
    .get(name) as any;

  if (!t) {
    return c.json({ error: "Webhook not found" }, 404);
  }

  if (!t.enabled) {
    return c.json({ error: "Webhook disabled" }, 403);
  }

  // Validate secret if configured
  if (t.webhook_secret) {
    const secret = c.req.header("X-Webhook-Secret") || c.req.query("secret");
    if (secret !== t.webhook_secret) {
      return c.json({ error: "Invalid secret" }, 401);
    }
  }

  // Read payload
  let payload = "";
  try {
    const ct = c.req.header("content-type") || "";
    if (ct.includes("application/json")) {
      payload = JSON.stringify(await c.req.json(), null, 2);
    } else if (ct.includes("form")) {
      payload = JSON.stringify(await c.req.parseBody(), null, 2);
    } else {
      payload = await c.req.text();
    }
  } catch {
    payload = "(could not parse payload)";
  }

  // Fire through trigger.sh for consistent behavior (session_mode, prompts, IPC)
  Bun.spawn(["/atlas/app/triggers/trigger.sh", t.name, payload], {
    stdout: "ignore",
    stderr: "ignore",
  });

  return c.json({
    ok: true,
    trigger: name,
    message: "Webhook received, Claude will process it",
  });
});

// ============ MEMORY ============
app.get("/memory", (c) => {
  const memoryMd =
    readFile(`${MEMORY}/MEMORY.md`) || readFile(`${WS}/MEMORY.md`);

  let files: string[] = [];
  if (existsSync(MEMORY)) {
    const walk = (dir: string, prefix = ""): string[] => {
      let out: string[] = [];
      try {
        for (const f of readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${f.name}` : f.name;
          if (f.isDirectory()) out.push(...walk(join(dir, f.name), rel));
          else out.push(rel);
        }
      } catch {}
      return out;
    };
    files = walk(MEMORY)
      .filter((f) => f.endsWith(".md"))
      .sort();
  }

  const html = `
    <h1>Memory</h1>
    <div class="card"><h3>MEMORY.md</h3>
      <pre>${memoryMd ? safe(memoryMd) : '<span class="text-muted">No MEMORY.md found.</span>'}</pre>
    </div>

    <div class="card"><h3>Search Memory Files</h3>
      <form class="search-box" hx-get="/memory/search" hx-target="#search-results" hx-swap="innerHTML">
        <input type="text" name="q" placeholder="Search memory files...">
        <button type="submit">Search</button>
      </form>
      <div id="search-results"></div>
    </div>

    <div class="card"><h3>Memory Files (${files.length})</h3>
      ${
        files.length === 0
          ? '<div class="text-muted">No memory files found.</div>'
          : `<ul style="list-style:none">${files
              .map(
                (f) =>
                  `<li style="padding:3px 0"><span class="tag">${f.split("/")[0]}</span>
           <a href="/memory/view?file=${encodeURIComponent(f)}" style="color:#7c6ef0;text-decoration:none" hx-get="/memory/view?file=${encodeURIComponent(f)}" hx-target="#file-view" hx-swap="innerHTML">${safe(f)}</a></li>`,
              )
              .join("")}</ul>`
      }
    </div>
    <div id="file-view"></div>`;

  return c.html(layout("Memory", html, "memory"));
});

app.get("/memory/search", (c) => {
  const q = c.req.query("q") || "";
  if (!q) return c.html('<div class="text-muted">Enter a search term.</div>');

  const MAX_RESULTS = 20;
  const MAX_FILE_SIZE = 100 * 1024; // 100KB
  const results: { file: string; lines: string[] }[] = [];
  if (existsSync(MEMORY)) {
    const qLower = q.toLowerCase();
    const walk = (dir: string, prefix = ""): void => {
      if (results.length >= MAX_RESULTS) return;
      try {
        for (const f of readdirSync(dir, { withFileTypes: true })) {
          if (results.length >= MAX_RESULTS) return;
          const rel = prefix ? `${prefix}/${f.name}` : f.name;
          if (f.isDirectory()) {
            walk(join(dir, f.name), rel);
            continue;
          }
          if (!f.name.endsWith(".md")) continue;
          const fullPath = join(dir, f.name);
          try {
            if (statSync(fullPath).size > MAX_FILE_SIZE) continue;
          } catch {
            continue;
          }
          const content = readFile(fullPath);
          const matching = content
            .split("\n")
            .filter((l) => l.toLowerCase().includes(qLower));
          if (matching.length > 0)
            results.push({ file: rel, lines: matching.slice(0, 3) });
        }
      } catch {}
    };
    walk(MEMORY);
  }

  if (results.length === 0)
    return c.html(`<div class="text-muted">No results for "${safe(q)}".</div>`);
  const capped =
    results.length >= MAX_RESULTS
      ? `<div class="text-muted mb-8">Showing first ${MAX_RESULTS} results. Use grep for comprehensive results.</div>`
      : "";
  return c.html(
    capped +
      results
        .map(
          (r) => `
    <div class="card" style="padding:10px;margin-bottom:8px">
      <strong style="color:#7c6ef0">${safe(r.file)}</strong>
      <pre style="margin-top:4px;padding:8px;font-size:12px">${r.lines.map((l) => safe(l)).join("\n")}</pre>
    </div>`,
        )
        .join(""),
  );
});

app.get("/memory/view", (c) => {
  const file = c.req.query("file") || "";
  if (!file) return c.html("");
  const resolved = resolve(join(MEMORY, file));
  if (!resolved.startsWith(MEMORY + "/"))
    return c.html('<div class="text-muted">Invalid path.</div>');
  const content = readFile(resolved);
  return c.html(
    `<div class="card"><h3>${safe(file)}</h3><pre>${safe(content) || '<span class="text-muted">Empty file.</span>'}</pre></div>`,
  );
});

// ============ JOURNAL ============
app.get("/journal", (c) => {
  const today = new Date().toISOString().slice(0, 10);
  const date = c.req.query("date") || today;

  const html = `
    <h1>Journal</h1>
    <div class="card">
      <div class="flex mb-8">
        <input type="date" value="${date}" hx-get="/journal/content" hx-target="#journal-content" hx-swap="innerHTML"
               hx-trigger="change" hx-include="this" name="date" style="width:200px">
      </div>
      <div id="journal-content" hx-get="/journal/content?date=${date}" hx-trigger="load" hx-swap="innerHTML"></div>
    </div>`;

  return c.html(layout("Journal", html, "journal"));
});

app.get("/journal/content", (c) => {
  const date = c.req.query("date") || new Date().toISOString().slice(0, 10);
  const path = `${MEMORY}/${date}.md`;
  const content = readFile(path);
  if (!content)
    return c.html(
      `<div class="text-muted">No journal entry for ${safe(date)}.</div>`,
    );
  return c.html(`<pre>${safe(content)}</pre>`);
});

// ============ CHAT ============
app.get("/chat", (c) => {
  // Page URL accepts ?session=<key> (human-facing) or ?sessionKey=<key> (API-style).
  // Falls back to _default on missing/invalid input.
  const fromSession = c.req.query("session");
  let sessionKey: string;
  if (fromSession && typeof fromSession === "string"
      && /^[a-zA-Z0-9_\-]+$/.test(fromSession) && fromSession.trim().length > 0
      && fromSession.length <= 128) {
    sessionKey = fromSession;
  } else {
    sessionKey = resolveWebSessionKey(c);
  }
  const skQuery = `sessionKey=${encodeURIComponent(sessionKey)}`;
  const sidebar = renderChatSidebar(sessionKey);
  const html = `
    <div class="chat-layout">
      ${sidebar}
      <div class="chat-main">
        <div class="chat-container">
          <div class="chat-messages" id="chat-messages" hx-get="/chat/conversation?${skQuery}" hx-trigger="load, every 2s" hx-swap="innerHTML"></div>
          <form class="chat-input" hx-post="/chat?${skQuery}" hx-target="#chat-messages" hx-swap="innerHTML" hx-on::after-request="this.reset()">
            <input type="text" name="content" placeholder="Type a message..." autocomplete="off" required>
            <button type="submit">Send</button>
          </form>
        </div>
      </div>
    </div>
    <script>
    document.body.addEventListener('htmx:afterSwap', function(e) {
      if (e.detail.target.id === 'chat-messages') {
        var el = e.detail.target;
        var isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
        var isPost = e.detail.requestConfig.verb === 'post';
        var isInitial = !el.dataset.loaded;
        if (isInitial) el.dataset.loaded = '1';
        if (isNearBottom || isPost || isInitial) {
          el.scrollTop = el.scrollHeight;
        }
      }
    });
    // Bridge: when sidebar's "+ New" returns HX-Redirect via the JSON-API,
    // HTMX handles it automatically. No extra wiring required here.
    </script>`;

  return c.html(layout("Chat", html, "chat", "padding:0;max-width:none"));
});

app.get("/chat/conversation", (c) => {
  const sessionKey = resolveWebSessionKey(c);
  const TYPING = '<div class="typing-dots"><span></span><span></span><span></span></div><div class="chat-time">&nbsp;</div>';

  // User messages: always from DB (ground truth — JSONL entries are just trigger boilerplate)
  const dbMessages = db
    .prepare("SELECT content, created_at FROM messages WHERE channel = ? AND session_key = ? ORDER BY created_at ASC, id ASC")
    .all('web', sessionKey) as { content: string; created_at: string }[];

  // Assistant messages: from JSONL session file
  const session = db
    .prepare("SELECT session_id FROM trigger_sessions WHERE trigger_name = ? AND session_key = ? LIMIT 1")
    .get('web-chat', sessionKey) as any;

  let assistantMsgs: ParsedMessage[] = [];
  let isRunning = false;
  if (session) {
    const filePath = findSessionFile(session.session_id);
    // Primary signal: a `claude --resume <session>` process is currently
    // running (works for both `claudec` IPC sockets and direct invocations).
    // Secondary signal: JSONL last entry indicates a pending turn — covers
    // the gap between trigger fire and process startup.
    isRunning = isClaudeProcessRunning(session.session_id) || isAgentTurnActive(filePath);
    if (filePath) {
      const all = parseSessionMessages(filePath);
      // Drop user-text entries from JSONL — those are trigger boilerplate, not real user text
      assistantMsgs = all.filter(m => m.type !== "user-text");
    }
  }

  if (dbMessages.length === 0 && assistantMsgs.length === 0) {
    return c.html('<div class="chat-bubble bot" style="opacity:0.5">Send a message to start a conversation.</div>');
  }

  // Merge: DB user messages + JSONL assistant/tool messages, sorted by timestamp
  // SQLite timestamps are "YYYY-MM-DD HH:MM:SS" UTC; JSONL are ISO "YYYY-MM-DDTHH:MM:SS.mmmZ" — both sort correctly after normalising
  const combined: ParsedMessage[] = [
    ...dbMessages.map(m => ({
      type: "user-text" as const,
      content: m.content,
      timestamp: sqliteToIso(m.created_at),
    })),
    ...assistantMsgs,
  ];
  combined.sort((a, b) => {
    const ta = a.timestamp || "";
    const tb = b.timestamp || "";
    if (ta !== tb) return ta < tb ? -1 : 1;
    // Same timestamp: user before assistant
    return (a.type === "user-text" ? 0 : 1) - (b.type === "user-text" ? 0 : 1);
  });

  const html = renderConversation(combined);
  const lastMsg = combined[combined.length - 1];
  const isAssistantLast = lastMsg.type.startsWith("assistant-");

  // Show typing while session is being set up or actively running
  const showTyping = (!session && dbMessages.length > 0) || (!!session && isRunning);
  if (showTyping && !isAssistantLast) {
    return c.html(html + TYPING);
  }

  return c.html(html);
});

app.post("/chat", async (c) => {
  const sessionKey = resolveWebSessionKey(c);
  const body = await c.req.parseBody();
  const content = ((body.content as string) || "").trim();
  if (!content) return c.html("");

  // Touch/create session row. Pass derived title on every call — touchChatSession
  // uses COALESCE so an existing non-null title (manual or earlier derived) wins.
  touchChatSession(sessionKey, { title: deriveSessionTitle(content) });

  const msg = db
    .prepare(
      "INSERT INTO messages (channel, sender, content, session_key) VALUES ('web', 'web-ui', ?, ?) RETURNING *",
    )
    .get(content, sessionKey) as any;

  // Touch wake file
  try {
    mkdirSync(`${WS}/inbox`, { recursive: true });
    closeSync(openSync(WAKE, "w"));
  } catch {}

  // Wrap the user text in the <webmsg> envelope before it lands as the
  // agent's user-turn. No per-message attrs on the HTMX path.
  const chatWrappedContent = wrapWebMessage(content);

  // Fire trigger (like signal/email addons do)
  const payload = JSON.stringify({
    inbox_message_id: msg.id,
    sender: "web-ui",
    message: chatWrappedContent.slice(0, 20000),
    timestamp: sqliteToIso(msg.created_at),
  });
  Bun.spawn(
    ["/atlas/app/triggers/trigger.sh", "web-chat", payload, sessionKey],
    {
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  // Return all DB messages (includes the just-inserted one) + any prior assistant responses + typing indicator
  const TYPING = '<div class="typing-dots"><span></span><span></span><span></span></div><div class="chat-time">&nbsp;</div>';
  const dbMessages = db
    .prepare("SELECT content, created_at FROM messages WHERE channel = ? AND session_key = ? ORDER BY created_at ASC, id ASC")
    .all('web', sessionKey) as { content: string; created_at: string }[];

  const session = db
    .prepare("SELECT session_id FROM trigger_sessions WHERE trigger_name = ? AND session_key = ? LIMIT 1")
    .get('web-chat', sessionKey) as any;

  let assistantMsgs: ParsedMessage[] = [];
  if (session) {
    const filePath = findSessionFile(session.session_id);
    if (filePath) {
      const all = parseSessionMessages(filePath);
      assistantMsgs = all.filter(m => m.type !== "user-text");
    }
  }

  const combined: ParsedMessage[] = [
    ...dbMessages.map(m => ({ type: "user-text" as const, content: m.content, timestamp: sqliteToIso(m.created_at) })),
    ...assistantMsgs,
  ];
  combined.sort((a, b) => {
    const ta = a.timestamp || "", tb = b.timestamp || "";
    if (ta !== tb) return ta < tb ? -1 : 1;
    return (a.type === "user-text" ? 0 : 1) - (b.type === "user-text" ? 0 : 1);
  });

  return c.html(renderConversation(combined) + TYPING);
});

// --- Chat sidebar actions (HTMX-flavoured wrappers around /api/v1/chat/sessions).
//     These return either the freshly rendered sidebar HTML or an HX-Redirect
//     header so the browser switches to the new active session. The underlying
//     JSON API at /api/v1/chat/sessions is untouched. ---

/** Reads activeKey from query first (?session=…), then HX-Current-URL header
 *  (set by HTMX on every request) so sidebar refreshes preserve highlighting
 *  even when triggered from action buttons. */
function sidebarActiveKey(c: any): string {
  const fromQuery = c.req.query("session");
  if (fromQuery && typeof fromQuery === "string" && /^[a-zA-Z0-9_\-]+$/.test(fromQuery) && fromQuery.length <= 128) {
    return fromQuery;
  }
  const cur = c.req.header("hx-current-url") ?? "";
  try {
    const u = new URL(cur);
    const fromUrl = u.searchParams.get("session");
    if (fromUrl && /^[a-zA-Z0-9_\-]+$/.test(fromUrl) && fromUrl.length <= 128) return fromUrl;
  } catch {}
  return "_default";
}

app.get("/chat/sidebar", (c) => {
  const active = sidebarActiveKey(c);
  const edit = c.req.query("edit");
  const editKey = edit && /^[a-zA-Z0-9_\-]+$/.test(edit) && edit.length <= 128 ? edit : null;
  return c.html(renderChatSidebar(active, editKey));
});

app.post("/chat/sessions/new", (c) => {
  const sessionKey = crypto.randomUUID();
  db.prepare(`INSERT INTO chat_sessions (session_key, channel, title) VALUES (?, 'web', NULL)`).run(sessionKey);
  c.header("HX-Redirect", `/chat?session=${encodeURIComponent(sessionKey)}`);
  return c.body(null, 204);
});

app.patch("/chat/sessions/:key", async (c) => {
  const key = c.req.param("key");
  if (!/^[a-zA-Z0-9_\-]+$/.test(key) || key.length > 128) {
    return c.html('<div class="flash flash-err">Invalid session key</div>', 400);
  }
  const existing = db.prepare("SELECT session_key FROM chat_sessions WHERE session_key = ? AND channel = 'web'").get(key);
  if (!existing) return c.html('<div class="flash flash-err">Not found</div>', 404);

  const body = await c.req.parseBody();
  const rawTitle = ((body.title as string) ?? "").trim();
  const newTitle = rawTitle.length > 0 ? rawTitle.slice(0, 200) : null;

  db.prepare(`UPDATE chat_sessions SET title = ?, updated_at = datetime('now') WHERE session_key = ?`)
    .run(newTitle, key);

  return c.html(renderChatSidebar(sidebarActiveKey(c)));
});

app.post("/chat/sessions/:key/archive", (c) => {
  const key = c.req.param("key");
  if (!/^[a-zA-Z0-9_\-]+$/.test(key) || key.length > 128) {
    return c.html('<div class="flash flash-err">Invalid session key</div>', 400);
  }
  if (key === "_default") {
    return c.html('<div class="flash flash-err">Default chat cannot be archived</div>', 400);
  }
  const existing = db.prepare("SELECT session_key FROM chat_sessions WHERE session_key = ? AND channel = 'web'").get(key);
  if (!existing) return c.html('<div class="flash flash-err">Not found</div>', 404);

  db.prepare(`UPDATE chat_sessions SET archived_at = datetime('now'), updated_at = datetime('now') WHERE session_key = ?`)
    .run(key);

  const active = sidebarActiveKey(c);
  // If we just archived the active chat, send the user back to _default so the
  // right pane doesn't keep rendering an archived session.
  if (active === key) {
    c.header("HX-Redirect", "/chat");
    return c.body(null, 204);
  }
  return c.html(renderChatSidebar(active));
});

app.delete("/chat/sessions/:key", (c) => {
  const key = c.req.param("key");
  if (!/^[a-zA-Z0-9_\-]+$/.test(key) || key.length > 128) {
    return c.html('<div class="flash flash-err">Invalid session key</div>', 400);
  }
  if (key === "_default") {
    return c.html('<div class="flash flash-err">Default chat cannot be deleted</div>', 400);
  }
  const existing = db.prepare("SELECT session_key FROM chat_sessions WHERE session_key = ? AND channel = 'web'").get(key);
  if (!existing) return c.html('<div class="flash flash-err">Not found</div>', 404);

  // Mirror DELETE /api/v1/chat/sessions/:key semantics — clean up trigger + messages first.
  const trigSession = db.prepare("SELECT session_id FROM trigger_sessions WHERE trigger_name = 'web-chat' AND session_key = ?")
    .get(key) as { session_id: string } | null;
  db.prepare("DELETE FROM trigger_sessions WHERE trigger_name = 'web-chat' AND session_key = ?").run(key);
  db.prepare("DELETE FROM messages WHERE channel = 'web' AND session_key = ?").run(key);
  if (trigSession) {
    db.prepare("DELETE FROM web_chat_stream_chunks WHERE session_id = ?").run(trigSession.session_id);
  }
  db.prepare("DELETE FROM chat_sessions WHERE session_key = ?").run(key);

  const active = sidebarActiveKey(c);
  if (active === key) {
    c.header("HX-Redirect", "/chat");
    return c.body(null, 204);
  }
  return c.html(renderChatSidebar(active));
});

// ============ SETTINGS ============
app.get("/settings", (c) => {
  const flash = c.req.query("saved");
  const identity = readFile(IDENTITY);
  const config = readFile(CONFIG);
  const extensions = readFile(EXTENSIONS);

  const triggerCount =
    (db.prepare("SELECT COUNT(*) as c FROM triggers").get() as any)?.c || 0;

  const html = `
    <h1>Settings</h1>
    ${flash ? `<div class="flash flash-ok">Saved ${safe(flash)} successfully.</div>` : ""}

    <div class="card"><h3>IDENTITY.md</h3>
      <form method="POST" action="/settings/identity">
        <textarea name="content" rows="8">${safe(identity)}</textarea>
        <button type="submit" class="mt-8">Save Identity</button>
      </form>
    </div>

    <div class="card"><h3>config.yml</h3>
      <form method="POST" action="/settings/config">
        <textarea name="content" rows="8">${safe(config)}</textarea>
        <button type="submit" class="mt-8">Save Config</button>
      </form>
    </div>

    <div class="card"><h3>user-extensions.sh</h3>
      <form method="POST" action="/settings/extensions">
        <textarea name="content" rows="8">${safe(extensions)}</textarea>
        <button type="submit" class="mt-8">Save Extensions</button>
      </form>
    </div>

    <div class="card"><h3>Triggers</h3>
      <div class="text-muted">${triggerCount} trigger(s) configured. <a href="/triggers" style="color:#7c6ef0">Manage Triggers &rarr;</a></div>
    </div>`;

  return c.html(layout("Settings", html, "settings"));
});

app.post("/settings/identity", async (c) => {
  const body = await c.req.parseBody();
  const content = (body.content as string) || "";
  mkdirSync(WS, { recursive: true });
  writeFileSync(IDENTITY, content);
  return c.redirect("/settings?saved=identity");
});

app.post("/settings/config", async (c) => {
  const body = await c.req.parseBody();
  const content = (body.content as string) || "";
  mkdirSync(WS, { recursive: true });
  writeFileSync(CONFIG, content);
  return c.redirect("/settings?saved=config");
});

app.post("/settings/extensions", async (c) => {
  const body = await c.req.parseBody();
  const content = (body.content as string) || "";
  mkdirSync(WS, { recursive: true });
  writeFileSync(EXTENSIONS, content);
  return c.redirect("/settings?saved=extensions");
});

// --- Analytics helpers ---
export function analyticsWhere(params: {
  from: string; to: string; types: string[]; trigger: string;
  minCost: string; status: string;
}): { clause: string; values: any[] } {
  const parts: string[] = [];
  const values: any[] = [];
  // Default date range guards: always apply from/to
  parts.push("date(created_at) >= ?");
  values.push(params.from);
  parts.push("date(created_at) <= ?");
  values.push(params.to);
  if (params.types.length > 0) {
    parts.push(`session_type IN (${params.types.map(() => "?").join(",")})`);
    values.push(...params.types);
  }
  if (params.trigger) {
    parts.push("trigger_name LIKE ?");
    values.push(`%${params.trigger}%`);
  }
  if (params.minCost) {
    const n = parseFloat(params.minCost);
    if (!isNaN(n)) { parts.push("cost_usd >= ?"); values.push(n); }
  }
  if (params.status === "ok")  { parts.push("is_error = 0"); }
  if (params.status === "err") { parts.push("is_error = 1"); }
  return { clause: `WHERE ${parts.join(" AND ")}`, values };
}

// ISO date string for N days ago (UTC)
export function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// --- Analytics route ---
app.get("/analytics", (c) => {
  const from       = c.req.query("from")      || daysAgo(7);
  const to         = c.req.query("to")        || todayIso();
  const rawTypes   = c.req.query("types")     || "";
  const filterTrig = c.req.query("trigger")   || "";
  const minCost    = c.req.query("min_cost")  || "";
  const statusFilt = c.req.query("status")    || "";
  const groupBy    = c.req.query("group_by")  || "";

  const types = rawTypes ? rawTypes.split(",").filter(Boolean) : [];

  const { clause: where, values: whereParams } = analyticsWhere({
    from, to, types, trigger: filterTrig, minCost, status: statusFilt,
  });

  let metrics: any[] = [];
  let totals: any = {};
  let week7: any = {};
  let realCostAll: any = {};
  let grouped: any[] = [];

  try {
    totals = db.prepare(`
      SELECT
        COUNT(*) as sessions,
        SUM(cost_usd) as cost,
        SUM(duration_ms) as duration_ms,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(cache_creation_tokens) as cache_write_tokens,
        SUM(cache_read_tokens) as cache_read_tokens
      FROM session_metrics ${where}
    `).get(...whereParams) as any || {};

    week7 = db.prepare(`
      SELECT SUM(cost_usd) as cost FROM session_metrics
      WHERE created_at >= datetime('now', '-7 days')
    `).get() as any || {};

    // Unused variable kept for TS compatibility — no longer computing "real cost"
    // since subagent cost is now aggregated directly into the trigger row.
    realCostAll = {};

    if (groupBy === "day") {
      grouped = db.prepare(`
        SELECT date(created_at) as group_label,
          SUM(cost_usd) as cost,
          COUNT(*) as sessions,
          SUM(input_tokens + output_tokens) as tokens
        FROM session_metrics ${where}
        GROUP BY date(created_at) ORDER BY cost DESC
      `).all(...whereParams) as any[];
    } else if (groupBy === "trigger") {
      grouped = db.prepare(`
        SELECT COALESCE(trigger_name,'(none)') as group_label,
          SUM(cost_usd) as cost,
          COUNT(*) as sessions,
          SUM(input_tokens + output_tokens) as tokens
        FROM session_metrics ${where}
        GROUP BY trigger_name ORDER BY cost DESC
      `).all(...whereParams) as any[];
    } else if (groupBy === "type") {
      grouped = db.prepare(`
        SELECT session_type as group_label,
          SUM(cost_usd) as cost,
          COUNT(*) as sessions,
          SUM(input_tokens + output_tokens) as tokens
        FROM session_metrics ${where}
        GROUP BY session_type ORDER BY cost DESC
      `).all(...whereParams) as any[];
    }

    if (!groupBy) {
      metrics = db.prepare(
        `SELECT * FROM session_metrics ${where} ORDER BY created_at DESC LIMIT 200`
      ).all(...whereParams) as any[];
    }
  } catch {}

  function fmtCost(v: number | null | undefined, decimals = 4): string {
    return v != null && v > 0 ? `$${v.toFixed(decimals)}` : "$0.0000";
  }
  function fmtNum(v: number | null | undefined): string {
    if (!v) return "0";
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
    return String(v);
  }
  function fmtDuration(ms: number): string {
    if (!ms) return "—";
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m ${s}s`;
  }
  function typeBadge(t: string): string {
    const colors: Record<string, string> = {
      worker: "#5c9cf5",
      reviewer: "#e040fb",
      trigger: "#7c6ef0",
      "trigger-relay": "#ff9800",
    };
    return `<span class="badge" style="background:${colors[t] || "#3a3b55"};color:#fff">${safe(t)}</span>`;
  }

  const totalCost = totals.cost || 0;
  const totalDurationMs = totals.duration_ms || 0;
  const costPerHour = totalDurationMs > 0
    ? (totalCost / totalDurationMs) * 3_600_000
    : null;

  // Build current filter query string (for links and CSV)
  const currentQs = (): string => {
    const p = new URLSearchParams();
    p.set("from", from); p.set("to", to);
    if (rawTypes)    p.set("types", rawTypes);
    if (filterTrig)  p.set("trigger", filterTrig);
    if (minCost)     p.set("min_cost", minCost);
    if (statusFilt)  p.set("status", statusFilt);
    if (groupBy)     p.set("group_by", groupBy);
    return p.toString();
  };

  const isFiltered = rawTypes || filterTrig || minCost || statusFilt || groupBy ||
    from !== daysAgo(7) || to !== todayIso();
  const activeLabel = isFiltered
    ? ` <span class="text-muted" style="font-size:12px">(filtered)</span>` : "";

  // Type multi-select checkboxes
  const typeOptions = ["trigger", "worker", "reviewer", "trigger-relay"];
  const typeCheckboxes = typeOptions.map(t => {
    const checked = types.includes(t) ? " checked" : "";
    return `<label style="display:inline-flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">
      <input type="checkbox" name="types_cb" value="${t}"${checked} style="width:auto;margin:0">
      ${typeBadge(t)}
    </label>`;
  }).join(" ");

  // Group-by options
  const groupByOptions = ["", "day", "trigger", "type"].map(g =>
    `<option value="${g}"${groupBy === g ? " selected" : ""}>${g || "None (table)"}</option>`
  ).join("");

  // Status options
  const statusOptions = ["", "ok", "err"].map(s =>
    `<option value="${s}"${statusFilt === s ? " selected" : ""}>${s || "All"}</option>`
  ).join("");

  const filterForm = `
    <form method="GET" action="/analytics" id="analytics-form" style="background:#252640;border:1px solid #3a3b55;border-radius:6px;padding:12px 16px;margin-bottom:16px">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;align-items:end">
        <div>
          <div class="text-muted" style="margin-bottom:4px">From</div>
          <input type="date" name="from" value="${safe(from)}" style="width:100%;padding:4px 8px;font-size:12px">
        </div>
        <div>
          <div class="text-muted" style="margin-bottom:4px">To</div>
          <input type="date" name="to" value="${safe(to)}" style="width:100%;padding:4px 8px;font-size:12px">
        </div>
        <div>
          <div class="text-muted" style="margin-bottom:4px">Trigger (partial match)</div>
          <input type="text" name="trigger" value="${safe(filterTrig)}" placeholder="e.g. email" style="width:100%;padding:4px 8px;font-size:12px">
        </div>
        <div>
          <div class="text-muted" style="margin-bottom:4px">Min cost ($)</div>
          <input type="number" name="min_cost" value="${safe(minCost)}" min="0" step="0.001" placeholder="0.00" style="width:100%;padding:4px 8px;font-size:12px">
        </div>
        <div>
          <div class="text-muted" style="margin-bottom:4px">Status</div>
          <select name="status" style="width:100%;padding:4px 8px;font-size:12px">${statusOptions}</select>
        </div>
        <div>
          <div class="text-muted" style="margin-bottom:4px">Group by</div>
          <select name="group_by" style="width:100%;padding:4px 8px;font-size:12px">${groupByOptions}</select>
        </div>
      </div>
      <div style="margin-top:10px">
        <div class="text-muted" style="margin-bottom:6px;font-size:12px">Types</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">${typeCheckboxes}</div>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px;align-items:center">
        <button type="submit" onclick="syncTypeField()" class="btn btn-sm">Apply</button>
        <a href="/analytics" class="btn btn-sm btn-outline">Reset</a>
        <a href="/analytics.csv?${safe(currentQs())}" class="btn btn-sm btn-outline" style="margin-left:auto">CSV export</a>
      </div>
      <input type="hidden" name="types" id="types-hidden" value="${safe(rawTypes)}">
    </form>
    <script>
    function syncTypeField() {
      const cbs = document.querySelectorAll('input[name=types_cb]:checked');
      document.getElementById('types-hidden').value = Array.from(cbs).map(c => c.value).join(',');
    }
    </script>`;

  // Grouped view
  const groupedTable = grouped.length > 0 ? `
    <div class="card">
      <h3>Grouped by ${safe(groupBy)}${activeLabel}</h3>
      <div style="overflow-x:auto"><table>
        <thead><tr><th>${safe(groupBy === "day" ? "Date" : groupBy === "trigger" ? "Trigger" : "Type")}</th>
          <th>Sessions</th><th>Tokens</th><th>Cost</th></tr></thead>
        <tbody>
          ${grouped.map(g => `<tr>
            <td>${safe(String(g.group_label))}</td>
            <td>${g.sessions || 0}</td>
            <td>${fmtNum(g.tokens)}</td>
            <td>${fmtCost(g.cost)}</td>
          </tr>`).join("")}
        </tbody>
      </table></div>
    </div>` : "";

  // Sessions table
  const rows = metrics.map((m) => {
    return `
    <tr>
      <td class="text-muted" style="white-space:nowrap">${safe(timeAgo(m.created_at))}</td>
      <td>${typeBadge(m.session_type)}</td>
      <td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.trigger_name ? safe(m.trigger_name) : '<span class="text-muted">—</span>'}</td>
      <td>${fmtDuration(m.duration_ms)}</td>
      <td title="new input">${fmtNum(m.input_tokens)}</td>
      <td title="output">${fmtNum(m.output_tokens)}</td>
      <td title="cache writes" style="color:#f0a500">${fmtNum(m.cache_creation_tokens)}</td>
      <td title="cache reads" style="color:#5c9cf5">${fmtNum(m.cache_read_tokens)}</td>
      <td>${fmtCost(m.cost_usd)}</td>
      <td><span class="dot" style="background:${m.is_error ? "#f44336" : "#4caf50"}"></span>${m.is_error ? "err" : "ok"}</td>
    </tr>`;
  }).join("");

  // No supplemental cost note needed — subagent cost is aggregated into trigger rows.

  const html = `
    <h1>Analytics</h1>
    ${filterForm}

    <div class="grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:8px">
      <div class="stat">
        <div class="num">${fmtCost(totalCost)}</div>
        <div class="label">Cost${activeLabel}</div>
      </div>
      <div class="stat"><div class="num">${fmtCost(week7.cost)}</div><div class="label">Cost (7d, all types)</div></div>
      <div class="stat"><div class="num">${costPerHour != null ? fmtCost(costPerHour, 4) : "—"}</div><div class="label">Est. $/hr${activeLabel}</div></div>
    </div>

    <div class="grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:16px">
      <div class="stat"><div class="num">${totals.sessions || 0}</div><div class="label">Sessions${activeLabel}</div></div>
      <div class="stat">
        <div class="num" style="font-size:20px">${fmtNum(totals.input_tokens)}</div>
        <div class="label">Input tokens</div>
      </div>
      <div class="stat">
        <div class="num" style="font-size:20px">${fmtNum(totals.output_tokens)}</div>
        <div class="label">Output tokens</div>
      </div>
    </div>

    ${groupedTable}

    ${!groupBy ? `<div class="card">
      <h3>Sessions${activeLabel}</h3>
      ${metrics.length === 0
        ? '<div class="text-muted">No sessions match the current filter.</div>'
        : `<div style="overflow-x:auto"><table>
        <thead><tr>
          <th>Time</th><th>Type</th><th>Trigger</th><th>Duration</th>
          <th title="New input tokens">Input</th>
          <th>Output</th>
          <th title="Cache creation tokens (billed at write rate)" style="color:#f0a500">Cache↑</th>
          <th title="Cache read tokens (billed at read rate, loaded from prior turns)" style="color:#5c9cf5">Cache↓</th>
          <th>Cost</th><th>Status</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`}
    </div>` : ""}`;

  return c.html(layout("Analytics", html, "analytics"));
});

// --- Analytics CSV export ---
app.get("/analytics.csv", (c) => {
  const from       = c.req.query("from")      || daysAgo(7);
  const to         = c.req.query("to")        || todayIso();
  const rawTypes   = c.req.query("types")     || "";
  const filterTrig = c.req.query("trigger")   || "";
  const minCost    = c.req.query("min_cost")  || "";
  const statusFilt = c.req.query("status")    || "";

  const types = rawTypes ? rawTypes.split(",").filter(Boolean) : [];
  const { clause: where, values: whereParams } = analyticsWhere({
    from, to, types, trigger: filterTrig, minCost, status: statusFilt,
  });

  let rows: any[] = [];
  try {
    rows = db.prepare(
      `SELECT session_type, session_id, trigger_name,
              started_at, ended_at, duration_ms,
              input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
              cost_usd, num_turns, is_error, created_at
       FROM session_metrics ${where} ORDER BY created_at DESC LIMIT 10000`
    ).all(...whereParams) as any[];
  } catch {}

  const header = "session_type,session_id,trigger_name,started_at,ended_at,duration_ms,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,cost_usd,num_turns,is_error,created_at";
  const csvRows = rows.map(r => [
    r.session_type, r.session_id,
    r.trigger_name ?? "", r.started_at, r.ended_at, r.duration_ms,
    r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens,
    r.cost_usd, r.num_turns, r.is_error, r.created_at,
  ].map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","));

  const csv = [header, ...csvRows].join("\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="analytics-${from}-${to}.csv"`,
    },
  });
});

// ============ SESSIONS ============

function sessionTypeBadge(t: string): string {
  const colors: Record<string, string> = {
    trigger: "#5c9cf5",
    worker: "#ff9800",
    reviewer: "#e040fb",
  };
  const color = colors[t] || "#999";
  return `<span class="badge" style="background:${color};color:#fff">${safe(t)}</span>`;
}

function fmtSessionDuration(ms: number | null | undefined): string {
  if (!ms) return "";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function fmtSessionCost(v: number | null | undefined): string {
  if (!v || v === 0) return "";
  return `$${v.toFixed(4)}`;
}

app.get("/sessions", (c) => {
  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10));
  const typeFilter = c.req.query("type") || "";
  const triggerFilter = c.req.query("trigger") || "";
  const limit = 50;
  const offset = (page - 1) * limit;

  const whereParts: string[] = [];
  const whereParams: any[] = [];
  if (typeFilter) {
    whereParts.push("session_type = ?");
    whereParams.push(typeFilter);
  }
  if (triggerFilter) {
    whereParts.push("trigger_name LIKE ?");
    whereParams.push(`%${triggerFilter}%`);
  }
  const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

  let rows: any[] = [];
  let total = 0;
  try {
    total = (db.prepare(`SELECT COUNT(*) as c FROM session_metrics ${where}`).get(...whereParams) as any)?.c || 0;
    rows = db.prepare(
      `SELECT * FROM session_metrics ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`
    ).all(...whereParams, limit, offset) as any[];
  } catch {}

  const totalPages = Math.ceil(total / limit);
  const qs = [typeFilter ? `type=${encodeURIComponent(typeFilter)}` : "", triggerFilter ? `trigger=${encodeURIComponent(triggerFilter)}` : ""].filter(Boolean).join("&");

  const paginationHtml = totalPages > 1
    ? `<div class="flex mt-8" style="justify-content:space-between">
    <span class="text-muted">Page ${page} of ${totalPages} (${total} sessions)</span>
    <span>${page > 1 ? `<a href="/sessions?page=${page - 1}${qs ? "&" + qs : ""}" class="btn btn-sm btn-outline">Prev</a> ` : ""}${page < totalPages ? `<a href="/sessions?page=${page + 1}${qs ? "&" + qs : ""}" class="btn btn-sm btn-outline">Next</a>` : ""}</span>
  </div>` : "";

  const typeOptions = ["", "trigger", "worker", "reviewer"];
  const typeSelect = `<select name="type" onchange="this.form.submit()" style="width:auto;padding:4px 8px;font-size:12px">
    ${typeOptions.map(t => `<option value="${t}"${typeFilter === t ? " selected" : ""}>${t || "All types"}</option>`).join("")}
  </select>`;

  const filterForm = `
    <form method="GET" style="margin-bottom:16px;display:flex;gap:8px;align-items:center">
      ${typeSelect}
      <input name="trigger" placeholder="filter trigger..." onchange="this.form.submit()" value="${safe(triggerFilter)}"
        style="width:auto;padding:4px 8px;font-size:12px">
      ${(typeFilter || triggerFilter) ? `<a href="/sessions" class="btn btn-sm btn-outline">Clear</a>` : ""}
    </form>`;

  const tableRows = rows.map((row) => {
    const isActive = existsSync(`/tmp/claudec-${row.session_id}.sock`);
    const statusHtml = isActive
      ? `<span style="color:#4caf50">&#9679; active</span>`
      : row.is_error
        ? `<span style="color:#f44336">&#10007; error</span>`
        : `<span style="color:#999">&#10003; done</span>`;

    return `
      <tr class="msg-row" hx-get="/sessions/${safe(row.session_id)}" hx-target="#sd-${safe(row.session_id)}" hx-swap="innerHTML">
        <td>${sessionTypeBadge(row.session_type || "")}</td>
        <td>${row.trigger_name ? safe(row.trigger_name) : '<span class="text-muted">—</span>'}</td>
        <td>${row.num_turns != null ? row.num_turns : ""}</td>
        <td>${fmtSessionCost(row.cost_usd)}</td>
        <td>${fmtSessionDuration(row.duration_ms)}</td>
        <td>${statusHtml}</td>
        <td class="text-muted">${timeAgo(row.started_at)}</td>
      </tr>
      <tr id="sd-${safe(row.session_id)}"></tr>`;
  }).join("");

  const html = `
    <h1>Sessions</h1>
    ${filterForm}
    <table>
      <thead><tr>
        <th>Type</th><th>Trigger</th><th>Turns</th><th>Cost</th><th>Duration</th><th>Status</th><th>Started</th>
      </tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
    ${rows.length === 0 ? '<div class="card text-muted">No sessions found.</div>' : ""}
    ${paginationHtml}`;

  return c.html(layout("Sessions", html, "sessions"));
});

app.get("/sessions/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId");

  // Reject sessionIds that aren't safe alphanumeric/hyphen identifiers to prevent path traversal
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    return c.html(`<td colspan="7"><div class="msg-detail text-muted">Invalid session ID.</div></td>`);
  }

  let row: any = null;
  try {
    row = db.prepare("SELECT * FROM session_metrics WHERE session_id = ?").get(sessionId) as any;
  } catch {}

  const isActive = existsSync(`/tmp/claudec-${sessionId}.sock`);
  const filePath = findSessionFile(sessionId);

  let messagesHtml = "";
  if (!filePath) {
    messagesHtml = '<div class="text-muted">Session transcript not available.</div>';
  } else {
    let msgs = parseSessionMessages(filePath);
    let truncatedNote = "";
    if (msgs.length > 200) {
      const totalMsgs = msgs.length;
      msgs = msgs.slice(msgs.length - 200);
      truncatedNote = `<div class="text-muted" style="margin-bottom:8px;font-size:12px">Showing last 200 of ${totalMsgs} messages.</div>`;
    }

    const parts: string[] = [];
    for (const msg of msgs) {
      if (msg.type === "assistant-text") {
        parts.push(`<pre style="white-space:pre-wrap;background:#2a2b3d;padding:10px;border-radius:6px;font-size:12px">${safe(msg.content)}</pre>`);
      } else if (msg.type === "assistant-tool-use") {
        parts.push(`<details><summary style="cursor:pointer;color:#7c6ef0">&#128295; ${safe(msg.toolName || "tool")}</summary><pre style="font-size:11px;white-space:pre-wrap">${safe((msg.toolInput || "").slice(0, 2000))}</pre></details>`);
      } else if (msg.type === "user-tool-result") {
        parts.push(`<details><summary style="cursor:pointer;color:#888">&#8617; tool result</summary><pre style="font-size:11px;white-space:pre-wrap">${safe(msg.content.slice(0, 500))}</pre></details>`);
      } else if (msg.type === "user-text") {
        if (msg.content.length > 500) continue;
        parts.push(`<div style="text-align:right"><span style="background:#3a3b55;padding:6px 10px;border-radius:6px;font-size:12px;display:inline-block;max-width:80%;text-align:left">${safe(msg.content.slice(0, 300))}</span></div>`);
      } else if (msg.type === "assistant-thinking") {
        parts.push(`<details><summary style="cursor:pointer;color:#888">&#128161; thinking</summary><pre style="font-size:11px;white-space:pre-wrap">${safe(msg.content.slice(0, 1000))}</pre></details>`);
      }
    }
    messagesHtml = truncatedNote + parts.join("\n");
  }

  const metaHtml = row ? `
    <div style="margin-bottom:10px;font-size:12px;color:#999">
      <strong style="color:#e0e0e0">${safe(row.session_type || "")}</strong>
      ${row.trigger_name ? ` &middot; ${safe(row.trigger_name)}` : ""}
      ${row.num_turns != null ? ` &middot; ${row.num_turns} turns` : ""}
      ${row.cost_usd ? ` &middot; ${fmtSessionCost(row.cost_usd)}` : ""}
      ${row.duration_ms ? ` &middot; ${fmtSessionDuration(row.duration_ms)}` : ""}
      ${row.started_at ? ` &middot; started ${timeAgo(row.started_at)}` : ""}
    </div>` : "";

  const activeHtml = isActive
    ? `<div style="color:#4caf50;margin-bottom:8px;font-size:13px">&#9679; Session currently active</div>`
    : "";

  return c.html(`<td colspan="7"><div class="msg-detail">
    ${activeHtml}${metaHtml}
    <div style="display:flex;flex-direction:column;gap:6px">${messagesHtml}</div>
  </div></td>`);
});

// =============================================================================
// External Configuration API (v1)
// =============================================================================

const api = new Hono();
api.use("*", apiKeyAuth);

// Last-resort error handler: any throw that escapes a route's own
// try/catch lands here, gets logged with full stack, and returns a
// stable JSON 500 instead of Hono's default plain-text "Internal Server
// Error" page (which made a recent voice-send 500 unreadable on the
// proxy side because we couldn't parse the body for diagnostics).
api.onError((err, c) => {
  console.error("[api] uncaught error on", c.req.path, "—", err);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  return c.json(
    { error: "Internal error", detail: err instanceof Error ? err.message : "unknown" },
    500,
  );
});

// --- Configuration ---

api.get("/config", (c) => {
  const config = resolveConfig(WS);
  return c.json({ ok: true, config: redactConfig(config), sources: getConfigSources() });
});

api.get("/config/:section", (c) => {
  const section = c.req.param("section");
  const config = resolveConfig(WS) as Record<string, any>;
  if (!(section in config)) {
    return c.json({ error: "Not found", message: `Unknown config section: ${section}` }, 404);
  }
  return c.json({ ok: true, section, config: config[section] });
});

api.patch("/config", async (c) => {
  const body = await c.req.json();
  const runtimePath = join(WS, ".atlas-runtime-config.json");

  // ─────────────────────────────────────────────────────────────
  // Atomic read-merge-write.
  //
  // A bare `try/catch` around `JSON.parse(readFileSync(...))` would
  // silently swallow corrupt-file errors. If the file were ever
  // truncated by a previous crash or partial write, the next PATCH
  // would start from `{}` and clobber every previously-merged key.
  //
  // Instead: parse errors are logged loudly and refuse to proceed,
  // and the write goes through a tmp-file + rename so a crash
  // mid-write never produces a half-written runtime-config.
  // ─────────────────────────────────────────────────────────────
  let existing: Record<string, any> = {};
  if (existsSync(runtimePath)) {
    try {
      const raw = readFileSync(runtimePath, "utf-8");
      existing = JSON.parse(raw);
    } catch (err) {
      // Don't silently fall back to `{}` — that loses all previous
      // controller-written state on the next write. Surface the error
      // so an operator (or follow-up sync) can recover.
      console.error(
        `[config PATCH] runtime-config is corrupt at ${runtimePath} — refusing to deep-merge over an empty object:`,
        err,
      );
      return c.json(
        {
          error: "Runtime config is corrupt",
          message:
            "The on-disk runtime config could not be parsed. Manual inspection required to avoid silently overwriting valid state.",
        },
        500,
      );
    }
  }

  // Deep merge — target keys preserved unless source overrides them.
  function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
        target[key] = deepMerge(target[key] || {}, source[key]);
      } else {
        target[key] = source[key];
      }
    }
    return target;
  }

  deepMerge(existing, body);
  const serialized = JSON.stringify(existing, null, 2);

  // Atomic write: tmp file + rename. rename() is atomic within the same
  // filesystem (POSIX). A crash between writeFileSync and renameSync
  // leaves the original runtime-config untouched.
  const tmpPath = `${runtimePath}.tmp`;
  try {
    writeFileSync(tmpPath, serialized, "utf-8");
    renameSync(tmpPath, runtimePath);
  } catch (err) {
    // Best-effort tmp cleanup; don't mask the original error.
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {}
    console.error(`[config PATCH] failed to write runtime-config:`, err);
    return c.json(
      { error: "Write failed", message: err instanceof Error ? err.message : "unknown" },
      500,
    );
  }

  // Regenerate settings
  try {
    Bun.spawnSync(["bun", "run", "/atlas/app/hooks/generate-settings.ts"]);
  } catch {}
  syncCrontab();

  const config = resolveConfig(WS);
  return c.json({ ok: true, config: redactConfig(config), sources: getConfigSources() });
});

// --- Secrets ---

api.get("/secrets", (c) => {
  const secretsDir = join(WS, "secrets");
  if (!existsSync(secretsDir)) return c.json({ ok: true, secrets: [] });
  const files = readdirSync(secretsDir).filter((f) => {
    try { return statSync(join(secretsDir, f)).isFile(); } catch { return false; }
  });
  return c.json({ ok: true, secrets: files });
});

api.put("/secrets/:name", async (c) => {
  const name = c.req.param("name");
  // Sanitize: prevent path traversal
  if (name.includes("/") || name.includes("..") || name.startsWith(".")) {
    return c.json({ error: "Invalid secret name" }, 400);
  }
  const body = await c.req.json();
  if (!body.value || typeof body.value !== "string") {
    return c.json({ error: "Missing 'value' field" }, 400);
  }

  const secretsDir = join(WS, "secrets");
  mkdirSync(secretsDir, { recursive: true });
  const filePath = join(secretsDir, name);
  writeFileSync(filePath, body.value, { mode: 0o600 });
  return c.json({ ok: true, name });
});

api.delete("/secrets/:name", (c) => {
  const name = c.req.param("name");
  if (name.includes("/") || name.includes("..") || name.startsWith(".")) {
    return c.json({ error: "Invalid secret name" }, 400);
  }
  const filePath = join(WS, "secrets", name);
  if (!existsSync(filePath)) {
    return c.json({ error: "Not found" }, 404);
  }
  unlinkSync(filePath);
  return c.json({ ok: true, name });
});

// --- Identity & Soul ---

api.get("/identity", (c) => {
  const content = existsSync(IDENTITY) ? readFileSync(IDENTITY, "utf-8") : "";
  return c.json({ ok: true, content });
});

api.put("/identity", async (c) => {
  const body = await c.req.json();
  if (typeof body.content !== "string") {
    return c.json({ error: "Missing 'content' field" }, 400);
  }
  writeFileSync(IDENTITY, body.content, "utf-8");
  return c.json({ ok: true });
});

api.get("/soul", (c) => {
  const soulPath = join(WS, "SOUL.md");
  const content = existsSync(soulPath) ? readFileSync(soulPath, "utf-8") : "";
  return c.json({ ok: true, content });
});

api.put("/soul", async (c) => {
  const body = await c.req.json();
  if (typeof body.content !== "string") {
    return c.json({ error: "Missing 'content' field" }, 400);
  }
  writeFileSync(join(WS, "SOUL.md"), body.content, "utf-8");
  return c.json({ ok: true });
});

// --- Memory ---

function walkMemoryFiles(dir: string, base: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    const relPath = join(base, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMemoryFiles(fullPath, relPath));
    } else {
      results.push(relPath);
    }
  }
  return results;
}

api.get("/memory", (c) => {
  const memDir = join(WS, "memory");
  const files = walkMemoryFiles(memDir, "");
  return c.json({ ok: true, files });
});

api.get("/memory/*", (c) => {
  const path = c.req.path.replace("/api/v1/memory/", "");
  if (path.includes("..")) return c.json({ error: "Invalid path" }, 400);
  const filePath = join(WS, "memory", path);
  if (!existsSync(filePath)) return c.json({ error: "Not found" }, 404);
  const content = readFileSync(filePath, "utf-8");
  return c.json({ ok: true, path, content });
});

api.put("/memory/*", async (c) => {
  const path = c.req.path.replace("/api/v1/memory/", "");
  if (path.includes("..")) return c.json({ error: "Invalid path" }, 400);
  const body = await c.req.json();
  if (typeof body.content !== "string") {
    return c.json({ error: "Missing 'content' field" }, 400);
  }
  const filePath = join(WS, "memory", path);
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, body.content, "utf-8");
  return c.json({ ok: true, path });
});

api.delete("/memory/*", (c) => {
  const path = c.req.path.replace("/api/v1/memory/", "");
  if (path.includes("..")) return c.json({ error: "Invalid path" }, 400);
  const filePath = join(WS, "memory", path);
  if (!existsSync(filePath)) return c.json({ error: "Not found" }, 404);
  unlinkSync(filePath);
  return c.json({ ok: true, path });
});

// --- Control (Kill Switch) ---

api.get("/control/status", (c) => {
  const status = getControlStatus(db, WS);
  return c.json({ ok: true, ...status });
});

api.post("/control/pause", (c) => {
  pauseAtlas(db, WS);
  return c.json({ ok: true, paused: true });
});

api.post("/control/resume", (c) => {
  resumeAtlas(db, WS);
  return c.json({ ok: true, paused: false });
});

api.post("/control/stop", (c) => {
  const result = stopAllSessions(db, WS);
  return c.json({ ok: true, paused: true, killed: result.killed });
});

// --- Sessions (read-only) ---

api.get("/sessions", (c) => {
  const limit = parseInt(c.req.query("limit") || "50", 10);
  const sessions = db.query(
    "SELECT id, trigger_name, session_key, session_mode, session_id, payload, started_at, completed_at FROM trigger_runs ORDER BY started_at DESC LIMIT ?"
  ).all(limit);
  return c.json({ ok: true, sessions });
});

// --- Triggers (JSON API) ---

api.get("/triggers", (c) => {
  const triggers = db.query(
    "SELECT id, name, type, description, channel, schedule, session_mode, enabled, last_run, run_count, created_at FROM triggers ORDER BY name"
  ).all();
  return c.json({ ok: true, triggers });
});

api.post("/triggers/:name/toggle", (c) => {
  const name = c.req.param("name");
  const trigger = db.query("SELECT id, enabled FROM triggers WHERE name = ?").get(name) as { id: number; enabled: number } | null;
  if (!trigger) return c.json({ error: "Not found" }, 404);
  const newEnabled = trigger.enabled ? 0 : 1;
  db.run("UPDATE triggers SET enabled = ? WHERE id = ?", [newEnabled, trigger.id]);
  syncCrontab();
  return c.json({ ok: true, name, enabled: !!newEnabled });
});

api.post("/triggers/:name/run", (c) => {
  const name = c.req.param("name");
  const trigger = db.query("SELECT id, name FROM triggers WHERE name = ?").get(name) as { id: number; name: string } | null;
  if (!trigger) return c.json({ error: "Not found" }, 404);

  if (isAtlasPaused(WS)) {
    return c.json({ error: "Atlas is paused", message: "Resume Atlas before firing triggers" }, 409);
  }

  const triggerScript = "/atlas/app/triggers/trigger.sh";
  Bun.spawn(["bash", triggerScript, trigger.name, "", "_manual"], {
    stdout: "ignore", stderr: "ignore",
  });
  return c.json({ ok: true, name, message: "Trigger fired" });
});

// --- Chat (JSON API) ---

// STT — Whisper-compatible endpoint (parakeet on the cluster, by default).
// Set ATLAS_STT_URL to override.
const STT_URL = process.env.ATLAS_STT_URL
  ?? "http://parakeet.shared-stt.svc.cluster.local:5092/v1/audio/transcriptions";
const STT_TIMEOUT_MS = 30_000;

// --- Chunked STT helpers (ported from signal-addon.py) ---

const NATIVE_STT_FORMATS = new Set([".wav", ".flac", ".ogg"]);
const CHUNK_THRESHOLD_SECS = 120;
const CHUNK_SIZE_SECS = 120;
const CHUNK_OVERLAP_SECS = 1;

/** Map common audio MIME types to file extensions. */
function inferExtFromMime(mime: string): string {
  const map: Record<string, string> = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/aac": ".aac",
    "audio/flac": ".flac",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/wave": ".wav",
    "audio/mp3": ".mp3",
  };
  // strip codec params like "audio/webm; codecs=opus"
  const base = mime.split(";")[0].trim().toLowerCase();
  return map[base] ?? ".bin";
}

/** Convert an audio file to 16 kHz mono WAV via ffmpeg. Returns path or null. */
async function convertToWav(inputPath: string, outputPath: string): Promise<boolean> {
  const proc = Bun.spawn(
    ["ffmpeg", "-i", inputPath, "-ar", "16000", "-ac", "1", "-y", outputPath],
    { stdout: "ignore", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const errText = await new Response(proc.stderr).text();
    console.error("[chat] STT ffmpeg conversion failed:", errText.slice(0, 200));
    return false;
  }
  return true;
}

/** Get audio duration in seconds via ffprobe. Returns 0 on failure. */
async function getAudioDuration(filePath: string): Promise<number> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", filePath],
    { stdout: "pipe", stderr: "ignore" },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) return 0;
  try {
    const out = await new Response(proc.stdout).text();
    const info = JSON.parse(out) as { format?: { duration?: string } };
    return parseFloat(info.format?.duration ?? "0") || 0;
  } catch {
    return 0;
  }
}

/**
 * Split a WAV file into overlapping CHUNK_SIZE_SECS chunks via ffmpeg.
 * Returns an array of temp file paths (caller must clean them up).
 * If splitting fails, returns [wavPath] (the original).
 */
async function splitWavChunks(wavPath: string, duration: number): Promise<string[]> {
  const chunks: string[] = [];
  let start = 0;
  let idx = 0;
  while (start < duration) {
    const chunkPath = `/tmp/${crypto.randomUUID()}_chunk${idx}.wav`;
    const proc = Bun.spawn(
      [
        "ffmpeg", "-y", "-i", wavPath,
        "-ss", String(start),
        "-t", String(CHUNK_SIZE_SECS),
        "-ar", "16000", "-ac", "1",
        chunkPath,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const exitCode = await proc.exited;
    const chunkFile = Bun.file(chunkPath);
    if (exitCode === 0 && await chunkFile.exists() && chunkFile.size > 100) {
      chunks.push(chunkPath);
    } else {
      const errText = await new Response(proc.stderr).text();
      console.error(`[chat] STT chunk split error at ${start}s:`, errText.slice(0, 200));
      break;
    }
    start += CHUNK_SIZE_SECS - CHUNK_OVERLAP_SECS;
    idx++;
  }
  return chunks.length > 0 ? chunks : [wavPath];
}

/** Send one file (by path) to the STT endpoint. Returns transcript or null. */
async function doSttRequest(filePath: string): Promise<string | null> {
  const fileBlob = Bun.file(filePath);
  const form = new FormData();
  form.append("file", fileBlob, filePath.split("/").pop() ?? "audio.wav");
  form.append("model", "default");
  const res = await fetch(STT_URL, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(STT_TIMEOUT_MS),
  });
  if (!res.ok) {
    console.error(`[chat] STT non-2xx: ${res.status}`);
    return null;
  }
  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim() || null;
}

/**
 * Best-effort STT: convert if needed, chunk long audio, transcribe each
 * chunk against the cluster STT service (parakeet), return joined transcript
 * or `null` if conversion or all chunks fail.
 *
 * Ported from signal-addon.py `_transcribe_audio` — keeps the same
 * non-fatal semantics: any error returns null so the caller can fall back to
 * the "(Datei: …)" placeholder.
 */
async function transcribeAudio(file: File): Promise<string | null> {
  const ext = inferExtFromMime(file.type) || ".bin";
  console.log(`[chat] STT input: ${file.size}b mime=${file.type} ext=${ext}`);

  // Write incoming File to disk so ffmpeg/ffprobe can read it
  const inputPath = `/tmp/${crypto.randomUUID()}${ext}`;
  let wavPath: string | null = null;
  const chunkPaths: string[] = [];

  try {
    await Bun.write(inputPath, file);

    // Convert non-native formats to 16 kHz mono WAV
    let workPath = inputPath;
    if (!NATIVE_STT_FORMATS.has(ext)) {
      wavPath = `/tmp/${crypto.randomUUID()}.wav`;
      const ok = await convertToWav(inputPath, wavPath);
      if (!ok) {
        console.error("[chat] STT request failed: ffmpeg conversion returned non-zero");
        return null;
      }
      workPath = wavPath;
    }

    const duration = await getAudioDuration(workPath);

    if (duration <= CHUNK_THRESHOLD_SECS) {
      // Short audio — single request
      return await doSttRequest(workPath);
    }

    // Long audio — split and transcribe each chunk
    const nChunks = Math.ceil((duration - CHUNK_OVERLAP_SECS) / (CHUNK_SIZE_SECS - CHUNK_OVERLAP_SECS));
    console.log(`[chat] STT chunking: duration=${Math.round(duration)}s, splitting into ${nChunks} x ${CHUNK_SIZE_SECS}s chunks`);

    const splits = await splitWavChunks(workPath, duration);
    // If splitWavChunks returned the original (fallback), chunkPaths stays empty
    if (splits.length === 1 && splits[0] === workPath) {
      // Single-chunk fallback (split failed)
      return await doSttRequest(workPath);
    }
    chunkPaths.push(...splits);

    const transcriptions: string[] = [];
    for (let i = 0; i < chunkPaths.length; i++) {
      const t0 = Date.now();
      try {
        const text = await doSttRequest(chunkPaths[i]);
        const ms = Date.now() - t0;
        const words = text ? text.trim().split(/\s+/).length : 0;
        console.log(`[chat] STT chunk ${i + 1}/${chunkPaths.length}: ${ms}ms, ${words}w`);
        if (text) transcriptions.push(text);
      } catch (err) {
        console.error(`[chat] STT chunk ${i + 1} failed:`, err);
        // continue — return whatever we have from successful chunks
      }
    }
    return transcriptions.length > 0 ? transcriptions.join(" ").trim() : null;

  } catch (err) {
    console.error("[chat] STT request failed:", err);
    return null;
  } finally {
    // Clean up temp files
    for (const p of [inputPath, wavPath, ...chunkPaths]) {
      if (!p) continue;
      try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
    }
  }
}

api.post("/chat/messages", async (c) => {
  // Accept either application/json (legacy text-only) or multipart/form-data
  // (text + file attachments, e.g. voice notes). Multipart form fields:
  //   - message       (optional) — text content / caption. Required ONLY when
  //                    no files are attached (a bare file send is valid).
  //   - file          (optional, repeatable) — binary attachment(s)
  //   - transcription (optional) — pre-computed STT transcript for the audio
  //                    attachment. When omitted on an audio file, this
  //                    handler runs STT inline (parakeet) so the agent
  //                    sees usable text without a round-trip to the client.
  //
  // Wrapped in a single try/catch so any unhandled throw becomes a logged
  // 500 with a stable shape — Hono's default 500 message hid the real cause
  // when STT or formData parsing surfaced an exception in production.
  try {
  const sessionKey = resolveWebSessionKey(c);
  const contentType = c.req.header("content-type") ?? "";
  let content: string;
  let attachmentSpecs: Array<{ file: File; transcription?: string | null }> = [];
  // Track whether the caller supplied content; if not we may synthesise from STT.
  let contentExplicitlySet = false;
  // Optional per-message caller metadata — mirrored as <webmsg> attributes.
  let callerUserMail: string | null = null;
  let callerUserName: string | null = null;

  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.formData();
    content = ((form.get("message") as string) ?? "").trim();
    contentExplicitlySet = content.length > 0;
    const callerTranscription = ((form.get("transcription") as string) ?? "").trim() || null;
    callerUserMail = ((form.get("user_mail") as string) ?? "").trim() || null;
    callerUserName = ((form.get("user_name") as string) ?? "").trim() || null;
    const files = form.getAll("file").filter((f): f is File => f instanceof File);

    // Diagnostic: log incoming shape so we can correlate failures with the
    // mime types / sizes browsers actually deliver. Stays quiet for empty
    // requests so it doesn't drown the log on healthy traffic.
    if (files.length > 0) {
      console.log(
        `[chat] POST multipart: content=${content.length}b explicit=${contentExplicitlySet} `
        + `files=[${files.map((f) => `${f.name}@${f.size}b/${f.type || "no-type"}`).join(", ")}] `
        + `callerTranscription=${callerTranscription ? "yes" : "no"}`,
      );
    }

    // Identify the (single) audio file. Browsers usually ship
    // "audio/webm;codecs=opus", but some webm-mux pipelines tag voice notes
    // as "video/webm" — fall back to a name-based heuristic for those.
    const audioIdx = files.findIndex((f) =>
      f.type.startsWith("audio/")
      || /\.(webm|m4a|mp3|ogg|wav|aac|opus)$/i.test(f.name || ""),
    );

    // Run STT inline if there's audio + no transcript was provided. Failure
    // is non-fatal: we just save the message without a transcript and let
    // the agent fall back to its own STT skill if it cares.
    let computedTranscript: string | null = callerTranscription;
    if (audioIdx >= 0 && !computedTranscript) {
      computedTranscript = await transcribeAudio(files[audioIdx]);
    }

    attachmentSpecs = files.map((f, idx) => ({
      file: f,
      transcription: idx === audioIdx ? computedTranscript : null,
    }));

    // If the caller didn't ship a message string, synthesise one. Order of
    // preference: STT transcript → "(Datei: name)" placeholder → "(N Dateien)".
    if (!contentExplicitlySet) {
      if (computedTranscript) {
        content = computedTranscript;
      } else if (files.length === 1) {
        content = `(Datei: ${files[0].name || "ohne Namen"})`;
      } else if (files.length > 1) {
        content = `(${files.length} Dateien)`;
      }
    }
  } else {
    const body = await c.req.json();
    content = (body.message || "").trim();
    contentExplicitlySet = content.length > 0;
    callerUserMail = ((body.user_mail as string | null | undefined) ?? "").toString().trim() || null;
    callerUserName = ((body.user_name as string | null | undefined) ?? "").toString().trim() || null;
  }

  if (!content || typeof content !== "string") {
    return c.json({ error: "Missing 'message' field" }, 400);
  }

  // Touch/create session row. Pass derived title on every call — touchChatSession
  // uses COALESCE so an existing non-null title (manual or earlier derived) wins.
  touchChatSession(sessionKey, { title: deriveSessionTitle(content) });

  const msg = db
    .prepare(
      "INSERT INTO messages (channel, sender, content, session_key) VALUES ('web', 'web-ui', ?, ?) RETURNING *",
    )
    .get(content, sessionKey) as any;

  // Persist attachments (if any) and capture metadata for the trigger payload + response.
  const savedAttachments: Attachment[] = [];
  for (const spec of attachmentSpecs) {
    try {
      const a = await saveAttachment(db, {
        messageId: msg.id,
        file: spec.file,
        mimeType: spec.file.type || "application/octet-stream",
        fileName: spec.file.name,
        transcription: spec.transcription ?? null,
      });
      savedAttachments.push(a);
    } catch (e) {
      // Non-fatal: log and continue. Worst case: the message goes through
      // without that attachment instead of failing the whole request.
      console.error("[chat] failed to save attachment:", e);
    }
  }

  // Touch wake file
  try {
    mkdirSync(`${WS}/inbox`, { recursive: true });
    closeSync(openSync(WAKE, "w"));
  } catch {}

  // Wrap the resolved content in the <webmsg> envelope before it lands as the
  // agent's user-turn. Caller-supplied user_mail / user_name become XML attrs.
  const wrappedContent = wrapWebMessage(content, {
    userMail: callerUserMail,
    userName: callerUserName,
  });

  // Trigger payload — include attachment metadata so the AI is aware of voice
  // notes / files and can fetch the original via /api/v1/attachments/<id>.
  const payload = JSON.stringify({
    inbox_message_id: msg.id,
    sender: "web-ui",
    message: wrappedContent.slice(0, 20000),
    timestamp: sqliteToIso(msg.created_at),
    attachments: savedAttachments.map((a) => ({
      id: a.id,
      kind: a.kind,
      mime_type: a.mime_type,
      file_name: a.file_name,
      file_size: a.file_size,
      transcription: a.transcription,
      url: attachmentUrl(a.id),
    })),
  });
  Bun.spawn(
    ["/atlas/app/triggers/trigger.sh", "web-chat", payload, sessionKey],
    { stdout: "ignore", stderr: "ignore" },
  );

  return c.json({
    ok: true,
    message: {
      id: msg.id,
      content: msg.content,
      timestamp: sqliteToIso(msg.created_at),
      attachments: savedAttachments.map((a) => ({
        id: a.id,
        kind: a.kind,
        mime_type: a.mime_type,
        file_name: a.file_name,
        file_size: a.file_size,
        url: attachmentUrl(a.id),
      })),
    },
  });
  } catch (err) {
    // Surface the real error to logs so we can fix it instead of returning
    // an opaque 500. The client still gets a sanitised message.
    console.error("[chat] POST handler threw:", err);
    if (err instanceof Error && err.stack) {
      console.error(err.stack);
    }
    return c.json({ error: "Internal error", detail: err instanceof Error ? err.message : "unknown" }, 500);
  }
});

// Stream a stored attachment back to the caller. Used by the web UI to play
// voice notes inline (the unclutter-pro frontend proxies this through its
// own /api/chat/attachments/<id> endpoint, which adds session auth).
api.get("/attachments/:id", async (c) => {
  const id = c.req.param("id");
  const a = getAttachment(db, id);
  if (!a) return c.json({ error: "not found" }, 404);
  if (!attachmentExists(a)) return c.json({ error: "file missing on disk" }, 410);

  const path = attachmentDiskPath(a);
  const file = Bun.file(path);
  return new Response(file, {
    headers: {
      "Content-Type": a.mime_type,
      "Content-Length": String(a.file_size),
      "Content-Disposition": `inline; filename="${a.file_name.replace(/"/g, "")}"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
});

api.delete("/chat/messages", async (c) => {
  const sessionKey = resolveWebSessionKey(c);
  // Reset web-chat session (like Signal /new):
  // 1. Find existing session
  const session = db
    .prepare("SELECT session_id FROM trigger_sessions WHERE trigger_name = ? AND session_key = ? LIMIT 1")
    .get('web-chat', sessionKey) as { session_id: string } | null;

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

    const socketPath = `/tmp/claudec-${session.session_id}.sock`;
    if (existsSync(socketPath)) {
      // Session is running — inject farewell via IPC socket
      try {
        const { createConnection: netConnect } = await import("net");
        await new Promise<void>((resolve, reject) => {
          const sock = netConnect(socketPath);
          sock.setTimeout(10_000);
          sock.on("connect", () => {
            sock.write(JSON.stringify({ action: "send", text: farewell, submit: true }) + "\n");
            sock.end();
            farewellSent = true;
            resolve();
          });
          sock.on("error", reject);
          sock.on("timeout", () => { sock.destroy(); reject(new Error("timeout")); });
        });
      } catch {
        // IPC injection failed — proceed with cleanup anyway
      }
    } else {
      // Session not running — resume it with farewell
      try {
        const env = { ...process.env, ATLAS_TRIGGER: "web-chat", ATLAS_TRIGGER_CHANNEL: "web", ATLAS_TRIGGER_SESSION_KEY: sessionKey };
        delete env.CLAUDECODE;
        const proc = Bun.spawn(
          ["/atlas/app/triggers/trigger-runner", "--direct", farewell, "--channel", "web", "--resume", session.session_id],
          { stdout: "ignore", stderr: "ignore", env },
        );
        // Kill farewell after 5min max (runs in background, doesn't block the response)
        setTimeout(() => { try { proc.kill(); } catch {} }, 300_000);
        farewellSent = true;
      } catch {
        // Resume failed — proceed with cleanup
      }
    }
  }

  // 2. Delete session entry so next message creates a fresh session (immediately — don't wait for farewell to finish)
  db.prepare("DELETE FROM trigger_sessions WHERE trigger_name = ? AND session_key = ?").run('web-chat', sessionKey);
  // 3. Clear web channel user messages for this session
  db.prepare("DELETE FROM messages WHERE channel = ? AND session_key = ?").run('web', sessionKey);
  // 4. Drop any persisted stream chunks for the retired session so they
  //    don't haunt the next conversation if SQLite recycles the row ids.
  if (session) {
    db.prepare("DELETE FROM web_chat_stream_chunks WHERE session_id = ?").run(session.session_id);
  }
  // 5. Reset updated_at on the chat_sessions row (session was cleared)
  db.prepare("UPDATE chat_sessions SET updated_at = datetime('now'), title = NULL WHERE session_key = ?").run(sessionKey);

  return c.json({ ok: true, farewellSent });
});

api.get("/chat/messages", (c) => {
  const sessionKey = resolveWebSessionKey(c);
  // User messages from DB
  const dbMessages = db
    .prepare("SELECT id, content, created_at FROM messages WHERE channel = ? AND session_key = ? ORDER BY created_at ASC, id ASC")
    .all('web', sessionKey) as { id: number; content: string; created_at: string }[];

  // Assistant messages from JSONL session file
  const session = db
    .prepare("SELECT session_id FROM trigger_sessions WHERE trigger_name = ? AND session_key = ? LIMIT 1")
    .get('web-chat', sessionKey) as any;

  let assistantMsgs: ParsedMessage[] = [];
  let isRunning = false;
  if (session) {
    const filePath = findSessionFile(session.session_id);
    // Primary signal: a `claude --resume <session>` process is currently
    // running (works for both `claudec` IPC sockets and direct invocations).
    // Secondary signal: JSONL last entry indicates a pending turn — covers
    // the gap between trigger fire and process startup.
    isRunning = isClaudeProcessRunning(session.session_id) || isAgentTurnActive(filePath);
    if (filePath) {
      const all = parseSessionMessages(filePath);
      // Drop user-text entries from JSONL — those are trigger boilerplate
      assistantMsgs = all.filter(m => m.type !== "user-text");
    }
  }

  // Merge DB user messages + JSONL assistant/tool messages, sorted chronologically
  const combined: {
    role: string;
    content: string;
    timestamp: string;
    toolName?: string;
    attachments?: Array<{
      id: string;
      kind: string;
      mime_type: string;
      file_name: string;
      file_size: number;
      url: string;
    }>;
  }[] = [];

  for (const m of dbMessages) {
    // Include attachment metadata so the web client can re-render audio
    // bubbles / file chips after a page reload (without re-fetching the
    // payload sent to the trigger). Transcripts stay server-side only.
    const atts = getAttachmentsForMessage(db, m.id).map((a) => ({
      id: a.id,
      kind: a.kind,
      mime_type: a.mime_type,
      file_name: a.file_name,
      file_size: a.file_size,
      url: attachmentUrl(a.id),
    }));
    combined.push({
      role: "user",
      content: m.content,
      timestamp: sqliteToIso(m.created_at),
      ...(atts.length > 0 ? { attachments: atts } : {}),
    });
  }

  // Include assistant-text and assistant-tool-use messages (skip thinking, tool-result)
  for (const m of assistantMsgs) {
    if (m.type === "assistant-text") {
      combined.push({
        role: "assistant",
        content: m.content,
        timestamp: m.timestamp || "",
      });
    } else if (m.type === "assistant-tool-use") {
      combined.push({
        role: "tool",
        content: m.content,
        timestamp: m.timestamp || "",
        toolName: m.toolName,
      });
    }
  }

  combined.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    // Same timestamp: user before assistant/tool
    return (a.role === "user" ? 0 : 1) - (b.role === "user" ? 0 : 1);
  });

  // Show typing while session is being set up or actively running
  const isAgentRunning = (!session && dbMessages.length > 0) || (!!session && isRunning);
  const toolSteps = assistantMsgs.filter(m => m.type === "assistant-tool-use").length;

  return c.json({ ok: true, messages: combined, isAgentRunning, isTyping: isAgentRunning, toolSteps });
});

api.get("/chat/stream", (c) => {
  const sessionKey = resolveWebSessionKey(c);
  // Per-request opt-out of incremental text chunks. Default ON — the new
  // streaming behaviour is what we want for new clients. Callers that want
  // the old "wait for the whole message" UX can pass `?stream=false`.
  const streamParam = c.req.query("stream");
  const wantsStreamChunks = streamParam !== "false" && streamParam !== "0";

  return c.newResponse(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (event: string, data: any) => {
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {}
        };

        let lastUserMsgCount = 0;
        let lastAssistantMsgCount = 0;
        let lastToolCount = 0;
        let lastChunkId = 0; // monotonic id from web_chat_stream_chunks
        let wasRunning = false;
        let isFirstPoll = true;
        let pollCount = 0;
        const MAX_POLLS = 600; // 5 minutes at 500ms intervals

        const poll = () => {
          try {
            pollCount++;
            if (pollCount > MAX_POLLS) {
              send("agent_ended", {});
              controller.close();
              return;
            }

            // User messages from DB
            const dbMessages = db
              .prepare("SELECT id, content, created_at FROM messages WHERE channel = ? AND session_key = ? ORDER BY created_at ASC, id ASC")
              .all('web', sessionKey) as { id: number; content: string; created_at: string }[];

            // Assistant messages from JSONL session file
            const session = db
              .prepare("SELECT session_id FROM trigger_sessions WHERE trigger_name = ? AND session_key = ? LIMIT 1")
              .get('web-chat', sessionKey) as any;

            let assistantMsgs: ParsedMessage[] = [];
            let isRunning = false;
            if (session) {
              const filePath = findSessionFile(session.session_id);
              // Primary signal: a `claude --resume <session>` process is
              // currently running. Secondary signal: JSONL last entry shows a
              // pending turn — covers the gap between trigger fire and
              // process startup, plus tool_use waiting on results.
              isRunning = isClaudeProcessRunning(session.session_id) || isAgentTurnActive(filePath);
              if (filePath) {
                const all = parseSessionMessages(filePath);
                assistantMsgs = all.filter(m => m.type !== "user-text");
              }
            }

            const isAgentRunning = (!session && dbMessages.length > 0) || (!!session && isRunning);

            // Categorize messages
            const userMessages = dbMessages.map(m => ({
              content: m.content,
              timestamp: sqliteToIso(m.created_at),
            }));
            const assistantTextMsgs = assistantMsgs.filter(m => m.type === "assistant-text");
            const toolUseMsgs = assistantMsgs.filter(m => m.type === "assistant-tool-use");

            if (isFirstPoll) {
              // Build full message list for init event
              const messages: { role: string; content: string; timestamp: string; toolName?: string }[] = [];
              for (const m of dbMessages) {
                messages.push({
                  role: "user",
                  content: m.content,
                  timestamp: sqliteToIso(m.created_at),
                });
              }
              for (const m of assistantMsgs) {
                if (m.type === "assistant-text") {
                  messages.push({
                    role: "assistant",
                    content: m.content,
                    timestamp: m.timestamp || "",
                  });
                } else if (m.type === "assistant-tool-use") {
                  messages.push({
                    role: "tool",
                    content: m.content,
                    timestamp: m.timestamp || "",
                    toolName: m.toolName,
                  });
                }
              }
              messages.sort((a, b) => {
                if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
                return (a.role === "user" ? 0 : 1) - (b.role === "user" ? 0 : 1);
              });

              send("init", { messages, isAgentRunning, toolSteps: toolUseMsgs.length });

              lastUserMsgCount = userMessages.length;
              lastAssistantMsgCount = assistantTextMsgs.length;
              lastToolCount = toolUseMsgs.length;
              // Skip any chunks that landed before this stream opened — they
              // belong to an already-rendered message and the JSONL is the
              // canonical source for past turns. Without this, a fresh
              // connection would replay every delta the trigger-runner has
              // ever persisted for this session. When no session row exists
              // yet (user opened the chat before sending anything) there are
              // no chunks to skip; lastChunkId stays at 0 and the next poll
              // will discover the new session and emit chunks from the start.
              if (session) {
                const maxRow = db
                  .prepare(
                    "SELECT COALESCE(MAX(id), 0) AS maxId FROM web_chat_stream_chunks WHERE session_id = ?",
                  )
                  .get(session.session_id) as { maxId: number } | undefined;
                lastChunkId = maxRow?.maxId ?? 0;
              }
              wasRunning = isAgentRunning;
              isFirstPoll = false;
              setTimeout(poll, 500);
              return;
            }

            // Subsequent polls — send granular events

            // New user messages
            if (userMessages.length > lastUserMsgCount) {
              for (let i = lastUserMsgCount; i < userMessages.length; i++) {
                send("user_message", { content: userMessages[i].content, timestamp: userMessages[i].timestamp });
              }
              lastUserMsgCount = userMessages.length;
            }

            // Stream chunks: emit any text deltas the trigger-runner has
            // persisted since the last poll. Each chunk carries the same
            // messageId the final assistant_message will carry, so the client
            // can stitch them into a growing bubble and then replace with the
            // final text once it lands in the JSONL. Skipped when the client
            // opted out via ?stream=false.
            if (wantsStreamChunks && session) {
              const chunks = db
                .prepare(
                  `SELECT id, message_uuid, chunk_index, content_delta
                     FROM web_chat_stream_chunks
                     WHERE session_id = ? AND id > ?
                     ORDER BY id ASC
                     LIMIT 200`,
                )
                .all(session.session_id, lastChunkId) as {
                  id: number;
                  message_uuid: string;
                  chunk_index: number;
                  content_delta: string;
                }[];
              for (const ch of chunks) {
                send("assistant_message_chunk", {
                  messageId: ch.message_uuid,
                  index: ch.chunk_index,
                  delta: ch.content_delta,
                });
                lastChunkId = ch.id;
              }
            }

            // New assistant text messages
            if (assistantTextMsgs.length > lastAssistantMsgCount) {
              for (let i = lastAssistantMsgCount; i < assistantTextMsgs.length; i++) {
                send("assistant_message", {
                  content: assistantTextMsgs[i].content,
                  timestamp: assistantTextMsgs[i].timestamp || "",
                  ...(assistantTextMsgs[i].messageId
                    ? { messageId: assistantTextMsgs[i].messageId }
                    : {}),
                });
              }
              lastAssistantMsgCount = assistantTextMsgs.length;
            }

            // New tool uses
            if (toolUseMsgs.length > lastToolCount) {
              for (let i = lastToolCount; i < toolUseMsgs.length; i++) {
                send("tool_activity", { toolName: toolUseMsgs[i].toolName, totalSteps: i + 1 });
              }
              lastToolCount = toolUseMsgs.length;
            }

            // Agent state transitions
            if (!wasRunning && isAgentRunning) {
              send("agent_started", {});
            }
            if (wasRunning && !isAgentRunning) {
              send("agent_ended", {});
              wasRunning = isAgentRunning;
              // Delay close so the client has time to receive and process
              // agent_ended before the connection drops. Without this, the event
              // can be lost if the TCP buffer flushes at the same time as close.
              setTimeout(() => { try { controller.close(); } catch {} }, 1500);
              return;
            }

            wasRunning = isAgentRunning;
            setTimeout(poll, 500);
          } catch {
            try { controller.close(); } catch {}
          }
        };

        // Send initial state immediately
        poll();
      },
      cancel() {
        // Client disconnected — nothing to clean up since setTimeout
        // will fail silently when controller is closed
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    }
  );
});

// ============ CHAT SESSION MANAGEMENT ============

api.get("/chat/sessions", (c) => {
  const includeArchived = c.req.query("includeArchived") === "true";
  const archivedClause = includeArchived ? "" : "AND cs.archived_at IS NULL";
  const rows = db.prepare(`
    SELECT
      cs.session_key,
      cs.title,
      cs.created_at,
      cs.updated_at,
      cs.archived_at,
      COUNT(m.id) AS message_count,
      MAX(m.created_at) AS last_message_at
    FROM chat_sessions cs
    LEFT JOIN messages m ON m.channel = 'web' AND m.session_key = cs.session_key
    WHERE cs.channel = 'web' ${archivedClause}
    GROUP BY cs.session_key
    ORDER BY cs.updated_at DESC
  `).all() as {
    session_key: string;
    title: string | null;
    created_at: string;
    updated_at: string;
    archived_at: string | null;
    message_count: number;
    last_message_at: string | null;
  }[];

  return c.json({
    sessions: rows.map(r => ({
      session_key: r.session_key,
      title: r.title,
      created_at: sqliteToIso(r.created_at),
      updated_at: sqliteToIso(r.updated_at),
      archived_at: r.archived_at ? sqliteToIso(r.archived_at) : null,
      message_count: r.message_count,
      last_message_at: r.last_message_at ? sqliteToIso(r.last_message_at) : null,
    })),
  });
});

api.post("/chat/sessions", async (c) => {
  let title: string | null = null;
  try {
    const body = await c.req.json();
    title = (body.title ?? null);
    if (typeof title !== "string" || title.trim() === "") title = null;
    else title = title.trim();
  } catch {
    // Accept empty body
  }

  const sessionKey = crypto.randomUUID();
  db.prepare(
    `INSERT INTO chat_sessions (session_key, channel, title) VALUES (?, 'web', ?)`
  ).run(sessionKey, title);

  const row = db.prepare("SELECT session_key, title, created_at, updated_at FROM chat_sessions WHERE session_key = ?")
    .get(sessionKey) as { session_key: string; title: string | null; created_at: string; updated_at: string };

  return c.json({
    session_key: row.session_key,
    title: row.title,
    created_at: sqliteToIso(row.created_at),
    updated_at: sqliteToIso(row.updated_at),
  }, 201);
});

api.patch("/chat/sessions/:key", async (c) => {
  const key = c.req.param("key");
  const existing = db.prepare("SELECT session_key FROM chat_sessions WHERE session_key = ?").get(key);
  if (!existing) return c.json({ error: "not found" }, 404);

  let body: any = {};
  try { body = await c.req.json(); } catch {}

  const updates: string[] = ["updated_at = datetime('now')"];
  const params: any[] = [];

  if ("title" in body) {
    const t = body.title;
    updates.push("title = ?");
    params.push(typeof t === "string" && t.trim().length > 0 ? t.trim() : null);
  }

  if ("archived" in body) {
    if (body.archived === true) {
      updates.push("archived_at = datetime('now')");
    } else if (body.archived === false) {
      updates.push("archived_at = NULL");
    }
  }

  params.push(key);
  db.prepare(`UPDATE chat_sessions SET ${updates.join(", ")} WHERE session_key = ?`).run(...params);

  const row = db.prepare("SELECT session_key, title, created_at, updated_at, archived_at FROM chat_sessions WHERE session_key = ?")
    .get(key) as { session_key: string; title: string | null; created_at: string; updated_at: string; archived_at: string | null };

  return c.json({
    session_key: row.session_key,
    title: row.title,
    created_at: sqliteToIso(row.created_at),
    updated_at: sqliteToIso(row.updated_at),
    archived_at: row.archived_at ? sqliteToIso(row.archived_at) : null,
  });
});

api.delete("/chat/sessions/:key", (c) => {
  const key = c.req.param("key");
  if (key === "_default") {
    return c.json({ error: "Cannot delete the default session; use DELETE /chat/messages to reset it" }, 400);
  }
  const existing = db.prepare("SELECT session_key FROM chat_sessions WHERE session_key = ?").get(key);
  if (!existing) return c.json({ error: "not found" }, 404);

  // Find session_id for stream chunk cleanup
  const trigSession = db.prepare("SELECT session_id FROM trigger_sessions WHERE trigger_name = 'web-chat' AND session_key = ?")
    .get(key) as { session_id: string } | null;

  db.prepare("DELETE FROM trigger_sessions WHERE trigger_name = 'web-chat' AND session_key = ?").run(key);
  db.prepare("DELETE FROM messages WHERE channel = 'web' AND session_key = ?").run(key);
  if (trigSession) {
    db.prepare("DELETE FROM web_chat_stream_chunks WHERE session_id = ?").run(trigSession.session_id);
  }
  db.prepare("DELETE FROM chat_sessions WHERE session_key = ?").run(key);

  return c.json({ ok: true });
});

// Mount API under /api/v1
app.route("/api/v1", api);

// --- Start ---
export default {
  port: 3000,
  fetch: app.fetch,
};

console.log(`${AGENT_NAME} Web-UI running on http://localhost:3000`);
