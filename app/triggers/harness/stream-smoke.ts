/**
 * Smoke test: verify the Claude harness adapter streams text.delta events
 * for a real model turn, and that persistStreamChunk records them the way
 * the web chat reads them.
 *
 * Run with:  cd app/triggers && bun harness/stream-smoke.ts
 *
 * NOT part of the automated suite — requires an authenticated Claude CLI on
 * PATH. Uses a throwaway working directory and leaves ~/.claude.json alone.
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { ClaudeCodeBackend } from "./claude/backend.ts";
import { persistStreamChunk, type StreamChunkState } from "../trigger-runner.ts";

const db = new Database(":memory:");
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

const cwd = mkdtempSync(join(tmpdir(), "atlas-stream-smoke-"));
const state: StreamChunkState = { messageId: null, index: 0 };
const eventCounts = new Map<string, number>();

const conversation = new ClaudeCodeBackend({ prepareEnvironment: false }).openConversation({
  prompt: "Count from 1 to 20 in German, one number per line. Then briefly explain in 3 sentences what makes the number 7 special in different cultures.",
  systemPrompt: "This is a streaming smoke test. Answer directly without using tools.",
  model: "haiku",
  cwd,
  turns: "single",
  ephemeral: true,
  streamText: true,
});

const start = Date.now();
let firstChunkAtMs: number | null = null;
let sessionId = "smoke";

try {
  for await (const event of conversation) {
    eventCounts.set(event.type, (eventCounts.get(event.type) ?? 0) + 1);
    if (event.type === "session") sessionId = event.session.nativeId;
    if (event.type === "text.delta") {
      firstChunkAtMs ??= Date.now() - start;
      if (event.messageId !== state.messageId) console.log(`[boundary] message ${event.messageId}`);
      persistStreamChunk(sessionId, event, state, db);
    }
    if (event.type === "turn.finished") {
      console.log(`\nTurn: ${event.result.outcome}, usage ${JSON.stringify(event.result.usage)}`);
      break;
    }
  }
} finally {
  conversation.stop();
  rmSync(cwd, { recursive: true, force: true });
}

const rows = db.prepare("SELECT * FROM web_chat_stream_chunks ORDER BY id ASC").all() as any[];

console.log("\n=== Event types seen ===");
for (const [t, n] of eventCounts) console.log(`  ${t}: ${n}`);
console.log(`\nTime-to-first-chunk: ${firstChunkAtMs ?? "n/a"} ms`);
console.log(`\n=== Persisted chunks (${rows.length}) ===`);
for (const r of rows) {
  console.log(`  [${r.chunk_index}] ${JSON.stringify(r.content_delta)}`);
}

const assembled = rows.map((r) => r.content_delta).join("");
console.log(`\n=== Assembled text ===\n${assembled}`);

db.close();
