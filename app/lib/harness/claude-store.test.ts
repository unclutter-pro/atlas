import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ClaudeSessionStore } from "./claude-store.ts";
import { configuredHarnessBackend, createSessionStore } from "./stores.ts";

let home: string;
let project: string;
let store: ClaudeSessionStore;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "atlas-claude-store-"));
  project = join(home, ".claude", "projects", "-home-agent");
  mkdirSync(project, { recursive: true });
  store = new ClaudeSessionStore(home);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const ref = (id: string) => store.ref(id)!;
const line = (obj: Record<string, unknown>) => `${JSON.stringify(obj)}\n`;
const user = (text: string, at: string, extra: Record<string, unknown> = {}) =>
  line({ type: "user", uuid: `u-${at}`, timestamp: at, message: { role: "user", content: text }, ...extra });
const assistant = (content: unknown[], at: string, extra: Record<string, unknown> = {}) =>
  line({ type: "assistant", uuid: `a-${at}`, timestamp: at, message: { id: `msg-${at}`, model: "claude-sonnet-4-5", content, ...extra } });
const toolResult = (callId: string, text: string, at: string, isError = false) =>
  line({ type: "user", uuid: `r-${at}`, timestamp: at, message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: text, is_error: isError }] } });

function write(id: string, ...lines: string[]): string {
  const file = join(project, `${id}.jsonl`);
  writeFileSync(file, lines.join(""));
  return file;
}

describe("refs and lookup", () => {
  test("accepts only IDs that can name a transcript", () => {
    expect(store.ref("abc-123_x")).toEqual({ backend: "claude-code", nativeId: "abc-123_x" });
    expect(store.ref("../etc/passwd")).toBeNull();
    expect(store.ref("")).toBeNull();
    expect(store.ref(null)).toBeNull();
  });

  test("finds a transcript in any project directory", () => {
    mkdirSync(join(home, ".claude", "projects", "-other"), { recursive: true });
    writeFileSync(join(home, ".claude", "projects", "-other", "s1.jsonl"), user("hi", "2026-01-01T10:00:00Z"));
    expect(store.exists(ref("s1"))).toBe(true);
    expect(store.exists(ref("s2"))).toBe(false);
    expect(store.exists({ backend: "other", nativeId: "s1" })).toBe(false);
  });

  test("locate maps workspace paths under session storage back to the session", () => {
    expect(store.locate(".claude/projects/-home-agent/s1.jsonl")).toEqual(ref("s1"));
    expect(store.locate("memory/MEMORY.md")).toBeNull();
  });
});

describe("history entries", () => {
  test("normalizes text, reasoning, tool calls and results", async () => {
    write("s1",
      user("Hello", "2026-01-01T10:00:00Z"),
      assistant([
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "Running it" },
        { type: "tool_use", id: "call-1", name: "Bash", input: { command: "ls" } },
      ], "2026-01-01T10:00:01Z", { stop_reason: "tool_use" }),
      toolResult("call-1", "a.txt", "2026-01-01T10:00:02Z"),
    );
    const read = await store.load(ref("s1"));
    expect(read!.model).toBe("claude-sonnet-4-5");
    expect(read!.entries.map((e) => e.kind)).toEqual(["user-text", "reasoning", "assistant-text", "tool-call", "tool-result"]);
    const text = read!.entries[2]!;
    expect(text).toMatchObject({ kind: "assistant-text", text: "Running it", messageId: "msg-2026-01-01T10:00:01Z", nested: false });
    expect(read!.entries[3]).toMatchObject({ kind: "tool-call", callId: "call-1", name: "Bash", input: { command: "ls" } });
    expect(read!.entries[4]).toMatchObject({ kind: "tool-result", callId: "call-1", content: "a.txt", isError: false });
    // IDs are stable across reads
    const again = await store.load(ref("s1"));
    expect(again!.entries.map((e) => e.id)).toEqual(read!.entries.map((e) => e.id));
  });

  test("marks nested agent lines and skips empty or broken lines", async () => {
    write("s1",
      user("main", "2026-01-01T10:00:00Z"),
      user("side", "2026-01-01T10:00:01Z", { isSidechain: true }),
      "{not json\n",
      user("   ", "2026-01-01T10:00:02Z"),
    );
    const read = await store.load(ref("s1"));
    expect(read!.entries.map((e) => [e.kind, e.nested])).toEqual([["user-text", false], ["user-text", true]]);
  });

  test("load with a window keeps only entries of that run", async () => {
    write("s1",
      user("old run", "2026-01-01T09:00:00Z"),
      user("this run", "2026-01-01T10:00:00Z"),
      assistant([{ type: "text", text: "answer" }], "2026-01-01T10:00:05Z"),
      user("next run", "2026-01-01T11:00:00Z"),
    );
    const read = await store.load(ref("s1"), { window: { from: "2026-01-01T10:00:00Z", to: "2026-01-01T10:00:10Z" } });
    expect(read!.windowed).toBe(true);
    expect(read!.entries.map((e) => ("text" in e ? e.text : ""))).toEqual(["this run", "answer"]);
  });

  test("load reads only the tail of a history above maxBytes", async () => {
    write("s1", user("first", "2026-01-01T10:00:00Z"), user("second", "2026-01-01T10:00:01Z"));
    const read = await store.load(ref("s1"), { maxBytes: 150 });
    expect(read!.truncated).toBe(true);
    expect(read!.entries.map((e) => ("text" in e ? e.text : ""))).toEqual(["second"]);
  });

  test("excerpt reads whole lines from either end", () => {
    write("s1", user("first", "2026-01-01T10:00:00Z"), user("second", "2026-01-01T10:00:01Z"));
    const head = store.excerpt(ref("s1"), { from: "start", maxBytes: 150 })!;
    const tail = store.excerpt(ref("s1"), { from: "end", maxBytes: 150 })!;
    expect(head.entries.map((e) => ("text" in e ? e.text : ""))).toEqual(["first"]);
    expect(tail.entries.map((e) => ("text" in e ? e.text : ""))).toEqual(["second"]);
    expect(store.excerpt(ref("missing"), { from: "end", maxBytes: 10 })).toBeNull();
  });
});

