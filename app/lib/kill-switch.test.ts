/**
 * Stop must reach real trigger-runner processes: they are found through the
 * PID in their dedup lock file (there is no per-session IPC socket).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { stopAllSessions } from "./kill-switch";
import { getLockPath, getRetiringPath, isPidAlive } from "./trigger-socket";

const home = mkdtempSync(join(tmpdir(), "kill-switch-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

function db(): Database {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE trigger_runs (id INTEGER PRIMARY KEY, trigger_name TEXT, session_key TEXT, session_id TEXT,
      started_at TEXT DEFAULT (datetime('now')), completed_at TEXT);
    CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
  `);
  return d;
}

describe("stopAllSessions", () => {
  test("kills the runner that holds the lock, closes every run and pauses", async () => {
    const key = `ks-${process.pid}`;
    // A process whose command line looks like a runner (the kill checks it).
    const runner = Bun.spawn(["bash", "-c", "exec -a trigger-runner-test sleep 30"]);
    const lock = getLockPath("kill-test", key);
    writeFileSync(lock, String(runner.pid));
    const d = db();
    d.run("INSERT INTO trigger_runs (trigger_name, session_key, session_id) VALUES ('kill-test', ?, 'sid-1')", [key]);
    d.run("INSERT INTO trigger_runs (trigger_name, session_key, session_id) VALUES ('kill-test', 'no-runner', NULL)");
    try {
      await Bun.sleep(100);
      expect(stopAllSessions(d, home)).toEqual({ killed: 1, closed: 2 });
      await runner.exited;
      expect(isPidAlive(runner.pid)).toBe(false);
      expect((d.query("SELECT COUNT(*) AS c FROM trigger_runs WHERE completed_at IS NULL").get() as { c: number }).c).toBe(0);
    } finally {
      runner.kill();
      try {
        unlinkSync(lock);
      } catch {}
    }
  });

  test("also kills a runner still finishing its farewell after /new (retiring, no lock)", async () => {
    const key = `ks-retire-${process.pid}`;
    const retiring = Bun.spawn(["bash", "-c", "exec -a trigger-runner-test sleep 30"]);
    const path = getRetiringPath("kill-test", key);
    writeFileSync(path, String(retiring.pid));
    const d = db();
    d.run("INSERT INTO trigger_runs (trigger_name, session_key, session_id) VALUES ('kill-test', ?, 'sid-old')", [key]);
    try {
      await Bun.sleep(100);
      expect(stopAllSessions(d, home)).toEqual({ killed: 1, closed: 1 });
      await retiring.exited;
      expect(isPidAlive(retiring.pid)).toBe(false);
    } finally {
      retiring.kill();
      try {
        unlinkSync(path);
      } catch {}
    }
  });

  test("never signals a process that is not a trigger-runner (stale lock with a reused PID)", async () => {
    const key = `ks-stale-${process.pid}`;
    const other = Bun.spawn(["sleep", "30"]);
    const lock = getLockPath("kill-test", key);
    writeFileSync(lock, String(other.pid));
    const d = db();
    d.run("INSERT INTO trigger_runs (trigger_name, session_key) VALUES ('kill-test', ?)", [key]);
    try {
      expect(stopAllSessions(d, home)).toEqual({ killed: 0, closed: 1 });
      expect(isPidAlive(other.pid)).toBe(true);
    } finally {
      other.kill();
      try {
        unlinkSync(lock);
      } catch {}
    }
  });
});
