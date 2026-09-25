/**
 * Backend selection and session storage registry. SDK-free: the web UI reads
 * sessions through this; execution backends are registered in
 * triggers/harness/registry.ts under the same IDs.
 */

import type { HarnessSessionStore } from "../harness.ts";
import { resolveConfig } from "../config.ts";
import { harnessError } from "./errors.ts";
import { CLAUDE_BACKEND, ClaudeSessionStore } from "./claude-store.ts";

/** Explicit registration: unknown backends never silently fall back to Claude. */
const stores: Record<string, (home: string) => HarnessSessionStore> = {
  [CLAUDE_BACKEND]: (home) => new ClaudeSessionStore(home),
};

/** ATLAS_HARNESS_BACKEND, else harness.backend in config.yml, else claude-code. */
export function configuredHarnessBackend(home?: string): string {
  return resolveConfig(home).harness?.backend?.trim() || CLAUDE_BACKEND;
}

export function createSessionStore(options: { backend?: string; home?: string } = {}): HarnessSessionStore {
  const home = options.home ?? process.env.HOME ?? "/home/agent";
  const id = options.backend ?? configuredHarnessBackend(home);
  if (!Object.hasOwn(stores, id)) throw harnessError("unsupported", `Unknown harness backend: ${id}`);
  return stores[id]!(home);
}
