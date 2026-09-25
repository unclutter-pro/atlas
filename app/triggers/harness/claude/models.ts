import type { ModelCatalog, ModelRef, ModelTier } from "../../../lib/harness.ts";
import { expandModelName } from "../../../lib/config.ts";
import { harnessError } from "../../../lib/harness/errors.ts";

export const MODEL_TIERS: ModelTier[] = ["strong", "balanced", "fast"];

export function claudeModels(overrides: Partial<Record<ModelTier, string>> = {}): ModelCatalog {
  const defaults = { strong: "opus", balanced: "sonnet", fast: "haiku" };
  const entries = MODEL_TIERS.map((tier) => {
    const model = expandModelName(overrides[tier] ?? defaults[tier]);
    if (!model?.trim()) throw harnessError("configuration", `Missing ${tier} model`);
    return [tier, { model: { provider: "anthropic", model }, displayName: model,
      contextWindowTokens: null, maxOutputTokens: null }] as const;
  });
  if (new Set(entries.map(([, profile]) => profile.model.model)).size !== 3)
    throw harnessError("configuration", "Claude profiles must map to three distinct models");
  return Object.fromEntries(entries) as ModelCatalog;
}

export function validateModel(model: ModelRef): void {
  if (model.provider !== "anthropic" || !model.model.trim())
    throw harnessError("configuration", "Claude requires an anthropic model reference");
}
