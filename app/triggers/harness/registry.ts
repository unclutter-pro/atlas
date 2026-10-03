import type { HarnessBackend } from "../../lib/harness.ts";
import { harnessError } from "../../lib/harness/errors.ts";
import { configuredHarnessBackend } from "../../lib/harness/stores.ts";
import { ClaudeCodeBackend } from "./claude/backend.ts";

/**
 * Explicit registration: unknown backends never silently fall back to Claude.
 * Session stores are registered under the same IDs in lib/harness/stores.ts.
 */
const factories: Record<string, () => HarnessBackend> = {
  "claude-code": () => new ClaudeCodeBackend(),
};

/** The configured backend (ATLAS_HARNESS_BACKEND, else harness.backend in config.yml). */
export function createHarnessBackend(id = configuredHarnessBackend()): HarnessBackend {
  if (!Object.hasOwn(factories, id)) throw harnessError("unsupported", `Unknown harness backend: ${id}`);
  return factories[id]!();
}
