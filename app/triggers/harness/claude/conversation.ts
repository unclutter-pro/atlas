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
import { isSubagentHook, object } from "./normalize.ts";
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

/** Assistant message errors that mean the credential is not accepted. */
const AUTH_ERRORS = new Set(["authentication_failed", "oauth_org_not_allowed"]);
const AUTH_TEXT_RE = /API Error: 401|authentication_error|invalid api key|oauth token (?:has )?(?:expired|been revoked|revoked)|please run \/login|not logged in|failed to authenticate/i;

/**
 * The provider refused the credential. Claude Code marks the assistant message
 * (`error: "authentication_failed"`) and ends the turn with is_error and a
 * text like "Invalid API key · Please run /login"; the text is the fallback.
 */
export function isAuthenticationFailure(result: Record<string, any>, assistantError: string | null = null): boolean {
  if (assistantError && AUTH_ERRORS.has(assistantError)) return true;
  const errored = result.is_error === true || result.subtype !== "success";
  return errored && typeof result.result === "string" && AUTH_TEXT_RE.test(result.result);
}

/**
 * The CLI can also end without a result when it cannot authenticate at all,
 * e.g. "Failed to authenticate: OAuth session expired and could not be
 * refreshed". Such errors surface as HarnessError "authentication".
 */
function authenticationError(err: unknown): unknown {
  const message = err instanceof Error ? err.message : String(err);
  return !(err instanceof Error && "detail" in err) && AUTH_TEXT_RE.test(message) ? harnessError("authentication", message) : err;
}

/**
 * A turn's SDK result message as a TurnResult. Claude reports session totals;
 * `baseline` (the totals before this turn) turns them into turn usage.
 */
export function turnResult(
  result: unknown,
  session: SessionRef | null,
  baseline: CostSnapshot | null,
  assistantError: string | null = null,
): TurnResult {
  const raw = object(result);
  const text = typeof raw.result === "string" ? raw.result : null;
  const authFailed = isAuthenticationFailure(raw, assistantError);
  const failed = raw.subtype !== "success" || authFailed;
  let error: HarnessError | null = null;
  if (authFailed) {
    error = { code: "authentication", message: text || "Authentication failed" };
  } else if (isInvalidRequest(text)) {
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
    PostToolBatch: [{ hooks: [async (hookInput) => {
      if (isSubagentHook(hookInput)) return {};
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
    // Error of the turn's last top-level assistant message (SDKAssistantMessageError).
    let assistantError: string | null = null;
    try {
      for await (const msg of q) {
        const raw = object(msg);
        const sid = typeof raw.session_id === "string" && raw.session_id ? raw.session_id : null;
        if (raw.type === "result") {
          if (sid) session = sessionRef(sid);
          const result = turnResult(raw, session, totals, assistantError);
          assistantError = null;
          totals = totalsAfter(raw);
          yield { type: "turn.finished", result };
          continue;
        }
        if (raw.type === "system" && raw.subtype === "background_tasks_changed") {
          const tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
          // Ambient tasks (watchers, skip_transcript) aren't activity; the SDK
          // docs say to exclude them from "is background work running" checks.
          const count = tasks.filter((t: unknown) => !object(t).ambient).length;
          channel?.setBackgroundTaskCount(count);
          yield { type: "background-tasks", count };
          continue;
        }
        // task_started/task_progress/task_notification are the per-task edges behind
        // the background_tasks_changed level signal above — used for stall detection,
        // check-ins and crash recovery (see triggers/background-tasks.ts).
        if (raw.type === "system" && raw.subtype === "task_started") {
          if (!raw.ambient) {
            yield {
              type: "background-task-started",
              taskId: String(raw.task_id),
              taskType: typeof raw.task_type === "string" ? raw.task_type : "",
              description: typeof raw.description === "string" ? raw.description : "",
            };
          }
          continue;
        }
        if (raw.type === "system" && raw.subtype === "task_progress") {
          yield { type: "background-task-progress", taskId: String(raw.task_id) };
          continue;
        }
        if (raw.type === "system" && raw.subtype === "task_notification") {
          yield {
            type: "background-task-done",
            taskId: String(raw.task_id),
            outputFile: typeof raw.output_file === "string" ? raw.output_file : null,
          };
          continue;
        }
        if (sid && sid !== session?.nativeId) {
          session = sessionRef(sid);
          yield { type: "session", session };
        }
        if (raw.type === "assistant" && !raw.parent_tool_use_id) {
          assistantError = typeof raw.error === "string" ? raw.error : null;
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
    } catch (err) {
      throw authenticationError(err);
    } finally {
      stop();
    }
  }

  const iterator = events();
  return {
    [Symbol.asyncIterator]: () => iterator,
    push(text: string) {
      if (!channel) throw harnessError("unsupported", "A single-turn conversation takes no further input");
      return channel.push(text);
    },
    interrupt: async () => {
      await q.interrupt();
    },
    stop,
  };
}