describe("cursor", () => {
  test("returns only new complete lines and buffers a partial one", () => {
    const file = write("s1", user("one", "2026-01-01T10:00:00Z"));
    const cursor = store.cursor(ref("s1"))!;
    expect(cursor.read().entries).toHaveLength(1);
    const next = user("two", "2026-01-01T10:00:01Z");
    appendFileSync(file, next.slice(0, 20));
    expect(cursor.read().entries).toHaveLength(0);
    appendFileSync(file, next.slice(20));
    const read = cursor.read();
    expect(read.entries.map((e) => ("text" in e ? e.text : ""))).toEqual(["two"]);
    expect(read.reset).toBe(false);
  });

  test("reports a rewritten history as reset", () => {
    const file = write("s1", user("one", "2026-01-01T10:00:00Z"), user("two", "2026-01-01T10:00:01Z"));
    const cursor = store.cursor(ref("s1"))!;
    cursor.read();
    writeFileSync(file, user("new", "2026-01-01T10:00:02Z"));
    const read = cursor.read();
    expect(read.reset).toBe(true);
    expect(read.entries.map((e) => ("text" in e ? e.text : ""))).toEqual(["new"]);
  });

  test("until bounds a second reader to an earlier position", () => {
    const file = write("s1", user("one", "2026-01-01T10:00:00Z"));
    const live = store.cursor(ref("s1"))!;
    live.read();
    appendFileSync(file, user("two", "2026-01-01T10:00:01Z"));
    const snapshot = store.cursor(ref("s1"), { initialBytes: Infinity, until: live.position })!;
    expect(snapshot.read().entries.map((e) => ("text" in e ? e.text : ""))).toEqual(["one"]);
  });

  test("starts at the tail of a large history", () => {
    write("s1", user("one", "2026-01-01T10:00:00Z"), user("two", "2026-01-01T10:00:01Z"));
    const cursor = store.cursor(ref("s1"), { initialBytes: 150 })!;
    expect(cursor.read().entries.map((e) => ("text" in e ? e.text : ""))).toEqual(["two"]);
    expect(cursor.truncated).toBe(true);
  });
});

