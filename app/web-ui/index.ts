/**
 * Legacy Hono app, reached through server.ts's fetch fallback. It serves only
 * the key-protected external API (/api/v1/*), webhooks (/api/webhook/:name)
 * and /healthz. The web UI (including Chat) is the React SPA plus /ui/api.
 * /api/v1/chat/* keeps its contract but runs on the shared chat service and
 * hub (ui-api/chat/service.ts, ui-api/chat/legacy.ts).
 */

import { Hono } from "hono";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
  renameSync,
} from "fs";
import { join } from "path";
import { getDb } from "../lib/atlas-db";
import { createWebhookHandler } from "./webhook";
import { apiKeyAuth } from "../lib/api-auth";
import { crossSiteRejection, HttpError } from "./ui-api/shared/http";
import {
  createSession as createChatSession,
  deriveSessionTitle,
  getSessionDetail as getChatSessionDetail,
  listSessions as listChatSessions,
  purgeSession as purgeChatSession,
  resetSession as resetChatSession,
  sendMessage as sendChatMessage,
  sessionKeyFromQuery,
  updateSession as updateChatSession,
  wrapWebMessage,
  type SendMessageInput,
} from "./ui-api/chat/service";
import { legacyChatStream, legacyMessagesResponse } from "./ui-api/chat/legacy";
import { notifyAllChats } from "./ui-api/chat/hub";
import { resolveConfig, redactConfig, getConfigSources } from "../lib/config";
import { pauseAtlas, resumeAtlas, stopAllSessions, getControlStatus, isAtlasPaused } from "../lib/kill-switch";
import { getAttachment, attachmentDiskPath, attachmentExists, attachmentUrl } from "../lib/attachments";
import { fireTrigger, paths, syncCrontab, trySpawnSync } from "./ui-api/shared/env";

// --- Config ---
const WS = process.env.HOME!;
const IDENTITY = `${WS}/IDENTITY.md`;

const db = getDb();

// Chat helpers live in the chat service; re-exported for existing importers.
export { deriveSessionTitle, wrapWebMessage };

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

// ============ WEBHOOK API ============
app.post("/api/webhook/:name", createWebhookHandler({
  getTrigger: (name) => db.prepare("SELECT * FROM triggers WHERE name = ? AND type = 'webhook'").get(name) as any,
  fireTrigger: (name, payload) => {
    fireTrigger(name, payload);
  },
}));

// =============================================================================
// External Configuration API (v1)
// =============================================================================

const api = new Hono();
// Browsers must not reach /api/v1 cross-site (it is open when ATLAS_API_KEY is
// unset). Non-browser clients send no Origin/Sec-Fetch-Site and pass; bodies
// may be multipart (voice messages), so no JSON requirement here.
api.use("*", async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") return next();
  const rejection = crossSiteRejection(c.req.raw, { requireJson: false });
  if (rejection) return c.json({ error: rejection.message }, rejection.status as 403 | 415);
  return next();
});
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
  const config = redactConfig(resolveConfig(WS));
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

  trySpawnSync(["bun", "run", "/atlas/app/triggers/harness/configure.ts"]);
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
  notifyAllChats();
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

  if (!fireTrigger(trigger.name, "", "_manual")) {
    return c.json({ error: "Not fired", message: `${paths.triggerSh} is not available here` }, 503);
  }
  return c.json({ ok: true, name, message: "Trigger fired" });
});

// --- Chat (JSON API) ---

// Chat routes delegate to the chat service (ui-api/chat/*) and keep the v1
// request/response shapes; the stream maps hub events to the v1 SSE events.

/** HttpError from the chat service → v1 JSON error. */
function chatError(c: any, err: unknown) {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  throw err;
}

