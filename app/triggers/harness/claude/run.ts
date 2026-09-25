import { type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, AgentInput, AgentMessage, HarnessRun, RunOutcome, RunResult, SessionRef, SessionSpec } from "../../../lib/harness.ts";
import { EventQueue } from "../events.ts";
import { describeError, harnessError } from "../../../lib/harness/errors.ts";
import { emptyUsage, MessageAccumulator, normalizeUsage, object } from "./normalize.ts";
import { atlasQueryOptions } from "./options.ts";
import type { QueryFactory } from "./conversation.ts";
import { NATIVE_TOOLS } from "./policy.ts";
import { runUsage, type CostSnapshot } from "./usage.ts";

export function startClaudeRun(
  factory: QueryFactory,
  ref: SessionRef, spec: SessionSpec, request: { runId: string; input: AgentInput[] },
  resume: boolean, release: (started: boolean) => void, baseline: CostSnapshot | null,
): HarnessRun {
  const events = new EventQueue<AgentEvent>();
  let sequence = 0;
  type Payload = AgentEvent extends infer E ? E extends AgentEvent ? Omit<E, "sequence" | "runId" | "timestamp"> : never : never;
  const event = (payload: Payload): AgentEvent => ({ ...payload, sequence: sequence++, runId: request.runId, timestamp: new Date().toISOString() });
  const emit = (payload: Payload) => events.push(event(payload));
  let resolve!: (result: RunResult) => void;
  const finished = new Promise<RunResult>((r) => { resolve = r; });
  let q: Query | undefined;
  let ended = false;
  let abortRequested = false;
  let didStart = false;
  const steering: AgentInput[] = [];
  const known = new Set(request.input.map((input) => input.id));
  const applied = new Set<string>();
  let awaitingApplication = request.input.map((input) => input.id);
  const applyInputs = () => {
    for (const id of awaitingApplication) {
      applied.add(id);
      emit({ type: "input.applied", inputId: id });
    }
    awaitingApplication = [];
  };

  // Deferring lets callers subscribe or cancel before the SDK is started.
  queueMicrotask(async () => {
    const startedAt = new Date().toISOString();
    const startedMs = performance.now();
    let usage = emptyUsage();
    let finalMessage: AgentMessage | null = null;
    let outcome: RunOutcome = {
      outcome: "failed", executionState: "stopped", error: { code: "execution", message: "SDK ended without a result" },
    };
    let streamId: string | undefined;
    let toolCalls = 0;
    let compactions = 0;
    const seenCalls = new Set<string>();
    const seenResults = new Set<string>();
    const messages = new MessageAccumulator();
    const observedUsage = new Map<string, Record<string, any>>();
    try {
      if (!abortRequested) {
        const env = { ...process.env, ...spec.toolEnvironment };
        delete env.CLAUDECODE;
        const prompt = request.input.flatMap((input) => input.content.map((part) => part.type === "text"
          ? { type: "text" as const, text: part.text }
          : { type: "image" as const, source: { type: "base64" as const, media_type: part.mimeType, data: part.base64 } }));
        async function* input(): AsyncGenerator<SDKUserMessage> {
          yield { type: "user", session_id: ref.nativeId, parent_tool_use_id: null,
            message: { role: "user", content: prompt as SDKUserMessage["message"]["content"] } };
        }
        const options = atlasQueryOptions({ systemPrompt: spec.systemPrompt, model: spec.model.model.model,
          cwd: spec.cwd, includePartialMessages: true, ...(resume ? { resume: ref.nativeId } : {}) });
        q = factory({ prompt: input(), options: {
          ...options, ...(resume ? {} : { sessionId: ref.nativeId }), env,
          tools: [...new Set(spec.nativeTools.flatMap((capability) => NATIVE_TOOLS[capability]))],
          strictMcpConfig: true, mcpServers: {},
          hooks: { PostToolBatch: [{ hooks: [async () => {
            const pending = steering.splice(0);
            if (!pending.length) return {};
            awaitingApplication.push(...pending.map((input) => input.id));
            return { hookSpecificOutput: { hookEventName: "PostToolBatch" as const,
              additionalContext: pending.flatMap((input) => input.content.map((part) => part.type === "text" ? part.text : "")).join("\n\n") } };
          }] }] },
        } });
        for await (const msg of q) {
          const raw = object(msg);
          if (raw.session_id && raw.session_id !== ref.nativeId)
            throw harnessError("execution", "SDK returned a different session ID");
          didStart = true;
          if (raw.parent_tool_use_id) continue;
          if (msg.type === "stream_event") {
            const stream = object(msg.event);
            if (stream.type === "message_start") { streamId = stream.message?.id; applyInputs(); }
            if (streamId && stream.type === "content_block_delta" && stream.delta?.type === "text_delta")
              emit({ type: "text.delta", messageId: streamId, partIndex: stream.index ?? 0, text: stream.delta.text });
          }
          const message = messages.add(msg);
          if (message) {
            if (message.role === "assistant" && raw.message?.usage)
              observedUsage.set(message.id, object(raw.message.usage));
            if (message.role === "assistant") { applyInputs(); finalMessage = message; }
            emit({ type: "message.completed", message });
            for (const part of message.content) {
              if (part.type === "tool-call" && !seenCalls.has(part.callId)) {
                seenCalls.add(part.callId); toolCalls++;
                emit({ type: "tool.started", callId: part.callId, name: part.name, input: part.input });
              }
              if (part.type === "tool-result" && !seenResults.has(part.callId)) {
                seenResults.add(part.callId);
                emit({ type: "tool.finished", callId: part.callId, content: part.content, isError: part.isError });
              }
            }
          }
          if (msg.type === "system" && msg.subtype === "compact_boundary") { compactions++; emit({ type: "compaction.finished" }); }
          if (msg.type === "result") {
            usage = runUsage(msg, baseline);
            if (msg.subtype === "success" && !finalMessage) finalMessage = {
              id: msg.uuid, role: "assistant", content: [{ type: "text", text: msg.result }], createdAt: new Date().toISOString(),
            };
            outcome = msg.subtype === "success" ? { outcome: "completed", executionState: "stopped" }
              : { outcome: "failed", executionState: "stopped", error: { code: "execution", message: msg.errors.join("\n") } };
            break;
          }
        }
      }
    } catch (error) {
      outcome = { outcome: "failed", executionState: "unknown", error: describeError(error) };
    } finally {
      if (usage.total.completeness === "unavailable" && observedUsage.size) {
        const entries = [...observedUsage.values()];
        const partial: Record<string, number | null> = {};
        for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"])
          partial[key] = entries.every((entry) => typeof entry[key] === "number")
            ? entries.reduce((sum, entry) => sum + entry[key], 0) : null;
        usage = normalizeUsage({ usage: partial });
        usage.total.completeness = "partial";
      }
      // This path owns one local SDK process. Always release it, even when
      // iteration or event publication fails. Closing does not undo tool effects.
      let stopped = true;
      try { q?.close(); } catch { stopped = false; }
      if (!stopped) outcome = { outcome: "failed", executionState: "unknown", error: { code: "transport", message: "Could not stop Claude process" } };
      else if (abortRequested) outcome = { outcome: "aborted", executionState: "stopped" };
      const result: RunResult = {
        ...outcome, runId: request.runId, session: { ...ref }, model: structuredClone(spec.model),
        finalMessage, usage, appliedInputIds: [...applied],
        metrics: { startedAt, endedAt: new Date().toISOString(), durationMs: performance.now() - startedMs,
          modelRequests: null, toolCalls, compactions },
      };
      ended = true;
      release(didStart);
      events.finish(event({ type: "run.finished", result }));
      resolve(result);
    }
  });
  return {
    id: request.runId, events, finished,
    steer: async (input) => {
      if (ended || abortRequested) return { status: "rejected", reason: "run-ended" };
      validateInput(input);
      if (input.content.some((part) => part.type !== "text")) return { status: "rejected", reason: "unsupported" };
      if (!known.has(input.id)) { known.add(input.id); steering.push(structuredClone(input)); }
      return { status: "accepted" };
    },
    abort: async () => {
      if (ended || abortRequested) return;
      abortRequested = true;
      try { await q?.interrupt(); } finally { q?.close(); }
    },
  };
}

export function validateInput(input: AgentInput): void {
  if (!input.id || !input.content.length) throw harnessError("configuration", "Input needs an ID and content");
  for (const part of input.content) {
    if (part.type === "image" && !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(part.mimeType))
      throw harnessError("unsupported", `Unsupported image type ${part.mimeType}`);
  }
}
