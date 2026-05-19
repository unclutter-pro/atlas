/**
 * Tests for trigger-runner.ts exported pure functions.
 * Uses Bun's built-in test runner.
 *
 * Run with: cd app/triggers && bun test
 */

import { test, describe, expect, beforeAll, beforeEach, afterAll, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { createConnection } from "net";
import type { Server } from "net";

import {
  buildSystemPrompt,
  resolveModel,
  getMcpServers,
  safePlaceholderReplace,
  readTriggerConfig,
  recordMetrics,
  checkCorruptedSession,
  tryIpcInject,
  createMessageChannel,
  getSocketPath,
  startSocketServer,
  trySocketInject,
  cleanupSocket,
  persistStreamChunk,
  aggregateRunCost,
  modelFamily,
  MODEL_PRICING,
  type TriggerConfig,
  type MetricsData,
  type StreamChunkState,
  type AggregatedUsage,
} from "./trigger-runner.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "atlas-trigger-test-"));
}

function createInMemoryDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS triggers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      channel TEXT DEFAULT 'internal',
      prompt TEXT DEFAULT '',
      session_mode TEXT DEFAULT 'ephemeral',
      enabled INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS session_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_type TEXT NOT NULL,
      session_id TEXT,
      trigger_name TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      duration_ms INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_creation_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      num_turns INTEGER DEFAULT 0,
      is_error INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

// ---------------------------------------------------------------------------
// safePlaceholderReplace
// ---------------------------------------------------------------------------

describe("safePlaceholderReplace", () => {
  test("replaces simple placeholders", () => {
    const result = safePlaceholderReplace(
      "Hello {{name}}, welcome to {{place}}!",
      { "{{name}}": "Alice", "{{place}}": "Wonderland" }
    );
    expect(result).toBe("Hello Alice, welcome to Wonderland!");
  });

  test("handles values containing regex special characters", () => {
    const result = safePlaceholderReplace(
      "{{payload}}",
      { "{{payload}}": "price is $10.00 (USD) [+tax]" }
    );
    expect(result).toBe("price is $10.00 (USD) [+tax]");
  });

  test("handles values with backslashes", () => {
    const result = safePlaceholderReplace(
      "{{payload}}",
      { "{{payload}}": "path\\to\\file" }
    );
    expect(result).toBe("path\\to\\file");
  });

  test("replaces multiple occurrences", () => {
    const result = safePlaceholderReplace(
      "{{x}} and {{x}} again",
      { "{{x}}": "hello" }
    );
    expect(result).toBe("hello and hello again");
  });

  test("handles empty value", () => {
    const result = safePlaceholderReplace(
      "before {{empty}} after",
      { "{{empty}}": "" }
    );
    expect(result).toBe("before  after");
  });

  test("handles no-match gracefully", () => {
    const result = safePlaceholderReplace(
      "no placeholders here",
      { "{{missing}}": "value" }
    );
    expect(result).toBe("no placeholders here");
  });

  test("handles newlines in values", () => {
    const result = safePlaceholderReplace(
      "message: {{payload}}",
      { "{{payload}}": "line1\nline2\nline3" }
    );
    expect(result).toBe("message: line1\nline2\nline3");
  });
});

// ---------------------------------------------------------------------------
// buildSystemPrompt
// ---------------------------------------------------------------------------