api.post("/chat/messages", async (c) => {
  // Accept either application/json (legacy text-only) or multipart/form-data
  // (text + file attachments, e.g. voice notes). Multipart form fields:
  //   - message       (optional) — text content / caption. Required ONLY when
  //                    no files are attached (a bare file send is valid).
  //   - file          (optional, repeatable) — binary attachment(s)
  //   - transcription (optional) — pre-computed STT transcript for the audio
  //                    attachment. When omitted on an audio file, the service
  //                    runs STT inline so the agent sees usable text.
  //   - user_mail / user_name (optional) — become <webmsg> attributes.
  try {
    const sessionKey = sessionKeyFromQuery(c.req.query("sessionKey"));
    const contentType = c.req.header("content-type") ?? "";
    let input: Omit<SendMessageInput, "surface">;
    if (contentType.includes("multipart/form-data")) {
      const form = await c.req.formData();
      const field = (name: string) => ((form.get(name) as string | null) ?? "").toString().trim() || null;
      const files = form.getAll("file").filter((f): f is File => f instanceof File);
      if (files.length > 0) {
        console.log(
          `[chat] POST multipart: files=[${files.map((f) => `${f.name}@${f.size}b/${f.type || "no-type"}`).join(", ")}] `
          + `callerTranscription=${field("transcription") ? "yes" : "no"}`,
        );
      }
      input = {
        content: field("message") ?? "",
        files,
        transcription: field("transcription"),
        userMail: field("user_mail"),
        userName: field("user_name"),
      };
    } else {
      const body = await c.req.json();
      input = {
        content: typeof body.message === "string" ? body.message : "",
        userMail: ((body.user_mail as string | null | undefined) ?? "").toString().trim() || null,
        userName: ((body.user_name as string | null | undefined) ?? "").toString().trim() || null,
      };
    }

    let sent;
    try {
      sent = await sendChatMessage(sessionKey, { ...input, surface: "v1" });
    } catch (err) {
      return chatError(c, err);
    }
    return c.json({
      ok: true,
      message: {
        id: sent.id,
        content: sent.content,
        timestamp: sent.createdAt,
        attachments: sent.attachments.map((a) => ({
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
    // Surface the real error to logs; the client gets a stable JSON 500.
    console.error("[chat] POST handler threw:", err);
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
  // Reset the web-chat session (like Signal /new).
  const sessionKey = sessionKeyFromQuery(c.req.query("sessionKey"));
  const { farewellSent } = await resetChatSession(sessionKey);
  return c.json({ ok: true, farewellSent });
});

api.get("/chat/messages", (c) => {
  return c.json(legacyMessagesResponse(sessionKeyFromQuery(c.req.query("sessionKey"))));
});

api.get("/chat/stream", (c) => {
  const sessionKey = sessionKeyFromQuery(c.req.query("sessionKey"));
  // Per-request opt-out of incremental text chunks (`?stream=false`).
  const streamParam = c.req.query("stream");
  const wantsStreamChunks = streamParam !== "false" && streamParam !== "0";
  return legacyChatStream(sessionKey, { wantsStreamChunks }, c.req.raw);
});

// ============ CHAT SESSION MANAGEMENT ============

api.get("/chat/sessions", (c) => {
  const includeArchived = c.req.query("includeArchived") === "true";
  const sessions = listChatSessions({ archived: includeArchived ? "all" : "exclude" })
    .map((s) => ({
      session_key: s.key,
      title: s.title,
      created_at: s.createdAt,
      updated_at: s.updatedAt,
      archived_at: s.archivedAt,
      message_count: s.messageCount,
      last_message_at: s.messageCount > 0 ? s.lastActivityAt : null,
    }))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  return c.json({ sessions });
});

api.post("/chat/sessions", async (c) => {
  let title: string | null = null;
  try {
    const body = await c.req.json();
    title = typeof body?.title === "string" ? body.title : null;
  } catch {
    // Accept empty body
  }
  const s = createChatSession(title, { titleMax: Infinity });
  return c.json({ session_key: s.key, title: s.title, created_at: s.createdAt, updated_at: s.updatedAt }, 201);
});

api.patch("/chat/sessions/:key", async (c) => {
  const key = c.req.param("key");
  if (!getChatSessionDetail(key)) return c.json({ error: "not found" }, 404);

  let body: any = {};
  try { body = await c.req.json(); } catch {}
  const update: { title?: string | null; archived?: boolean } = {};
  if (body && typeof body === "object" && "title" in body) update.title = typeof body.title === "string" ? body.title : null;
  if (body && typeof body === "object" && typeof body.archived === "boolean") update.archived = body.archived;

  const s = updateChatSession(key, update, { allowDefaultArchive: true, titleMax: Infinity });
  return c.json({ session_key: s.key, title: s.title, created_at: s.createdAt, updated_at: s.updatedAt, archived_at: s.archivedAt });
});

api.delete("/chat/sessions/:key", (c) => {
  const key = c.req.param("key");
  if (key === "_default") {
    return c.json({ error: "Cannot delete the default session; use DELETE /chat/messages to reset it" }, 400);
  }
  if (!getChatSessionDetail(key)) return c.json({ error: "not found" }, 404);
  purgeChatSession(key);
  return c.json({ ok: true });
});

// Mount API under /api/v1
app.route("/api/v1", api);

// Server start lives in server.ts; this module only exports the legacy app.
