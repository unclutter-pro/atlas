import type { HarnessBackend } from "../../lib/harness.ts";
import { harnessError } from "../../lib/harness/errors.ts";
import { configuredHarnessBackend } from "../../lib/harness/stores.ts";
import { ClaudeCodeBackend, type ClaudeBackendOptions } from "./claude/backend.ts";

/**
 * Explicit registration: unknown backends never silently fall back to Claude.
 * Session stores are registered under the same IDs in lib/harness/stores.ts.
 */
const factories: Record<string, (options?: ClaudeBackendOptions) => HarnessBackend> = {
  "claude-code": (options) => new ClaudeCodeBackend(options),
};

/** The configured backend (ATLAS_HARNESS_BACKEND, else harness.backend in config.yml). */
export function createHarnessBackend(id = configuredHarnessBackend(), options?: ClaudeBackendOptions): HarnessBackend {
  if (!Object.hasOwn(factories, id)) throw harnessError("unsupported", `Unknown harness backend: ${id}`);
  return factories[id]!(options);
}

/**
 * The runner's long-lived conversation loop still speaks the Claude SDK
 * stream; it runs only when Claude Code is the configured backend.
 */
export function createAtlasHarness(options?: ClaudeBackendOptions): ClaudeCodeBackend {
  const id = configuredHarnessBackend(options?.home);
  if (id !== "claude-code") {
    throw harnessError("unsupported", `The trigger runner needs the claude-code backend, configured: ${id}`);
  }
  return new ClaudeCodeBackend(options);
}
