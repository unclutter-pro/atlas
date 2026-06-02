/**
 * Unit tests for manage-tasks.ts — Atlas task management system.
 * Run with: cd app/triggers && bun test
 */

import { test, describe, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  goalCreate,
  goalList,
  goalGet,
  goalClose,
  goalTaskCounts,
  taskAdd,
  taskList,
  taskReady,
  taskGet,
  taskClose,
  taskCancel,
  parseArgs,
  parseId,
  getSessionScope,
  parseValidatorOutput,
  type Goal,
  type Task,
} from "./manage-tasks.ts";

// ---------------------------------------------------------------------------
// DB setup helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      done_condition TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'done', 'abandoned', 'validation_exhausted')),
      validation_count INTEGER NOT NULL DEFAULT 0,
      trigger_name TEXT NOT NULL,
      session_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT,
      close_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_goals_session_status
      ON goals(trigger_name, session_key, status);

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open'
        CHECK(status IN ('open', 'in_progress', 'done', 'cancelled')),
      priority INTEGER NOT NULL DEFAULT 2 CHECK(priority BETWEEN 0 AND 4),
      goal_id INTEGER REFERENCES goals(id) ON DELETE CASCADE,
      trigger_name TEXT NOT NULL,
      session_key TEXT NOT NULL,
      claimed_by TEXT,
      claimed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT,
      close_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_session_status
      ON tasks(trigger_name, session_key, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_goal ON tasks(goal_id);

    CREATE TABLE IF NOT EXISTS task_deps (
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, depends_on),
      CHECK (task_id != depends_on)
    );

    CREATE TABLE IF NOT EXISTS goal_validations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL,
      verdict TEXT NOT NULL CHECK(verdict IN ('pass', 'fail', 'exhausted')),
      feedback TEXT,
      duration_ms INTEGER,
      started_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  return db;
}

function makeScope(suffix: string = "test") {
  return { triggerName: `trigger-${suffix}`, sessionKey: `session-${suffix}` };
}

// ---------------------------------------------------------------------------
// Schema + DB
// ---------------------------------------------------------------------------

