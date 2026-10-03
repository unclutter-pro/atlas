/**
 * Single source of truth for "what time zone is Atlas in?", shared by
 * web-ui, trigger-runner and sync-crontab.
 *
 * Resolution order (see resolveTimezone):
 *   1. Explicit: config.yml `timezone:` / ATLAS_TIMEZONE env (env wins).
 *   2. Container runtime: TZ env, then /etc/timezone, then the
 *      /etc/localtime symlink target.
 *   3. UTC.
 *
 * An invalid explicit value is ignored (logged + reported via `invalid`)
 * and resolution falls through to the runtime/default layers.
 *
 * The pure zone-math helpers are re-exported from zoned-time.ts.
 */

import { existsSync, readFileSync, readlinkSync } from "fs";
import { getConfigSource, resolveConfig } from "./config";
import { isValidTimeZone } from "./zoned-time";

// Pure zone math lives in zoned-time.ts (no I/O, safe for the browser bundle).
export * from "./zoned-time";

export type TimezoneSource = "config" | "env" | "runtime" | "default";

export interface TimezoneResolution {
  timeZone: string;
  source: TimezoneSource;
  /** Set when the explicit config/env value was invalid and got ignored. */
  invalid?: string;
}

// ---------------------------------------------------------------------------
// Container runtime detection
// ---------------------------------------------------------------------------

export interface TimezoneDeps {
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** Defaults to "/etc/timezone". */
  etcTimezonePath?: string;
  /** Defaults to "/etc/localtime". */
  etcLocaltimePath?: string;
}

function zoneFromEtcTimezone(path: string): string | null {
  try {
    const content = readFileSync(path, "utf-8").trim();
    return content || null;
  } catch {
    return null;
  }
}

function zoneFromLocaltime(path: string): string | null {
  try {
    const target = readlinkSync(path);
    const m = target.match(/zoneinfo\/(.+)$/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/** TZ env, then /etc/timezone, then /etc/localtime; UTC (found=false) when none resolve to a valid zone. */
function detectContainerTimeZone(deps: TimezoneDeps): { timeZone: string; found: boolean } {
  const env = deps.env ?? process.env;
  const candidates = [env.TZ, zoneFromEtcTimezone(deps.etcTimezonePath ?? "/etc/timezone"), zoneFromLocaltime(deps.etcLocaltimePath ?? "/etc/localtime")];
  for (const c of candidates) {
    if (c && isValidTimeZone(c)) return { timeZone: c, found: true };
  }
  return { timeZone: "UTC", found: false };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the IANA zone Atlas should use everywhere. Reads config fresh on
 * every call (like resolveConfig), so a config.yml edit takes effect on the
 * next call without a restart.
 */
export function resolveTimezone(home?: string, deps: TimezoneDeps = {}): TimezoneResolution {
  const config = resolveConfig(home);
  const explicit = (config.timezone ?? "").trim();
  const runtime = detectContainerTimeZone(deps);
  const runtimeSource: TimezoneSource = runtime.found ? "runtime" : "default";

  if (explicit) {
    // config.ts tracks "file" (config.yml) and "runtime" (.atlas-runtime-config.json) as
    // separate layers of *explicit* config; both are "config" here — only ATLAS_TIMEZONE is "env".
    const cfgSource = getConfigSource("timezone");
    const source: TimezoneSource = cfgSource === "env" ? "env" : "config";
    if (isValidTimeZone(explicit)) return { timeZone: explicit, source };
    console.warn(
      `[timezone] Ignoring invalid time zone "${explicit}" from ${source === "env" ? "ATLAS_TIMEZONE" : "config.yml timezone"} — using ${runtime.timeZone} instead.`,
    );
    return { timeZone: runtime.timeZone, source: runtimeSource, invalid: explicit };
  }

  return { timeZone: runtime.timeZone, source: runtimeSource };
}

/**
 * Resolve the zone and set process.env.TZ to it so ambient Date/Intl
 * calculations (cron next-run without an explicit zone, log timestamps,
 * subprocesses spawned from here) follow it. Call once at a real process
 * entrypoint (not merely on import) — safe to call again later (e.g. after
 * a config.yml save) to pick up a change without a restart.
 */
export function applyProcessTimeZone(home?: string, deps: TimezoneDeps = {}): TimezoneResolution {
  const result = resolveTimezone(home, deps);
  process.env.TZ = result.timeZone;
  return result;
}
