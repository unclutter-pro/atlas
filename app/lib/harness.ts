/**
 * Backend contract implemented by triggers/harness/claude/backend.ts.
 * The current runner uses that adapter's explicit compatibility entry point.
 * Session storage (HarnessSessionStore) is SDK-free and lives in lib/harness/,
 * so the web UI can read sessions without the execution adapter.
 * Semantics and migration plan: docs/harness-interface.md.
 * Keep SDK types, database access and channel routing out of this module.
 */

export type JsonValue =
  | null | boolean | number | string
  | JsonValue[] | { [key: string]: JsonValue };

/** Backend identity is separate from the model provider. */
export interface SessionRef {
  backend: string;
  nativeId: string;
}

export interface ModelRef {
  provider: string;
  model: string;
}

/** Task classes, independent of provider product names. */
export type ModelTier = "strong" | "balanced" | "fast";

export interface ModelProfile {
  model: ModelRef;
  displayName: string;
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
}

/** All three entries are required and must resolve to distinct model refs. */
export type ModelCatalog = { [Tier in ModelTier]: ModelProfile };

/** Persist the resolved model as well as its task tier. */
export interface ModelSelection {
  tier: ModelTier;
  model: ModelRef;
}

export interface HarnessCapabilities {
  resume: boolean;
  steering: "tool-boundary" | "unsupported";
  textStreaming: boolean;
  images: boolean;
  customTools: boolean;
  compactionContext: boolean;
  /** Live means snapshots as usage becomes known, not per-token billing. */
  usageUpdates: "live" | "final-only";
}

export type InputPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; base64: string };

export interface AgentInput {
  /** Atlas delivery ID. Stable across uncertain delivery attempts. */
  id: string;
  content: InputPart[];
}

/** Native coding tools are mapped by adapters, never by Atlas callers. */
export type ToolCapability =
  | "files.read" | "files.write" | "process.exec" | "network.fetch";

export interface SessionSpec {
  cwd: string;
  model: ModelSelection;
  systemPrompt: string;
  /** Per-session tool subprocess environment, never global process.env. */
  toolEnvironment: Record<string, string>;
  /** Exact exposed capability set. Unsupported configurations must fail. */
  nativeTools: ToolCapability[];
}

/** Host callbacks are rebound on resume; closures are not persisted. */
export interface SessionBindings {
  tools: HostTool[];
  /**
   * Required context for every compaction and its continuation. Read-only:
   * do not run this session recursively or ask it to flush memory here.
   * Reject opening a session if this binding cannot be honored.
   */
  compactionContext?: (request: {
    runId: string;
    signal: AbortSignal;
  }) => Promise<string>;
}

export interface HostTool {
  name: string;
  description: string;
  /** JSON Schema object; the host validates arguments before execution. */
  inputSchema: { [key: string]: JsonValue };
  execute: (
    args: JsonValue,
    call: { runId: string; callId: string; signal: AbortSignal },
  ) => Promise<{ content: string; isError?: boolean }>;
}

export interface HarnessBackend {
  readonly id: string;
  readonly capabilities: HarnessCapabilities;
  /** Read access to this backend's persisted sessions. */
  readonly sessions: HarnessSessionStore;

  /**
   * Exactly three deployment-configured profiles. No model/tool execution.
   * Reject missing or duplicate mappings; do not substitute models silently.
   * Authentication or availability can still fail during execution.
   */
  getModels(signal?: AbortSignal): Promise<ModelCatalog>;

  /** Validates the full spec before any model or tool execution. */
  create(
    spec: SessionSpec,
    bindings: SessionBindings,
    signal?: AbortSignal,
  ): Promise<HarnessSession>;

  /** No automatic fallback to a new session on failure. */
  resume(
    ref: SessionRef,
    spec: SessionSpec,
    bindings: SessionBindings,
    signal?: AbortSignal,
  ): Promise<HarnessSession>;

  /** Must not start model execution; may reconnect to backend storage. */
  inspect(ref: SessionRef): Promise<{
    state: "idle" | "running" | "missing" | "unknown";
  }>;

  /** Read without opening a live session. Cursor is opaque to Atlas. */
  history(ref: SessionRef, cursor?: string): Promise<{
    messages: AgentMessage[];
    nextCursor?: string;
  }>;
}

export interface HarnessSession {
  readonly ref: SessionRef;
  readonly model: ModelSelection;

