import { TalkError, type TalkClient } from "./client.ts";
import { roomAllowed, type TalkConfig } from "./config.ts";
import type { TalkMessage, TalkRoom } from "./events.ts";

type Awaitable<T> = T | Promise<T>;
type ReceiveClient = Pick<TalkClient, "capabilities" | "rooms" | "receive" | "history">;

export interface TalkListenerHooks {
  getCursor(room: string): Awaitable<number | null>;
  /** Must atomically persist messages + events + cursor. A rejected save is replayed. */
  persist(room: TalkRoom, messages: TalkMessage[], cursor: number, options?: { historyOnly?: boolean }): Awaitable<void>;
  onRooms?(rooms: TalkRoom[], snapshotStartedAt: number): Awaitable<void>;
  onRevokedRoom?(room: string): Awaitable<void>;
  onStatus?(status: TalkListenerStatus): Awaitable<void>;
}

export interface TalkListenerStatus {
  state: "starting" | "running" | "backoff" | "auth_failed" | "unsupported" | "stopped";
  mode: "long-poll";
  signaling: "not-implemented";
  roomCount: number;
  activePolls: number;
  maxConnections: number;
  /** Scheduling estimate, excluding server outages or per-room backoff. */
  estimatedMaxPollDelayMs: number;
  discoveryIntervalMs: number;
  lastDiscoveryAt: number | null;
  lastReceiveAt: number | null;
  unsupportedFederatedRooms: string[];
  lastError: { code: string; room?: string; retryAt?: number } | null;
}

interface RoomState {
  room: TalkRoom;
  failures: number;
  retryAt: number;
  catchingUp: boolean;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/** Durable ingestion only. Routing, prompt construction and model calls live elsewhere. */
export class TalkListener {
  private readonly rooms = new Map<string, RoomState>();
  private readonly now: () => number;
  private readonly sleep: typeof sleep;
  private readonly random: () => number;
  private controller: AbortController | null = null;
  private fatal: TalkError | null = null;
  private globalRetryAt = 0;
  private pollInFlight = false;
  private snapshot: TalkListenerStatus;

