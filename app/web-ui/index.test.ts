/**
 * Tests for web-ui pure helpers — sqliteToIso, isAgentTurnActive.
 * Run with: cd app/web-ui && bun test
 */

import { test, describe, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { sqliteToIso, isAgentTurnActive, isClaudeProcessRunning } from "./index";

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