  /**
   * One active run per session. Returns before execution finishes.
   * Atlas assigns a fresh runId to each attempt and persists inputs first.
   * Events are buffered from creation until the single consumer attaches.
   */
  run(request: { runId: string; input: AgentInput[] }): HarnessRun;

  /** Release the local handle while idle; retain persisted history. */
  close(): Promise<void>;
}

export interface HarnessRun {
  readonly id: string;
  /** Ordered, single-consumer stream. Ends after run.finished. */
  readonly events: AsyncIterable<AgentEvent>;
  /**
   * Resolves even on execution failure, independent of event consumption.
   * The same result is emitted in run.finished before this resolves.
   */
  readonly finished: Promise<RunResult>;

  /**
   * Accepted means queued in this live run, not durably delivered.
   * input.applied confirms incorporation into a model request.
   * No implicit conversion into a follow-up run.
   */
  steer(input: AgentInput): Promise<
    | { status: "accepted" }
    | { status: "rejected"; reason: "unsupported" | "run-ended" }
  >;

  /** Idempotent cancellation request; await finished for its outcome. */
  abort(): Promise<void>;
}

export type MessagePart =
  | InputPart
  | { type: "tool-call"; callId: string; name: string; input: JsonValue }
  | { type: "tool-result"; callId: string; content: string; isError: boolean };

export interface AgentMessage {
  /** Stable across live events and history reads. */
  id: string;
  role: "user" | "assistant" | "tool";
  content: MessagePart[];
  createdAt: string;
}

/** Authoritative totals for this run, never cumulative session counters. */
export interface UsageSummary {
  /** Null means unavailable, not zero. All token buckets are disjoint. */
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cost: { currency: "USD"; amount: number; source: "reported" | "estimated" } | null;
  /** Includes internal compaction calls when known; excludes Atlas children. */
  completeness: "complete" | "partial" | "unavailable";
}

/** Cumulative snapshot since this run started; replace, never add snapshots. */
export interface UsageReport {
  total: UsageSummary;
  /**
   * Attribution of the total to actual models, including internal calls.
   * Null if the reported total cannot be fully attributed. Never guess.
   * When present, entries partition the total; they are not additional costs.
   */
  byModel: Array<{ model: ModelRef; usage: UsageSummary }> | null;
}

export interface RunMetrics {
  startedAt: string;
  endedAt: string;
  /** Wall time includes tools and retries; measured with a monotonic clock. */
  durationMs: number;
  /** Observed requests including retries/compaction, null if unavailable. */
  modelRequests: number | null;
  toolCalls: number | null;
  compactions: number | null;
}

export interface HarnessError {
  code:
    | "unsupported" | "authentication" | "rate-limit" | "context-limit"
    | "session-missing" | "session-busy" | "configuration"
    | "transport" | "execution";
  message: string;
}

/** Error shape for operations that fail before or outside an active run. */
export interface HarnessOperationError extends Error {
  detail: HarnessError;
}

export type RunResult = {
  runId: string;
  session: SessionRef;
  model: ModelSelection;
  /** Last completed assistant message, also on abort/failure; not a success flag. */
  finalMessage: AgentMessage | null;
  usage: UsageReport;
  metrics: RunMetrics;
  /** Inputs confirmed incorporated, including initial inputs and steering. */
  appliedInputIds: string[];
} & RunOutcome;

export type RunOutcome =
  | { outcome: "completed"; executionState: "stopped" }
  | { outcome: "aborted"; executionState: "stopped" }
  | {
      outcome: "failed";
      /** A lost connection does not prove tools stopped executing. */
      executionState: "stopped" | "unknown";
      error: HarnessError;
    }
;

export type AgentEvent = {
  /** Monotonic within this run. Not a durable backend replay cursor. */
  sequence: number;
  runId: string;
  timestamp: string;
} & (
  | { type: "input.applied"; inputId: string }
  | {
      type: "text.delta";
      messageId: string;
      partIndex: number;
      text: string;
    }
  | { type: "message.completed"; message: AgentMessage }
  | { type: "tool.started"; callId: string; name: string; input: JsonValue }
  | { type: "tool.finished"; callId: string; content: string; isError: boolean }
  | { type: "compaction.started" }
  | { type: "compaction.finished" }
  | { type: "usage.updated"; usage: UsageReport }
  | { type: "run.finished"; result: RunResult }
);

// ---------------------------------------------------------------------------
// Session storage: read-only, no model execution, no SDK.
// Every Atlas reader of session history or metadata (web UI, runner recovery,
// cost aggregation) goes through this instead of backend files.
// ---------------------------------------------------------------------------

