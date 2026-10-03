/**
 * Server-Sent Events for the chat: GET /ui/api/chat/sessions/:key/stream
 * (ChatStreamEventMap in types.ts), plus the shared keepalive used by the
 * /api/v1 stream (legacy.ts).
 *
 * A connection is only a hub subscription: it does no I/O of its own. One
 * module-level interval writes a pre-encoded keepalive comment to every open
 * stream, and only while at least one is open. 8 s keeps connections under
 * Bun.serve's default 10 s idleTimeout.
 */

import { errorResponse } from "../shared/http";
import { getHub, type HubEvent } from "./hub";
import { ensureSession } from "./service";
import type { ChatStreamEventMap, ChatStreamEventName } from "./types";

const encoder = new TextEncoder();
const KEEPALIVE = encoder.encode(": keepalive\n\n");
export const KEEPALIVE_MS = 8_000;

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no",
} as const;

// --- heartbeat registry -----------------------------------------------------

const open = new Set<ReadableStreamDefaultController<Uint8Array>>();
let heartbeat: ReturnType<typeof setInterval> | null = null;

export function addHeartbeat(controller: ReadableStreamDefaultController<Uint8Array>): void {
  open.add(controller);
  if (!heartbeat) {
    heartbeat = setInterval(() => {
      for (const c of open) {
        try {
          c.enqueue(KEEPALIVE);
        } catch {
          open.delete(c);
        }
      }
      if (open.size === 0) stopHeartbeat();
    }, KEEPALIVE_MS);
  }
}

export function removeHeartbeat(controller: ReadableStreamDefaultController<Uint8Array>): void {
  open.delete(controller);
  if (open.size === 0) stopHeartbeat();
}

function stopHeartbeat(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

/** Open streams and whether the keepalive interval runs (tests). */
export function heartbeatState(): { streams: number; running: boolean } {
  return { streams: open.size, running: heartbeat !== null };
}

export function encodeEvent(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Stream plumbing shared by both chat streams: subscribe on start, heartbeat,
 * clean up once on cancel / client abort / close().
 */
export function sseResponse(
  req: Request | undefined,
  start: (io: { send: (event: string, data: unknown) => void; close: () => void; raw: (bytes: Uint8Array) => void }) => () => void,
): Response {
  let cleanup: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let done = false;
      let unsubscribe: (() => void) | null = null;
      const finish = () => {
        if (done) return;
        done = true;
        removeHeartbeat(controller);
        unsubscribe?.();
      };
      const raw = (bytes: Uint8Array) => {
        if (done) return;
        try {
          controller.enqueue(bytes);
        } catch {
          finish();
        }
      };
      const io = {
        raw,
        send: (event: string, data: unknown) => raw(encodeEvent(event, data)),
        close: () => {
          finish();
          try {
            controller.close();
          } catch {}
        },
      };
      cleanup = finish;
      addHeartbeat(controller);
      unsubscribe = start(io);
      if (done) unsubscribe();
    },
    cancel() {
      cleanup?.();
    },
  });
  req?.signal?.addEventListener("abort", () => cleanup?.(), { once: true });
  return new Response(stream, { headers: SSE_HEADERS });
}

/** GET /ui/api/chat/sessions/:key/stream */
export function chatStreamResponse(key: string, req?: Request): Response {
  if (!ensureSession(key)) return errorResponse(404, "Chat not found");
  const hub = getHub(key);
  return sseResponse(req, (io) => {
    const send = <K extends ChatStreamEventName>(name: K, data: ChatStreamEventMap[K]) => io.send(name, data);
    io.raw(encoder.encode("retry: 2000\n\n"));
    const sub = hub.subscribe((e: HubEvent) => {
      switch (e.type) {
        case "items_added":
          for (const item of e.items) send("item", { item });
          break;
        case "item_updated":
          send("item_update", { item: e.item });
          break;
        case "chunks": {
          // One delta per streamId per flush.
          const byStream = new Map<string, string>();
          for (const r of e.rows) byStream.set(r.streamId, (byStream.get(r.streamId) ?? "") + r.delta);
          for (const [streamId, text] of byStream) send("delta", { streamId, text });
          break;
        }
        case "run":
          send("run", e.run);
          break;
        case "session":
          send("session", e.session);
          break;
        case "reset":
          send("snapshot", e.snapshot);
          break;
        case "deleted":
          send("session_deleted", { key });
          io.close();
          break;
      }
    });
    send("snapshot", sub.snapshot);
    return sub.unsubscribe;
  });
}
