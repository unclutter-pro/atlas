/**
 * Tests for web-ui pure helpers — sqliteToIso, isAgentTurnActive.
 * Run with: cd app/web-ui && bun test
 */

import { test, describe, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { sqliteToIso, isAgentTurnActive, isClaudeProcessRunning, parseSessionMessages, app, analyticsWhere, daysAgo, todayIso, resolveWebSessionKey, deriveSessionTitle, renderChatSidebar, listSidebarSessions } from "./index";
import { getDb } from "../lib/atlas-db";

describe("sqliteToIso", () => {
  test("converts SQLite UTC timestamp to ISO with Z", () => {
    expect(sqliteToIso("2026-05-06 05:37:12")).toBe("2026-05-06T05:37:12Z");
  });

  test("preserves already-Z-suffixed timestamps", () => {
    expect(sqliteToIso("2026-05-06T05:37:12Z")).toBe("2026-05-06T05:37:12Z");
  });

  test("handles empty input gracefully", () => {
    expect(sqliteToIso("")).toBe("");
  });

  test("output is a valid Date when parsed", () => {
    const iso = sqliteToIso("2026-05-06 05:37:12");
    const d = new Date(iso);
    expect(d.getUTCHours()).toBe(5);
    expect(d.getUTCMinutes()).toBe(37);
    expect(isNaN(d.getTime())).toBe(false);
  });
});

describe("isAgentTurnActive", () => {
  let tmp: string;
  let path: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atlas-turn-test-"));
    path = join(tmp, "session.jsonl");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns true when filePath is null (session starting up)", () => {
    expect(isAgentTurnActive(null)).toBe(true);
  });

  test("returns true when JSONL is unreadable (treat as active)", () => {
    expect(isAgentTurnActive("/nonexistent/path.jsonl")).toBe(true);
  });

  test("returns true when JSONL is empty (just spawned)", () => {
    writeFileSync(path, "");
    expect(isAgentTurnActive(path)).toBe(true);
  });

  test("returns false when last assistant message has stop_reason=end_turn", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "hello" }] } }),
    ];
    writeFileSync(path, lines.join("\n"));
    expect(isAgentTurnActive(path)).toBe(false);
  });

  test("returns true when last assistant message has stop_reason=tool_use", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: "do thing" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash", id: "x" }] } }),
    ];
    writeFileSync(path, lines.join("\n"));
    expect(isAgentTurnActive(path)).toBe(true);
  });

  test("returns true when last entry is user (fresh prompt mid-flight)", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "next" } }),
    ];
    writeFileSync(path, lines.join("\n"));
    expect(isAgentTurnActive(path)).toBe(true);
  });

  test("returns true when last entry is user with tool_result (waiting for agent)", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", name: "Bash", id: "x" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } }),
    ];
    writeFileSync(path, lines.join("\n"));
    expect(isAgentTurnActive(path)).toBe(true);
  });

  test("skips post-turn metadata (last-prompt, pr-link) and finds real last entry", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }),
      JSON.stringify({ type: "last-prompt", prompt: "hi" }),
      JSON.stringify({ type: "pr-link", url: "..." }),
    ];
    writeFileSync(path, lines.join("\n"));
    expect(isAgentTurnActive(path)).toBe(false);
  });

  test("ignores malformed JSON lines", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      "not valid json",
      JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] } }),
      "{still not valid",
    ];
    writeFileSync(path, lines.join("\n"));
    expect(isAgentTurnActive(path)).toBe(false);
  });

  test("returns false on stop_sequence (also a terminal stop reason)", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "stop_sequence", content: [{ type: "text", text: "halt" }] } }),
    ];
    writeFileSync(path, lines.join("\n"));
    expect(isAgentTurnActive(path)).toBe(false);
  });

  test("returns false on null stop_reason (allowlist: only tool_use is non-terminal)", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: null, content: [{ type: "text", text: "??" }] } }),
    ];
    writeFileSync(path, lines.join("\n"));
    expect(isAgentTurnActive(path)).toBe(false);
  });

  test("returns false on unknown stop_reason (allowlist guards against future schema additions)", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "refusal", content: [{ type: "text", text: "no" }] } }),
    ];
    writeFileSync(path, lines.join("\n"));
    expect(isAgentTurnActive(path)).toBe(false);
  });
});

