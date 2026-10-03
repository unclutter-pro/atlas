/**
 * EventSource wrapper for GET /ui/api/chat/sessions/:key/stream.
 *
 * The browser retries on its own while readyState is CONNECTING (server sends
 * `retry: 2000`). Once the source is CLOSED (non-200, wrong content type) we
 * ask the snapshot endpoint whether the chat still exists: 404 ends it,
 * anything else reopens with backoff 1 s × 1.6 up to 10 s.
 */

import { CHAT_STREAM_EVENTS, type ChatStreamEvent } from "../../../ui-api/chat/types";

export type Connection = "connecting" | "open" | "reconnecting";

export interface EventSourceLike {
  readonly readyState: number;
  close(): void;
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void;
  onopen: ((ev: Event) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
}

export interface ChatStreamOptions {
  url: string;
  onEvent: (event: ChatStreamEvent) => void;
  onConnection: (c: Connection) => void;
  onNotFound: () => void;
  /** Resolves "missing" on 404; anything else (incl. network errors) means retry. */
  checkExists: () => Promise<"exists" | "missing" | "unknown">;
  createEventSource?: (url: string) => EventSourceLike;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export const BACKOFF_BASE_MS = 1000;
export const BACKOFF_FACTOR = 1.6;
export const BACKOFF_MAX_MS = 10_000;

export function backoffDelay(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, Math.round(BACKOFF_BASE_MS * BACKOFF_FACTOR ** attempt));
}

const CONNECTING = 0;
const CLOSED = 2;

export class ChatStream {
  private es: EventSourceLike | null = null;
  private timer: unknown = null;
  private attempt = 0;
  private closed = false;

  constructor(private readonly opts: ChatStreamOptions) {}

  start(): void {
    this.open();
  }

  close(): void {
    this.closed = true;
    if (this.timer != null) (this.opts.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>);
    this.timer = null;
    this.es?.close();
    this.es = null;
  }

  private open(): void {
    if (this.closed) return;
    const es = (this.opts.createEventSource ?? ((u: string) => new EventSource(u)))(this.opts.url);
    this.es = es;
    es.onopen = () => {
      if (this.es !== es) return;
      this.attempt = 0;
      this.opts.onConnection("open");
    };
    es.onerror = () => {
      if (this.es !== es || this.closed) return;
      this.opts.onConnection("reconnecting");
      if (es.readyState === CONNECTING) return;
      if (es.readyState === CLOSED) this.recover(es);
    };
    for (const name of CHAT_STREAM_EVENTS) {
      es.addEventListener(name, (ev) => {
        if (this.es !== es || this.closed) return;
        let data: unknown;
        try {
          data = JSON.parse(ev.data as string);
        } catch {
          return;
        }
        this.opts.onEvent({ event: name, data } as ChatStreamEvent);
        // The server closes the stream after this; don't let the browser reconnect.
        if (name === "session_deleted") this.close();
      });
    }
  }

  private async recover(es: EventSourceLike): Promise<void> {
    es.close();
    this.es = null;
    const exists = await this.opts.checkExists().catch(() => "unknown" as const);
    if (this.closed) return;
    if (exists === "missing") {
      this.close();
      this.opts.onNotFound();
      return;
    }
    const delay = backoffDelay(this.attempt++);
    this.timer = (this.opts.setTimer ?? setTimeout)(() => {
      this.timer = null;
      this.open();
    }, delay);
  }
}
