import type { AgentMessage, MessagePart, UsageReport, UsageSummary } from "../../../lib/harness.ts";

export function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export function emptyUsage(): UsageReport {
  return { total: { inputTokens: null, outputTokens: null, cacheReadTokens: null,
    cacheWriteTokens: null, cost: null, completeness: "unavailable" }, byModel: null };
}

export function normalizeUsage(result: unknown): UsageReport {
  const raw = object(result);
  const usage = object(raw.usage);
  const total: UsageSummary = {
    inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens),
    cacheReadTokens: number(usage.cache_read_input_tokens),
    cacheWriteTokens: number(usage.cache_creation_input_tokens),
    cost: number(raw.total_cost_usd) === null ? null : {
      currency: "USD", amount: raw.total_cost_usd, source: "reported",
    },
    completeness: "partial",
  };
  const keys = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
  if (keys.every((key) => total[key] !== null) && total.cost !== null) total.completeness = "complete";
  if (keys.every((key) => total[key] === null) && total.cost === null) total.completeness = "unavailable";
  const byModel = Object.entries(object(raw.modelUsage)).map(([model, value]) => {
    const entry = object(value);
    return { model: { provider: "anthropic", model }, usage: normalizeUsage({
      usage: { input_tokens: entry.inputTokens, output_tokens: entry.outputTokens,
        cache_read_input_tokens: entry.cacheReadInputTokens,
        cache_creation_input_tokens: entry.cacheCreationInputTokens },
      total_cost_usd: entry.costUSD,
    }).total };
  });
  const matches = byModel.length > 0 && keys.every((key) => total[key] !== null &&
    byModel.every((entry) => entry.usage[key] !== null) &&
    byModel.reduce((sum, entry) => sum + entry.usage[key]!, 0) === total[key]) &&
    total.cost !== null && byModel.every((entry) => entry.usage.cost !== null) &&
    Math.abs(byModel.reduce((sum, entry) => sum + entry.usage.cost!.amount, 0) - total.cost.amount) < 1e-8;
  return { total, byModel: matches ? byModel : null };
}

/** Preserve API message IDs used by the existing UI to join deltas and history. */
export function normalizeMessage(value: unknown): AgentMessage | null {
  const raw = object(value);
  if (raw.type !== "assistant" && raw.type !== "user") return null;
  if (raw.parent_tool_use_id || raw.isSidechain) return null;
  const message = object(raw.message);
  const id = message.id ?? raw.uuid;
  if (typeof id !== "string") return null;
  const content: MessagePart[] = [];
  const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }]
    : Array.isArray(message.content) ? message.content : [];
  for (const value of blocks) {
    const block = object(value);
    if (block.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text });
    if (block.type === "tool_use") content.push({ type: "tool-call", callId: block.id, name: block.name, input: block.input });
    if (block.type === "tool_result") content.push({ type: "tool-result", callId: block.tool_use_id,
      content: typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? []), isError: !!block.is_error });
    if (block.type === "image" && block.source?.type === "base64") content.push({
      type: "image", mimeType: block.source.media_type, base64: block.source.data,
    });
  }
  return { id, role: raw.type, content, createdAt: raw.timestamp ?? "" };
}

/** Claude may emit several content blocks with one API message ID. */
export class MessageAccumulator {
  private readonly fragments = new Map<string, Map<string, AgentMessage>>();
  readonly messages = new Map<string, AgentMessage>();

  add(raw: unknown): AgentMessage | null {
    const message = normalizeMessage(raw);
    if (!message) return null;
    const fragments = this.fragments.get(message.id) ?? new Map<string, AgentMessage>();
    fragments.set(object(raw).uuid ?? message.id, message);
    this.fragments.set(message.id, fragments);
    const combined = { ...message, content: [...fragments.values()].flatMap((part) => part.content) };
    this.messages.set(message.id, combined);
    return combined;
  }
}