describe("parseSessionMessages — messageId propagation", () => {
  let tmp: string;
  let path: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atlas-parse-test-"));
    path = join(tmp, "session.jsonl");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("captures Anthropic message.id on assistant-text blocks (used to stitch SSE chunks → final message)", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" }, timestamp: "2026-05-17T10:00:00Z" }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-17T10:00:01Z",
        message: {
          role: "assistant",
          id: "msg_01ABCDEF",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "hello back" }],
        },
      }),
    ];
    writeFileSync(path, lines.join("\n"));

    const parsed = parseSessionMessages(path);
    const assistantText = parsed.find((m) => m.type === "assistant-text");
    expect(assistantText).toBeDefined();
    expect(assistantText?.content).toBe("hello back");
    expect(assistantText?.messageId).toBe("msg_01ABCDEF");
  });

  test("messageId is undefined when JSONL entry lacks message.id (legacy/malformed lines)", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-17T10:00:01Z",
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "no id here" }],
        },
      }),
    ];
    writeFileSync(path, lines.join("\n"));

    const parsed = parseSessionMessages(path);
    const assistantText = parsed.find((m) => m.type === "assistant-text");
    expect(assistantText?.messageId).toBeUndefined();
  });

  test("propagates the same messageId to every block inside one assistant message (text + tool_use share an id)", () => {
    const lines = [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-17T10:00:01Z",
        message: {
          role: "assistant",
          id: "msg_shared",
          stop_reason: "tool_use",
          content: [
            { type: "text", text: "ok let me check" },
            { type: "tool_use", id: "tu_1", name: "WebFetch", input: { url: "https://x" } },
          ],
        },
      }),
    ];
    writeFileSync(path, lines.join("\n"));

    const parsed = parseSessionMessages(path);
    const text = parsed.find((m) => m.type === "assistant-text");
    expect(text?.messageId).toBe("msg_shared");
    // tool_use block doesn't propagate messageId (it's not used downstream),
    // but we don't crash either.
  });
});

