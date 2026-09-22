/**
 * Per-chat live hub: one in-memory model of a chat shared by every open
 * stream (browser tabs, /api/v1 streams, snapshot reads).
 *
 * Event-driven, no polling. A hub re-reads its sources only when told that
 * something changed:
 *   - runner pings (notify-server.ts → notifyChat): turn start/end, new
 *     stream chunks, new transcript lines, session id known;
 *   - fs.watch on the session JSONL;
 *   - local changes from the web-ui itself (notifyLocal: sends, renames,
 *     resets, deletes; notifyAllChats after the kill switch).
 * Each signal only marks parts dirty; one coalesced flush (30 ms) then reads
 * each dirty source once for all subscribers: new user messages by id, new
 * chunk rows by id, new JSONL bytes by offset.
 *
 * The only timer doing I/O is the safety net: while a turn is starting or
 * running and someone is watching, 15 s without any ping or watch event
 * re-derive the run state (lock file + kill(pid, 0) + one query + a 64 KiB
 * tail). It catches runners that died without a turn_end (SIGKILL, OOM) or a
 * trigger.sh that never started. Idle chats cost nothing.
 *
 * Hubs live in a registry on globalThis (survives `bun --hot`) and are
 * disposed 30 s after their last subscriber leaves.
 */

import { existsSync, watch, type FSWatcher } from "fs";
import { isAtlasPaused } from "../../../lib/kill-switch";
import { getLockPath, getSocketPath, isPidAlive, readLockPid } from "../../../lib/trigger-socket";
import type { ChatNotifyEvent } from "../../../lib/web-ui-notify";
import { findSessionFile } from "../activity/transcript";
import { home, paths } from "../shared/env";
import { lastTranscriptAt, loadUserItems, mergeByTime, TranscriptCursor, turnActiveFromTail } from "./conversation";
import * as store from "./store";
import { CHAT_TRIGGER, type ChunkRow } from "./store";
import {
  DEFAULT_SESSION_KEY,
  SNAPSHOT_MAX_ITEMS,
  type ChatItem,
  type ChatRun,
  type ChatRunState,
  type ChatSessionDetail,
  type ChatSessionStats,
  type ChatSnapshot,
  type ChatUserItem,
} from "./types";

export type HubEvent =
  | { type: "items_added"; items: ChatItem[] }
  | { type: "item_updated"; item: ChatItem }
  /** New stream chunk rows, in id order (rows of already finalised messages are left out). */
  | { type: "chunks"; rows: ChunkRow[] }
  | { type: "run"; run: ChatRun }
  | { type: "session"; session: ChatSessionDetail }
  /** State was rebuilt (session replaced/reset, transcript rewritten). */
  | { type: "reset"; snapshot: ChatSnapshot }
  | { type: "deleted" };

export type HubListener = (event: HubEvent) => void;

export type LocalChatEvent =
  | { kind: "user_message"; userMessageId: number; clientId?: string; triggered: boolean }
  | { kind: "session" }
  | { kind: "reset" }
  | { kind: "derive" }
  | { kind: "deleted" };

/** Timings; tests shorten them. */
export const hubTiming = {
  flushMs: 30,
  disposeMs: 30_000,
  safetyMs: 15_000,
  /** A sent message counts as "starting" this long when no runner shows up. */
  startingWindowMs: 60_000,
  /** Re-read the transcript this long after a normal turn end that left drafts open. */
  lateFinalMs: 1_000,
};

export const hubDeps = {
  /** Whether a send can start a runner at all. Outside the container trigger.sh is missing, so no "starting". */
  runnerAvailable: () => existsSync(paths.triggerSh),
};

/** Source reads per hub, for tests and diagnostics. */
export interface HubCounters {
  builds: number;
  flushes: number;
  userReads: number;
  chunkReads: number;
  transcriptReads: number;
  derives: number;
  metaReads: number;
}

type Timer = ReturnType<typeof setTimeout>;

function unref(t: Timer): Timer {
  (t as { unref?: () => void }).unref?.();
  return t;
}

const IDLE: ChatRun = { state: "idle", since: null, canStop: false };

interface Dirty {
  rebuild: boolean;
  relocate: boolean;
  users: boolean;
  chunks: boolean;
  transcript: boolean;
  run: boolean;
  derive: boolean;
  meta: boolean;
  stats: boolean;
}

const CLEAN: Dirty = { rebuild: false, relocate: false, users: false, chunks: false, transcript: false, run: false, derive: false, meta: false, stats: false };