describe("buildSystemPrompt", () => {
  let tmpDir: string;
  let appDir: string;
  let workspace: string;

  beforeAll(() => {
    tmpDir = makeTempDir();
    appDir = join(tmpDir, "app");
    workspace = join(tmpDir, "workspace");

    mkdirSync(join(appDir, "prompts"), { recursive: true });
    mkdirSync(workspace, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("includes SOUL.md wrapped in soul tags", () => {
    writeFileSync(join(workspace, "SOUL.md"), "You are Atlas.");
    const result = buildSystemPrompt("internal", { appDir, workspace });
    expect(result).toContain("<soul");
    expect(result).toContain("You are Atlas.");
    expect(result).toContain("</soul>");
  });

  test("includes IDENTITY.md wrapped in identity tags", () => {
    writeFileSync(join(workspace, "IDENTITY.md"), "Identity content here.");
    const result = buildSystemPrompt("internal", { appDir, workspace });
    expect(result).toContain("<identity");
    expect(result).toContain("Identity content here.");
    expect(result).toContain("</identity>");
  });

  test("includes trigger-system-prompt.md after --- separator", () => {
    writeFileSync(
      join(appDir, "prompts", "trigger-system-prompt.md"),
      "Core trigger instructions."
    );
    const result = buildSystemPrompt("internal", { appDir, workspace });
    expect(result).toContain("---");
    expect(result).toContain("Core trigger instructions.");
  });

  test("includes channel-specific prompt after --- separator", () => {
    writeFileSync(
      join(appDir, "prompts", "trigger-channel-signal.md"),
      "Signal-specific instructions."
    );
    const result = buildSystemPrompt("signal", { appDir, workspace });
    expect(result).toContain("Signal-specific instructions.");
  });

  test("gracefully skips missing optional files", () => {
    // Create a fresh temp dir with no optional files
    const minimalTmpDir = makeTempDir();
    const minimalAppDir = join(minimalTmpDir, "app");
    const minimalWorkspace = join(minimalTmpDir, "workspace");
    mkdirSync(join(minimalAppDir, "prompts"), { recursive: true });
    mkdirSync(minimalWorkspace, { recursive: true });

    // Only create the core system prompt
    writeFileSync(
      join(minimalAppDir, "prompts", "trigger-system-prompt.md"),
      "Core prompt only."
    );

    const result = buildSystemPrompt("nonexistent-channel", {
      appDir: minimalAppDir,
      workspace: minimalWorkspace,
    });

    expect(result).toContain("Core prompt only.");
    // Should NOT throw and should NOT contain undefined/null
    expect(result).not.toContain("undefined");
    expect(result).not.toContain("null");

    rmSync(minimalTmpDir, { recursive: true, force: true });
  });

  test("concatenates sections with --- separators", () => {
    const result = buildSystemPrompt("internal", { appDir, workspace });
    // With both soul+identity and trigger-system-prompt.md, we expect --- separators
    expect(result).toContain("---");
  });
});

// ---------------------------------------------------------------------------
// resolveModel
// ---------------------------------------------------------------------------

describe("resolveModel", () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeAll(() => {
    tmpDir = makeTempDir();
    originalHome = process.env.HOME;
  });

  afterEach(() => {
    // Restore HOME after each test
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // resolveModel now delegates to resolveConfig(HOME), so we control
  // resolution by pointing HOME at a temp dir with a config.yml.

  test("reads trigger model from config.yml via resolveConfig", () => {
    writeFileSync(join(tmpDir, "config.yml"), `
models:
  trigger: claude-sonnet-4-6
  cron: claude-haiku-4-5
`);
    process.env.HOME = tmpDir;
    expect(resolveModel("", "trigger")).toBe("claude-sonnet-4-6");
  });

  test("reads cron model from config.yml via resolveConfig", () => {
    writeFileSync(join(tmpDir, "config.yml"), `
models:
  trigger: claude-sonnet-4-6
  cron: claude-haiku-4-5
`);
    process.env.HOME = tmpDir;
    expect(resolveModel("", "cron")).toBe("claude-haiku-4-5");
  });

  test("falls back to default model when config missing", () => {
    const emptyDir = makeTempDir();
    process.env.HOME = emptyDir;
    // Default for trigger is "opus" from built-in defaults
    const model = resolveModel("", "trigger");
    expect(model).toBe("opus");
    rmSync(emptyDir, { recursive: true, force: true });
  });

  test("falls back to trigger key when specific type not found", () => {
    writeFileSync(join(tmpDir, "config.yml"), `
models:
  trigger: claude-sonnet-4-6
`);
    process.env.HOME = tmpDir;
    // Asking for "worker" but only "trigger" is defined — should fall back to trigger
    const model = resolveModel("", "worker");
    expect(model).toBe("claude-sonnet-4-6");
  });

  test("handles malformed YAML gracefully", () => {
    const badDir = makeTempDir();
    writeFileSync(join(badDir, "config.yml"), "{ this is: not valid: yaml: [");
    process.env.HOME = badDir;
    // Malformed YAML => falls back to defaults; trigger default is "opus"
    const model = resolveModel("", "trigger");
    expect(model).toBe("opus");
    rmSync(badDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// getMcpServers
// ---------------------------------------------------------------------------

describe("getMcpServers", () => {
  test("returns empty object by default (no user MCP config)", () => {
    const servers = getMcpServers();
    expect(Object.keys(servers).length).toBe(0);
  });

  test("does not include URL-based servers", () => {
    const servers = getMcpServers();
    for (const config of Object.values(servers)) {
      expect(config).not.toHaveProperty("url");
    }
  });
});

// ---------------------------------------------------------------------------
// readTriggerConfig
// ---------------------------------------------------------------------------

describe("readTriggerConfig", () => {
  test("returns trigger config for existing trigger", () => {
    const db = createInMemoryDb();
    db.prepare(`
      INSERT INTO triggers (name, type, channel, prompt, session_mode, enabled)
      VALUES ('test-trigger', 'manual', 'signal', 'Do the thing', 'persistent', 1)
    `).run();

    const config = readTriggerConfig(db, "test-trigger");
    expect(config).not.toBeNull();
    expect(config!.name).toBe("test-trigger");
    expect(config!.channel).toBe("signal");
    expect(config!.prompt).toBe("Do the thing");
    expect(config!.session_mode).toBe("persistent");
    expect(config!.enabled).toBe(1);
  });

  test("returns null for missing trigger", () => {
    const db = createInMemoryDb();
    const config = readTriggerConfig(db, "nonexistent-trigger");
    expect(config).toBeNull();
  });

  test("handles trigger with default values", () => {
    const db = createInMemoryDb();
    db.prepare(`
      INSERT INTO triggers (name, type) VALUES ('minimal', 'cron')
    `).run();

    const config = readTriggerConfig(db, "minimal");
    expect(config).not.toBeNull();
    expect(config!.channel).toBe("internal");
    expect(config!.session_mode).toBe("ephemeral");
    expect(config!.enabled).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// recordMetrics
// ---------------------------------------------------------------------------

describe("recordMetrics", () => {
  test("inserts metrics row correctly", () => {
    const db = createInMemoryDb();

    const data: MetricsData = {
      sessionType: "trigger",
      sessionId: "sess-abc-123",
      triggerName: "test-trigger",
      startedAt: "2026-03-08T10:00:00Z",
      endedAt: "2026-03-08T10:01:00Z",
      durationMs: 60000,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheCreationTokens: 100,
      costUsd: 0.005,
      numTurns: 3,
      isError: false,
    };

    recordMetrics(db, data);

    const row = db.prepare("SELECT * FROM session_metrics LIMIT 1").get() as Record<string, unknown>;
    expect(row.session_type).toBe("trigger");
    expect(row.session_id).toBe("sess-abc-123");
    expect(row.trigger_name).toBe("test-trigger");
    expect(row.duration_ms).toBe(60000);
    expect(row.input_tokens).toBe(1000);
    expect(row.output_tokens).toBe(500);
    expect(row.cache_read_tokens).toBe(200);
    expect(row.cache_creation_tokens).toBe(100);
    expect(row.cost_usd).toBeCloseTo(0.005);
    expect(row.num_turns).toBe(3);
    expect(row.is_error).toBe(0);
  });

  test("records error flag correctly", () => {
    const db = createInMemoryDb();

    const data: MetricsData = {
      sessionType: "trigger",
      sessionId: "sess-error",
      triggerName: "test-trigger",
      startedAt: "2026-03-08T10:00:00Z",
      endedAt: "2026-03-08T10:00:05Z",
      durationMs: 5000,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      numTurns: 0,
      isError: true,
    };

    recordMetrics(db, data);

    const row = db.prepare("SELECT is_error FROM session_metrics LIMIT 1").get() as { is_error: number };
    expect(row.is_error).toBe(1);
  });

  test("handles empty session_id", () => {
    const db = createInMemoryDb();

    const data: MetricsData = {
      sessionType: "trigger",
      sessionId: "",
      triggerName: "test-trigger",
      startedAt: "2026-03-08T10:00:00Z",
      endedAt: "2026-03-08T10:00:00Z",
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      numTurns: 0,
      isError: false,
    };

    // Should not throw
    expect(() => recordMetrics(db, data)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// checkCorruptedSession
// ---------------------------------------------------------------------------

describe("checkCorruptedSession", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = makeTempDir();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns false for non-existent session", () => {
    expect(checkCorruptedSession("nonexistent-session-id", tmpDir)).toBe(false);
  });

  test("returns true when last JSONL line is queue-operation", () => {
    const sessionsDir = join(tmpDir, ".claude", "projects", "test-proj", "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    const sessionId = "test-session-corrupted";
    const jsonlPath = join(sessionsDir, `${sessionId}.jsonl`);

    writeFileSync(jsonlPath, [
      JSON.stringify({ type: "user", content: "Hello" }),
      JSON.stringify({ type: "assistant", content: "Hi there" }),
      JSON.stringify({ type: "queue-operation", data: {} }),
    ].join("\n") + "\n");

    expect(checkCorruptedSession(sessionId, tmpDir)).toBe(true);
  });

  test("returns false when last JSONL line is not queue-operation", () => {
    const sessionsDir = join(tmpDir, ".claude", "projects", "test-proj", "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    const sessionId = "test-session-healthy";
    const jsonlPath = join(sessionsDir, `${sessionId}.jsonl`);

    writeFileSync(jsonlPath, [
      JSON.stringify({ type: "user", content: "Hello" }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ].join("\n") + "\n");

    expect(checkCorruptedSession(sessionId, tmpDir)).toBe(false);
  });

  test("returns false for empty JSONL file", () => {
    const sessionsDir = join(tmpDir, ".claude", "projects", "test-proj2", "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    const sessionId = "test-session-empty";
    const jsonlPath = join(sessionsDir, `${sessionId}.jsonl`);

    writeFileSync(jsonlPath, "");

    expect(checkCorruptedSession(sessionId, tmpDir)).toBe(false);
  });

  test("returns false for malformed JSONL", () => {
    const sessionsDir = join(tmpDir, ".claude", "projects", "test-proj3", "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    const sessionId = "test-session-malformed";
    const jsonlPath = join(sessionsDir, `${sessionId}.jsonl`);

    writeFileSync(jsonlPath, "not valid json\n");

    expect(checkCorruptedSession(sessionId, tmpDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tryIpcInject
// ---------------------------------------------------------------------------

describe("tryIpcInject", () => {
  test("returns false for non-existent socket", async () => {
    const result = await tryIpcInject("nonexistent-session-id-12345", "hello");
    expect(result).toBe(false);
  });

  test("returns false for invalid socket path (no socket file)", async () => {
    // Use a session ID that definitely doesn't have a socket
    const result = await tryIpcInject("00000000-0000-0000-0000-000000000000", "test message");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getSocketPath
// ---------------------------------------------------------------------------

describe("getSocketPath", () => {
  test("returns expected path format", () => {
    const path = getSocketPath("signal-chat", "+491234");
    expect(path).toBe("/tmp/.trigger-signal-chat-_491234.sock");
  });

  test("sanitizes special characters in session key", () => {
    const path = getSocketPath("email-handler", "thread/4821@mail.com");
    expect(path).toBe("/tmp/.trigger-email-handler-thread_4821_mail_com.sock");
  });

  test("handles _default key", () => {
    const path = getSocketPath("deploy-hook", "_default");
    expect(path).toBe("/tmp/.trigger-deploy-hook-_default.sock");
  });
});

// ---------------------------------------------------------------------------
// createMessageChannel
// ---------------------------------------------------------------------------

describe("createMessageChannel", () => {
  test("yields pushed messages in order", async () => {
    const ch = createMessageChannel("test-session", 60000);
    ch.push("first message");
    ch.push("second message");

    const iter = ch.generator[Symbol.asyncIterator]();

    const msg1 = await iter.next();
    expect(msg1.done).toBe(false);
    expect(msg1.value.type).toBe("user");
    expect(msg1.value.message.role).toBe("user");
    expect(msg1.value.message.content).toBe("first message");
    expect(msg1.value.session_id).toBe("test-session");

    const msg2 = await iter.next();
    expect(msg2.done).toBe(false);
    expect(msg2.value.message.content).toBe("second message");

    ch.close();
    const end = await iter.next();
    expect(end.done).toBe(true);
  });

  test("waits for messages when queue is empty", async () => {
    const ch = createMessageChannel("test-session-2", 60000);

    // Push after a delay
    setTimeout(() => ch.push("delayed message"), 50);

    const iter = ch.generator[Symbol.asyncIterator]();
    const msg = await iter.next();
    expect(msg.done).toBe(false);
    expect(msg.value.message.content).toBe("delayed message");

    ch.close();
  });

  test("ends after idle timeout", async () => {
    // Very short timeout for testing
    const ch = createMessageChannel("test-session-3", 100);
    ch.push("initial");

    const iter = ch.generator[Symbol.asyncIterator]();

    // Consume the initial message
    await iter.next();

    // Now wait — should timeout and end
    const end = await iter.next();
    expect(end.done).toBe(true);
  });

  test("close() terminates the generator", async () => {
    const ch = createMessageChannel("test-session-4", 60000);

    // Start consuming in background
    const iter = ch.generator[Symbol.asyncIterator]();

    // Close after a short delay
    setTimeout(() => ch.close(), 50);

    // The iterator should end
    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  test("handles interleaved push and consume", async () => {
    const ch = createMessageChannel("test-session-5", 60000);
    const iter = ch.generator[Symbol.asyncIterator]();

    // Push -> consume -> push -> consume
    ch.push("msg-1");
    const r1 = await iter.next();
    expect(r1.value.message.content).toBe("msg-1");

    ch.push("msg-2");
    const r2 = await iter.next();
    expect(r2.value.message.content).toBe("msg-2");

    ch.close();
  });
});

// ---------------------------------------------------------------------------
// Socket IPC (startSocketServer + trySocketInject)
// ---------------------------------------------------------------------------

describe("Socket IPC", () => {
  let socketPath: string;
  let server: Server | null = null;

  afterEach(() => {
    if (server) {
      cleanupSocket(server, socketPath);
      server = null;
    }
  });

  test("trySocketInject returns false when no socket exists", async () => {
    const result = await trySocketInject("/tmp/.trigger-nonexistent-test.sock", "hello", "signal", "+491234");
    expect(result).toBe(false);
  });

  test("socket server accepts and acknowledges messages", async () => {
    socketPath = `/tmp/.trigger-test-ipc-${Date.now()}.sock`;
    const received: string[] = [];

    server = startSocketServer(socketPath, (text) => {
      received.push(text);
    });

    // Wait for server to be ready
    await Bun.sleep(50);

    const ok = await trySocketInject(socketPath, "test message", "signal", "+491234");
    expect(ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe("test message");
  });

  test("socket server handles multiple sequential messages", async () => {
    socketPath = `/tmp/.trigger-test-multi-${Date.now()}.sock`;
    const received: string[] = [];

    server = startSocketServer(socketPath, (text) => {
      received.push(text);
    });

    await Bun.sleep(50);

    const ok1 = await trySocketInject(socketPath, "msg-1", "signal", "+491234");
    const ok2 = await trySocketInject(socketPath, "msg-2", "email", "thread-42");
    const ok3 = await trySocketInject(socketPath, "msg-3", "webhook", "repo-main");

    expect(ok1).toBe(true);
    expect(ok2).toBe(true);
    expect(ok3).toBe(true);
    expect(received).toEqual(["msg-1", "msg-2", "msg-3"]);
  });

  test("socket server pushes to message channel", async () => {
    socketPath = `/tmp/.trigger-test-channel-${Date.now()}.sock`;

    const ch = createMessageChannel("test-session-socket", 60000);
    server = startSocketServer(socketPath, (text) => {
      ch.push(text);
    });

    await Bun.sleep(50);

    // Inject via socket
    const ok = await trySocketInject(socketPath, "injected via socket", "signal", "+491234");
    expect(ok).toBe(true);

    // Read from channel
    const iter = ch.generator[Symbol.asyncIterator]();
    const msg = await iter.next();
    expect(msg.done).toBe(false);
    expect(msg.value.message.content).toBe("injected via socket");

    ch.close();
  });

  test("cleanupSocket removes socket file", async () => {
    socketPath = `/tmp/.trigger-test-cleanup-${Date.now()}.sock`;
    server = startSocketServer(socketPath, () => {});
    await Bun.sleep(50);

    expect(existsSync(socketPath)).toBe(true);
    cleanupSocket(server, socketPath);
    server = null; // Already cleaned up

    expect(existsSync(socketPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// persistStreamChunk — text delta persistence for the web channel SSE stream
// ---------------------------------------------------------------------------

describe("persistStreamChunk", () => {
  let db: Database;
  let state: { uuid: string | null; nextIndex: number };
  let api: StreamChunkState;

  beforeAll(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE web_chat_stream_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        message_uuid TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content_delta TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  });

  afterAll(() => {
    db.close();
  });

  afterEach(() => {
    db.exec("DELETE FROM web_chat_stream_chunks");
  });

  function freshState(): StreamChunkState {
    state = { uuid: null, nextIndex: 0 };
    api = {
      setUuid: (u) => { state.uuid = u; state.nextIndex = 0; },
      uuidRef: () => state.uuid,
      nextIndex: () => state.nextIndex++,
    };
    return api;
  }

  function rows(): { message_uuid: string; chunk_index: number; content_delta: string }[] {
    return db.prepare(
      "SELECT message_uuid, chunk_index, content_delta FROM web_chat_stream_chunks ORDER BY id ASC",
    ).all() as { message_uuid: string; chunk_index: number; content_delta: string }[];
  }

  test("message_start records the message id but writes no chunk row", () => {
    const s = freshState();
    persistStreamChunk(
      { type: "stream_event", session_id: "sess-1", event: { type: "message_start", message: { id: "msg-abc" } } },
      s,
      db,
    );
    expect(state.uuid).toBe("msg-abc");
    expect(rows().length).toBe(0);
  });

  test("text deltas after message_start are persisted with incrementing index", () => {
    const s = freshState();
    persistStreamChunk(
      { type: "stream_event", session_id: "sess-1", event: { type: "message_start", message: { id: "msg-1" } } },
      s, db,
    );
    persistStreamChunk(
      { type: "stream_event", session_id: "sess-1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } } },
      s, db,
    );
    persistStreamChunk(
      { type: "stream_event", session_id: "sess-1", event: { type: "content_block_delta", delta: { type: "text_delta", text: " world" } } },
      s, db,
    );

    expect(rows()).toEqual([
      { message_uuid: "msg-1", chunk_index: 0, content_delta: "Hello" },
      { message_uuid: "msg-1", chunk_index: 1, content_delta: " world" },
    ]);
  });

  test("a new message_start resets the chunk index to 0", () => {
    const s = freshState();
    // turn 1
    persistStreamChunk({ type: "stream_event", session_id: "sess-1", event: { type: "message_start", message: { id: "msg-1" } } }, s, db);
    persistStreamChunk({ type: "stream_event", session_id: "sess-1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "A" } } }, s, db);
    persistStreamChunk({ type: "stream_event", session_id: "sess-1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "B" } } }, s, db);
    // turn 2 (after a tool, say)
    persistStreamChunk({ type: "stream_event", session_id: "sess-1", event: { type: "message_start", message: { id: "msg-2" } } }, s, db);
    persistStreamChunk({ type: "stream_event", session_id: "sess-1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "X" } } }, s, db);

    expect(rows()).toEqual([
      { message_uuid: "msg-1", chunk_index: 0, content_delta: "A" },
      { message_uuid: "msg-1", chunk_index: 1, content_delta: "B" },
      { message_uuid: "msg-2", chunk_index: 0, content_delta: "X" },
    ]);
  });

  test("non-text deltas (tool_use, thinking, message_stop) are ignored", () => {
    const s = freshState();
    persistStreamChunk({ type: "stream_event", session_id: "sess-1", event: { type: "message_start", message: { id: "msg-1" } } }, s, db);

    // Tool-block delta, thinking-delta, content_block_stop, message_stop — none should write a row
    persistStreamChunk({ type: "stream_event", session_id: "sess-1", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{" } } }, s, db);
    persistStreamChunk({ type: "stream_event", session_id: "sess-1", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "..." } } }, s, db);
    persistStreamChunk({ type: "stream_event", session_id: "sess-1", event: { type: "content_block_stop", index: 0 } }, s, db);
    persistStreamChunk({ type: "stream_event", session_id: "sess-1", event: { type: "message_stop" } }, s, db);

    expect(rows().length).toBe(0);
  });

  test("empty text deltas are ignored (no zero-length rows)", () => {
    const s = freshState();
    persistStreamChunk({ type: "stream_event", session_id: "sess-1", event: { type: "message_start", message: { id: "msg-1" } } }, s, db);
    persistStreamChunk({ type: "stream_event", session_id: "sess-1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "" } } }, s, db);

    expect(rows().length).toBe(0);
  });

  test("text delta before any message_start is silently dropped", () => {
    const s = freshState();
    persistStreamChunk({ type: "stream_event", session_id: "sess-1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "orphan" } } }, s, db);

    expect(rows().length).toBe(0);
    expect(state.uuid).toBeNull();
  });

  test("non-stream_event types are ignored", () => {
    const s = freshState();
    persistStreamChunk({ type: "assistant", session_id: "sess-1", event: { type: "message_start", message: { id: "x" } } }, s, db);
    expect(state.uuid).toBeNull();
    expect(rows().length).toBe(0);
  });

  test("missing session_id is ignored", () => {
    const s = freshState();
    persistStreamChunk({ type: "stream_event", event: { type: "message_start", message: { id: "msg-1" } } }, s, db);
    // message_start with no session_id should not even set the uuid
    expect(state.uuid).toBeNull();
    expect(rows().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// modelFamily + MODEL_PRICING
// ---------------------------------------------------------------------------

describe("modelFamily", () => {
  test("detects opus from model string", () => {
    expect(modelFamily("claude-opus-4-5")).toBe("opus");
    expect(modelFamily("claude-opus-3")).toBe("opus");
  });
  test("detects haiku from model string", () => {
    expect(modelFamily("claude-haiku-3-5")).toBe("haiku");
    expect(modelFamily("claude-haiku-3")).toBe("haiku");
  });
  test("defaults to sonnet for anything else", () => {
    expect(modelFamily("claude-sonnet-4-5")).toBe("sonnet");
    expect(modelFamily("claude-3-5-sonnet-20241022")).toBe("sonnet");
    expect(modelFamily("unknown-model")).toBe("sonnet");
    expect(modelFamily("")).toBe("sonnet");
  });
});

// ---------------------------------------------------------------------------
// aggregateRunCost
// ---------------------------------------------------------------------------

describe("aggregateRunCost", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "atlas-agg-cost-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeEntry(opts: {
    id: string;
    timestamp: string;
    model?: string;
    inputTokens: number;
    outputTokens: number;
    cacheRead?: number;
    cacheCreate?: number;
  }): string {
    return JSON.stringify({
      type: "assistant",
      timestamp: opts.timestamp,
      message: {
        id: opts.id,
        model: opts.model ?? "claude-sonnet-4-5",
        usage: {
          input_tokens: opts.inputTokens,
          output_tokens: opts.outputTokens,
          cache_read_input_tokens: opts.cacheRead ?? 0,
          cache_creation_input_tokens: opts.cacheCreate ?? 0,
        },
      },
    });
  }

  function setupProject(sessionId: string): {
    projectDir: string;
    parentJsonl: string;
    subagentsDir: string;
  } {
    const projectDir = "test-project-agg";
    const base = join(tmp, ".claude", "projects", projectDir);
    mkdirSync(base, { recursive: true });
    const parentJsonl = join(base, `${sessionId}.jsonl`);
    const subagentsDir = join(base, sessionId, "subagents");
    mkdirSync(subagentsDir, { recursive: true });
    return { projectDir, parentJsonl, subagentsDir };
  }

  test("returns zeros when no JSONL files exist", () => {
    const origProjDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = "nonexistent-project-agg";
    const result = aggregateRunCost("no-session", "2026-01-01T10:00:00Z", "2026-01-01T10:01:00Z", tmp);
    process.env.CLAUDE_PROJECT_DIR = origProjDir;
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.costUsd).toBe(0);
  });

  test("sums parent JSONL tokens correctly", () => {
    const sessionId = "agg-parent-only";
    const { projectDir, parentJsonl } = setupProject(sessionId);
    const origProjDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = projectDir;

    writeFileSync(parentJsonl, [
      makeEntry({ id: "msg_1", timestamp: "2026-01-01T10:00:10Z", inputTokens: 1000, outputTokens: 500, cacheRead: 200, cacheCreate: 100 }),
    ].join("\n"));

    const result = aggregateRunCost(sessionId, "2026-01-01T10:00:00Z", "2026-01-01T10:01:00Z", tmp);
    process.env.CLAUDE_PROJECT_DIR = origProjDir;

    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(500);
    expect(result.cacheReadTokens).toBe(200);
    expect(result.cacheCreationTokens).toBe(100);
    // cost = (1000*3 + 500*15 + 200*0.3 + 100*3.75) / 1_000_000 = 10935/1e6
    expect(result.costUsd).toBeCloseTo(0.010935, 6);
  });

  test("sums parent + subagent JSONL tokens together", () => {
    const sessionId = "agg-with-subagents";
    const { projectDir, parentJsonl, subagentsDir } = setupProject(sessionId);
    const origProjDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = projectDir;

    writeFileSync(parentJsonl, makeEntry({ id: "msg_parent", timestamp: "2026-01-01T10:00:10Z", inputTokens: 500, outputTokens: 200 }));
    writeFileSync(join(subagentsDir, "agent-sub1.jsonl"), makeEntry({ id: "msg_sub1", timestamp: "2026-01-01T10:00:20Z", inputTokens: 300, outputTokens: 100 }));
    writeFileSync(join(subagentsDir, "agent-sub2.jsonl"), makeEntry({ id: "msg_sub2", timestamp: "2026-01-01T10:00:30Z", inputTokens: 200, outputTokens: 50 }));

    const result = aggregateRunCost(sessionId, "2026-01-01T10:00:00Z", "2026-01-01T10:01:00Z", tmp);
    process.env.CLAUDE_PROJECT_DIR = origProjDir;

    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(350);
  });

  test("filters out messages outside the time window", () => {
    const sessionId = "agg-time-window";
    const { projectDir, parentJsonl } = setupProject(sessionId);
    const origProjDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = projectDir;

    writeFileSync(parentJsonl, [
      // Before window start — should be excluded
      makeEntry({ id: "msg_before", timestamp: "2026-01-01T09:59:00Z", inputTokens: 9999, outputTokens: 9999 }),
      // Inside window
      makeEntry({ id: "msg_inside", timestamp: "2026-01-01T10:00:10Z", inputTokens: 100, outputTokens: 50 }),
      // After window end + 60s buffer — should be excluded
      makeEntry({ id: "msg_after", timestamp: "2026-01-01T10:02:30Z", inputTokens: 9999, outputTokens: 9999 }),
    ].join("\n"));

    const result = aggregateRunCost(sessionId, "2026-01-01T10:00:00Z", "2026-01-01T10:01:00Z", tmp);
    process.env.CLAUDE_PROJECT_DIR = origProjDir;

    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
  });

  test("deduplicates by message.id across parent and subagent files", () => {
    const sessionId = "agg-dedup";
    const { projectDir, parentJsonl, subagentsDir } = setupProject(sessionId);
    const origProjDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = projectDir;

    // Same message id in both parent and subagent — should only count once
    const sharedEntry = makeEntry({ id: "msg_shared", timestamp: "2026-01-01T10:00:10Z", inputTokens: 500, outputTokens: 200 });
    writeFileSync(parentJsonl, sharedEntry);
    writeFileSync(join(subagentsDir, "agent-dup.jsonl"), sharedEntry);

    const result = aggregateRunCost(sessionId, "2026-01-01T10:00:00Z", "2026-01-01T10:01:00Z", tmp);
    process.env.CLAUDE_PROJECT_DIR = origProjDir;

    // Should count only once, not twice
    expect(result.inputTokens).toBe(500);
    expect(result.outputTokens).toBe(200);
  });

  test("applies correct pricing per model family", () => {
    const sessionId = "agg-pricing";
    const { projectDir, parentJsonl, subagentsDir } = setupProject(sessionId);
    const origProjDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = projectDir;

    // Opus: in=15, out=75 per 1M
    writeFileSync(parentJsonl, makeEntry({ id: "msg_opus", timestamp: "2026-01-01T10:00:10Z", model: "claude-opus-4-5", inputTokens: 1000, outputTokens: 1000 }));
    // Haiku: in=1, out=5 per 1M
    writeFileSync(join(subagentsDir, "agent-haiku.jsonl"), makeEntry({ id: "msg_haiku", timestamp: "2026-01-01T10:00:20Z", model: "claude-haiku-3-5", inputTokens: 1000, outputTokens: 1000 }));

    const result = aggregateRunCost(sessionId, "2026-01-01T10:00:00Z", "2026-01-01T10:01:00Z", tmp);
    process.env.CLAUDE_PROJECT_DIR = origProjDir;

    // opus: (1000*15 + 1000*75) / 1e6 = 0.090
    // haiku: (1000*1 + 1000*5) / 1e6 = 0.006
    expect(result.costUsd).toBeCloseTo(0.096, 6);
  });

  test("returns zeros for files with no usage data or missing message.id", () => {
    const sessionId = "agg-no-usage";
    const { projectDir, parentJsonl } = setupProject(sessionId);
    const origProjDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = projectDir;

    writeFileSync(parentJsonl, [
      JSON.stringify({ type: "user", timestamp: "2026-01-01T10:00:10Z", message: { role: "user", content: "hi" } }),
      // No message.id
      JSON.stringify({ type: "assistant", timestamp: "2026-01-01T10:00:11Z", message: { model: "claude-sonnet-4-5", usage: { input_tokens: 100, output_tokens: 50 } } }),
    ].join("\n"));

    const result = aggregateRunCost(sessionId, "2026-01-01T10:00:00Z", "2026-01-01T10:01:00Z", tmp);
    process.env.CLAUDE_PROJECT_DIR = origProjDir;

    expect(result.inputTokens).toBe(0);
    expect(result.costUsd).toBe(0);
  });

  test("includes messages within the 60-second end buffer", () => {
    const sessionId = "agg-buffer";
    const { projectDir, parentJsonl } = setupProject(sessionId);
    const origProjDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = projectDir;

    // 30 seconds after endedAt — within 60s buffer
    writeFileSync(parentJsonl, makeEntry({ id: "msg_buffered", timestamp: "2026-01-01T10:01:30Z", inputTokens: 200, outputTokens: 100 }));

    const result = aggregateRunCost(sessionId, "2026-01-01T10:00:00Z", "2026-01-01T10:01:00Z", tmp);
    process.env.CLAUDE_PROJECT_DIR = origProjDir;

    expect(result.inputTokens).toBe(200);
    expect(result.outputTokens).toBe(100);
  });
});
