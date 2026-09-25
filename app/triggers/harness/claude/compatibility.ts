/**
 * Migration boundary for Atlas' existing long-lived conversation loop.
 * SDK-shaped messages stay here until that coordinator moves to HarnessRun.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Query, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { atlasQueryOptions, type ClaudeOptionsInput } from "./options.ts";

export type QueryFactory = typeof query;
export type Conversation = Query;
export type ConversationResult = SDKResultMessage;
export interface ConversationRequest extends ClaudeOptionsInput {
  prompt: Parameters<typeof query>[0]["prompt"];
  /** Atlas supplies context; the adapter owns the SDK hook protocol. */
  nextToolContext?: () => string | undefined;
}

export function openConversation(request: ConversationRequest, factory: QueryFactory = query): Conversation {
  const { prompt, nextToolContext, ...input } = request;
  const hooks = nextToolContext ? {
    PostToolBatch: [{ hooks: [async () => {
      const context = nextToolContext();
      return context ? {
        hookSpecificOutput: { hookEventName: "PostToolBatch" as const, additionalContext: context },
      } : {};
    }] }],
  } : undefined;
  return factory({ prompt, options: atlasQueryOptions({ ...input, ...(hooks ? { hooks } : {}) }) });
}