  constructor(
    readonly config: TalkConfig,
    readonly client: ReceiveClient,
    readonly hooks: TalkListenerHooks,
    options: { now?: () => number; sleep?: typeof sleep; random?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
    this.random = options.random ?? Math.random;
    this.snapshot = {
      state: "starting", mode: "long-poll", signaling: "not-implemented",
      roomCount: 0, activePolls: 0, maxConnections: config.maxConnections,
      estimatedMaxPollDelayMs: 0, discoveryIntervalMs: config.discoveryIntervalMs,
      lastDiscoveryAt: null, lastReceiveAt: null, unsupportedFederatedRooms: [], lastError: null,
    };
  }

  status(): TalkListenerStatus {
    return { ...this.snapshot, unsupportedFederatedRooms: [...this.snapshot.unsupportedFederatedRooms], lastError: this.snapshot.lastError && { ...this.snapshot.lastError } };
  }

  private async report(): Promise<void> {
    this.snapshot.roomCount = this.rooms.size;
    this.snapshot.estimatedMaxPollDelayMs = Math.ceil(this.rooms.size / this.config.maxConnections) * this.config.pollTimeoutSeconds * 1000;
    await this.hooks.onStatus?.(this.status());
  }

  /** Register a newly created DM before sending, without changing its receive cursor. */
  registerRoom(room: TalkRoom): void {
    if (!roomAllowed(this.config, room.token)) throw new TalkError("Talk conversation is excluded by talk.rooms", "forbidden");
    if (room.isFederated) throw new TalkError("Federated Talk conversations are not supported by this transport", "unsupported");
    const old = this.rooms.get(room.token);
    if (old) old.room = room;
    else this.rooms.set(room.token, { room, failures: 0, retryAt: 0, catchingUp: true });
  }

  async refreshRooms(signal?: AbortSignal): Promise<void> {
    const snapshotStartedAt = this.now();
    const discovered = await this.client.rooms(signal);
    const allowed = discovered.filter((room) => roomAllowed(this.config, room.token));
    const local = allowed.filter((room) => !room.isFederated);
    await this.hooks.onRooms?.(local, snapshotStartedAt);
    const tokens = new Set(local.map((room) => room.token));
    for (const room of this.rooms.keys()) {
      if (!tokens.has(room)) {
        await this.hooks.onRevokedRoom?.(room);
        this.rooms.delete(room);
      }
    }
    for (const room of local) this.registerRoom(room);
    this.snapshot.unsupportedFederatedRooms = allowed.filter((room) => room.isFederated).map((room) => room.token);
    this.snapshot.lastDiscoveryAt = this.now();
    await this.report();
  }

  private backoff(failures: number, minimum = 0): number {
    const base = Math.min(this.config.maxBackoffMs, this.config.backoffMs * 2 ** Math.min(failures - 1, 16));
    return Math.max(minimum, Math.round(base * (0.8 + this.random() * 0.4)));
  }

  private failFatal(error: TalkError): void {
    this.fatal = error;
    this.snapshot.state = error.code === "auth" ? "auth_failed" : "unsupported";
    this.snapshot.lastError = { code: error.code };
    this.controller?.abort();
  }

  private async pollRoom(state: RoomState, signal?: AbortSignal): Promise<void> {
    const room = state.room;
    if (signal?.aborted || this.rooms.get(room.token) !== state) return;
    this.snapshot.activePolls++;
    try {
      let cursor = await this.hooks.getCursor(room.token);
      if (cursor === null) {
        // Import unread messages even on first enrollment. A newly discovered DM may
        // already contain its first message; seeding to latest would silently lose it.
        cursor = room.lastReadMessage;
        const context = cursor > 0
          ? (await this.client.history(room.token, { before: cursor + 1, limit: this.config.initialHistoryLimit, signal })).messages.filter((message) => message.id <= cursor!)
          : [];
        await this.hooks.persist(room, context, cursor, { historyOnly: true });
      }
      if (signal?.aborted || !this.rooms.has(room.token)) return;
      const page = await this.client.receive(room.token, { after: cursor, limit: 200, wait: !state.catchingUp, signal });
      if (signal?.aborted || !this.rooms.has(room.token)) return;
      const nextCursor = page.cursor ?? cursor;
      if (!Number.isSafeInteger(nextCursor) || nextCursor < cursor) throw new TalkError("Talk returned an invalid receive cursor", "protocol");
      if (page.messages.length || nextCursor > cursor) await this.hooks.persist(room, page.messages, nextCursor);
      state.catchingUp = page.messages.length >= 200;
      state.failures = 0;
      state.retryAt = 0;
      this.snapshot.lastReceiveAt = this.now();
      if (this.snapshot.lastError?.room === room.token) this.snapshot.lastError = null;
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof TalkError && error.code === "auth") {
        this.failFatal(error);
        throw error;
      }
      if (error instanceof TalkError && ["not_found", "forbidden"].includes(error.code)) {
        // Membership may be restored later; discovery will register it again.
        await this.hooks.onRevokedRoom?.(room.token);
        this.rooms.delete(room.token);
        this.snapshot.lastError = { code: error.code, room: room.token };
      } else {
        state.failures++;
        state.retryAt = this.now() + this.backoff(state.failures, error instanceof TalkError ? error.retryAfterMs ?? 0 : 0);
        if (error instanceof TalkError && error.code === "rate_limited") this.globalRetryAt = Math.max(this.globalRetryAt, state.retryAt);
        this.snapshot.lastError = { code: error instanceof TalkError ? error.code : "persistence", room: room.token, retryAt: state.retryAt };
      }
    } finally {
      this.snapshot.activePolls--;
      await this.report();
    }
  }

