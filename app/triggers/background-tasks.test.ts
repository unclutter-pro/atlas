import { test, describe, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createBackgroundTaskTracker,
  saveBackgroundTask,
  clearBackgroundTask,
  listBackgroundTasks,
  clearBackgroundTasks,
  buildInterruptedTasksNotice,
} from "./background-tasks.ts";

// ---------------------------------------------------------------------------
// createBackgroundTaskTracker
// ---------------------------------------------------------------------------

describe("createBackgroundTaskTracker", () => {
  test("a stall fires one check-in, then re-arms once progress resumes", () => {
    const tracker = createBackgroundTaskTracker({ stallMs: 1000, checkinMs: 1_000_000 });
    tracker.started("t1", "local_agent", "research the thing", 0);

    expect(tracker.checkNow(500)).toEqual([]);
    const first = tracker.checkNow(1000);
    expect(first).toHaveLength(1);
    expect(first[0]).toContain("research the thing");
    expect(first[0]).toContain("t1");
    expect(first[0]).toContain("[Runtime notice]");

    // Still stalled at the next tick — must not double-fire.
    expect(tracker.checkNow(1500)).toEqual([]);

    tracker.progress("t1", 1500);
    expect(tracker.checkNow(2000)).toEqual([]); // only 500ms since progress
    expect(tracker.checkNow(2500)).toHaveLength(1); // 1000ms since progress — re-armed
  });

  test("periodic check-ins fire on their own cadence while a task stays live", () => {
    const tracker = createBackgroundTaskTracker({ stallMs: 1_000_000, checkinMs: 1000 });
    tracker.started("t1", "local_agent", "long task", 0);

    expect(tracker.checkNow(999)).toEqual([]);
    expect(tracker.checkNow(1000)).toHaveLength(1);
    expect(tracker.checkNow(1999)).toEqual([]);
    expect(tracker.checkNow(2000)).toHaveLength(1);
  });

  test("a bash task is never flagged as stalled, but still gets periodic check-ins", () => {
    const tracker = createBackgroundTaskTracker({ stallMs: 100, checkinMs: 5000 });
    tracker.started("t1", "local_bash", "sleep 999", 0);

    // Bash tasks never report progress; stallMs alone must never trigger for them.
    expect(tracker.checkNow(4000)).toEqual([]);
    // The periodic check-in still applies to every live task, bash included.
    const periodic = tracker.checkNow(5000);
    expect(periodic).toHaveLength(1);
    expect(periodic[0]).toContain("sleep 999");
  });

  test("done() stops tracking a task and resets the periodic cadence", () => {
    const tracker = createBackgroundTaskTracker({ stallMs: 1_000_000, checkinMs: 1000 });
    tracker.started("t1", "local_agent", "task one", 0);
    tracker.done("t1");
    expect(tracker.isEmpty()).toBe(true);
    expect(tracker.checkNow(1000)).toEqual([]);

    // A new task starting later gets a fresh cadence, not the old one's.
    tracker.started("t2", "local_agent", "task two", 5000);
    expect(tracker.checkNow(5999)).toEqual([]);
    expect(tracker.checkNow(6000)).toHaveLength(1);
  });

  test("each live task gets its own periodic notice", () => {
    const tracker = createBackgroundTaskTracker({ stallMs: 1_000_000, checkinMs: 1000 });
    tracker.started("t1", "local_agent", "task one", 0);
    tracker.started("t2", "mcp_task", "task two", 0);
    expect(tracker.checkNow(1000)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Persistence: save/list/clear + crash-recovery notice
// ---------------------------------------------------------------------------

describe("background task persistence", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE background_tasks (
        trigger_name TEXT NOT NULL,
        session_key TEXT NOT NULL,
        task_id TEXT NOT NULL,
        task_type TEXT NOT NULL,
        description TEXT NOT NULL,
        output_file TEXT,
        started_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (trigger_name, session_key, task_id)
      );
    `);
  });

  test("save/list/clear a single task round-trips", () => {
    saveBackgroundTask(db, "signal-chat", "+4912345", { taskId: "t1", taskType: "local_agent", description: "deploy the app", outputFile: null });
    const rows = listBackgroundTasks(db, "signal-chat", "+4912345");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ taskId: "t1", taskType: "local_agent", description: "deploy the app", outputFile: null });

    clearBackgroundTask(db, "signal-chat", "+4912345", "t1");
    expect(listBackgroundTasks(db, "signal-chat", "+4912345")).toEqual([]);
  });

  test("saving again for the same task updates output_file instead of duplicating", () => {
    saveBackgroundTask(db, "t", "k", { taskId: "t1", taskType: "local_agent", description: "d", outputFile: null });
    saveBackgroundTask(db, "t", "k", { taskId: "t1", taskType: "local_agent", description: "d", outputFile: "/tmp/out.md" });
    const rows = listBackgroundTasks(db, "t", "k");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outputFile).toBe("/tmp/out.md");
  });

  test("clearBackgroundTasks drops every task for a trigger+session_key, leaving others alone", () => {
    saveBackgroundTask(db, "t", "k1", { taskId: "t1", taskType: "local_agent", description: "d1", outputFile: null });
    saveBackgroundTask(db, "t", "k1", { taskId: "t2", taskType: "local_bash", description: "d2", outputFile: null });
    saveBackgroundTask(db, "t", "k2", { taskId: "t3", taskType: "local_agent", description: "d3", outputFile: null });

    clearBackgroundTasks(db, "t", "k1");
    expect(listBackgroundTasks(db, "t", "k1")).toEqual([]);
    expect(listBackgroundTasks(db, "t", "k2")).toHaveLength(1);
  });

  test("the crash-recovery notice names the interrupted task and where its output may be", () => {
    saveBackgroundTask(db, "signal-chat", "+4912345", { taskId: "t1", taskType: "local_agent", description: "deploy the app", outputFile: null });
    const tasks = listBackgroundTasks(db, "signal-chat", "+4912345");

    const withoutOutputFile = buildInterruptedTasksNotice(tasks, "prev-session-abc");
    expect(withoutOutputFile).toContain("deploy the app");
    expect(withoutOutputFile).toContain("t1");
    expect(withoutOutputFile).toContain("transcript of the previous session");
    expect(withoutOutputFile).toContain("prev-session-abc");
    expect(withoutOutputFile).toStartWith("<system-notice>");

    const withOutputFile = buildInterruptedTasksNotice([{ ...tasks[0]!, outputFile: "/tmp/out.md" }], "prev-session-abc");
    expect(withOutputFile).toContain("/tmp/out.md");
    expect(withOutputFile).not.toContain("transcript of the previous session");
  });
});
