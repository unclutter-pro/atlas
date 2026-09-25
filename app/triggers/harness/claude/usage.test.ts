import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClaudeSessionStore } from "../../../lib/harness/claude-store.ts";
import { readCostSnapshot, runUsage, ZERO_COST } from "./usage.ts";

const first = { total_cost_usd: 0.000737, modelUsage: { haiku: {
  inputTokens: 407, outputTokens: 66, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.000737,
} } };
const resumed = { total_cost_usd: 0.001466, usage: { input_tokens: 514, output_tokens: 43, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: { haiku: {
  inputTokens: 921, outputTokens: 109, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.001466,
} } };

test("live-observed cumulative Claude counters become per-run totals, including internal calls", () => {
  const a = runUsage(first, ZERO_COST);
  const b = runUsage(resumed, first);
  expect(a.total.inputTokens).toBe(407);
  expect(b.total).toMatchObject({ inputTokens: 514, outputTokens: 43, completeness: "complete" });
  expect(b.total.cost!.amount).toBeCloseTo(0.000729, 10);
  expect(b.byModel![0].usage.cost!.amount).toBeCloseTo(0.000729, 10);
  expect(a.total.cost!.amount + b.total.cost!.amount).toBeCloseTo(0.001466, 10);
});

test("missing resume baseline and counter resets never bill the full session again", () => {
  expect(runUsage(resumed, null).total).toMatchObject({ inputTokens: 514, cost: null, completeness: "partial" });
  expect(runUsage(first, resumed).total.cost).toBeNull();
});

test("resume reads persisted cost-state, but rejects stale or incomplete snapshots", () => {
  const home = mkdtempSync(join(tmpdir(), "atlas-cost-baseline-"));
  const ref = { backend: "claude-code", nativeId: "persisted" };
  const dir = join(home, ".claude/projects/test"); mkdirSync(dir, { recursive: true });
  const file = join(dir, "persisted.jsonl");
  const state = JSON.stringify({ type: "cost-state", totalCostUSD: first.total_cost_usd, modelUsage: first.modelUsage });
  try {
    writeFileSync(file, state + "\n");
    expect(readCostSnapshot(new ClaudeSessionStore(home), ref)).toEqual(first);
    writeFileSync(file, state + '\n{"type":"assistant"}\n');
    expect(readCostSnapshot(new ClaudeSessionStore(home), ref)).toBeNull();
    writeFileSync(file, state + '\n{"partial":');
    expect(readCostSnapshot(new ClaudeSessionStore(home), ref)).toBeNull();
  } finally { rmSync(home, { recursive: true, force: true }); }
});
