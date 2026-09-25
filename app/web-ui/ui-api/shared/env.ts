/**
 * Workspace paths, DB access and time helpers shared by /ui/api/* modules.
 *
 * Paths are resolved from $HOME on every call so tests and the dev seed can
 * point HOME at an isolated workspace.
 */

import { existsSync } from "fs";
import { join } from "path";
import { getDb } from "../../../lib/atlas-db";
import type { HarnessSessionStore, SessionRef } from "../../../lib/harness";
import { createSessionStore } from "../../../lib/harness/stores";

export { getDb };

export function home(): string {
  return process.env.HOME!;
}

/**
 * Stored sessions of the configured agent backend (harness.backend). Every
 * read of session history or metadata goes through this, never backend files.
 */
export function sessionStore(): HarnessSessionStore {
  return createSessionStore({ home: home() });
}

/** Reference of a persisted session ID that has stored history, else null. */
export function storedSession(sessions: HarnessSessionStore, sessionId: string | null | undefined): SessionRef | null {
  const ref = sessions.ref(sessionId);
  return ref && sessions.exists(ref) ? ref : null;
}

export const paths = {
  memory: () => join(home(), "memory"),
  memoryMd: () => join(home(), "memory", "MEMORY.md"),
  journal: () => join(home(), "memory", "journal"),
  identity: () => join(home(), "IDENTITY.md"),
  soul: () => join(home(), "SOUL.md"),
  config: () => join(home(), "config.yml"),
  runtimeConfig: () => join(home(), ".atlas-runtime-config.json"),
  extensions: () => join(home(), "user-extensions.sh"),
  secrets: () => join(home(), "secrets"),
  triggers: () => join(home(), "triggers"),
  supervisorD: () => join(home(), "supervisor.d"),
  /** Container-only scripts. Spawns of these must be guarded (absent locally). */
  triggerSh: "/atlas/app/triggers/trigger.sh",
  syncCrontab: "/atlas/app/triggers/sync-crontab.ts",
} as const;

export function agentName(): string {
  return process.env.AGENT_NAME || "Atlas";
}

/**
 * SQLite `datetime('now')` values ("YYYY-MM-DD HH:MM:SS", UTC, no zone) to
 * ISO 8601 with Z. Already-ISO values pass through. Send every timestamp to
 * the frontend through this so browsers don't parse it as local time.
 */
export function toIso(s: string | null | undefined): string | null {
  if (!s) return null;
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) return s.includes("T") ? s : s.replace(" ", "T");
  return s.replace(" ", "T") + "Z";
}

/** Date → SQLite "YYYY-MM-DD HH:MM:SS" (UTC) for comparisons against stored timestamps. */
export function toSqlite(d: Date): string {
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

/** Milliseconds between two SQLite/ISO timestamps (end defaults to now). */
export function elapsedMs(start: string | null | undefined, end?: string | null): number | null {
  const a = toIso(start);
  if (!a) return null;
  const b = end ? toIso(end) : null;
  return (b ? Date.parse(b) : Date.now()) - Date.parse(a);
}

/**
 * True under `bun test`, which sets NODE_ENV=test. The compiled web-ui pins
 * NODE_ENV to "production" at build time, so this folds to false there.
 */
export function isTestRun(): boolean {
  return process.env.NODE_ENV === "test";
}

/** Best-effort fire-and-forget spawn; returns false when the binary/script is missing or a test run suppresses it. */
export function trySpawn(cmd: string[]): boolean {
  if (isTestRun()) return false;
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Blocking variant of trySpawn, for scripts a request must await. */
export function trySpawnSync(cmd: string[]): boolean {
  if (isTestRun()) return false;
  try {
    Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Regenerate the crontab after cron trigger changes. No-op outside the container. */
export function syncCrontab(): void {
  if (existsSync(paths.syncCrontab)) trySpawn(["bun", "run", paths.syncCrontab]);
}

/** Fire a trigger through trigger.sh (same path as cron/webhooks). Returns false when nothing was started. */
export function fireTrigger(name: string, payload?: string, sessionKey?: string): boolean {
  if (!existsSync(paths.triggerSh)) return false;
  const args = [paths.triggerSh, name];
  if (payload !== undefined || sessionKey !== undefined) args.push(payload ?? "");
  if (sessionKey !== undefined) args.push(sessionKey);
  return trySpawn(args);
}