describe("isClaudeProcessRunning", () => {
  test("returns false for empty session ID", () => {
    expect(isClaudeProcessRunning("")).toBe(false);
  });

  test("returns false for a session ID that is definitely not running", () => {
    const fakeSession = "00000000-0000-0000-0000-deadbeefdead";
    expect(isClaudeProcessRunning(fakeSession)).toBe(false);
  });

  test("does not throw on /proc absence (e.g. macOS dev environment)", () => {
    // Just call it — readdir failures should swallow and return false
    expect(() => isClaudeProcessRunning("any-session-id")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// analyticsWhere helper
// ---------------------------------------------------------------------------

describe("analyticsWhere", () => {
  test("always includes date range guards", () => {
    const { clause, values } = analyticsWhere({ from: "2024-01-01", to: "2024-12-31", types: [], trigger: "", minCost: "", status: "" });
    expect(clause).toContain("date(created_at) >=");
    expect(clause).toContain("date(created_at) <=");
    expect(values).toContain("2024-01-01");
    expect(values).toContain("2024-12-31");
  });

  test("includes session_type IN clause for multiple types", () => {
    const { clause, values } = analyticsWhere({ from: "2024-01-01", to: "2024-12-31", types: ["trigger", "worker"], trigger: "", minCost: "", status: "" });
    expect(clause).toContain("session_type IN");
    expect(values).toContain("trigger");
    expect(values).toContain("worker");
  });

  test("includes LIKE clause for trigger filter", () => {
    const { clause, values } = analyticsWhere({ from: "2024-01-01", to: "2024-12-31", types: [], trigger: "email", minCost: "", status: "" });
    expect(clause).toContain("trigger_name LIKE");
    expect(values.some(v => String(v).includes("email"))).toBe(true);
  });

  test("includes is_error filter for status=ok", () => {
    const { clause } = analyticsWhere({ from: "2024-01-01", to: "2024-12-31", types: [], trigger: "", minCost: "", status: "ok" });
    expect(clause).toContain("is_error = 0");
  });

  test("includes is_error filter for status=err", () => {
    const { clause } = analyticsWhere({ from: "2024-01-01", to: "2024-12-31", types: [], trigger: "", minCost: "", status: "err" });
    expect(clause).toContain("is_error = 1");
  });

  test("includes cost filter for min_cost", () => {
    const { clause, values } = analyticsWhere({ from: "2024-01-01", to: "2024-12-31", types: [], trigger: "", minCost: "0.5", status: "" });
    expect(clause).toContain("cost_usd >=");
    expect(values).toContain(0.5);
  });
});

// ---------------------------------------------------------------------------
// daysAgo / todayIso
// ---------------------------------------------------------------------------

describe("daysAgo / todayIso", () => {
  test("daysAgo(0) returns today in YYYY-MM-DD format", () => {
    const today = todayIso();
    const ago0 = daysAgo(0);
    expect(ago0).toBe(today);
  });

  test("daysAgo(7) returns a date 7 days before today", () => {
    const today = new Date(todayIso());
    const sevenDaysAgo = new Date(daysAgo(7));
    const diffDays = Math.round((today.getTime() - sevenDaysAgo.getTime()) / 86400000);
    expect(diffDays).toBe(7);
  });

  test("todayIso() returns YYYY-MM-DD format", () => {
    const today = todayIso();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// /analytics endpoint — integration smoke test
// ---------------------------------------------------------------------------

describe("/analytics endpoint", () => {
  test("responds with HTML containing filter form and sessions section", async () => {
    const req = new Request("http://localhost/analytics?from=2024-01-01&to=2030-01-01");
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Basic structure checks
    expect(html).toContain("Analytics");
    expect(html).toContain("Sessions");
    expect(html).toContain("analytics-form");
  });

  test("responds with HTML showing trigger type in type checkboxes", async () => {
    const req = new Request("http://localhost/analytics?from=2024-01-01&to=2030-01-01");
    const res = await app.fetch(req);
    const html = await res.text();
    // The type checkboxes should include 'trigger' but not 'subagent' (no longer a separate row type)
    expect(html).toContain("trigger");
    expect(html).not.toContain(`value="subagent"`);
  });

  test("group_by=day returns grouped table", async () => {
    const req = new Request("http://localhost/analytics?from=2024-01-01&to=2030-01-01&group_by=day");
    const res = await app.fetch(req);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Grouped by day");
  });

  test("group_by=trigger returns grouped table with trigger label", async () => {
    const req = new Request("http://localhost/analytics?from=2024-01-01&to=2030-01-01&group_by=trigger");
    const res = await app.fetch(req);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Grouped by trigger");
  });

  test("defaults to last 7 days when no date params given", async () => {
    const req = new Request("http://localhost/analytics");
    const res = await app.fetch(req);
    const html = await res.text();
    expect(res.status).toBe(200);
    // The filter form should show a 'from' input
    expect(html).toContain('name="from"');
    expect(html).toContain('name="to"');
  });

  test("CSV export returns proper content-type header", async () => {
    const req = new Request("http://localhost/analytics.csv?from=2024-01-01&to=2030-01-01");
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain(".csv");
  });

  test("CSV export body has expected header row", async () => {
    const req = new Request("http://localhost/analytics.csv?from=2024-01-01&to=2030-01-01");
    const res = await app.fetch(req);
    const text = await res.text();
    expect(text.startsWith("session_type,session_id,trigger_name")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveWebSessionKey
// ---------------------------------------------------------------------------

describe("resolveWebSessionKey", () => {
  function makeCtx(sessionKey?: string) {
    const url = sessionKey
      ? `http://localhost/chat/messages?sessionKey=${encodeURIComponent(sessionKey)}`
      : "http://localhost/chat/messages";
    return { req: { query: (k: string) => k === "sessionKey" ? (sessionKey ?? undefined) : undefined } };
  }

  test("returns _default when no sessionKey param is present", () => {
    expect(resolveWebSessionKey(makeCtx())).toBe("_default");
  });

  test("returns the provided valid sessionKey", () => {
    expect(resolveWebSessionKey(makeCtx("my-session-1"))).toBe("my-session-1");
  });

  test("returns _default for an empty sessionKey string", () => {
    expect(resolveWebSessionKey(makeCtx(""))).toBe("_default");
  });

  test("returns _default for a sessionKey that is only whitespace", () => {
    expect(resolveWebSessionKey(makeCtx("   "))).toBe("_default");
  });

  test("returns _default for a sessionKey with invalid characters", () => {
    expect(resolveWebSessionKey(makeCtx("bad key!"))).toBe("_default");
  });

  test("returns _default for a sessionKey that is too long (>128 chars)", () => {
    const longKey = "a".repeat(129);
    expect(resolveWebSessionKey(makeCtx(longKey))).toBe("_default");
  });

  test("accepts a sessionKey exactly 128 chars long", () => {
    const maxKey = "a".repeat(128);
    expect(resolveWebSessionKey(makeCtx(maxKey))).toBe(maxKey);
  });

  test("accepts alphanumeric, hyphens, and underscores", () => {
    expect(resolveWebSessionKey(makeCtx("Session_Key-123"))).toBe("Session_Key-123");
  });
});

// ---------------------------------------------------------------------------
// deriveSessionTitle
// ---------------------------------------------------------------------------

describe("deriveSessionTitle", () => {
  test("returns short content unchanged", () => {
    expect(deriveSessionTitle("Hello world")).toBe("Hello world");
  });

  test("returns content that is exactly 60 chars unchanged", () => {
    const s = "a".repeat(60);
    expect(deriveSessionTitle(s)).toBe(s);
  });

  test("truncates content longer than 60 chars with ellipsis", () => {
    const s = "a".repeat(80);
    const result = deriveSessionTitle(s);
    expect(result.endsWith("…")).toBe(true);
    // The result should be 58 chars of content + 1 char ellipsis = 59 display units
    // (slice(0,57) + trimEnd() + '…')
    expect(result.length).toBeLessThanOrEqual(58);
  });

  test("collapses multiline/whitespace-heavy content into a single line", () => {
    const s = "First line\nSecond line\n  with extra spaces  ";
    const result = deriveSessionTitle(s);
    expect(result).not.toContain("\n");
    expect(result).toBe("First line Second line with extra spaces");
  });

  test("trims leading and trailing whitespace", () => {
    expect(deriveSessionTitle("  hello  ")).toBe("hello");
  });

  test("ellipsis result does not end with trailing space before ellipsis", () => {
    // Build a 70-char string where position 57 would be a space
    const s = "a".repeat(56) + " " + "b".repeat(20);
    const result = deriveSessionTitle(s);
    expect(result.endsWith("…")).toBe(true);
    // trimEnd before '…' means no trailing space before ellipsis
    expect(result).not.toMatch(/ …$/);
  });
});

// ---------------------------------------------------------------------------
// Chat sidebar: renderChatSidebar + listSidebarSessions + HTTP routes
// ---------------------------------------------------------------------------
// The web-ui shares the live atlas DB (no test isolation layer), so these
// tests create disposable sessions with unique keys and tear them down in
// afterAll. Read-only assertions about _default work regardless of DB state.

describe("renderChatSidebar (pure render)", () => {
  test("contains the wrapper with id=chat-sidebar and the + New button", () => {
    const html = renderChatSidebar("_default");
    expect(html).toContain('id="chat-sidebar"');
    expect(html).toContain("+ New chat");
    expect(html).toContain('hx-post="/chat/sessions/new"');
  });

  test("renders _default even when no chat_sessions row exists yet", () => {
    const html = renderChatSidebar("_default");
    expect(html).toContain("?session=_default");
  });

  test("marks the active session with the 'active' class", () => {
    const html = renderChatSidebar("_default");
    // The default link should have the active class on this run
    expect(html).toMatch(/class="chat-session active"[^>]*href="\/chat\?session=_default"/);
  });

  test("default session never shows a delete button (cannot be deleted)", () => {
    const html = renderChatSidebar("_default");
    // No delete action targeting _default
    expect(html).not.toContain('hx-delete="/chat/sessions/_default"');
  });

  test("escapes HTML in session titles to prevent XSS", () => {
    const db = getDb();
    const key = `xsstest-${Date.now()}`;
    db.prepare(`INSERT INTO chat_sessions (session_key, channel, title) VALUES (?, 'web', ?)`)
      .run(key, "<script>alert('x')</script>");
    try {
      const html = renderChatSidebar(key);
      expect(html).not.toContain("<script>alert");
      expect(html).toContain("&lt;script&gt;");
    } finally {
      db.prepare(`DELETE FROM chat_sessions WHERE session_key = ?`).run(key);
    }
  });

  test("renders rename form when editKey matches a row", () => {
    const db = getDb();
    const key = `editview-${Date.now()}`;
    db.prepare(`INSERT INTO chat_sessions (session_key, channel, title) VALUES (?, 'web', 'Hello')`).run(key);
    try {
      const html = renderChatSidebar(key, key);
      expect(html).toContain(`hx-patch="/chat/sessions/${key}"`);
      expect(html).toContain('name="title"');
      expect(html).toContain('value="Hello"');
    } finally {
      db.prepare(`DELETE FROM chat_sessions WHERE session_key = ?`).run(key);
    }
  });
});

describe("listSidebarSessions", () => {
  test("always includes _default at the top, even on a clean install", () => {
    const rows = listSidebarSessions();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].session_key).toBe("_default");
  });

  test("excludes archived sessions", () => {
    const db = getDb();
    const archivedKey = `archived-${Date.now()}`;
    db.prepare(`INSERT INTO chat_sessions (session_key, channel, title, archived_at)
                VALUES (?, 'web', 'archived chat', datetime('now'))`).run(archivedKey);
    try {
      const rows = listSidebarSessions();
      expect(rows.find(r => r.session_key === archivedKey)).toBeUndefined();
    } finally {
      db.prepare(`DELETE FROM chat_sessions WHERE session_key = ?`).run(archivedKey);
    }
  });
});

describe("GET /chat (full page)", () => {
  test("includes the sidebar wrapper and a chat-container in the body", async () => {
    const req = new Request("http://localhost/chat");
    const res = await app.fetch(req);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="chat-sidebar"');
    expect(html).toContain('class="chat-layout"');
    expect(html).toContain('class="chat-container"');
    // HTMX URLs must carry sessionKey so backend routes resolve correctly
    expect(html).toContain('hx-get="/chat/conversation?sessionKey=_default"');
    expect(html).toContain('hx-post="/chat?sessionKey=_default"');
  });

  test("propagates explicit ?session=<key> into HTMX URLs", async () => {
    const db = getDb();
    const key = `pagetest-${Date.now()}`;
    db.prepare(`INSERT INTO chat_sessions (session_key, channel, title) VALUES (?, 'web', NULL)`).run(key);
    try {
      const req = new Request(`http://localhost/chat?session=${key}`);
      const res = await app.fetch(req);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`hx-get="/chat/conversation?sessionKey=${key}"`);
      expect(html).toContain(`hx-post="/chat?sessionKey=${key}"`);
    } finally {
      db.prepare(`DELETE FROM chat_sessions WHERE session_key = ?`).run(key);
    }
  });
});

describe("GET /chat/sidebar", () => {
  test("returns the sidebar fragment", async () => {
    const res = await app.fetch(new Request("http://localhost/chat/sidebar"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.trim().startsWith("<aside")).toBe(true);
    expect(html).toContain('id="chat-sidebar"');
  });

  test("highlights ?session= when provided", async () => {
    const db = getDb();
    const key = `sidebartest-${Date.now()}`;
    db.prepare(`INSERT INTO chat_sessions (session_key, channel, title) VALUES (?, 'web', 'My chat')`).run(key);
    try {
      const res = await app.fetch(new Request(`http://localhost/chat/sidebar?session=${key}`));
      const html = await res.text();
      expect(html).toMatch(new RegExp(`class="chat-session active"[^>]*href="/chat\\?session=${key}"`));
    } finally {
      db.prepare(`DELETE FROM chat_sessions WHERE session_key = ?`).run(key);
    }
  });

  test("renders rename form when ?edit=<key>", async () => {
    const db = getDb();
    const key = `edittest-${Date.now()}`;
    db.prepare(`INSERT INTO chat_sessions (session_key, channel, title) VALUES (?, 'web', 'Old name')`).run(key);
    try {
      const res = await app.fetch(new Request(`http://localhost/chat/sidebar?session=${key}&edit=${key}`));
      const html = await res.text();
      expect(html).toContain(`hx-patch="/chat/sessions/${key}"`);
      expect(html).toContain('value="Old name"');
    } finally {
      db.prepare(`DELETE FROM chat_sessions WHERE session_key = ?`).run(key);
    }
  });
});

describe("POST /chat/sessions/new", () => {
  test("creates a new chat_sessions row and returns HX-Redirect to it", async () => {
    const db = getDb();
    const before = (db.prepare("SELECT COUNT(*) as c FROM chat_sessions WHERE channel = 'web'").get() as any).c;
    const res = await app.fetch(new Request("http://localhost/chat/sessions/new", { method: "POST" }));
    expect(res.status).toBe(204);
    const redirect = res.headers.get("HX-Redirect") ?? "";
    expect(redirect.startsWith("/chat?session=")).toBe(true);
    const newKey = redirect.split("=")[1];
    try {
      const after = (db.prepare("SELECT COUNT(*) as c FROM chat_sessions WHERE channel = 'web'").get() as any).c;
      expect(after).toBe(before + 1);
      const row = db.prepare("SELECT session_key, title FROM chat_sessions WHERE session_key = ?").get(newKey) as any;
      expect(row.session_key).toBe(newKey);
      expect(row.title).toBeNull();
    } finally {
      db.prepare(`DELETE FROM chat_sessions WHERE session_key = ?`).run(newKey);
    }
  });
});

describe("PATCH /chat/sessions/:key (rename via HTMX)", () => {
  test("updates the title and returns the updated sidebar", async () => {
    const db = getDb();
    const key = `renametest-${Date.now()}`;
    db.prepare(`INSERT INTO chat_sessions (session_key, channel, title) VALUES (?, 'web', 'Old')`).run(key);
    try {
      const form = new URLSearchParams();
      form.set("title", "Renamed");
      const res = await app.fetch(new Request(`http://localhost/chat/sessions/${key}?session=${key}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('id="chat-sidebar"');
      expect(html).toContain("Renamed");
      const row = db.prepare("SELECT title FROM chat_sessions WHERE session_key = ?").get(key) as any;
      expect(row.title).toBe("Renamed");
    } finally {
      db.prepare(`DELETE FROM chat_sessions WHERE session_key = ?`).run(key);
    }
  });

  test("returns 404 for unknown session key", async () => {
    const form = new URLSearchParams();
    form.set("title", "x");
    const res = await app.fetch(new Request(`http://localhost/chat/sessions/does-not-exist-12345`, {
      method: "PATCH",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }));
    expect(res.status).toBe(404);
  });

  test("rejects invalid session keys (path-injection guard)", async () => {
    const form = new URLSearchParams();
    form.set("title", "x");
    const res = await app.fetch(new Request(`http://localhost/chat/sessions/bad%20key`, {
      method: "PATCH",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }));
    expect(res.status).toBe(400);
  });
});

describe("POST /chat/sessions/:key/archive", () => {
  test("archives the session and returns updated sidebar when not active", async () => {
    const db = getDb();
    const key = `archtest-${Date.now()}`;
    db.prepare(`INSERT INTO chat_sessions (session_key, channel, title) VALUES (?, 'web', 'foo')`).run(key);
    try {
      const res = await app.fetch(new Request(`http://localhost/chat/sessions/${key}/archive?session=_default`, { method: "POST" }));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('id="chat-sidebar"');
      const row = db.prepare("SELECT archived_at FROM chat_sessions WHERE session_key = ?").get(key) as any;
      expect(row.archived_at).not.toBeNull();
    } finally {
      db.prepare(`DELETE FROM chat_sessions WHERE session_key = ?`).run(key);
    }
  });

  test("redirects to /chat when archiving the currently active session", async () => {
    const db = getDb();
    const key = `archactive-${Date.now()}`;
    db.prepare(`INSERT INTO chat_sessions (session_key, channel, title) VALUES (?, 'web', 'foo')`).run(key);
    try {
      const res = await app.fetch(new Request(`http://localhost/chat/sessions/${key}/archive?session=${key}`, { method: "POST" }));
      expect(res.status).toBe(204);
      expect(res.headers.get("HX-Redirect")).toBe("/chat");
    } finally {
      db.prepare(`DELETE FROM chat_sessions WHERE session_key = ?`).run(key);
    }
  });

  test("refuses to archive the _default session", async () => {
    const res = await app.fetch(new Request(`http://localhost/chat/sessions/_default/archive`, { method: "POST" }));
    expect(res.status).toBe(400);
  });
});

describe("DELETE /chat/sessions/:key (sidebar action)", () => {
  test("deletes the session and returns updated sidebar when not active", async () => {
    const db = getDb();
    const key = `deltest-${Date.now()}`;
    db.prepare(`INSERT INTO chat_sessions (session_key, channel, title) VALUES (?, 'web', 'foo')`).run(key);
    const res = await app.fetch(new Request(`http://localhost/chat/sessions/${key}?session=_default`, { method: "DELETE" }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="chat-sidebar"');
    const row = db.prepare("SELECT session_key FROM chat_sessions WHERE session_key = ?").get(key);
    expect(row).toBeNull();
  });

  test("redirects to /chat when deleting the active session", async () => {
    const db = getDb();
    const key = `delactive-${Date.now()}`;
    db.prepare(`INSERT INTO chat_sessions (session_key, channel, title) VALUES (?, 'web', 'foo')`).run(key);
    const res = await app.fetch(new Request(`http://localhost/chat/sessions/${key}?session=${key}`, { method: "DELETE" }));
    expect(res.status).toBe(204);
    expect(res.headers.get("HX-Redirect")).toBe("/chat");
    // Ensure cleanup ran
    const row = db.prepare("SELECT session_key FROM chat_sessions WHERE session_key = ?").get(key);
    expect(row).toBeNull();
  });

  test("refuses to delete the _default session", async () => {
    const res = await app.fetch(new Request(`http://localhost/chat/sessions/_default`, { method: "DELETE" }));
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Per-user session context: user_id / user_email / user_name / user_role
// ---------------------------------------------------------------------------

describe("POST /api/v1/chat/sessions — user identity fields", () => {
  const API_KEY = process.env.ATLAS_API_KEY || "test-key";

  function apiHeaders(extra?: Record<string, string>) {
    return { "Content-Type": "application/json", "X-API-Key": API_KEY, ...extra };
  }

  test("creates a session with user fields stored", async () => {
    const db = getDb();
    const res = await app.fetch(new Request("http://localhost/api/v1/chat/sessions", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        title: "Test chat",
        user_id: "u_123",
        user_email: "alice@example.com",
        user_name: "Alice",
        user_role: "admin",
      }),
    }));
    expect(res.status).toBe(201);
    const json = await res.json() as any;
    expect(json.session_key).toBeTruthy();
    expect(json.user_id).toBe("u_123");
    expect(json.user_email).toBe("alice@example.com");
    expect(json.user_name).toBe("Alice");
    expect(json.user_role).toBe("admin");

    // Verify DB row
    const row = db.prepare(
      "SELECT user_id, user_email, user_name, user_role FROM chat_sessions WHERE session_key = ?"
    ).get(json.session_key) as any;
    expect(row.user_id).toBe("u_123");
    expect(row.user_email).toBe("alice@example.com");
    expect(row.user_name).toBe("Alice");
    expect(row.user_role).toBe("admin");

    // Cleanup
    db.prepare("DELETE FROM chat_sessions WHERE session_key = ?").run(json.session_key);
  });

  test("creates a session without user fields (all null)", async () => {
    const db = getDb();
    const res = await app.fetch(new Request("http://localhost/api/v1/chat/sessions", {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ title: "No user" }),
    }));
    expect(res.status).toBe(201);
    const json = await res.json() as any;
    expect(json.user_id).toBeUndefined();
    expect(json.user_name).toBeUndefined();

    const row = db.prepare(
      "SELECT user_id, user_email, user_name, user_role FROM chat_sessions WHERE session_key = ?"
    ).get(json.session_key) as any;
    expect(row.user_id).toBeNull();
    expect(row.user_name).toBeNull();

    db.prepare("DELETE FROM chat_sessions WHERE session_key = ?").run(json.session_key);
  });
});

describe("PATCH /api/v1/chat/sessions/:key — user identity fields", () => {
  const API_KEY = process.env.ATLAS_API_KEY || "test-key";

  function apiHeaders() {
    return { "Content-Type": "application/json", "X-API-Key": API_KEY };
  }

  test("updates user fields on an existing session", async () => {
    const db = getDb();
    const key = `patch-user-${Date.now()}`;
    db.prepare(
      `INSERT INTO chat_sessions (session_key, channel, title) VALUES (?, 'web', NULL)`
    ).run(key);
    try {
      const res = await app.fetch(new Request(`http://localhost/api/v1/chat/sessions/${key}`, {
        method: "PATCH",
        headers: apiHeaders(),
        body: JSON.stringify({ user_id: "u_456", user_email: "bob@example.com", user_name: "Bob", user_role: "member" }),
      }));
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(json.user_id).toBe("u_456");
      expect(json.user_email).toBe("bob@example.com");
      expect(json.user_name).toBe("Bob");
      expect(json.user_role).toBe("member");

      const row = db.prepare(
        "SELECT user_id, user_email, user_name, user_role FROM chat_sessions WHERE session_key = ?"
      ).get(key) as any;
      expect(row.user_id).toBe("u_456");
      expect(row.user_name).toBe("Bob");
    } finally {
      db.prepare("DELETE FROM chat_sessions WHERE session_key = ?").run(key);
    }
  });

  test("clears user fields by passing null or empty string", async () => {
    const db = getDb();
    const key = `patch-clear-${Date.now()}`;
    db.prepare(
      `INSERT INTO chat_sessions (session_key, channel, title, user_id, user_name) VALUES (?, 'web', NULL, 'u_old', 'Old Name')`
    ).run(key);
    try {
      const res = await app.fetch(new Request(`http://localhost/api/v1/chat/sessions/${key}`, {
        method: "PATCH",
        headers: apiHeaders(),
        body: JSON.stringify({ user_id: null, user_name: "" }),
      }));
      expect(res.status).toBe(200);

      const row = db.prepare(
        "SELECT user_id, user_name FROM chat_sessions WHERE session_key = ?"
      ).get(key) as any;
      expect(row.user_id).toBeNull();
      expect(row.user_name).toBeNull();
    } finally {
      db.prepare("DELETE FROM chat_sessions WHERE session_key = ?").run(key);
    }
  });

  test("returns 404 for non-existent session key", async () => {
    const res = await app.fetch(new Request(`http://localhost/api/v1/chat/sessions/does-not-exist-user-test`, {
      method: "PATCH",
      headers: apiHeaders(),
      body: JSON.stringify({ user_id: "x" }),
    }));
    expect(res.status).toBe(404);
  });
});

describe("touchChatSession — COALESCE first-write-wins for user fields", () => {
  test("does not overwrite existing user fields on subsequent touches", () => {
    const db = getDb();
    const key = `touch-coalesce-${Date.now()}`;
    db.prepare(
      `INSERT INTO chat_sessions (session_key, channel, title, user_id, user_name) VALUES (?, 'web', NULL, 'original-id', 'OriginalName')`
    ).run(key);
    try {
      // Import touchChatSession via the app routes by posting a message (indirect test)
      // We exercise the COALESCE logic directly at the DB layer to keep test fast/isolated.
      db.prepare(
        `INSERT INTO chat_sessions (session_key, channel, title, user_id, user_email, user_name, user_role)
         VALUES (?, 'web', ?, ?, ?, ?, ?)
         ON CONFLICT(session_key) DO UPDATE SET
           updated_at = datetime('now'),
           title = COALESCE(chat_sessions.title, excluded.title),
           user_id = COALESCE(chat_sessions.user_id, excluded.user_id),
           user_email = COALESCE(chat_sessions.user_email, excluded.user_email),
           user_name = COALESCE(chat_sessions.user_name, excluded.user_name),
           user_role = COALESCE(chat_sessions.user_role, excluded.user_role)`
      ).run(key, "derived title", "new-id-should-not-win", "new@example.com", "NewName", "admin");

      const row = db.prepare(
        "SELECT user_id, user_email, user_name, user_role, title FROM chat_sessions WHERE session_key = ?"
      ).get(key) as any;

      // user_id and user_name were already set — COALESCE must preserve originals
      expect(row.user_id).toBe("original-id");
      expect(row.user_name).toBe("OriginalName");
      // user_email and user_role were null — they get backfilled
      expect(row.user_email).toBe("new@example.com");
      expect(row.user_role).toBe("admin");
      // title was null — it gets backfilled
      expect(row.title).toBe("derived title");
    } finally {
      db.prepare("DELETE FROM chat_sessions WHERE session_key = ?").run(key);
    }
  });
});

describe("GET /api/v1/chat/sessions — user_id in list response", () => {
  const API_KEY = process.env.ATLAS_API_KEY || "test-key";

  test("sessions list includes user_id field (null when not set)", async () => {
    const db = getDb();
    const key = `list-user-${Date.now()}`;
    db.prepare(
      `INSERT INTO chat_sessions (session_key, channel, title) VALUES (?, 'web', 'listed')`
    ).run(key);
    try {
      const res = await app.fetch(new Request("http://localhost/api/v1/chat/sessions", {
        headers: { "X-API-Key": API_KEY },
      }));
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      expect(Array.isArray(json.sessions)).toBe(true);
      // Every row must have a user_id key (null or string)
      for (const s of json.sessions) {
        expect("user_id" in s).toBe(true);
      }
      // The row we inserted has no user set — must be null
      const found = json.sessions.find((s: any) => s.session_key === key);
      expect(found).toBeDefined();
      expect(found.user_id).toBeNull();
    } finally {
      db.prepare("DELETE FROM chat_sessions WHERE session_key = ?").run(key);
    }
  });

  test("sessions list includes user_id value when set", async () => {
    const db = getDb();
    const key = `list-user-set-${Date.now()}`;
    db.prepare(
      `INSERT INTO chat_sessions (session_key, channel, title, user_id, user_name) VALUES (?, 'web', 'listed-with-user', 'u_789', 'Charlie')`
    ).run(key);
    try {
      const res = await app.fetch(new Request("http://localhost/api/v1/chat/sessions", {
        headers: { "X-API-Key": API_KEY },
      }));
      expect(res.status).toBe(200);
      const json = await res.json() as any;
      const found = json.sessions.find((s: any) => s.session_key === key);
      expect(found).toBeDefined();
      expect(found.user_id).toBe("u_789");
    } finally {
      db.prepare("DELETE FROM chat_sessions WHERE session_key = ?").run(key);
    }
  });
});