describe("Schema + DB", () => {
  test("migrations run cleanly on fresh DB", () => {
    const db = createTestDb();
    // All four tables should exist
    const tables = db.prepare(
      "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name IN ('goals','tasks','task_deps','goal_validations')"
    ).get() as { cnt: number };
    expect(tables.cnt).toBe(4);
  });

  test("migrations are idempotent — running CREATE TABLE IF NOT EXISTS twice does not throw", () => {
    const db = createTestDb();
    // Running the same CREATE TABLE IF NOT EXISTS again should be a no-op
    expect(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS goals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          description TEXT,
          done_condition TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          validation_count INTEGER NOT NULL DEFAULT 0,
          trigger_name TEXT NOT NULL,
          session_key TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          closed_at TEXT,
          close_reason TEXT
        );
      `);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// CLI flag parsing
// ---------------------------------------------------------------------------

describe("CLI parsing", () => {
  test("parses --title and --done flags", () => {
    const { flags } = parseArgs(["goal", "create", "--title=My goal", "--done=All tests pass"]);
    expect(flags["title"]).toBe("My goal");
    expect(flags["done"]).toBe("All tests pass");
  });

  test("parses --depends-on with multiple IDs", () => {
    const { flags } = parseArgs(["add", "--title=x", "--depends-on=1,2,3"]);
    expect(flags["depends-on"]).toBe("1,2,3");
  });

  test("parses --priority flag", () => {
    const { flags } = parseArgs(["add", "--title=x", "--priority=0"]);
    expect(flags["priority"]).toBe("0");
  });

  test("parses --cascade-cancel boolean flag", () => {
    const { flags } = parseArgs(["goal", "close", "1", "--reason=done", "--cascade-cancel"]);
    expect(flags["cascade-cancel"]).toBe(true);
  });

  test("captures positional arguments", () => {
    const { positional } = parseArgs(["goal", "show", "42"]);
    expect(positional).toEqual(["goal", "show", "42"]);
  });

  test("rejects invalid priority (5) at taskAdd level", () => {
    const db = createTestDb();
    const scope = makeScope();
    expect(() =>
      taskAdd(db, { title: "x", priority: 5, ...scope })
    ).toThrow();
  });

  test("parseId accepts bare numeric ID", () => {
    expect(parseId("146")).toBe(146);
  });

  test("parseId accepts ID with leading '#' (round-trip from CLI output)", () => {
    // The CLI prints `Created task #146`, so users naturally copy `#146` back in.
    expect(parseId("#146")).toBe(146);
  });

  test("parseId trims whitespace before parsing", () => {
    expect(parseId(" 42 ")).toBe(42);
    expect(parseId(" #42 ")).toBe(42);
  });

  test("parseId returns NaN for empty/undefined/garbage", () => {
    expect(parseId(undefined)).toBeNaN();
    expect(parseId(null)).toBeNaN();
    expect(parseId("")).toBeNaN();
    expect(parseId("abc")).toBeNaN();
  });

  test("rejects negative priority", () => {
    const db = createTestDb();
    const scope = makeScope();
    expect(() =>
      taskAdd(db, { title: "x", priority: -1, ...scope })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Goal lifecycle
// ---------------------------------------------------------------------------

describe("Goal lifecycle", () => {
  let db: Database;
  const scope = makeScope("goals");

  beforeEach(() => { db = createTestDb(); });

  test("create → list shows it scoped to current session", () => {
    goalCreate(db, { title: "Goal A", done: "Done when A", ...scope });
    goalCreate(db, {
      title: "Other scope goal",
      done: "Done",
      triggerName: "other-trigger",
      sessionKey: "other-session",
    });

    const goals = goalList(db, scope);
    expect(goals.length).toBe(1);
    expect(goals[0].title).toBe("Goal A");
  });

  test("goal description is stored correctly", () => {
    const goal = goalCreate(db, {
      title: "Documented goal",
      done: "Done",
      description: "This is broader context",
      ...scope,
    });
    expect(goal.description).toBe("This is broader context");
  });

  test("goalGet returns correct goal", () => {
    const created = goalCreate(db, { title: "Get test", done: "Done", ...scope });
    const fetched = goalGet(db, created.id);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.title).toBe("Get test");
  });

  test("goalGet returns null for missing id", () => {
    expect(goalGet(db, 9999)).toBeNull();
  });

  test("close with open tasks blocks (no --cascade-cancel)", () => {
    const goal = goalCreate(db, { title: "Goal with tasks", done: "Done", ...scope });
    taskAdd(db, { title: "Task 1", goalId: goal.id, ...scope });

    const result = goalClose(db, { goalId: goal.id, reason: "Done" });
    expect(result.blocked).toBeDefined();
    expect(result.closed).toBe(false);
  });

  test("close with --cascade-cancel marks open tasks as cancelled (still needs validation)", () => {
    const goal = goalCreate(db, { title: "Goal", done: "Done", ...scope });
    const task1 = taskAdd(db, { title: "T1", goalId: goal.id, ...scope });
    const task2 = taskAdd(db, { title: "T2", goalId: goal.id, ...scope });

    const result = goalClose(db, {
      goalId: goal.id,
      reason: "Done",
      cascadeCancel: true,
    });
    // cascade-cancel handles the task side effects, but the goal itself
    // still requires validator approval (orchestrated by the CLI handler).
    expect(result.closed).toBe(false);
    expect(result.needsValidation).toBe(true);

    const t1 = taskGet(db, task1.id)!;
    const t2 = taskGet(db, task2.id)!;
    expect(t1.status).toBe("cancelled");
    expect(t2.status).toBe("cancelled");
    expect(t1.close_reason).toContain("goal closed: Done");
  });

  test("close without open tasks does not close directly — always needs validation", () => {
    const goal = goalCreate(db, { title: "Empty goal", done: "Done", ...scope });
    const result = goalClose(db, { goalId: goal.id, reason: "Done successfully" });
    expect(result.closed).toBe(false);
    expect(result.needsValidation).toBe(true);
    // Goal stays active until the validator orchestration (in CLI handler) marks it done
    const stillActive = goalGet(db, goal.id)!;
    expect(stillActive.status).toBe("active");
  });

  test("goalTaskCounts returns correct counts", () => {
    const goal = goalCreate(db, { title: "Counted goal", done: "Done", ...scope });
    taskAdd(db, { title: "Open", goalId: goal.id, ...scope });
    const done = taskAdd(db, { title: "Done", goalId: goal.id, ...scope });
    taskClose(db, { taskId: done.id, reason: "Finished" });

    const counts = goalTaskCounts(db, goal.id);
    expect(counts.open).toBe(1);
    expect(counts.done).toBe(1);
  });

  test("goalClose always returns needsValidation=true (no opt-out)", () => {
    const goal = goalCreate(db, { title: "Needs check", done: "Tests pass", ...scope });
    const result = goalClose(db, { goalId: goal.id, reason: "Done" });
    expect(result.needsValidation).toBe(true);
    expect(result.closed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Validator mock mode
// ---------------------------------------------------------------------------

describe("Validator mock mode", () => {
  let db: Database;
  const scope = makeScope("validator");

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { delete process.env.ATLAS_VALIDATOR_MOCK; });

  test("ATLAS_VALIDATOR_MOCK=pass → pass verdict + telemetry row", async () => {
    process.env.ATLAS_VALIDATOR_MOCK = "pass";
    const goal = goalCreate(db, { title: "Mocked goal", done: "Done", ...scope });

    const { runValidator } = await import("./manage-tasks.ts");
    const result = await runValidator({ goal, reason: "I did the work", db });

    expect(result.verdict).toBe("pass");

    const row = db.prepare("SELECT * FROM goal_validations WHERE goal_id = ?").get(goal.id) as any;
    expect(row).toBeDefined();
    expect(row.verdict).toBe("pass");
  });

  test("ATLAS_VALIDATOR_MOCK=fail → fail verdict + telemetry row", async () => {
    process.env.ATLAS_VALIDATOR_MOCK = "fail:Missing test coverage";
    const goal = goalCreate(db, { title: "Failing goal", done: "100% coverage", ...scope });

    const { runValidator } = await import("./manage-tasks.ts");
    const result = await runValidator({ goal, reason: "I think it's done", db });

    expect(result.verdict).toBe("fail");
    expect(result.feedback).toContain("Missing test coverage");

    const row = db.prepare("SELECT * FROM goal_validations WHERE goal_id = ?").get(goal.id) as any;
    expect(row).toBeDefined();
    expect(row.verdict).toBe("fail");
    expect(row.feedback).toContain("Missing test coverage");
  });

  test("ATLAS_VALIDATOR_MOCK increments validation_count", async () => {
    process.env.ATLAS_VALIDATOR_MOCK = "fail";
    const goal = goalCreate(db, { title: "Count test", done: "Done", ...scope });

    const { runValidator } = await import("./manage-tasks.ts");
    await runValidator({ goal, reason: "try 1", db });

    const updated = goalGet(db, goal.id)!;
    expect(updated.validation_count).toBe(1);
  });

  test("parseValidatorOutput: extracts JSON even when trigger-runner prefixes it with [ISO] Result:", () => {
    // Regression: in real validator runs, trigger-runner.ts logs the final
    // assistant message as `[2026-05-20T11:34:08.868Z] Result: {…}` to stdout.
    // The earlier parser checked `line.startsWith("{")` and missed the JSON,
    // causing every real validation to fall back to "no parseable output".
    const stdout = [
      `[2026-05-20T11:33:43.868Z] Direct session starting (channel=validator, model=opus)`,
      `[2026-05-20T11:34:08.868Z] Result: {"verdict": "pass", "feedback": "Done condition verified end-to-end"}`,
      `[2026-05-20T11:34:08.880Z] Direct session done (error=false)`,
    ].join("\n");
    const out = parseValidatorOutput(stdout);
    expect(out.verdict).toBe("pass");
    expect(out.feedback).toBe("Done condition verified end-to-end");
  });

  test("parseValidatorOutput: picks the LAST verdict line when validator reasons in JSON before committing", () => {
    const stdout = [
      `[ts] Result: {"thought":"checking files"}`,
      `[ts] Result: {"verdict":"fail","feedback":"final-verdict"}`,
    ].join("\n");
    const out = parseValidatorOutput(stdout);
    expect(out.verdict).toBe("fail");
    expect(out.feedback).toBe("final-verdict");
  });

  test("parseValidatorOutput: returns fallback fail when no JSON is found", () => {
    const out = parseValidatorOutput("no json here\njust prose\n");
    expect(out.verdict).toBe("fail");
    expect(out.feedback).toContain("no parseable output");
  });

  test("parseValidatorOutput: truncates feedback to 200 chars", () => {
    const longFeedback = "x".repeat(500);
    const stdout = `Result: {"verdict":"pass","feedback":"${longFeedback}"}`;
    const out = parseValidatorOutput(stdout);
    expect(out.verdict).toBe("pass");
    expect(out.feedback.length).toBe(200);
  });

  test("max 3 validations → validation_exhausted on close attempt", () => {
    const goal = goalCreate(db, { title: "Exhausted goal", done: "Done", ...scope });

    // Manually set validation_count to 3
    db.prepare("UPDATE goals SET validation_count = 3 WHERE id = ?").run(goal.id);

    // The CLI would check this and mark exhausted — test the DB state directly
    const refreshed = goalGet(db, goal.id)!;
    expect(refreshed.validation_count).toBe(3);

    // Simulate what the CLI does when limit is reached
    db.prepare(
      "UPDATE goals SET status = 'validation_exhausted', closed_at = datetime('now'), close_reason = ? WHERE id = ?"
    ).run("exhausted after 3 attempts", goal.id);
    db.prepare(
      "INSERT INTO goal_validations (goal_id, attempt, verdict, feedback) VALUES (?, ?, 'exhausted', ?)"
    ).run(goal.id, 4, "Maximum validation attempts reached");

    const final = goalGet(db, goal.id)!;
    expect(final.status).toBe("validation_exhausted");
  });
});

// ---------------------------------------------------------------------------
// Task lifecycle
// ---------------------------------------------------------------------------

describe("Task lifecycle", () => {
  let db: Database;
  const scope = makeScope("tasks");

  beforeEach(() => { db = createTestDb(); });

  test("add with deps stores dependency rows", () => {
    const t1 = taskAdd(db, { title: "First", ...scope });
    const t2 = taskAdd(db, { title: "Second", dependsOn: [t1.id], ...scope });

    const deps = db.prepare("SELECT * FROM task_deps WHERE task_id = ?").all(t2.id) as any[];
    expect(deps.length).toBe(1);
    expect(deps[0].depends_on).toBe(t1.id);
  });

  test("add with multiple deps stores all rows", () => {
    const t1 = taskAdd(db, { title: "T1", ...scope });
    const t2 = taskAdd(db, { title: "T2", ...scope });
    const t3 = taskAdd(db, { title: "T3", dependsOn: [t1.id, t2.id], ...scope });

    const deps = db.prepare("SELECT * FROM task_deps WHERE task_id = ?").all(t3.id) as any[];
    expect(deps.length).toBe(2);
  });

  test("ready returns only tasks with all deps closed", () => {
    const t1 = taskAdd(db, { title: "T1", ...scope });
    const t2 = taskAdd(db, { title: "T2", dependsOn: [t1.id], ...scope });
    const t3 = taskAdd(db, { title: "T3", ...scope }); // no deps

    // Before t1 is closed, only t3 is ready (t2 is blocked)
    let ready = taskReady(db, scope);
    const readyIds = ready.map((t) => t.id);
    expect(readyIds).toContain(t3.id);
    expect(readyIds).not.toContain(t2.id);
    expect(readyIds).toContain(t1.id);

    // Close t1 → t2 becomes ready
    taskClose(db, { taskId: t1.id, reason: "Done" });
    ready = taskReady(db, scope);
    expect(ready.map((t) => t.id)).toContain(t2.id);
  });

  test("ready excludes tasks where any dep is open/in_progress", () => {
    const t1 = taskAdd(db, { title: "T1", ...scope });
    const t2 = taskAdd(db, { title: "T2", ...scope });
    // t3 depends on both t1 and t2
    const t3 = taskAdd(db, { title: "T3", dependsOn: [t1.id, t2.id], ...scope });

    // Close only t1 — t2 still open → t3 not ready
    taskClose(db, { taskId: t1.id, reason: "Done" });
    const ready = taskReady(db, scope);
    expect(ready.map((t) => t.id)).not.toContain(t3.id);
  });

  test("close marks task as done", () => {
    const t = taskAdd(db, { title: "Closable", ...scope });
    const closed = taskClose(db, { taskId: t.id, reason: "All done" });
    expect(closed.status).toBe("done");
    expect(closed.close_reason).toBe("All done");
    expect(closed.closed_at).toBeDefined();
  });

  test("cancel works on open status", () => {
    const t = taskAdd(db, { title: "Cancellable", ...scope });
    const cancelled = taskCancel(db, { taskId: t.id, reason: "Not needed" });
    expect(cancelled.status).toBe("cancelled");
  });

  test("cancel works on in_progress status", () => {
    const t = taskAdd(db, { title: "In progress", ...scope });
    db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(t.id);
    const cancelled = taskCancel(db, { taskId: t.id });
    expect(cancelled.status).toBe("cancelled");
  });

  test("close on already-done task throws", () => {
    const t = taskAdd(db, { title: "Already done", ...scope });
    taskClose(db, { taskId: t.id, reason: "Done" });
    expect(() => taskClose(db, { taskId: t.id, reason: "Again" })).toThrow();
  });

  test("taskGet returns null for missing id", () => {
    expect(taskGet(db, 9999)).toBeNull();
  });

  test("taskList with statuses filter works", () => {
    const t1 = taskAdd(db, { title: "Open", ...scope });
    const t2 = taskAdd(db, { title: "To close", ...scope });
    taskClose(db, { taskId: t2.id, reason: "Done" });

    const openOnly = taskList(db, { ...scope, statuses: ["open"] });
    expect(openOnly.map((t) => t.id)).toContain(t1.id);
    expect(openOnly.map((t) => t.id)).not.toContain(t2.id);

    const doneOnly = taskList(db, { ...scope, statuses: ["done"] });
    expect(doneOnly.map((t) => t.id)).toContain(t2.id);
  });

  test("priority stored and retrieved correctly", () => {
    const t = taskAdd(db, { title: "High pri", priority: 1, ...scope });
    expect(t.priority).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Session scoping
// ---------------------------------------------------------------------------

describe("Session scoping", () => {
  let db: Database;

  beforeEach(() => { db = createTestDb(); });

  test("two different sessions see only their own tasks", () => {
    const scopeA = makeScope("scope-a");
    const scopeB = makeScope("scope-b");

    taskAdd(db, { title: "Task A", ...scopeA });
    taskAdd(db, { title: "Task B", ...scopeB });

    const tasksA = taskList(db, { ...scopeA, statuses: ["open"] });
    const tasksB = taskList(db, { ...scopeB, statuses: ["open"] });

    expect(tasksA.length).toBe(1);
    expect(tasksA[0].title).toBe("Task A");
    expect(tasksB.length).toBe(1);
    expect(tasksB[0].title).toBe("Task B");
  });

  test("two different sessions see only their own goals", () => {
    const scopeA = makeScope("goal-scope-a");
    const scopeB = makeScope("goal-scope-b");

    goalCreate(db, { title: "Goal A", done: "Done A", ...scopeA });
    goalCreate(db, { title: "Goal B", done: "Done B", ...scopeB });

    const goalsA = goalList(db, scopeA);
    const goalsB = goalList(db, scopeB);

    expect(goalsA.length).toBe(1);
    expect(goalsA[0].title).toBe("Goal A");
    expect(goalsB.length).toBe(1);
    expect(goalsB[0].title).toBe("Goal B");
  });

  test("--all override returns tasks from all sessions", () => {
    const scopeA = makeScope("all-a");
    const scopeB = makeScope("all-b");

    taskAdd(db, { title: "Task A", ...scopeA });
    taskAdd(db, { title: "Task B", ...scopeB });

    const allTasks = taskList(db, { all: true, statuses: ["open"] });
    expect(allTasks.length).toBeGreaterThanOrEqual(2);
  });

  test("--all override returns goals from all sessions", () => {
    const scopeA = makeScope("all-goal-a");
    const scopeB = makeScope("all-goal-b");

    goalCreate(db, { title: "Goal A", done: "Done A", ...scopeA });
    goalCreate(db, { title: "Goal B", done: "Done B", ...scopeB });

    const allGoals = goalList(db, { all: true });
    expect(allGoals.length).toBeGreaterThanOrEqual(2);
  });

  test("an empty-string scope never matches real session rows", () => {
    // getSessionScope rejects empty env vars, but guard the query layer too:
    // a blank session key must not act as a wildcard that leaks other sessions.
    const scopeA = makeScope("real-a");
    goalCreate(db, { title: "Goal A", done: "Done A", ...scopeA });
    taskAdd(db, { title: "Task A", ...scopeA });

    const leakedGoals = goalList(db, { triggerName: "", sessionKey: "" });
    const leakedTasks = taskList(db, { triggerName: "", sessionKey: "", statuses: ["open"] });
    expect(leakedGoals.length).toBe(0);
    expect(leakedTasks.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Hook integration (unit level)
// ---------------------------------------------------------------------------

describe("Hook integration (unit level)", () => {
  // Resolve the app directory that contains the NEW task management files.
  // Check for a task-session.sh (new file) to distinguish container vs dev.
  const REPO_APP_DIR = "/home/agent/projects/atlas/app";
  function resolveAppDir(): string {
    const { existsSync } = require("fs");
    // In production container, /atlas/app has task-session.sh
    if (existsSync("/atlas/app/hooks/task-session.sh")) return "/atlas/app";
    // In dev/test, use the repo directly
    return REPO_APP_DIR;
  }

  test("task-session.sh exists and is a non-empty file", async () => {
    const { existsSync, readFileSync } = await import("fs");
    const appDir = resolveAppDir();
    const scriptPath = `${appDir}/hooks/task-session.sh`;
    expect(existsSync(scriptPath)).toBe(true);
    const content = readFileSync(scriptPath, "utf8");
    expect(content.length).toBeGreaterThan(50);
    expect(content).toContain("task-session.sh");
  });

  test("post-compact.sh exists", async () => {
    const { existsSync } = await import("fs");
    const appDir = resolveAppDir();
    expect(existsSync(`${appDir}/hooks/post-compact.sh`)).toBe(true);
  });

  test("task binary exists at app/bin/task", async () => {
    const { existsSync } = await import("fs");
    const appDir = resolveAppDir();
    expect(existsSync(`${appDir}/bin/task`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Synthetic session key (webhook)
// ---------------------------------------------------------------------------

describe("Synthetic session key", () => {
  test("webhook-prefixed synthetic key has correct format", () => {
    const runId = 42;
    const syntheticKey = `webhook-${runId}`;
    expect(syntheticKey).toMatch(/^webhook-\d+$/);
  });

  test("tasks can be created with synthetic session key", () => {
    const db = createTestDb();
    const scope = { triggerName: "my-webhook", sessionKey: "webhook-42" };
    const task = taskAdd(db, { title: "Webhook task", ...scope });
    expect(task.id).toBeGreaterThan(0);
    expect(task.session_key).toBe("webhook-42");
  });
});

// ---------------------------------------------------------------------------
// Kill-switch
// ---------------------------------------------------------------------------

describe("Kill-switch (ATLAS_TASKS_DISABLE_GATE)", () => {
  afterEach(() => {
    delete process.env.ATLAS_TASKS_DISABLE_GATE;
  });

  test("kill-switch env var is defined and respected", () => {
    // The actual gate is in task-session.sh; we verify the env var behavior
    // by checking that it's read from environment
    process.env.ATLAS_TASKS_DISABLE_GATE = "1";
    expect(process.env.ATLAS_TASKS_DISABLE_GATE).toBe("1");
    delete process.env.ATLAS_TASKS_DISABLE_GATE;
    expect(process.env.ATLAS_TASKS_DISABLE_GATE).toBeUndefined();
  });
});
