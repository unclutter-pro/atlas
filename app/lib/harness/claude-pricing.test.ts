import { describe, expect, test } from "bun:test";
import { modelPrice, responseCost } from "./claude-pricing.ts";

describe("modelPrice", () => {
  test("current list prices by model ID", () => {
    expect(modelPrice("claude-opus-5-5")).toMatchObject({ input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 });
    expect(modelPrice("claude-opus-5")).toMatchObject({ input: 5, output: 25, cacheRead: 0.5 });
    expect(modelPrice("claude-opus-4-8")).toMatchObject({ input: 5, output: 25 });
    expect(modelPrice("claude-opus-4-1-20250805")).toMatchObject({ input: 15, output: 75, cacheRead: 1.5 });
    expect(modelPrice("claude-opus-4-20250514")).toMatchObject({ input: 15, output: 75 });
    expect(modelPrice("claude-fable-5-1")).toMatchObject({ input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 });
    expect(modelPrice("claude-fable-5")).toMatchObject({ input: 10, cacheRead: 1 });
    expect(modelPrice("claude-sonnet-5")).toMatchObject({ input: 2, output: 10, cacheRead: 0.2 });
    expect(modelPrice("claude-sonnet-4-6")).toMatchObject({ input: 3, output: 15 });
    expect(modelPrice("claude-haiku-4-5-20251001")).toMatchObject({ input: 1, output: 5, cacheRead: 0.1 });
    expect(modelPrice("claude-3-5-haiku-20241022")).toMatchObject({ input: 0.8, output: 4 });
  });

  test("ignores context suffixes and provider prefixes; never matches a longer version", () => {
    expect(modelPrice("claude-opus-5-5[1m]")).toMatchObject({ input: 4 });
    expect(modelPrice("us.anthropic.claude-sonnet-5")).toMatchObject({ input: 2 });
    expect(modelPrice("anthropic.claude-opus-4-1-20250805-v1:0")).toMatchObject({ input: 15 });
    expect(modelPrice("claude-opus-4-5@20251101")).toMatchObject({ input: 5 });
    expect(modelPrice("claude-opus-4-50")).toMatchObject({ input: 4, output: 20 }); // unknown → family fallback (Opus 5.5)
  });

  test("unknown IDs fall back to their family's current model, else Sonnet", () => {
    expect(modelPrice("claude-opus-9")).toMatchObject({ input: 4 });
    expect(modelPrice("claude-haiku-7")).toMatchObject({ input: 1 });
    expect(modelPrice("<synthetic>")).toMatchObject({ input: 2 });
  });
});

describe("responseCost", () => {
  test("splits cache writes into 5-minute and 1-hour writes", () => {
    const usage = { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 2_000_000, cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 } };
    // Sonnet 5: 2 + 10 + 0.2 + 2.5 + 4
    expect(responseCost("claude-sonnet-5", usage)).toBeCloseTo(18.7, 9);
  });

  test("prices writes without a split as 5-minute writes; fast mode and US inference multiply", () => {
    expect(responseCost("claude-opus-5", { cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(6.25, 9);
    expect(responseCost("claude-opus-5", { output_tokens: 1_000_000, speed: "fast" })).toBeCloseTo(50, 9);
    expect(responseCost("claude-opus-5", { output_tokens: 1_000_000, speed: "standard", inference_geo: "us" })).toBeCloseTo(27.5, 9);
  });

  test("ignores missing or invalid counts", () => {
    expect(responseCost("claude-haiku-4-5", {})).toBe(0);
    expect(responseCost("claude-haiku-4-5", { input_tokens: -5, output_tokens: Number.NaN })).toBe(0);
  });
});
