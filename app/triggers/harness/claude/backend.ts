import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Conversation, ConversationRequest, HarnessBackend, HarnessCapabilities, HarnessSession, ModelTier,
  SessionBindings, SessionRef, SessionSpec,
} from "../../../lib/harness.ts";
import { harnessError } from "../../../lib/harness/errors.ts";
import { ClaudeSessionStore } from "../../../lib/harness/claude-store.ts";
import { claudeModels, MODEL_TIERS, validateModel } from "./models.ts";
import { findTranscript, readHistory, validateRef } from "./history.ts";
import { openConversation, type QueryFactory } from "./conversation.ts";
import { NATIVE_TOOLS } from "./policy.ts";
import { prepareClaudeEnvironment } from "./environment.ts";
import { startClaudeRun, validateInput } from "./run.ts";
import { readCostSnapshot, ZERO_COST } from "./usage.ts";

export interface ClaudeBackendOptions {
  home?: string;
  /**
   * Adjust the process and ~/.claude.json before sessions start (default).
   * Off for checks that run against a developer's own Claude Code setup.
   */
  prepareEnvironment?: boolean;
  models?: Partial<Record<ModelTier, string>>;
  /** Dependency injection for contract tests; production uses the pinned SDK. */
  query?: QueryFactory;
}

export class ClaudeCodeBackend implements HarnessBackend {
  readonly id = "claude-code";
  readonly capabilities: HarnessCapabilities = {
    resume: true, steering: "tool-boundary", textStreaming: true, images: true,
    customTools: false, compactionContext: false, usageUpdates: "final-only",
  };
  readonly sessions: ClaudeSessionStore;
  private readonly home: string;
  private readonly factory: QueryFactory;
  private readonly running = new Set<string>();

  constructor(private readonly options: ClaudeBackendOptions = {}) {
    this.home = options.home ?? process.env.HOME ?? "/home/agent";
    this.sessions = new ClaudeSessionStore(this.home);
    this.factory = options.query ?? query;
  }

  async getModels(signal?: AbortSignal) {
    signal?.throwIfAborted();
    return claudeModels(this.options.models);
  }

  private validate(spec: SessionSpec, bindings: SessionBindings, signal?: AbortSignal) {
    signal?.throwIfAborted();
    validateModel(spec.model.model);
    if (!MODEL_TIERS.includes(spec.model.tier)) throw harnessError("configuration", "Unknown model tier");
    if (bindings.tools.length || bindings.compactionContext)
      throw harnessError("unsupported", "Portable host tools and compaction context are not implemented by this adapter yet");
    if (spec.nativeTools.some((tool) => !Object.hasOwn(NATIVE_TOOLS, tool)))
      throw harnessError("unsupported", "Unknown native tool capability");
  }

  async create(spec: SessionSpec, bindings: SessionBindings, signal?: AbortSignal): Promise<HarnessSession> {
    this.validate(spec, bindings, signal);
    return this.session({ backend: this.id, nativeId: randomUUID() }, spec, false);
  }

  async resume(ref: SessionRef, spec: SessionSpec, bindings: SessionBindings, signal?: AbortSignal): Promise<HarnessSession> {
    this.validate(spec, bindings, signal);
    validateRef(ref);
    if (this.running.has(ref.nativeId)) throw harnessError("session-busy", "Session is running");
    if (!findTranscript(this.sessions, ref)) throw harnessError("session-missing", `Session ${ref.nativeId} has no transcript`);
    return this.session(ref, spec, true);
  }

  async inspect(ref: SessionRef): Promise<{ state: "running" | "missing" | "unknown" }> {
    validateRef(ref);
    if (this.running.has(ref.nativeId)) return { state: "running" };
    try {
      // A transcript cannot prove that a different runner process is idle.
      return { state: findTranscript(this.sessions, ref) ? "unknown" : "missing" };
    } catch { return { state: "unknown" }; }
  }

  history(ref: SessionRef, cursor?: string) { return readHistory(this.sessions, ref, cursor); }

  /** Claude Code's native tools, hooks and subagents behind normalized events. */
  openConversation(request: ConversationRequest): Conversation {
    if (request.resume) validateRef(request.resume);
    this.prepare();
    const baseline = request.resume ? readCostSnapshot(this.sessions, request.resume) : ZERO_COST;
    return openConversation(request, this.factory, baseline);
  }

  private prepare(): void {
    if (this.options.prepareEnvironment !== false) prepareClaudeEnvironment(this.home);
  }

  private session(refInput: SessionRef, specInput: SessionSpec, resumed: boolean): HarnessSession {
    const ref = structuredClone(refInput);
    const spec = structuredClone(specInput);
    let active = false;
    let closed = false;
    let started = resumed;
    return {
      get ref() { return { ...ref }; },
      get model() { return structuredClone(spec.model); },
      run: (request) => {
        if (closed) throw harnessError("configuration", "Session handle is closed");
        if (active || this.running.has(ref.nativeId)) throw harnessError("session-busy", "Session already has an active run");
        if (!request.runId || request.input.length === 0) throw harnessError("configuration", "A run needs an ID and input");
        request.input.forEach(validateInput);
        if (new Set(request.input.map((input) => input.id)).size !== request.input.length)
          throw harnessError("configuration", "Duplicate initial input IDs");
        active = true;
        this.running.add(ref.nativeId);
        this.prepare();
        return startClaudeRun(this.factory, ref, spec, structuredClone(request), started, (didStart) => {
          started ||= didStart;
          active = false;
          this.running.delete(ref.nativeId);
        }, started ? readCostSnapshot(this.sessions, ref) : ZERO_COST);
      },
      close: async () => {
        if (active) throw harnessError("session-busy", "Abort and await the active run before closing");
        closed = true;
      },
    };
  }

}