describe("metadata", () => {
  test("turn is active while a tool call is pending and ended after a final answer", () => {
    write("s1", user("go", "2026-01-01T10:00:00Z"), assistant([{ type: "tool_use", id: "c", name: "Bash", input: {} }], "2026-01-01T10:00:01Z", { stop_reason: "tool_use" }));
    expect(store.metadata(ref("s1"))!.turn).toBe("active");
    write("s2", user("go", "2026-01-01T10:00:00Z"), assistant([{ type: "text", text: "done" }], "2026-01-01T10:00:01Z", { stop_reason: "end_turn" }));
    expect(store.metadata(ref("s2"))!.turn).toBe("ended");
    write("s3", user("go", "2026-01-01T10:00:00Z"));
    expect(store.metadata(ref("s3"))!.turn).toBe("active");
    write("s4", user("[Request interrupted by user]", "2026-01-01T10:00:00Z"));
    expect(store.metadata(ref("s4"))!.turn).toBe("ended");
  });

  test("ignores nested agent and metadata rows for turn and last entry", () => {
    write("s1",
      assistant([{ type: "text", text: "done" }], "2026-01-01T10:00:01Z", { stop_reason: "end_turn" }),
      user("side", "2026-01-01T10:00:05Z", { isSidechain: true }),
      line({ type: "cost-state", totalCostUSD: 1 }),
    );
    const meta = store.metadata(ref("s1"))!;
    expect(meta.turn).toBe("ended");
    expect(meta.lastEntryAt).toBe("2026-01-01T10:00:01Z");
  });

  test("lastActivityAt includes nested agent transcripts", () => {
    const file = write("s1", user("go", "2026-01-01T10:00:00Z"));
    const old = new Date(Date.now() - 3600_000);
    utimesSync(file, old, old);
    expect(Date.parse(store.metadata(ref("s1"))!.lastActivityAt!)).toBeLessThan(Date.now() - 3000_000);
    const nested = join(project, "s1", "subagents");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "agent-a.jsonl"), user("sub", "2026-01-01T10:00:01Z"));
    expect(Date.parse(store.metadata(ref("s1"))!.lastActivityAt!)).toBeGreaterThan(Date.now() - 60_000);
  });

  test("only the tail is read, and a history without conversation entries counts as active", () => {
    write("s1", assistant([{ type: "text", text: "done" }], "2026-01-01T10:00:01Z", { stop_reason: "end_turn" }), line({ type: "system", pad: "z".repeat(70_000) }));
    // The terminal assistant line is outside the 64 KiB tail: nothing found, active.
    expect(store.metadata(ref("s1"))!.turn).toBe("active");
    write("s2", line({ type: "system" }));
    expect(store.metadata(ref("s2"))).toMatchObject({ turn: "active", lastEntryAt: null });
  });

  test("is null without history", () => {
    expect(store.metadata(ref("missing"))).toBeNull();
  });
});

describe("usage", () => {
  const usageLine = (id: string, at: string, tokens: { i: number; o: number; r?: number; w?: number }, model = "claude-sonnet-4-5") =>
    line({ type: "assistant", timestamp: at, message: { id, model, usage: {
      input_tokens: tokens.i, output_tokens: tokens.o, cache_read_input_tokens: tokens.r ?? 0, cache_creation_input_tokens: tokens.w ?? 0,
    } } });
  const window = { from: "2026-01-01T10:00:00Z", to: "2026-01-01T10:01:00Z" };

  test("is unavailable without history", () => {
    expect(store.usage(ref("missing"), window).completeness).toBe("unavailable");
  });

  test("sums the session and its nested agents once per message inside the window", () => {
    write("s1",
      usageLine("m-before", "2026-01-01T09:59:00Z", { i: 9999, o: 9999 }),
      usageLine("m-1", "2026-01-01T10:00:10Z", { i: 1000, o: 500, r: 200, w: 100 }),
      usageLine("m-1", "2026-01-01T10:00:10Z", { i: 1000, o: 500, r: 200, w: 100 }),
      usageLine("m-buffer", "2026-01-01T10:01:30Z", { i: 10, o: 10 }),
      usageLine("m-after", "2026-01-01T10:02:30Z", { i: 9999, o: 9999 }),
    );
    const nested = join(project, "s1", "subagents");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "agent-a.jsonl"), usageLine("m-sub", "2026-01-01T10:00:20Z", { i: 300, o: 100 }, "claude-haiku-4-5"));
    writeFileSync(join(nested, "agent-dup.jsonl"), usageLine("m-1", "2026-01-01T10:00:10Z", { i: 1000, o: 500 }));

    const usage = store.usage(ref("s1"), window);
    expect(usage).toMatchObject({ inputTokens: 1310, outputTokens: 610, cacheReadTokens: 200, cacheWriteTokens: 100, completeness: "complete" });
    // sonnet (1000*3 + 500*15 + 200*0.3 + 100*3.75 + 10*3 + 10*15) + haiku (300*1 + 100*5), per 1M
    expect(usage.cost).toMatchObject({ currency: "USD", source: "estimated" });
    expect(usage.cost!.amount).toBeCloseTo((10935 + 180 + 800) / 1e6, 9);
  });

  test("skips lines without usage or message id", () => {
    write("s1", line({ type: "assistant", timestamp: "2026-01-01T10:00:11Z", message: { usage: { input_tokens: 100, output_tokens: 50 } } }));
    expect(store.usage(ref("s1"), window)).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  test("1-hour cache writes and fast mode use their own rates", () => {
    write("s1", line({ type: "assistant", timestamp: "2026-01-01T10:00:10Z", message: { id: "m", model: "claude-opus-4-8", usage: {
      input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 }, speed: "fast",
    } } }));
    // Opus 4.8: 1h write $10/MTok, fast mode 2x
    expect(store.usage(ref("s1"), window).cost!.amount).toBeCloseTo(20, 9);
  });
});

