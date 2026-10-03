/**
 * Anthropic list prices, for costs estimated from stored usage.
 * Source: https://platform.claude.com/docs/en/about-claude/pricing (2026-09-25).
 * Update this table when models or prices change; nothing else hard-codes prices.
 */

/** USD per 1M tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

/** Cache writes cost 1.25x (5 minutes) or 2x (1 hour) input; reads 0.1x unless noted. */
function price(input: number, output: number, cacheReadMultiplier = 0.1): ModelPrice {
  return { input, output, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2, cacheRead: input * cacheReadMultiplier };
}

/**
 * Model IDs. A listed ID also matches with a date suffix ("-20251001"), a
 * Bedrock version ("-v1:0"), a context suffix ("[1m]") or a Vertex version
 * ("@20251101"); provider prefixes ("us.anthropic.") are ignored.
 */
export const MODEL_PRICES: ReadonlyArray<readonly [id: string, price: ModelPrice]> = [
  ["claude-fable-5-1", price(10, 50, 0.025)],
  ["claude-mythos-5-1", price(10, 50, 0.025)],
  ["claude-fable-5", price(10, 50)],
  ["claude-mythos-5", price(10, 50)],
  ["claude-opus-5-5", price(4, 20, 0.05)],
  ["claude-opus-5", price(5, 25)],
  ["claude-opus-4-8", price(5, 25)],
  ["claude-opus-4-7", price(5, 25)],
  ["claude-opus-4-6", price(5, 25)],
  ["claude-opus-4-5", price(5, 25)],
  ["claude-opus-4-1", price(15, 75)],
  ["claude-opus-4", price(15, 75)],
  ["claude-sonnet-5", price(2, 10)],
  ["claude-sonnet-4-6", price(3, 15)],
  ["claude-sonnet-4-5", price(3, 15)],
  ["claude-sonnet-4", price(3, 15)],
  ["claude-haiku-4-5", price(1, 5)],
  ["claude-3-5-haiku", price(0.8, 4)],
];

/** Unknown IDs of a known family are priced like the family's current model. */
const FAMILY_FALLBACK: ReadonlyArray<readonly [keyword: string, id: string]> = [
  ["fable", "claude-fable-5-1"],
  ["mythos", "claude-mythos-5-1"],
  ["opus", "claude-opus-5-5"],
  ["haiku", "claude-haiku-4-5"],
  ["sonnet", "claude-sonnet-5"],
];

const priceOf = (id: string) => MODEL_PRICES.find(([listed]) => listed === id)![1];

/** Price of a model ID such as "claude-opus-4-8", "claude-haiku-4-5-20251001" or "us.anthropic.claude-sonnet-5". */
export function modelPrice(model: string): ModelPrice {
  const lower = model.toLowerCase();
  const id = lower.includes("claude-") ? lower.slice(lower.indexOf("claude-")) : lower;
  for (const [listed, p] of MODEL_PRICES) {
    if (id.startsWith(listed) && /^(-\d{8})?(-v\d+(:\d+)?)?(\[.*\]|@.*)?$/.test(id.slice(listed.length))) return p;
  }
  const family = FAMILY_FALLBACK.find(([keyword]) => id.includes(keyword));
  return priceOf(family ? family[1] : "claude-sonnet-5");
}

/** Usage fields of one model response, as stored in a transcript. */
export interface ResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  /** "fast": fast mode, 2x on every category. */
  speed?: string;
  /** "us": US-only inference, 1.1x on every category. */
  inference_geo?: string;
}

/** Estimated USD cost of one model response. */
export function responseCost(model: string, usage: ResponseUsage): number {
  const p = modelPrice(model);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const write = n(usage.cache_creation_input_tokens);
  // Without the 5m/1h split, cache writes are priced as 5-minute writes.
  const write1h = Math.min(write, n(usage.cache_creation?.ephemeral_1h_input_tokens));
  const cost =
    n(usage.input_tokens) * p.input +
    n(usage.output_tokens) * p.output +
    n(usage.cache_read_input_tokens) * p.cacheRead +
    (write - write1h) * p.cacheWrite5m +
    write1h * p.cacheWrite1h;
  const speed = usage.speed === "fast" ? 2 : 1;
  const geo = usage.inference_geo === "us" ? 1.1 : 1;
  return (cost * speed * geo) / 1_000_000;
}
