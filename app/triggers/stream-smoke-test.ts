/**
 * Smoke test: verify the Claude Agent SDK actually emits stream_event
 * messages with the shape we expect (`content_block_delta` with
 * `delta.text_delta`), and that persistStreamChunk records them.
 *
 * Run with:  cd app/triggers && bun stream-smoke-test.ts
 *
 * NOT part of the automated suite — requires a working Claude CLI on PATH
 * and authenticated credentials. Used to validate the streaming PR locally.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { Database } from "bun:sqlite";
import { persistStreamChunk, type StreamChunkState } from "./trigger-runner.ts";

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

let uuid: string | null = null;
let idx = 0;
const state: StreamChunkState = {
  setUuid: (u) => { uuid = u; idx = 0; console.log(`[boundary] message_start uuid=${u}`); },
  uuidRef: () => uuid,
  nextIndex: () => idx++,
};

const eventCounts = new Map<string, number>();
const innerEventCounts = new Map<string, number>();

const q = query({
  prompt: "Count from 1 to 20 in German, one number per line. Then briefly explain in 3 sentences what makes the number 7 special in different cultures.",
  options: {
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    model: "claude-haiku-4-5",
    disallowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch", "Task"],
    cwd: process.env.HOME ?? "/tmp",
    persistSession: false,
    pathToClaudeCodeExecutable: "/usr/bin/claude",
  },
});

const start = Date.now();
let firstChunkAtMs: number | null = null;

for await (const msg of q) {
  const type = msg.type;
  eventCounts.set(type, (eventCounts.get(type) ?? 0) + 1);

  if (msg.type === "stream_event") {
    const inner = (msg as any).event?.type ?? "unknown";
    innerEventCounts.set(inner, (innerEventCounts.get(inner) ?? 0) + 1);
    if (inner === "content_block_delta" && firstChunkAtMs === null) {
      firstChunkAtMs = Date.now() - start;
    }
    persistStreamChunk(
      msg as any,
      state,
      db,
    );
  }

  if (msg.type === "result") {
    break;
  }
}

const rows = db.prepare("SELECT * FROM web_chat_stream_chunks ORDER BY id ASC").all() as any[];

console.log("\n=== Event types seen ===");
for (const [t, n] of eventCounts) console.log(`  ${t}: ${n}`);
console.log("\n=== stream_event inner types ===");
for (const [t, n] of innerEventCounts) console.log(`  ${t}: ${n}`);
console.log(`\nTime-to-first-chunk: ${firstChunkAtMs ?? "n/a"} ms`);
console.log(`\n=== Persisted chunks (${rows.length}) ===`);
for (const r of rows) {
  console.log(`  [${r.chunk_index}] ${JSON.stringify(r.content_delta)}`);
}

const assembled = rows.map(r => r.content_delta).join("");
console.log(`\n=== Assembled text ===\n${assembled}`);

db.close();
