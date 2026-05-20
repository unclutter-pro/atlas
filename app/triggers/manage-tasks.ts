#!/usr/bin/env bun
/**
 * Task management CLI for Atlas sessions.
 * Usage: task <command> [flags]
 *
 * GOALS
 *   task goal create --title="..." --done="..." [--description="..."]
 *   task goal list [--all]
 *   task goal show <id>
 *   task goal close <id> --reason="..." [--cascade-cancel]
 *
 * TASKS
 *   task add --title="..." [--description="..."] [--goal=<id>] [--priority=2] [--depends-on=<id>[,<id>...]]
 *   task list [--all] [--status=open,in_progress,done,cancelled]
 *   task ready
 *   task show <id>
 *   task close <id> [--reason="..."]
 *   task cancel <id>
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { openDb } from "../lib/db.ts";
import { initDb as atlasInitDb } from "../lib/atlas-db.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Goal = {
  id: number;
  title: string;
  description: string | null;
  done_condition: string;
  status: "active" | "done" | "abandoned" | "validation_exhausted";
  validation_count: number;
  trigger_name: string;
  session_key: string;
  created_at: string;
  closed_at: string | null;
  close_reason: string | null;
};

export type Task = {
  id: number;
  title: string;
  description: string | null;
  status: "open" | "in_progress" | "done" | "cancelled";
  priority: number;
  goal_id: number | null;
  trigger_name: string;
  session_key: string;
  claimed_by: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  close_reason: string | null;
};

export type GoalValidation = {
  id: number;
  goal_id: number;
  attempt: number;
  verdict: "pass" | "fail" | "exhausted";
  feedback: string | null;
  duration_ms: number | null;
  started_at: string;
};

export type ValidatorResult = {
  verdict: "pass" | "fail";
  feedback: string;
};

// ---------------------------------------------------------------------------
// Session scoping helpers
// ---------------------------------------------------------------------------

/** Get the current session scope (trigger_name, session_key) or error. */
export function getSessionScope(allowAll: boolean = false): {
  triggerName: string;
  sessionKey: string;
} | null {
  const triggerName = process.env.ATLAS_TRIGGER;
  const sessionKey = process.env.ATLAS_TRIGGER_SESSION_KEY;

  if (!triggerName || !sessionKey) {
    if (allowAll) return null;
    console.error(
      'Error: Cannot create tasks outside a trigger session — ATLAS_TRIGGER must be set'
    );
    process.exit(1);
  }
  return { triggerName, sessionKey };
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

export type ParsedArgs = {
  positional: string[];
  flags: Record<string, string | boolean>;
};

export function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (const arg of args) {
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        const val = arg.slice(eqIdx + 1);
        flags[key] = val;
      } else {
        flags[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  return { positional, flags };
}

function flag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  if (v === undefined || v === true) return undefined;
  return v as string;
}

function boolFlag(flags: Record<string, string | boolean>, key: string): boolean {
  return !!flags[key];
}

function die(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function initDb(): Database {
  // Use atlasInitDb to run all migrations (including task management tables).
  // Falls back to openDb if atlas-db.ts is unavailable.
  try {
    return atlasInitDb();
  } catch {
    const db = openDb();
    db.exec("PRAGMA foreign_keys = ON");
    return db;
  }
}

// ---------------------------------------------------------------------------
// Goal commands
// ---------------------------------------------------------------------------

export function goalCreate(db: Database, opts: {
  title: string;
  done: string;
  description?: string;
  triggerName: string;
  sessionKey: string;
}): Goal {
  const result = db.prepare(`
    INSERT INTO goals (title, description, done_condition, trigger_name, session_key)
    VALUES (?, ?, ?, ?, ?)
    RETURNING *
  `).get(
    opts.title,
    opts.description ?? null,
    opts.done,
    opts.triggerName,
    opts.sessionKey,
  ) as Goal;
  return result;
}

export function goalList(db: Database, opts: {
  triggerName?: string;
  sessionKey?: string;
  all?: boolean;
  includeClosedStatuses?: boolean;
}): Goal[] {
  if (opts.all) {
    if (opts.includeClosedStatuses) {
      return db.prepare("SELECT * FROM goals ORDER BY created_at DESC").all() as Goal[];
    }
    return db.prepare("SELECT * FROM goals WHERE status = 'active' ORDER BY created_at DESC").all() as Goal[];
  }
  if (!opts.triggerName || !opts.sessionKey) return [];
  if (opts.includeClosedStatuses) {
    return db.prepare(
      "SELECT * FROM goals WHERE trigger_name = ? AND session_key = ? ORDER BY created_at DESC"
    ).all(opts.triggerName, opts.sessionKey) as Goal[];
  }
  return db.prepare(
    "SELECT * FROM goals WHERE trigger_name = ? AND session_key = ? AND status = 'active' ORDER BY created_at DESC"
  ).all(opts.triggerName, opts.sessionKey) as Goal[];
}

export function goalGet(db: Database, id: number): Goal | null {
  return db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as Goal | null;
}

/** Returns count of tasks by status for a goal */
export function goalTaskCounts(db: Database, goalId: number): Record<string, number> {
  const rows = db.prepare(
    "SELECT status, COUNT(*) as cnt FROM tasks WHERE goal_id = ? GROUP BY status"
  ).all(goalId) as Array<{ status: string; cnt: number }>;
  const counts: Record<string, number> = { open: 0, in_progress: 0, done: 0, cancelled: 0 };
  for (const r of rows) {
    counts[r.status] = r.cnt;
  }
  return counts;
}

export function goalClose(db: Database, opts: {
  goalId: number;
  reason: string;
  cascadeCancel?: boolean;
  triggerName?: string;
  sessionKey?: string;
}): { blocked?: string; closed: boolean; needsValidation?: boolean; goal?: Goal } {
  const goal = goalGet(db, opts.goalId);
  if (!goal) return die(`Goal #${opts.goalId} not found`);

  if (goal.status !== "active") {
    return die(`Goal #${opts.goalId} is already ${goal.status}`);
  }

  // Count open tasks
  const openTasks = db.prepare(
    "SELECT COUNT(*) as cnt FROM tasks WHERE goal_id = ? AND status IN ('open', 'in_progress')"
  ).get(opts.goalId) as { cnt: number };

  if (openTasks.cnt > 0 && !opts.cascadeCancel) {
    return {
      blocked: `Goal #${opts.goalId} has ${openTasks.cnt} open task(s). Close/cancel them, or use --cascade-cancel to auto-cancel them as part of goal close.`,
      closed: false,
    };
  }

  // Cascade cancel open tasks
  if (opts.cascadeCancel && openTasks.cnt > 0) {
    db.prepare(
      `UPDATE tasks SET status = 'cancelled', close_reason = ?, closed_at = datetime('now'), updated_at = datetime('now')
       WHERE goal_id = ? AND status IN ('open', 'in_progress')`
    ).run(`goal closed: ${opts.reason}`, opts.goalId);
  }

  // Validation is always required (no opt-out). The caller is expected to
  // run the validator and update the goal status based on the verdict.
  return { closed: false, needsValidation: true, goal };
}

// ---------------------------------------------------------------------------
// Task commands
// ---------------------------------------------------------------------------

export function taskAdd(db: Database, opts: {
  title: string;
  description?: string;
  goalId?: number;
  priority?: number;
  dependsOn?: number[];
  triggerName: string;
  sessionKey: string;
}): Task {
  const priority = opts.priority ?? 2;
  if (priority < 0 || priority > 4) {
    throw new Error(`Invalid priority ${priority}. Must be between 0 and 4.`);
  }

  if (opts.goalId !== undefined) {
    const goal = goalGet(db, opts.goalId);
    if (!goal) die(`Goal #${opts.goalId} not found`);
  }

  const result = db.prepare(`
    INSERT INTO tasks (title, description, priority, goal_id, trigger_name, session_key)
    VALUES (?, ?, ?, ?, ?, ?)
    RETURNING *
  `).get(
    opts.title,
    opts.description ?? null,
    priority,
    opts.goalId ?? null,
    opts.triggerName,
    opts.sessionKey,
  ) as Task;

  // Insert deps
  if (opts.dependsOn && opts.dependsOn.length > 0) {
    for (const depId of opts.dependsOn) {
      // Validate dep task exists
      const dep = taskGet(db, depId);
      if (!dep) die(`Dependency task #${depId} not found`);
      db.prepare(
        "INSERT OR IGNORE INTO task_deps (task_id, depends_on) VALUES (?, ?)"
      ).run(result.id, depId);
    }
  }

  return result;
}

export function taskList(db: Database, opts: {
  triggerName?: string;
  sessionKey?: string;
  all?: boolean;
  statuses?: string[];
}): Task[] {
  const statuses = opts.statuses ?? ["open", "in_progress"];

  if (opts.all) {
    if (statuses.length === 0) {
      return db.prepare("SELECT * FROM tasks ORDER BY priority ASC, created_at ASC").all() as Task[];
    }
    const placeholders = statuses.map(() => "?").join(",");
    return db.prepare(
      `SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY priority ASC, created_at ASC`
    ).all(...statuses) as Task[];
  }

  if (!opts.triggerName || !opts.sessionKey) return [];

  if (statuses.length === 0) {
    return db.prepare(
      "SELECT * FROM tasks WHERE trigger_name = ? AND session_key = ? ORDER BY priority ASC, created_at ASC"
    ).all(opts.triggerName, opts.sessionKey) as Task[];
  }

  const placeholders = statuses.map(() => "?").join(",");
  return db.prepare(
    `SELECT * FROM tasks WHERE trigger_name = ? AND session_key = ? AND status IN (${placeholders})
     ORDER BY priority ASC, created_at ASC`
  ).all(opts.triggerName, opts.sessionKey, ...statuses) as Task[];
}

/** Returns tasks that are open AND all their deps are closed (done or cancelled). */
export function taskReady(db: Database, opts: {
  triggerName: string;
  sessionKey: string;
}): Task[] {
  // An open task is ready if it has no deps OR all its deps are done/cancelled
  const allOpen = db.prepare(
    `SELECT * FROM tasks WHERE trigger_name = ? AND session_key = ? AND status = 'open'
     ORDER BY priority ASC, created_at ASC`
  ).all(opts.triggerName, opts.sessionKey) as Task[];

  return allOpen.filter((task) => {
    const deps = db.prepare(
      "SELECT t.status FROM task_deps td JOIN tasks t ON t.id = td.depends_on WHERE td.task_id = ?"
    ).all(task.id) as Array<{ status: string }>;

    if (deps.length === 0) return true;
    return deps.every((d) => d.status === "done" || d.status === "cancelled");
  });
}

export function taskGet(db: Database, id: number): Task | null {
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | null;
}

export function taskClose(db: Database, opts: {
  taskId: number;
  reason?: string;
}): Task {
  const task = taskGet(db, opts.taskId);
  if (!task) throw new Error(`Task #${opts.taskId} not found`);

  if (task.status === "done" || task.status === "cancelled") {
    throw new Error(`Task #${opts.taskId} is already ${task.status}`);
  }

  db.prepare(
    `UPDATE tasks SET status = 'done', close_reason = ?, closed_at = datetime('now'),
     updated_at = datetime('now') WHERE id = ?`
  ).run(opts.reason ?? null, opts.taskId);

  return taskGet(db, opts.taskId)!;
}

export function taskCancel(db: Database, opts: {
  taskId: number;
  reason?: string;
}): Task {
  const task = taskGet(db, opts.taskId);
  if (!task) throw new Error(`Task #${opts.taskId} not found`);

  if (task.status === "done" || task.status === "cancelled") {
    throw new Error(`Task #${opts.taskId} is already ${task.status}`);
  }

  db.prepare(
    `UPDATE tasks SET status = 'cancelled', close_reason = ?, closed_at = datetime('now'),
     updated_at = datetime('now') WHERE id = ?`
  ).run(opts.reason ?? null, opts.taskId);

  return taskGet(db, opts.taskId)!;
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

const MAX_VALIDATIONS = 3;
const VALIDATOR_TIMEOUT_MS = 5 * 60 * 1000;

export async function runValidator(opts: {
  goal: Goal;
  reason: string;
  db: Database;
}): Promise<ValidatorResult> {
  const { goal, reason, db } = opts;

  // Mock mode for tests
  const mockEnv = process.env.ATLAS_VALIDATOR_MOCK;
  if (mockEnv) {
    const [mockVerdict, ...feedbackParts] = mockEnv.split(":");
    const verdict = (mockVerdict === "pass" || mockVerdict === "fail") ? mockVerdict : "fail";
    const feedback = feedbackParts.join(":") || (verdict === "pass" ? "Mock: validation passed" : "Mock: validation failed");

    const attempt = goal.validation_count + 1;
    const startedAt = Date.now();
    db.prepare(
      `INSERT INTO goal_validations (goal_id, attempt, verdict, feedback, duration_ms)
       VALUES (?, ?, ?, ?, ?)`
    ).run(goal.id, attempt, verdict, feedback, 0);

    db.prepare("UPDATE goals SET validation_count = validation_count + 1 WHERE id = ?").run(goal.id);

    return { verdict, feedback };
  }

  // Real validator spawn
  const APP_DIR = "/atlas/app";
  const HOME = process.env.HOME ?? "/home/agent";
  const triggerRunnerPath = `${APP_DIR}/triggers/trigger-runner`;

  if (!existsSync(triggerRunnerPath)) {
    // Fallback path for development
    const devPath = `${APP_DIR}/triggers/trigger-runner.ts`;
    if (!existsSync(devPath)) {
      return die("trigger-runner not found — cannot run validator");
    }
  }

  // Build validator prompt from template
  const promptTemplatePath = `${APP_DIR}/prompts/validator.md`;
  let promptTemplate = "";
  if (existsSync(promptTemplatePath)) {
    promptTemplate = await Bun.file(promptTemplatePath).text();
  } else {
    promptTemplate = `Verify: {title}\nDone condition: {done_condition}\nReason: {reason}\nRespond: {"verdict":"pass"|"fail","feedback":"..."}`;
  }

  const prompt = promptTemplate
    .split("{title}").join(goal.title)
    .split("{description}").join(goal.description ?? "(none provided)")
    .split("{done_condition}").join(goal.done_condition)
    .split("{reason}").join(reason);

  // Spawn with stripped environment (no ATLAS_TRIGGER, no ATLAS_TRIGGER_SESSION_KEY)
  const strippedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "ATLAS_TRIGGER" || k === "ATLAS_TRIGGER_SESSION_KEY") continue;
    if (v !== undefined) strippedEnv[k] = v;
  }

  const attempt = goal.validation_count + 1;
  const startMs = Date.now();

  // Determine executable
  const execPath = existsSync(triggerRunnerPath)
    ? triggerRunnerPath
    : "bun";

  // Tag this session with trigger-name=validator so dreaming/memory-cleanup
  // filters can exclude it (the validator is a quality gate, not a real
  // session worth analyzing).
  const spawnArgs = existsSync(triggerRunnerPath)
    ? [triggerRunnerPath, "--direct", prompt, "--channel", "validator", "--trigger-name", "validator"]
    : ["bun", `${APP_DIR}/triggers/trigger-runner.ts`, "--direct", prompt, "--channel", "validator", "--trigger-name", "validator"];

  const proc = Bun.spawn(spawnArgs, {
    env: strippedEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Apply timeout
  const timeoutHandle = setTimeout(() => {
    try { proc.kill(); } catch {}
  }, VALIDATOR_TIMEOUT_MS);

  let stdout = "";
  let stderr = "";

  try {
    const stdoutText = await new Response(proc.stdout).text();
    const stderrText = await new Response(proc.stderr).text();
    stdout = stdoutText;
    stderr = stderrText;
    await proc.exited;
  } finally {
    clearTimeout(timeoutHandle);
  }

  const durationMs = Date.now() - startMs;

  // Parse the last JSON line from stdout
  let result: ValidatorResult = { verdict: "fail", feedback: "Validator produced no parseable output" };

  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as { verdict?: string; feedback?: string };
      if (parsed.verdict === "pass" || parsed.verdict === "fail") {
        result = {
          verdict: parsed.verdict,
          feedback: (parsed.feedback ?? "").slice(0, 200),
        };
        break;
      }
    } catch {
      continue;
    }
  }

  // Record validation attempt
  db.prepare(
    `INSERT INTO goal_validations (goal_id, attempt, verdict, feedback, duration_ms)
     VALUES (?, ?, ?, ?, ?)`
  ).run(goal.id, attempt, result.verdict, result.feedback, durationMs);

  db.prepare("UPDATE goals SET validation_count = validation_count + 1 WHERE id = ?").run(goal.id);

  return result;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

const PRIORITY_LABELS: Record<number, string> = {
  0: "P0",
  1: "P1",
  2: "P2",
  3: "P3",
  4: "P4",
};

function priorityLabel(p: number): string {
  return PRIORITY_LABELS[p] ?? `P${p}`;
}

function printGoal(goal: Goal, db: Database): void {
  const counts = goalTaskCounts(db, goal.id);
  console.log(`Goal #${goal.id} [${goal.status}] ${goal.title}`);
  console.log(`  done-when: ${goal.done_condition}`);
  if (goal.description) {
    console.log(`  context:   ${goal.description}`);
  }
  console.log(`  validations: ${goal.validation_count}/${MAX_VALIDATIONS}`);
  console.log(`  tasks:     ${counts.open} open, ${counts.done} done, ${counts.in_progress} in_progress, ${counts.cancelled} cancelled`);
  console.log(`  created:   ${goal.created_at}`);
  if (goal.closed_at) {
    console.log(`  closed:    ${goal.closed_at} — ${goal.close_reason ?? ""}`);
  }
}

function printTask(task: Task, db: Database): void {
  const deps = db.prepare(
    `SELECT t.id, t.status, t.title FROM task_deps td JOIN tasks t ON t.id = td.depends_on WHERE td.task_id = ?`
  ).all(task.id) as Array<{ id: number; status: string; title: string }>;

  console.log(`Task #${task.id} [${priorityLabel(task.priority)}] [${task.status}] ${task.title}`);
  if (task.description) {
    console.log(`  description: ${task.description}`);
  }
  if (task.goal_id !== null) {
    console.log(`  goal: #${task.goal_id}`);
  }
  if (deps.length > 0) {
    const depStr = deps.map((d) => `#${d.id}[${d.status}]`).join(", ");
    console.log(`  deps: ${depStr}`);
  }
  console.log(`  created: ${task.created_at}`);
  if (task.closed_at) {
    console.log(`  closed:  ${task.closed_at} — ${task.close_reason ?? ""}`);
  }
}

// ---------------------------------------------------------------------------
// Main CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.length === 0 || rawArgs[0] === "--help" || rawArgs[0] === "help") {
    printHelp();
    return;
  }

  const db = initDb();
  const { positional, flags } = parseArgs(rawArgs);
  const firstArg = positional[0];

  // ---- GOAL subcommands ----
  if (firstArg === "goal") {
    const subCmd = positional[1];

    if (subCmd === "create") {
      const scope = getSessionScope(false)!;
      if (!process.env.ATLAS_TRIGGER_SESSION_KEY) {
        die("Cannot create goal outside a trigger session — ATLAS_TRIGGER_SESSION_KEY must be set");
      }
      const title = flag(flags, "title");
      const done = flag(flags, "done");
      if (!title) die("--title is required");
      if (!done) die("--done is required");

      const goal = goalCreate(db, {
        title,
        done,
        description: flag(flags, "description"),
        triggerName: scope.triggerName,
        sessionKey: scope.sessionKey,
      });
      console.log(`Created goal #${goal.id}: ${goal.title}`);
      console.log(`  Closing this goal will trigger an isolated validator (max 3 attempts).`);
      return;
    }

    if (subCmd === "list") {
      const all = boolFlag(flags, "all");
      const scope = all ? null : getSessionScope(false);
      const goals = goalList(db, {
        triggerName: scope?.triggerName,
        sessionKey: scope?.sessionKey,
        all,
        includeClosedStatuses: boolFlag(flags, "all"),
      });
      if (goals.length === 0) {
        console.log("No active goals.");
        return;
      }
      for (const g of goals) {
        const counts = goalTaskCounts(db, g.id);
        console.log(`#${g.id} [${g.status}] ${g.title}`);
        console.log(`  done-when: ${g.done_condition}`);
        console.log(`  tasks: ${counts.open} open, ${counts.done} done, ${counts.in_progress} in_progress`);
      }
      return;
    }

    if (subCmd === "show") {
      const id = parseInt(positional[2] ?? flag(flags, "id") ?? "");
      if (!id || isNaN(id)) die("Goal ID required");
      const goal = goalGet(db, id);
      if (!goal) die(`Goal #${id} not found`);
      printGoal(goal, db);
      return;
    }

    if (subCmd === "close") {
      const id = parseInt(positional[2] ?? flag(flags, "id") ?? "");
      if (!id || isNaN(id)) die("Goal ID required");
      const reason = flag(flags, "reason");
      if (!reason) die("--reason is required");

      const cascadeCancel = boolFlag(flags, "cascade-cancel");

      const goal = goalGet(db, id);
      if (!goal) die(`Goal #${id} not found`);

      // Check validation limit first — terminal state to prevent infinite loops
      if (goal.validation_count >= MAX_VALIDATIONS) {
        db.prepare(
          `UPDATE goals SET status = 'validation_exhausted', closed_at = datetime('now'), close_reason = ? WHERE id = ?`
        ).run(reason, id);
        db.prepare(
          `INSERT INTO goal_validations (goal_id, attempt, verdict, feedback)
           VALUES (?, ?, 'exhausted', 'Maximum validation attempts (3) reached')`
        ).run(id, goal.validation_count + 1);
        console.error(`Goal #${id} has exhausted its validation attempts (3/3). Marked as validation_exhausted.`);
        process.exit(1);
        return;
      }

      const result = goalClose(db, {
        goalId: id,
        reason,
        cascadeCancel,
      });

      if (result.blocked) {
        console.error(result.blocked);
        process.exit(1);
        return;
      }

      // Validation is always required — orchestrate the validator run + close.
      console.log(`Running validator for goal #${id}...`);
      const freshGoal = goalGet(db, id)!;
      const validationResult = await runValidator({ goal: freshGoal, reason, db });

      if (validationResult.verdict === "pass") {
        db.prepare(
          `UPDATE goals SET status = 'done', closed_at = datetime('now'), close_reason = ? WHERE id = ?`
        ).run(reason, id);
        console.log(`Goal #${id} closed. Validator passed: ${validationResult.feedback}`);
      } else {
        console.error(
          `Validator rejected close for goal #${id}: ${validationResult.feedback}\n` +
          `Refine your work, then run \`task goal close ${id} --reason=...\` again.`
        );
        process.exit(1);
      }
      return;
    }

    printHelp();
    return;
  }

  // ---- TASK subcommands ----
  if (firstArg === "add") {
    const scope = getSessionScope(false)!;
    const title = flag(flags, "title");
    if (!title) die("--title is required");

    const priority = flags.priority !== undefined
      ? parseInt(String(flags.priority), 10)
      : 2;

    if (isNaN(priority) || priority < 0 || priority > 4) {
      die(`Invalid --priority value. Must be 0–4.`);
    }

    const goalId = flags.goal !== undefined
      ? parseInt(String(flags.goal), 10)
      : undefined;

    const dependsOnStr = flag(flags, "depends-on");
    const dependsOn = dependsOnStr
      ? dependsOnStr.split(",").map((s) => {
          const n = parseInt(s.trim(), 10);
          if (isNaN(n)) die(`Invalid dependency ID: ${s.trim()}`);
          return n;
        })
      : undefined;

    const task = taskAdd(db, {
      title,
      description: flag(flags, "description"),
      goalId: goalId && !isNaN(goalId) ? goalId : undefined,
      priority,
      dependsOn,
      triggerName: scope.triggerName,
      sessionKey: scope.sessionKey,
    });
    console.log(`Created task #${task.id}: ${task.title}`);
    return;
  }

  if (firstArg === "list") {
    const all = boolFlag(flags, "all");
    const scope = all ? null : getSessionScope(false);

    const statusStr = flag(flags, "status");
    const statuses = statusStr ? statusStr.split(",").map((s) => s.trim()) : ["open", "in_progress"];

    const tasks = taskList(db, {
      triggerName: scope?.triggerName,
      sessionKey: scope?.sessionKey,
      all,
      statuses,
    });
    if (tasks.length === 0) {
      console.log("No tasks.");
      return;
    }
    for (const t of tasks) {
      console.log(`#${t.id} [${priorityLabel(t.priority)}] [${t.status}] ${t.title}`);
    }
    return;
  }

  if (firstArg === "ready") {
    const scope = getSessionScope(false)!;
    const tasks = taskReady(db, { triggerName: scope.triggerName, sessionKey: scope.sessionKey });
    if (tasks.length === 0) {
      console.log("No ready tasks.");
      return;
    }
    for (const t of tasks) {
      console.log(`#${t.id} [${priorityLabel(t.priority)}] ${t.title}`);
    }
    return;
  }

  if (firstArg === "show") {
    const id = parseInt(positional[1] ?? flag(flags, "id") ?? "");
    if (!id || isNaN(id)) die("Task ID required");
    const task = taskGet(db, id);
    if (!task) die(`Task #${id} not found`);
    printTask(task, db);
    return;
  }

  if (firstArg === "close") {
    const id = parseInt(positional[1] ?? flag(flags, "id") ?? "");
    if (!id || isNaN(id)) die("Task ID required");
    const task = taskClose(db, { taskId: id, reason: flag(flags, "reason") });
    console.log(`Task #${task.id} closed.`);
    return;
  }

  if (firstArg === "cancel") {
    const id = parseInt(positional[1] ?? flag(flags, "id") ?? "");
    if (!id || isNaN(id)) die("Task ID required");
    const task = taskCancel(db, { taskId: id, reason: flag(flags, "reason") });
    console.log(`Task #${task.id} cancelled.`);
    return;
  }

  console.error(`Unknown command: ${firstArg}`);
  printHelp();
  process.exit(1);
}

function printHelp(): void {
  console.log(`
task — Atlas task management CLI

GOALS
  task goal create --title="..." --done="..." [--description="..."]
  task goal list [--all]
  task goal show <id>
  task goal close <id> --reason="..." [--cascade-cancel]

TASKS
  task add --title="..." [--description="..."] [--goal=<id>] [--priority=2] [--depends-on=<id>[,<id>...]]
  task list [--all] [--status=open,in_progress,done,cancelled]
  task ready
  task show <id>
  task close <id> [--reason="..."]
  task cancel <id>

NOTES
  All commands scope to (ATLAS_TRIGGER, ATLAS_TRIGGER_SESSION_KEY).
  Use --all to see across all sessions (for debugging).
  Priority: 0=critical, 1=high, 2=normal (default), 3=low, 4=backlog.
  Closing a goal always runs an isolated validator (max 3 attempts).
`);
}

// Run if this is the main module
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