/**
 * Run state from durable sources (no pings): a live runner → running unless
 * the transcript tail shows the turn ended (no file yet counts as running);
 * no runner → starting when a message was sent < 60 s ago, nothing answered
 * it yet and Atlas isn't paused; otherwise idle.
 */
export function deriveRunState(
  key: string,
  ctx: { file: string | null; answeredAfter: (userAtMs: number) => boolean },
): ChatRunState {
  if (isPidAlive(readLockPid(getLockPath(CHAT_TRIGGER, key)))) {
    return !ctx.file || turnActiveFromTail(ctx.file) ? "running" : "idle";
  }
  if (hubDeps.runnerAvailable() && !isAtlasPaused(home())) {
    const last = store.lastUserMessage(key);
    const t = last ? Date.parse(last.at) : NaN;
    if (!Number.isNaN(t) && Date.now() - t < hubTiming.startingWindowMs && !ctx.answeredAfter(t)) return "starting";
  }
  return "idle";
}

export class ChatHub {
  readonly counters: HubCounters = { builds: 0, flushes: 0, userReads: 0, chunkReads: 0, transcriptReads: 0, derives: 0, metaReads: 0 };
  disposed = false;
  sessionId: string | null = null;
  file: string | null = null;
  cursor: TranscriptCursor | null = null;
  run: ChatRun = IDLE;

  private listeners = new Set<HubListener>();
  private detail: ChatSessionDetail | null = null;
  private stats: ChatSessionStats | null = null;
  private items: ChatItem[] = [];
  private truncated = false;
  private drafts = new Map<string, string>();
  /** streamIds that already have their final assistant item (late chunks are ignored). */
  private finalized = new Set<string>();
  private lastUserMessageId = 0;
  private lastChunkId = 0;
  private watcher: FSWatcher | null = null;
  private dirty: Dirty = { ...CLEAN };
  private pendingRun: ChatRunState | null = null;
  private clientIds = new Map<number, string>();
  private flushTimer: Timer | null = null;
  private disposeTimer: Timer | null = null;
  private safetyTimer: Timer | null = null;
  /** One-shot re-read after a normal turn end, for a final JSONL line written after the ping. */
  private lateFinalTimer: Timer | null = null;
  private pendingInterrupted = false;
  /** Last runner ping or JSONL watch event. */
  private lastSignalAt = Date.now();

  constructor(readonly key: string) {
    this.build();
    this.run = this.makeRun(this.derive(), null);
    if (this.run.state === "running") this.loadDraftsFromDb();
    this.scheduleDispose();
  }

  // --- subscription -------------------------------------------------------

  /** Snapshot and subscription in one synchronous step, so no event falls in between. */
  subscribe(listener: HubListener): { snapshot: ChatSnapshot; unsubscribe: () => void } {
    const snapshot = this.snapshot();
    this.listeners.add(listener);
    this.cancelDispose();
    this.armSafety();
    let active = true;
    return {
      snapshot,
      unsubscribe: () => {
        if (!active) return;
        active = false;
        this.listeners.delete(listener);
        if (this.listeners.size === 0) this.scheduleDispose();
        this.armSafety();
      },
    };
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }

  snapshot(): ChatSnapshot {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flush();
    }
    if (this.listeners.size === 0) {
      // Without subscribers the safety net is off: same check, on demand.
      if (this.run.state !== "idle" && Date.now() - this.lastSignalAt >= hubTiming.safetyMs) this.applyRunState(this.derive(), false);
      this.scheduleDispose();
    }
    return this.snapshotNow();
  }

  // --- signals ------------------------------------------------------------

  onPing(e: ChatNotifyEvent): void {
    if (this.disposed) return;
    const d = this.dirty;
    switch (e.kind) {
      case "chunk":
        d.chunks = true;
        break;
      case "message":
        d.chunks = d.transcript = d.run = true;
        break;
      case "session":
        d.relocate = d.meta = true;
        break;
      case "turn_start":
        this.pendingRun = "running";
        // Drafts whose final line never came belong to an earlier turn.
        this.drafts.clear();
        d.relocate = d.chunks = d.transcript = d.run = d.meta = true;
        break;
      case "turn_end":
      case "run_end":
        this.pendingRun = "idle";
        this.pendingInterrupted = e.interrupted === true;
        d.relocate = d.chunks = d.transcript = d.run = d.meta = d.stats = true;
        break;
    }
    this.lastSignalAt = Date.now();
    this.armSafety();
    this.schedule();
  }

  onLocal(e: LocalChatEvent): void {
    if (this.disposed) return;
    const d = this.dirty;
    switch (e.kind) {
      case "user_message":
        d.users = d.meta = true;
        if (e.clientId) this.clientIds.set(e.userMessageId, e.clientId);
        if (e.triggered && this.run.state === "idle" && this.pendingRun === null) {
          this.pendingRun = "starting";
          d.run = true;
        }
        break;
      case "session":
        d.meta = true;
        break;
      case "reset":
        d.rebuild = true;
        break;
      case "derive":
        d.derive = d.run = true;
        break;
      case "deleted":
        this.emit({ type: "deleted" });
        this.dispose();
        return;
    }
    this.schedule();
  }

  private onWatch(): void {
    if (this.disposed) return;
    this.dirty.transcript = true;
    this.lastSignalAt = Date.now();
    this.armSafety();
    this.schedule();
  }

  // --- flush --------------------------------------------------------------

  private schedule(): void {
    if (this.flushTimer || this.disposed) return;
    this.flushTimer = unref(setTimeout(() => this.flush(), hubTiming.flushMs));
  }

  /** Read every dirty source once and emit the changes. */
  flush(): void {
    this.flushTimer = null;
    if (this.disposed) return;
    this.counters.flushes++;
    const d = this.dirty;
    this.dirty = { ...CLEAN };

    if (d.rebuild) {
      this.build();
      const state = this.pendingRun ?? this.derive();
      this.pendingRun = null;
      this.applyRunState(state, false);
      this.emit({ type: "reset", snapshot: this.snapshotNow() });
      this.armSafety();
      return;
    }

    let sessionChanged = false;
    if (d.relocate) {
      const sid = store.getMappedSessionId(this.key);
      if (sid !== this.sessionId) {
        this.build();
        this.lastChunkId = 0; // the new session's chunks all belong to the running turn
        this.emit({ type: "reset", snapshot: this.snapshotNow() });
        d.chunks = true;
        d.users = d.transcript = false;
        sessionChanged = true;
      }
    }
    if (!this.cursor && this.sessionId && (d.transcript || d.relocate)) {
      // The JSONL of a new session appears after its first ping: retry on each.
      const file = findSessionFile(this.sessionId);
      if (file) {
        this.setFile(file);
        d.transcript = true;
      }
    }

    // Activity that proves a turn is running (for starting/idle → running).
    let activity = false;

    if (d.users) {
      this.counters.userReads++;
      const added = loadUserItems(this.key, this.lastUserMessageId);
      if (added.length) {
        this.lastUserMessageId = added[added.length - 1]!.messageId;
        this.items.push(...added);
        this.trim();
        this.emit({
          type: "items_added",
          items: added.map((it): ChatUserItem => {
            const clientId = this.clientIds.get(it.messageId);
            if (clientId === undefined) return it;
            this.clientIds.delete(it.messageId);
            return { ...it, clientId };
          }),
        });
      }
    }

    if (d.chunks && this.sessionId) {
      const fresh: ChunkRow[] = [];
      for (;;) {
        this.counters.chunkReads++;
        const rows = store.chunksAfter(this.sessionId, this.lastChunkId, 500);
        if (rows.length === 0) break;
        this.lastChunkId = rows[rows.length - 1]!.id;
        for (const r of rows) {
          if (this.finalized.has(r.streamId)) continue;
          this.drafts.set(r.streamId, (this.drafts.get(r.streamId) ?? "") + r.delta);
          fresh.push(r);
        }
        if (rows.length < 500) break;
      }
      if (fresh.length) {
        activity = true;
        this.emit({ type: "chunks", rows: fresh });
      }
    }

    if (d.transcript && this.cursor) {
      this.counters.transcriptReads++;
      const r = this.cursor.readNew();
      if (r.reset) {
        this.build();
        this.emit({ type: "reset", snapshot: this.snapshotNow() });
      } else {
        for (const it of r.added) {
          this.items.push(it);
          if (it.kind === "assistant" && it.streamId) {
            this.drafts.delete(it.streamId);
            this.finalized.add(it.streamId);
          }
        }
        this.trim();
        if (r.added.length) {
          if (this.run.state === "starting") activity = true;
          this.emit({ type: "items_added", items: r.added });
        }
        for (const it of r.updated) this.emit({ type: "item_updated", item: it });
      }
    }

    if (d.run || d.derive || activity || this.pendingRun !== null) {
      let state = this.run.state;
      if (activity && state !== "running") state = "running";
      let interrupted = false;
      if (this.pendingRun !== null) {
        state = this.pendingRun;
        interrupted = state === "idle" && this.pendingInterrupted;
        this.pendingRun = null;
        this.pendingInterrupted = false;
      }
      if (d.derive) state = this.derive();
      this.applyRunState(state, true, interrupted);
    }

    if (d.meta || d.stats || sessionChanged) this.refreshDetail(d.stats || sessionChanged);
    this.armSafety();
  }

  // --- state helpers ------------------------------------------------------

  /** Load everything from scratch (cold start, reset, new session id). */
  private build(): void {
    this.counters.builds++;
    this.sessionId = store.getMappedSessionId(this.key);
    this.setFile(findSessionFile(this.sessionId), true);
    const users = loadUserItems(this.key);
    this.lastUserMessageId = users.length ? users[users.length - 1]!.messageId : store.maxUserMessageId(this.key);
    const jsonl = this.cursor ? this.cursor.readNew().added : [];
    this.items = mergeByTime(users, jsonl);
    this.truncated = this.cursor?.truncated ?? false;
    this.trim();
    this.finalized = new Set(jsonl.flatMap((it) => (it.kind === "assistant" && it.streamId ? [it.streamId] : [])));
    this.drafts.clear();
    this.lastChunkId = this.sessionId ? store.maxChunkId(this.sessionId) : 0;
    this.refreshDetail(true, false);
  }

  /** On cold start while running: the in-flight message streamed so far. */
  private loadDraftsFromDb(): void {
    if (!this.sessionId) return;
    const rows = store.latestMessageChunks(this.sessionId);
    const streamId = rows[0]?.streamId;
    if (streamId && !this.finalized.has(streamId)) this.drafts.set(streamId, rows.map((r) => r.delta).join(""));
  }

  /** Point the cursor (and watcher) at a file; `fresh` re-reads it from the start. */
  private setFile(file: string | null, fresh = false): void {
    if (!fresh && file === this.file && (file === null || this.cursor)) return;
    this.watcher?.close();
    this.watcher = null;
    this.file = file;
    this.cursor = file ? new TranscriptCursor(file) : null;
    if (!file) return;
    try {
      this.watcher = watch(file, { persistent: false }, () => this.onWatch());
      this.watcher.on("error", () => {
        // Rely on runner pings from here on.
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      this.watcher = null;
    }
  }

  private trim(): void {
    if (this.items.length > SNAPSHOT_MAX_ITEMS) {
      this.items.splice(0, this.items.length - SNAPSHOT_MAX_ITEMS);
      this.truncated = true;
    }
  }

  private derive(): ChatRunState {
    this.counters.derives++;
    if (!this.file && this.sessionId) {
      this.setFile(findSessionFile(this.sessionId));
      if (this.cursor) {
        this.dirty.transcript = true;
        this.schedule();
      }
    }
    return deriveRunState(this.key, {
      file: this.file,
      answeredAfter: (t) => {
        for (let i = this.items.length - 1; i >= 0; i--) {
          const it = this.items[i]!;
          if (it.kind === "user") return false;
          const at = it.at ? Date.parse(it.at) : NaN;
          if (!Number.isNaN(at) && at >= t) return true;
        }
        return false;
      },
    });
  }

  private makeRun(state: ChatRunState, previous: ChatRun | null, interrupted = false): ChatRun {
    let since: string | null = null;
    if (state !== "idle") {
      if (previous && previous.state === state) since = previous.since;
      else if (!previous && state === "running") {
        // Cold start mid-turn: the turn most likely started with the last message.
        const last = store.lastUserMessage(this.key);
        since = last && Date.now() - Date.parse(last.at) < 6 * 3600_000 ? last.at : new Date().toISOString();
      } else since = new Date().toISOString();
    }
    const canStop = state === "running" && existsSync(getSocketPath(CHAT_TRIGGER, this.key));
    return state === "idle" && interrupted ? { state, since, canStop, interrupted: true } : { state, since, canStop };
  }

  private applyRunState(state: ChatRunState, emit: boolean, interrupted = false): void {
    const next = this.makeRun(state, this.run, interrupted);
    if (next.state === this.run.state && next.canStop === this.run.canStop && !!next.interrupted === !!this.run.interrupted) return;
    this.run = next;
    if (next.state === "idle") {
      // A stopped turn never finalizes its drafts. After a normal end the
      // final JSONL line can land just after the ping: keep the drafts (the
      // item replaces them by streamId) and look once more shortly after.
      if (interrupted) this.drafts.clear();
      else if (this.drafts.size > 0) this.scheduleLateFinalRead();
    }
    if (emit) this.emit({ type: "run", run: next });
  }

  private scheduleLateFinalRead(): void {
    if (this.lateFinalTimer) clearTimeout(this.lateFinalTimer);
    this.lateFinalTimer = unref(
      setTimeout(() => {
        this.lateFinalTimer = null;
        if (this.disposed) return;
        this.dirty.transcript = true;
        this.schedule();
      }, hubTiming.lateFinalMs),
    );
  }

  private refreshDetail(recomputeStats: boolean, emit = true): void {
    this.counters.metaReads++;
    const row = store.getSessionRow(this.key);
    if (recomputeStats || !this.stats) this.stats = store.getStats(this.sessionId);
    const next = row ? { ...store.toSummary(row), sessionId: this.sessionId, stats: this.sessionId ? this.stats : null } : null;
    const changed = JSON.stringify(next) !== JSON.stringify(this.detail);
    this.detail = next;
    if (emit && changed && next) this.emit({ type: "session", session: next });
  }

  private placeholderDetail(): ChatSessionDetail {
    const now = new Date().toISOString();
    return {
      key: this.key,
      title: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      lastActivityAt: now,
      messageCount: 0,
      preview: null,
      sessionId: this.sessionId,
      isDefault: this.key === DEFAULT_SESSION_KEY,
      stats: this.sessionId ? this.stats : null,
    };
  }

  private snapshotNow(): ChatSnapshot {
    return {
      session: this.detail ?? this.placeholderDetail(),
      items: [...this.items],
      drafts: [...this.drafts].map(([streamId, text]) => ({ streamId, text })),
      run: this.run,
      truncated: this.truncated,
    };
  }

  private emit(event: HubEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch (err) {
        console.error(`[chat-hub] listener failed for ${this.key}:`, err);
      }
    }
  }

  // --- timers -------------------------------------------------------------

  private armSafety(): void {
    if (this.safetyTimer) clearTimeout(this.safetyTimer);
    this.safetyTimer = null;
    if (this.disposed || this.listeners.size === 0 || this.run.state === "idle") return;
    this.safetyTimer = unref(
      setTimeout(() => {
        this.safetyTimer = null;
        this.dirty.derive = this.dirty.run = true;
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flush();
      }, hubTiming.safetyMs),
    );
  }

  private scheduleDispose(): void {
    if (this.disposeTimer || this.listeners.size > 0 || this.disposed) return;
    this.disposeTimer = unref(setTimeout(() => this.dispose(), hubTiming.disposeMs));
  }

  private cancelDispose(): void {
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.disposeTimer = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of [this.flushTimer, this.disposeTimer, this.safetyTimer, this.lateFinalTimer]) if (t) clearTimeout(t);
    this.flushTimer = this.disposeTimer = this.safetyTimer = this.lateFinalTimer = null;
    this.watcher?.close();
    this.watcher = null;
    this.listeners.clear();
    const reg = registry();
    if (reg.get(this.key) === this) reg.delete(this.key);
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const REGISTRY = Symbol.for("atlas.web-ui.chat-hubs");

function registry(): Map<string, ChatHub> {
  const g = globalThis as unknown as Record<symbol, Map<string, ChatHub> | undefined>;
  return (g[REGISTRY] ??= new Map());
}

/** The hub for a chat, created (cold start) on first use. */
export function getHub(key: string): ChatHub {
  const reg = registry();
  let hub = reg.get(key);
  if (!hub || hub.disposed) {
    hub = new ChatHub(key);
    reg.set(key, hub);
  }
  return hub;
}

/** The hub if one is live; never creates one. */
export function peekHub(key: string): ChatHub | undefined {
  const hub = registry().get(key);
  return hub && !hub.disposed ? hub : undefined;
}

/** Runner ping (via the notify socket). Chats nobody looks at ignore it. */
export function notifyChat(e: ChatNotifyEvent): void {
  if (e.trigger !== CHAT_TRIGGER) return;
  peekHub(e.sessionKey)?.onPing(e);
}

/** Change made by the web-ui itself. */
export function notifyLocal(key: string, event: LocalChatEvent): void {
  peekHub(key)?.onLocal(event);
}

/** Re-derive every live chat's run state now (after the kill switch). */
export function notifyAllChats(): void {
  for (const hub of registry().values()) hub.onLocal({ kind: "derive" });
}

/** Run state of a chat: the live hub's, else derived from durable sources. */
export function currentRunState(key: string): ChatRunState {
  const hub = peekHub(key);
  if (hub) {
    hub.snapshot(); // applies pending changes
    return hub.run.state;
  }
  const file = findSessionFile(store.getMappedSessionId(key));
  return deriveRunState(key, {
    file,
    answeredAfter: (t) => {
      const at = file ? lastTranscriptAt(file) : null;
      return !!at && Date.parse(at) >= t;
    },
  });
}

/** Test helper: dispose every hub. */
export function disposeAllHubs(): void {
  for (const hub of [...registry().values()]) hub.dispose();
}
