/**
 * Fixtures for the chat tests. DB-backed tests need a seeded HOME
 * (`bun dev/seed.ts <dir>`; they are skipped otherwise).
 */

import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { getDb, home } from "../shared/env";
import { disposeAllHubs, hubTiming } from "./hub";

export const seeded = existsSync(join(process.env.HOME ?? "", ".atlas-dev-seed"));

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_TIMING = { ...hubTiming };

export function resetHubs(): void {
  disposeAllHubs();
  Object.assign(hubTiming, DEFAULT_TIMING);
}

let seq = 0;
/** Unique chat key + Claude session id with a chat_sessions row and mapping. */
export function makeChat(opts: { mapped?: boolean; title?: string | null } = {}): { key: string; sid: string; file: string } {
  const n = `${Date.now().toString(36)}${(seq++).toString(36)}`;
  const key = `chat-test-${n}`;
  const sid = `sid-test-${n}`;
  const db = getDb();
  db.prepare("INSERT INTO chat_sessions (session_key, channel, title) VALUES (?, 'web', ?)").run(key, opts.title ?? null);
  if (opts.mapped !== false) {
    db.prepare("INSERT INTO trigger_sessions (trigger_name, session_key, session_id) VALUES ('web-chat', ?, ?)").run(key, sid);
  }
  return { key, sid, file: transcriptPath(sid) };
}

export function transcriptPath(sid: string): string {
  return join(home(), ".claude", "projects", "-chat-tests", `${sid}.jsonl`);
}

export function writeTranscript(sid: string, lines: unknown[]): string {
  const file = transcriptPath(sid);
  mkdirSync(join(home(), ".claude", "projects", "-chat-tests"), { recursive: true });
  writeFileSync(file, lines.map((l) => JSON.stringify(l) + "\n").join(""));
  return file;
}

export function appendTranscript(sid: string, lines: unknown[]): void {
  appendFileSync(transcriptPath(sid), lines.map((l) => JSON.stringify(l) + "\n").join(""));
}

export function cleanupChat(key: string, sid?: string): void {
  const db = getDb();
  db.prepare("DELETE FROM chat_sessions WHERE session_key = ?").run(key);
  db.prepare("DELETE FROM messages WHERE channel = 'web' AND session_key = ?").run(key);
  db.prepare("DELETE FROM trigger_sessions WHERE trigger_name = 'web-chat' AND session_key = ?").run(key);
  if (sid) {
    db.prepare("DELETE FROM web_chat_stream_chunks WHERE session_id = ?").run(sid);
    rmSync(transcriptPath(sid), { force: true });
  }
}

export function insertUserMessage(key: string, content: string): number {
  const row = getDb()
    .prepare("INSERT INTO messages (channel, sender, content, session_key) VALUES ('web', 'web-ui', ?, ?) RETURNING id")
    .get(content, key) as { id: number };
  return row.id;
}

export function insertChunks(sid: string, streamId: string, deltas: string[], startIndex = 0): void {
  const stmt = getDb().prepare("INSERT INTO web_chat_stream_chunks (session_id, message_uuid, chunk_index, content_delta) VALUES (?, ?, ?, ?)");
  deltas.forEach((d, i) => stmt.run(sid, streamId, startIndex + i, d));
}

export const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

export function assistantLine(opts: { uuid: string; streamId: string; blocks: unknown[]; stop?: string | null; at?: string }) {
  return {
    type: "assistant",
    uuid: opts.uuid,
    timestamp: opts.at ?? iso(),
    message: { id: opts.streamId, role: "assistant", content: opts.blocks, stop_reason: opts.stop ?? null },
  };
}

export function toolResultLine(opts: { uuid: string; toolUseId: string; content: string; isError?: boolean; at?: string }) {
  return {
    type: "user",
    uuid: opts.uuid,
    timestamp: opts.at ?? iso(),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: opts.toolUseId, content: opts.content, is_error: !!opts.isError }] },
  };
}

/** Incremental SSE reader: `next(name)` resolves with the next event of that name. */
export function sseReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: { event: string; data: any }[] = [];
  const raw: string[] = [];
  let closed = false;

  async function pump(): Promise<boolean> {
    const { value, done } = await reader.read();
    if (done) {
      closed = true;
      return false;
    }
    buffer += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      raw.push(frame);
      const name = frame.match(/^event: (.+)$/m)?.[1];
      const data = frame.match(/^data: (.+)$/m)?.[1];
      if (name) events.push({ event: name, data: data ? JSON.parse(data) : null });
    }
    return true;
  }

  return {
    events,
    raw,
    get closed() {
      return closed;
    },
    /** Wait for the next event named `name` (consumes it and everything before). */
    async next(name: string, timeoutMs = 2000): Promise<any> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const idx = events.findIndex((e) => e.event === name);
        if (idx !== -1) return events.splice(0, idx + 1)[idx]!.data;
        if (closed) throw new Error(`stream closed before "${name}"`);
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`timeout waiting for "${name}" (got ${events.map((e) => e.event).join(",")})`);
        await Promise.race([pump(), sleep(left)]);
      }
    },
    /** Read until the stream closes (or timeout). */
    async untilClosed(timeoutMs = 3000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (!closed && Date.now() < deadline) await Promise.race([pump(), sleep(deadline - Date.now())]);
      if (!closed) throw new Error("stream did not close");
    },
    cancel: () => reader.cancel().catch(() => {}),
  };
}
