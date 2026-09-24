import { readFileSync } from "node:fs";
import type { SessionRef, UsageReport } from "../../../lib/harness.ts";
import { findTranscript } from "./history.ts";
import { normalizeUsage, object } from "./normalize.ts";

export interface CostSnapshot {
  total_cost_usd: number;
  modelUsage: Record<string, any>;
}

export const ZERO_COST: CostSnapshot = { total_cost_usd: 0, modelUsage: {} };

/** Claude persists session-wide counters; take a baseline before resuming. */
export function readCostSnapshot(home: string, ref: SessionRef): CostSnapshot | null {
  try {
    const file = findTranscript(home, ref);
    if (!file) return null;
    let snapshot: CostSnapshot | null = null;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row.type === "assistant") snapshot = null;
      if (row.type === "cost-state" && !row.hasUnknownModelCost && typeof row.totalCostUSD === "number" && row.modelUsage)
        snapshot = { total_cost_usd: row.totalCostUSD, modelUsage: row.modelUsage };
    }
    return snapshot;
  } catch { return null; }
}

function delta(current: unknown, previous: unknown): number | null {
  return typeof current === "number" && typeof previous === "number" &&
    Number.isFinite(current) && Number.isFinite(previous) && current >= previous
    ? current - previous : null;
}

/** Result.usage is turn usage; result.modelUsage/cost are session cumulative. */
export function runUsage(raw: unknown, baseline: CostSnapshot | null): UsageReport {
  const result = object(raw);
  if (!baseline) {
    const report = normalizeUsage({ usage: result.usage });
    if (report.total.completeness !== "unavailable") report.total.completeness = "partial";
    return report;
  }
  const modelUsage: Record<string, any> = {};
  const fields = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "costUSD"];
  for (const [model, value] of Object.entries(object(result.modelUsage))) {
    const current = object(value);
    const previous = baseline.modelUsage[model];
    modelUsage[model] = Object.fromEntries(fields.map((key) => [key, delta(current[key], previous ? previous[key] : 0)]));
  }
  const entries = Object.values(modelUsage);
  const sum = (key: string) => entries.length && entries.every((entry) => entry[key] !== null)
    ? entries.reduce((total, entry) => total + entry[key], 0) : null;
  const tokens = {
    input_tokens: sum("inputTokens"), output_tokens: sum("outputTokens"),
    cache_read_input_tokens: sum("cacheReadInputTokens"), cache_creation_input_tokens: sum("cacheCreationInputTokens"),
  };
  const completeTokens = Object.values(tokens).every((value) => value !== null);
  const report = normalizeUsage({
    usage: completeTokens ? tokens : result.usage,
    total_cost_usd: delta(result.total_cost_usd, baseline.total_cost_usd), modelUsage,
  });
  if (!completeTokens && report.total.completeness !== "unavailable") report.total.completeness = "partial";
  return report;
}
