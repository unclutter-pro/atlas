/**
 * Backend selection and the SDK-free registries per backend: session storage
 * and login handling. The web UI uses these; execution backends are registered
 * in triggers/harness/registry.ts under the same IDs.
 */

import type { HarnessSessionStore } from "../harness.ts";
import { ClaudeAuth } from "./claude/auth.ts";
import type { HarnessAuth, HarnessAuthOptions } from "./auth.ts";
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

const auths: Record<string, (options: HarnessAuthOptions & { home: string }) => HarnessAuth> = {
  [CLAUDE_BACKEND]: (options) => new ClaudeAuth(options),
};

/** Login handling of the configured backend, or null when it has none. */
export function createHarnessAuth(options: HarnessAuthOptions = {}): HarnessAuth | null {
  const home = options.home ?? process.env.HOME ?? "/home/agent";
  const backend = options.backend ?? configuredHarnessBackend(home);
  return Object.hasOwn(auths, backend) ? auths[backend]!({ ...options, home, backend }) : null;
}