describe("listing and retention", () => {
  const age = (file: string, seconds: number) => {
    const t = new Date(Date.now() - seconds * 1000);
    utimesSync(file, t, t);
  };

  test("list returns recently active sessions with their nested agents, least recent first", () => {
    const old = write("old", user("old", "2026-01-01T10:00:00Z"));
    age(old, 7200);
    const recent = write("recent", user("recent", "2026-01-01T10:00:00Z"));
    age(recent, 600);
    const quiet = write("quiet", user("quiet", "2026-01-01T10:00:00Z"));
    age(quiet, 7200);
    mkdirSync(join(project, "quiet", "subagents"), { recursive: true });
    writeFileSync(join(project, "quiet", "subagents", "agent-a1.jsonl"), user("sub", "2026-01-01T10:00:01Z", { isSidechain: true }));

    const since = new Date(Date.now() - 3600_000).toISOString();
    const listed = store.list({ activeSince: since });
    expect(listed.map((s) => s.ref.nativeId)).toEqual(["recent", "quiet"]);
    expect(listed[1]!.nestedAgents.map((a) => a.id)).toEqual(["agent-a1"]);
  });

  test("load reads a nested agent's history", async () => {
    write("s1", user("main", "2026-01-01T10:00:00Z"));
    mkdirSync(join(project, "s1", "subagents"), { recursive: true });
    writeFileSync(join(project, "s1", "subagents", "agent-a1.jsonl"), user("sub task", "2026-01-01T10:00:01Z", { isSidechain: true }));
    const read = await store.load(ref("s1"), { agent: "agent-a1" });
    expect(read!.entries).toMatchObject([{ kind: "user-text", text: "sub task", nested: true }]);
    expect(await store.load(ref("s1"), { agent: "missing" })).toBeNull();
    expect(await store.load(ref("s1"), { agent: "../s1" })).toBeNull();
  });

  test("prune removes inactive sessions with their directory and keeps active ones", () => {
    const stale = write("stale", user("x", "2026-01-01T10:00:00Z"));
    mkdirSync(join(project, "stale", "subagents"), { recursive: true });
    const staleSub = join(project, "stale", "subagents", "agent-a.jsonl");
    writeFileSync(staleSub, "{}\n");
    age(stale, 20 * 86400);
    age(staleSub, 20 * 86400);
    const busy = write("busy", user("x", "2026-01-01T10:00:00Z"));
    age(busy, 20 * 86400);
    mkdirSync(join(project, "busy", "subagents"), { recursive: true });
    writeFileSync(join(project, "busy", "subagents", "agent-b.jsonl"), "{}\n");
    mkdirSync(join(project, "memory"), { recursive: true });

    const removed = store.prune({ inactiveBefore: new Date(Date.now() - 14 * 86400_000).toISOString() });
    expect(removed).toBe(1);
    expect(store.exists(ref("stale"))).toBe(false);
    expect(existsSync(join(project, "stale"))).toBe(false);
    expect(store.exists(ref("busy"))).toBe(true);
    expect(existsSync(join(project, "memory"))).toBe(true);
  });
});

describe("backend selection", () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.ATLAS_HARNESS_BACKEND; delete process.env.ATLAS_HARNESS_BACKEND; });
  afterEach(() => { if (saved === undefined) delete process.env.ATLAS_HARNESS_BACKEND; else process.env.ATLAS_HARNESS_BACKEND = saved; });

  test("defaults to claude-code", () => {
    expect(configuredHarnessBackend(home)).toBe("claude-code");
    expect(createSessionStore({ home }).backend).toBe("claude-code");
  });

  test("reads harness.backend from config.yml, env wins", () => {
    writeFileSync(join(home, "config.yml"), "harness:\n  backend: other\n");
    expect(configuredHarnessBackend(home)).toBe("other");
    process.env.ATLAS_HARNESS_BACKEND = "claude-code";
    expect(configuredHarnessBackend(home)).toBe("claude-code");
  });

  test("an unknown backend fails instead of falling back", () => {
    writeFileSync(join(home, "config.yml"), "harness:\n  backend: other\n");
    expect(() => createSessionStore({ home })).toThrow("Unknown harness backend: other");
  });
});
