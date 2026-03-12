/**
 * Kill Switch — Pause, Resume, and Stop Atlas sessions.
 *
 * State is tracked via:
 *   1. File marker: $HOME/.atlas-paused (checked by trigger.sh and trigger-runner.ts)
 *   2. Database: system_state table (for API queries and persistence)
 *
 * The file marker is the authoritative source — it persists across container restarts
 * and is checked before any trigger execution.
 */

import { existsSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import { join } from "path";
import type { Database } from "bun:sqlite";

const PAUSED_MARKER = ".atlas-paused";

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function markerPath(home: string): string {
  return join(home, PAUSED_MARKER);
}

function setDbState(db: Database, key: string, value: string): void {
  db.run(
    `INSERT INTO system_state (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value]
  );
}

function getDbState(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM system_state WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if Atlas is currently paused (file-based check, fast).
 */
export function isAtlasPaused(home: string): boolean {
  return existsSync(markerPath(home));
}

/**
 * Pause Atlas: disable all trigger execution.
 *
 * - Creates .atlas-paused marker file
 * - Records state in DB
 * - Stops supercronic (cron execution)
 *
 * Note: The web-ui remains running for API access.
 */
export function pauseAtlas(db: Database, home: string): void {
  // Create marker file
  writeFileSync(markerPath(home), new Date().toISOString(), "utf-8");

  // Record in DB
  setDbState(db, "paused", "true");
  setDbState(db, "paused_at", new Date().toISOString());

  // Stop supercronic
  try {
    Bun.spawnSync(["supervisorctl", "stop", "supercronic"]);
  } catch {
    // supervisorctl may not be available in all environments
  }
}

/**
 * Resume Atlas: re-enable trigger execution.
 *
 * - Removes .atlas-paused marker file
 * - Updates DB state
 * - Restarts supercronic
 * - Re-syncs crontab
 */
export function resumeAtlas(db: Database, home: string): void {
  // Remove marker file
  try {
    unlinkSync(markerPath(home));
  } catch {
    // File may not exist
  }

  // Update DB
  setDbState(db, "paused", "false");
  setDbState(db, "resumed_at", new Date().toISOString());

  // Restart supercronic
  try {
    Bun.spawnSync(["supervisorctl", "start", "supercronic"]);
  } catch {}

  // Re-sync crontab
  try {
    Bun.spawnSync(["bun", "run", "/atlas/app/triggers/sync-crontab.ts"]);
  } catch {}
}

/**
 * Hard stop: kill all active sessions and pause.
 *
 * - Terminates all running Claude sessions
 * - Marks active trigger_runs as completed
 * - Then pauses Atlas
 */
export function stopAllSessions(db: Database, home: string): { killed: number } {
  let killed = 0;

  // Find active trigger runs
  const activeRuns = db.query(
    "SELECT id, session_id FROM trigger_runs WHERE completed_at IS NULL"
  ).all() as Array<{ id: number; session_id: string | null }>;

  for (const run of activeRuns) {
    if (run.session_id) {
      killSessionBySocketPid(run.session_id);
      killed++;
    }
    // Mark as completed
    db.run(
      "UPDATE trigger_runs SET completed_at = datetime('now') WHERE id = ?",
      [run.id]
    );
  }

  // Now pause
  pauseAtlas(db, home);

  return { killed };
}

/**
 * Get current control status.
 */
export function getControlStatus(db: Database, home: string): {
  paused: boolean;
  paused_at: string | null;
  active_sessions: Array<{ id: number; trigger_name: string; session_key: string; session_id: string | null; started_at: string }>;
} {
  const paused = isAtlasPaused(home);
  const pausedAt = getDbState(db, "paused_at");

  const activeSessions = db.query(
    "SELECT id, trigger_name, session_key, session_id, started_at FROM trigger_runs WHERE completed_at IS NULL ORDER BY started_at DESC"
  ).all() as Array<{ id: number; trigger_name: string; session_key: string; session_id: string | null; started_at: string }>;

  return { paused, paused_at: paused ? pausedAt : null, active_sessions: activeSessions };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Kill a session by finding the PID that owns its IPC socket.
 */
function killSessionBySocketPid(sessionId: string): void {
  const socketPath = `/tmp/claudec-${sessionId}.sock`;
  if (!existsSync(socketPath)) return;

  try {
    const result = Bun.spawnSync(["lsof", "-t", socketPath]);
    const pids = result.stdout.toString().trim().split("\n").filter(Boolean);
    for (const pidStr of pids) {
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid)) {
        try { process.kill(pid, "SIGTERM"); } catch {}
      }
    }
  } catch {}

  try { unlinkSync(socketPath); } catch {}
}
