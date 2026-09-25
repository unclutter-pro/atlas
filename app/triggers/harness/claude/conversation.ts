/**
 * Atlas' long-lived conversation on the Claude Agent SDK: the runner's
 * multi-turn session with Claude Code's native tools, hooks and subagents.
 * SDK message shapes end here; callers only see ConversationEvents.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, Query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Conversation, ConversationEvent, ConversationRequest, HarnessError, SessionRef, TurnResult,
} from "../../../lib/harness.ts";
import { CLAUDE_BACKEND } from "../../../lib/harness/claude-store.ts";
import { harnessError } from "../../../lib/harness/errors.ts";
import { createMessageChannel } from "./message-channel.ts";
import { object } from "./normalize.ts";
import { atlasQueryOptions } from "./options.ts";
import { runUsage, ZERO_COST, type CostSnapshot } from "./usage.ts";

export type QueryFactory = typeof query;

/**
 * Claude Code reports a request the API rejected as result text
 * ("API Error: 400 {...}"), e.g. an image above the per-image or per-request
 * limit. The stored context then fails the same way on every resume.
 */
export function isInvalidRequest(text: string | null | undefined): boolean {
  return typeof text === "string" && text.startsWith("API Error: 400");
}

/**
 * A turn's SDK result message as a TurnResult. Claude reports session totals;
 * `baseline` (the totals before this turn) turns them into turn usage.
 */
export function turnResult(result: unknown, session: SessionRef | null, baseline: CostSnapshot | null): TurnResult {
  const raw = object(result);
  const text = typeof raw.result === "string" ? raw.result : null;
  const failed = raw.subtype !== "success";
  let error: HarnessError | null = null;
  if (isInvalidRequest(text)) {
    error = { code: "invalid-request", message: text! };
  } else if (failed) {
    const errors = Array.isArray(raw.errors) ? raw.errors.filter((e: unknown) => typeof e === "string") : [];
    error = { code: "execution", message: errors.join("\n") || text || String(raw.subtype ?? "error") };
  }
  return {
    outcome: failed ? "failed" : "completed",
    text,
    error,
    session,
    turns: typeof raw.num_turns === "number" ? raw.num_turns : null,
    durationMs: typeof raw.duration_ms === "number" ? raw.duration_ms : null,
    usage: runUsage(raw, baseline).total,
  };
}

/** Session totals after a result, the next turn's baseline. */
function totalsAfter(result: Record<string, any>): CostSnapshot | null {
  return typeof result.total_cost_usd === "number" && result.modelUsage && typeof result.modelUsage === "object"
    ? { total_cost_usd: result.total_cost_usd, modelUsage: result.modelUsage }
    : null;
}

const sessionRef = (nativeId: string): SessionRef => ({ backend: CLAUDE_BACKEND, nativeId });

/**
 * `baseline`: the stored session's totals before a resume (null when unknown;
 * turn cost is then reported as unknown instead of the whole session's).
 */
export function openConversation(
  request: ConversationRequest,
  factory: QueryFactory = query,
  baseline: CostSnapshot | null = ZERO_COST,
): Conversation {
  const channel = request.turns === "multi" ? createMessageChannel("pending", request.idleTimeoutMs) : null;
  channel?.push(request.prompt);
  const { nextToolContext } = request;
  const hooks: Options["hooks"] | undefined = nextToolContext ? {
    PostToolBatch: [{ hooks: [async () => {
      const context = nextToolContext();
      return context ? {
        hookSpecificOutput: { hookEventName: "PostToolBatch" as const, additionalContext: context },
      } : {};
    }] }],
  } : undefined;
  const q: Query = factory({
    prompt: channel ? channel.generator : request.prompt,
    options: atlasQueryOptions({
      systemPrompt: request.systemPrompt,
      model: request.model,
      cwd: request.cwd,
      mcpServers: request.mcpServers as Options["mcpServers"],
      ...(request.resume ? { resume: request.resume.nativeId } : {}),
      ...(request.ephemeral ? { persistSession: false } : {}),
      ...(request.streamText ? { includePartialMessages: true } : {}),
      ...(hooks ? { hooks } : {}),
    }),
  });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    channel?.close();
    try {
      q.close();
    } catch {}
  };

  async function* events(): AsyncGenerator<ConversationEvent> {
    let session: SessionRef | null = null;
    let totals = baseline;
    // Anthropic message id of the message being streamed (message_start).
    let streamId: string | null = null;
    try {
      for await (const msg of q) {
        const raw = object(msg);
        const sid = typeof raw.session_id === "string" && raw.session_id ? raw.session_id : null;
        if (raw.type === "result") {
          if (sid) session = sessionRef(sid);
          const result = turnResult(raw, session, totals);
          totals = totalsAfter(raw);
          yield { type: "turn.finished", result };
          continue;
        }
        if (sid && sid !== session?.nativeId) {
          session = sessionRef(sid);
          yield { type: "session", session };
        }
        if (raw.type === "assistant" || raw.type === "user") {
          yield { type: "message", role: raw.type, nested: !!raw.parent_tool_use_id };
        }
        if (raw.type === "stream_event") {
          const event = object(raw.event);
          const delta = object(event.delta);
          if (event.type === "message_start" && typeof event.message?.id === "string") {
            streamId = event.message.id;
          } else if (streamId && event.type === "content_block_delta" && delta.type === "text_delta"
            && typeof delta.text === "string" && delta.text) {
            yield { type: "text.delta", messageId: streamId, text: delta.text };
          }
        }
      }
    } finally {
      stop();
    }
  }

  const iterator = events();
  return {
    [Symbol.asyncIterator]: () => iterator,
    push(text: string) {
      if (!channel) throw harnessError("unsupported", "A single-turn conversation takes no further input");
      channel.push(text);
    },
    interrupt: async () => {
      await q.interrupt();
    },
    stop,
  };
}