  /** One fair pass: at most one bounded page per room, with a fixed connection pool. */
  async pollRound(signal?: AbortSignal): Promise<void> {
    if (this.pollInFlight) throw new Error("A Talk receive round is already running");
    if (this.fatal) throw this.fatal;
    if (this.globalRetryAt > this.now()) return;
    const pending = [...this.rooms.values()].filter((room) => room.retryAt <= this.now());
    this.pollInFlight = true;
    let index = 0;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      const results = await Promise.allSettled(Array.from({ length: Math.min(this.config.maxConnections, pending.length) }, async () => {
        while (!controller.signal.aborted && !this.fatal && this.globalRetryAt <= this.now()) {
          const state = pending[index++];
          if (!state) return;
          try { await this.pollRoom(state, controller.signal); }
          catch (error) { controller.abort(); throw error; }
        }
      }));
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (rejected) throw rejected.reason;
    } finally {
      signal?.removeEventListener("abort", cancel);
      this.pollInFlight = false;
    }
  }

  stop(): void { this.controller?.abort(); }

  async run(signal?: AbortSignal): Promise<void> {
    if (this.controller) throw new Error("Talk listener is already running");
    this.controller = new AbortController();
    const cancel = () => this.stop();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) this.controller.abort();
    const ownSignal = this.controller.signal;
    this.fatal = null;
    let failures = 0;
    try {
      await this.report();
      // Retry initial discovery without requiring a process restart for outages.
      while (!ownSignal.aborted) {
        try {
          await this.client.capabilities(ownSignal, true);
          await this.refreshRooms(ownSignal);
          break;
        } catch (error) {
          if (ownSignal.aborted) break;
          if (error instanceof TalkError && ["auth", "unsupported"].includes(error.code)) { this.failFatal(error); throw error; }
          const delay = this.backoff(++failures, error instanceof TalkError ? error.retryAfterMs ?? 0 : 0);
          this.snapshot.state = "backoff";
          this.snapshot.lastError = { code: error instanceof TalkError ? error.code : "persistence", retryAt: this.now() + delay };
          await this.report();
          await this.sleep(delay, ownSignal);
        }
      }
      if (ownSignal.aborted) return;
      this.snapshot.state = "running";
      this.snapshot.lastError = null;
      await this.report();
      const discover = async () => {
        let failed = 0;
        let delay = this.config.discoveryIntervalMs;
        while (!ownSignal.aborted) {
          await this.sleep(delay, ownSignal);
          if (ownSignal.aborted) break;
          if (this.globalRetryAt > this.now()) { delay = this.globalRetryAt - this.now(); continue; }
          try {
            await this.refreshRooms(ownSignal);
            failed = 0;
            delay = this.config.discoveryIntervalMs;
          } catch (error) {
            if (ownSignal.aborted) break;
            if (error instanceof TalkError && error.code === "auth") { this.failFatal(error); throw error; }
            delay = this.backoff(++failed, error instanceof TalkError ? error.retryAfterMs ?? 0 : 0);
            if (error instanceof TalkError && error.code === "rate_limited") this.globalRetryAt = this.now() + delay;
            this.snapshot.lastError = { code: error instanceof TalkError ? error.code : "persistence", retryAt: this.now() + delay };
            await this.report();
          }
        }
      };
      const receive = async () => {
        while (!ownSignal.aborted) {
          await this.pollRound(ownSignal);
          // Also bound requests on empty rooms or servers that return 304 immediately.
          await this.sleep(Math.max(100, this.globalRetryAt - this.now()), ownSignal);
        }
      };
      // Abort the sibling loop on a fatal callback or authentication error, then drain it.
      const loops = [discover(), receive()].map((loop) => loop.catch((error) => { this.controller?.abort(); throw error; }));
      const results = await Promise.allSettled(loops);
      if (this.fatal) throw this.fatal;
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (rejected) throw rejected.reason;
    } finally {
      this.controller.abort();
      this.controller = null;
      signal?.removeEventListener("abort", cancel);
      if (!this.fatal) this.snapshot.state = "stopped";
      await this.report();
    }
  }
}