/** Opaque read position. Only pass it back to the store that returned it. */
export type HistoryPosition = string;

/**
 * One stored conversation event, in storage order. A tool result is its own
 * entry; readers pair it with its call by callId.
 */
export type HistoryEntry = {
  /** Stable across reads of the same storage; unique within the session. */
  id: string;
  /** ISO timestamp, null when the backend did not record one. */
  at: string | null;
  /** Written by a nested agent inside this session, not the main conversation. */
  nested: boolean;
} & (
  | { kind: "user-text"; text: string }
  | {
      kind: "assistant-text";
      text: string;
      /**
       * Equals the messageId of this message's live text.delta events
       * (AgentMessage.id), so streamed drafts can be replaced by the stored text.
       */
      messageId: string | null;
    }
  | { kind: "reasoning"; text: string }
  | { kind: "tool-call"; callId: string | null; name: string; input: JsonValue }
  | { kind: "tool-result"; callId: string | null; content: string; isError: boolean }
);

export interface HistoryExcerpt {
  entries: HistoryEntry[];
  /** Model of the first assistant message in the excerpt. */
  model: string | null;
  /** Entries before the excerpt exist but were not read (byte budget). */
  truncated: boolean;
  /** Entries outside the requested time window were dropped. */
  windowed: boolean;
}

/** Incremental reader for a live session. Single consumer, not thread-safe. */
export interface HistoryCursor {
  /**
   * Entries stored since the previous read. The first read starts at the tail
   * when the history exceeds initialBytes. reset: storage was rewritten, the
   * reader must drop earlier entries; `entries` then restarts from the tail.
   */
  read(): { entries: HistoryEntry[]; reset: boolean };
  /** After the last complete entry read so far. */
  readonly position: HistoryPosition;
  /** The first read skipped older entries. */
  readonly truncated: boolean;
}

export interface SessionMetadata {
  /** Last write to the session or to any nested agent's storage. */
  lastActivityAt: string | null;
  /** Timestamp of the last user or assistant entry of the main conversation. */
  lastEntryAt: string | null;
  /**
   * From the stored conversation alone: "active" when the agent still owes a
   * response (the last entry is input or a tool call), "ended" otherwise. Only
   * meaningful while a runner owns the session; storage cannot prove liveness.
   */
  turn: "active" | "ended";
}

export interface HarnessSessionStore {
  readonly backend: string;

  /** Reference for a persisted native ID; null when it cannot be this backend's. */
  ref(nativeId: string | null | undefined): SessionRef | null;

  /** Whether the session has stored history. */
  exists(ref: SessionRef): boolean;

  /** Cheap: reads at most the storage tail. Null when the session has no history. */
  metadata(ref: SessionRef): SessionMetadata | null;

  /**
   * Bounded synchronous read for list views: the first or last maxBytes of the
   * stored history. Null when the session has no history.
   */
  excerpt(ref: SessionRef, options: { from: "start" | "end"; maxBytes: number }): HistoryExcerpt | null;

  /**
   * Whole history, or only entries inside [from, to] (a persistent session
   * holds many runs). Without a window, histories above maxBytes are read from
   * the tail. Asynchronous so large sessions do not block the caller.
   */
  load(
    ref: SessionRef,
    options?: { window?: { from: string | null; to: string | null }; maxBytes?: number },
  ): Promise<HistoryExcerpt | null>;

  /**
   * Incremental reader. `until` bounds every read to an earlier cursor's
   * position (a consistent full view next to a live tail).
   */
  cursor(
    ref: SessionRef,
    options?: { initialBytes?: number; until?: HistoryPosition },
  ): HistoryCursor | null;

  /**
   * Calls onChange (debounce on the caller's side) when stored history changes.
   * Returns an unsubscribe function, or null when the backend cannot notify;
   * callers then rely on runner notifications.
   */
  watch(ref: SessionRef, onChange: () => void): (() => void) | null;

  /**
   * Usage of everything the session and its nested agents stored inside
   * [from, to]. Each model request is counted once. Cost is estimated from
   * list prices unless the backend stores reported cost.
   */
  usage(ref: SessionRef, window: { from: string; to: string }): UsageSummary;

  /**
   * The session a file belongs to, for workspace file browsers. `path` is
   * relative to the workspace home. Null for files outside session storage.
   */
  locate(path: string): SessionRef | null;
}
