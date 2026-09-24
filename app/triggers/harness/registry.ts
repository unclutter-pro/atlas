import type { HarnessBackend } from "../../lib/harness.ts";
import { harnessError } from "./errors.ts";
import { ClaudeCodeBackend, type ClaudeBackendOptions } from "./claude/backend.ts";

/** Explicit registration: unknown backends never silently fall back to Claude. */
const factories: Record<string, () => HarnessBackend> = {
  "claude-code": () => new ClaudeCodeBackend(),
};

export function createHarnessBackend(id = "claude-code"): HarnessBackend {
  const factory = factories[id];
  if (!Object.hasOwn(factories, id)) throw harnessError("unsupported", `Unknown harness backend: ${id}`);
  return factory();
}

/** Existing Atlas deployments retain the SDK conversation policy during migration. */
export function createAtlasHarness(options?: ClaudeBackendOptions): ClaudeCodeBackend {
  return new ClaudeCodeBackend(options);
}
