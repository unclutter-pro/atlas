/**
 * Runner → web-ui pings for the live chat.
 *
 * The trigger runner tells the web-ui that something changed for a chat
 * (turn started, text streamed, transcript grew, turn ended) by POSTing a tiny
 * JSON event to the web-ui's Unix socket. Pings are hints only: the web-ui
 * re-reads the DB/JSONL itself, so a lost ping costs latency, never data.
 * Nothing here ever throws or blocks the runner.
 */

import { join } from "path";

export type ChatNotifyKind = "session" | "turn_start" | "chunk" | "message" | "turn_end" | "run_end";

export interface ChatNotifyEvent {
  v: 1;
  trigger: string;
  sessionKey: string;
  sessionId: string | null;
  kind: ChatNotifyKind;
  isError?: boolean;
  interrupted?: boolean;
}

const KINDS: ReadonlySet<string> = new Set<ChatNotifyKind>(["session", "turn_start", "chunk", "message", "turn_end", "run_end"]);
const KEY_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const TRIGGER_RE = /^[a-zA-Z0-9_.-]{1,128}$/;
/** Pings that arrive at a high rate while text streams; the rest are once per turn. */
const THROTTLED: ReadonlySet<ChatNotifyKind> = new Set<ChatNotifyKind>(["chunk", "message"]);

/** Web-ui notify socket. ATLAS_WEB_UI_NOTIFY_SOCKET overrides the default under ~/.index. */
export function notifySocketPath(home = process.env.HOME!): string {
  return process.env.ATLAS_WEB_UI_NOTIFY_SOCKET || join(home, ".index", "web-ui.sock");
}

/** Strict validation of an incoming ping body. */
export function parseNotifyEvent(body: unknown): ChatNotifyEvent | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  if (b.v !== 1) return null;
  if (typeof b.trigger !== "string" || !TRIGGER_RE.test(b.trigger)) return null;
  if (typeof b.sessionKey !== "string" || !KEY_RE.test(b.sessionKey)) return null;
  if (b.sessionId != null && (typeof b.sessionId !== "string" || !ID_RE.test(b.sessionId))) return null;
  if (typeof b.kind !== "string" || !KINDS.has(b.kind)) return null;
  if (b.isError !== undefined && typeof b.isError !== "boolean") return null;
  if (b.interrupted !== undefined && typeof b.interrupted !== "boolean") return null;
  const event: ChatNotifyEvent = {
    v: 1,
    trigger: b.trigger,
    sessionKey: b.sessionKey,
    sessionId: (b.sessionId as string | null | undefined) ?? null,
    kind: b.kind as ChatNotifyKind,
  };
  if (b.isError !== undefined) event.isError = b.isError as boolean;
  if (b.interrupted !== undefined) event.interrupted = b.interrupted as boolean;
  return event;
}

export interface WebUiNotifier {
  /** Fire-and-forget; never throws, never awaited. */
  ping(e: Omit<ChatNotifyEvent, "v">): void;
  /** Send throttled pings now and wait (bounded) for in-flight requests. */
  flush(maxWaitMs?: number): Promise<void>;
}

/**
 * Pings are sent one at a time (so the web-ui sees them in order: a
 * turn_end never overtakes the turn_start of the next turn). `chunk` and
 * `message` are trailing-throttled per session key; any other kind supersedes
 * a pending throttled ping, since the web-ui re-reads everything on those.
 * When `maxInFlight` pings are queued, new ones are dropped.
 */
export function createWebUiNotifier(opts: {
  socketPath?: string;
  throttleMs?: number;
  maxInFlight?: number;
  timeoutMs?: number;
} = {}): WebUiNotifier {
  const socketPath = opts.socketPath ?? notifySocketPath();
  const throttleMs = opts.throttleMs ?? 40;
  const maxInFlight = opts.maxInFlight ?? 4;
  const timeoutMs = opts.timeoutMs ?? 1000;

  let queued = 0;
  let chain: Promise<void> = Promise.resolve();
  const lastSent = new Map<string, number>();
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; event: ChatNotifyEvent }>();

  const send = (event: ChatNotifyEvent): void => {
    if (queued >= maxInFlight) return;
    queued++;
    const body = JSON.stringify(event);
    chain = chain
      .then(() =>
        fetch("http://web-ui/notify", {
          method: "POST",
          unix: socketPath,
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        } as RequestInit),
      )
      .then((res) => res.body?.cancel())
      .catch(() => {})
      .finally(() => {
        queued--;
      });
  };

  const sendThrottled = (k: string) => {
    const p = pending.get(k);
    if (!p) return;
    pending.delete(k);
    lastSent.set(k, Date.now());
    send(p.event);
  };

  return {
    ping(e) {
      try {
        const event: ChatNotifyEvent = { v: 1, ...e };
        const k = `${event.trigger}\u0000${event.sessionKey}`;
        if (!THROTTLED.has(event.kind)) {
          const p = pending.get(k);
          if (p) {
            clearTimeout(p.timer);
            pending.delete(k);
          }
          send(event);
          return;
        }
        const p = pending.get(k);
        if (p) {
          p.event = event;
          return;
        }
        const since = Date.now() - (lastSent.get(k) ?? 0);
        if (since >= throttleMs) {
          lastSent.set(k, Date.now());
          send(event);
          return;
        }
        pending.set(k, { event, timer: setTimeout(() => sendThrottled(k), throttleMs - since) });
      } catch {}
    },

    async flush(maxWaitMs = 300) {
      for (const [k, p] of [...pending]) {
        clearTimeout(p.timer);
        sendThrottled(k);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([chain, new Promise<void>((r) => (timer = setTimeout(r, maxWaitMs)))]);
      clearTimeout(timer);
    },
  };
}
