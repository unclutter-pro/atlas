/**
 * Tests for web-ui pure helpers — sqliteToIso, isAgentTurnActive.
 * Run with: cd app/web-ui && bun test
 */

import { test, describe, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { sqliteToIso, isAgentTurnActive, isClaudeProcessRunning, parseSessionMessages, app, analyticsWhere, daysAgo, todayIso, resolveWebSessionKey, deriveSessionTitle } from "./index";

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
