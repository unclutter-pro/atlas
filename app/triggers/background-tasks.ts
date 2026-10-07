/**
 * Tracks live background tasks (Agent/Bash run_in_background) for one trigger
 * session: stall detection and periodic check-ins so long work is never
 * silently dropped, plus crash recovery across process restarts.
 */
import type { Database } from "bun:sqlite";

/** Task types that never emit task_progress; stall detection would otherwise
 *  flag them the instant they start. They still get periodic check-ins. */
const NO_PROGRESS_TASK_TYPES = new Set(["local_bash"]);

function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m} min`;
}

type TrackedTask = {
  taskId: string;
  taskType: string;
  description: string;
  startedAt: number;
  lastProgressAt: number;
  stalledNotified: boolean;
};

export type BackgroundTaskTracker = {
  started(taskId: string, taskType: string, description: string, now: number): void;
  progress(taskId: string, now: number): void;
  done(taskId: string): void;
  isEmpty(): boolean;
  /** Call periodically with the current time; returns check-in notices due now. */
  checkNow(now: number): string[];
};

/**
 * `stallMs`: no progress on a progress-capable task for this long → one
 * check-in (re-armed once progress resumes). `checkinMs`: while any task is
 * live, a check-in at least this often regardless of stalls.
 */
export function createBackgroundTaskTracker(opts: { stallMs: number; checkinMs: number }): BackgroundTaskTracker {
  const tasks = new Map<string, TrackedTask>();
  // null while no task is live; set to the time the first task of the
  // current run of liveness started, so the periodic cadence restarts clean.
  let periodicSince: number | null = null;

  function started(taskId: string, taskType: string, description: string, now: number): void {
    tasks.set(taskId, { taskId, taskType, description, startedAt: now, lastProgressAt: now, stalledNotified: false });
    if (periodicSince === null) periodicSince = now;
  }

  function progress(taskId: string, now: number): void {
    const task = tasks.get(taskId);
    if (!task) return;
    task.lastProgressAt = now;
    task.stalledNotified = false; // re-arm: a future stall gets its own notice
  }

  function done(taskId: string): void {
    tasks.delete(taskId);
    if (tasks.size === 0) periodicSince = null;
  }

  function isEmpty(): boolean {
    return tasks.size === 0;
  }

  function checkNow(now: number): string[] {
    const messages: string[] = [];
    for (const task of tasks.values()) {
      if (task.stalledNotified || NO_PROGRESS_TASK_TYPES.has(task.taskType)) continue;
      if (now - task.lastProgressAt < opts.stallMs) continue;
      task.stalledNotified = true;
      messages.push(
        `[Runtime notice] Background task "${task.description}" (${task.taskId}) running for ` +
        `${formatDuration(now - task.startedAt)}, last progress ${formatDuration(now - task.lastProgressAt)} ago. ` +
        `Decide: keep waiting, stop it, or tell the user.`,
      );
    }
    if (periodicSince !== null && now - periodicSince >= opts.checkinMs) {
      periodicSince = now;
      for (const task of tasks.values()) {
        messages.push(
          `[Runtime notice] Background task "${task.description}" (${task.taskId}) still running after ` +
          `${formatDuration(now - task.startedAt)}. Decide: keep waiting, stop it, or tell the user.`,
        );
      }
    }
    return messages;
  }

  return { started, progress, done, isEmpty, checkNow };
}

// ---------------------------------------------------------------------------
// Crash recovery: persist the live task set so a process restart with tasks
// still running doesn't lose them silently.
// ---------------------------------------------------------------------------

export type PersistedBackgroundTask = {
  taskId: string;
  taskType: string;
  description: string;
  startedAt: string;
  outputFile: string | null;
};

export function saveBackgroundTask(
  db: Database,
  triggerName: string,
  sessionKey: string,
  task: { taskId: string; taskType: string; description: string; outputFile: string | null },
): void {
  db.prepare(
    `INSERT INTO background_tasks (trigger_name, session_key, task_id, task_type, description, output_file)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(trigger_name, session_key, task_id) DO UPDATE SET output_file = excluded.output_file`,
  ).run(triggerName, sessionKey, task.taskId, task.taskType, task.description, task.outputFile);
}

export function clearBackgroundTask(db: Database, triggerName: string, sessionKey: string, taskId: string): void {
  db.prepare(
    "DELETE FROM background_tasks WHERE trigger_name = ? AND session_key = ? AND task_id = ?",
  ).run(triggerName, sessionKey, taskId);
}

export function listBackgroundTasks(db: Database, triggerName: string, sessionKey: string): PersistedBackgroundTask[] {
  return db.prepare(
    `SELECT task_id AS taskId, task_type AS taskType, description, started_at AS startedAt, output_file AS outputFile
     FROM background_tasks WHERE trigger_name = ? AND session_key = ?`,
  ).all(triggerName, sessionKey) as PersistedBackgroundTask[];
}

export function clearBackgroundTasks(db: Database, triggerName: string, sessionKey: string): void {
  db.prepare("DELETE FROM background_tasks WHERE trigger_name = ? AND session_key = ?").run(triggerName, sessionKey);
}

/** Prepended to the first prompt when a previous process died with these tasks still live. */
export function buildInterruptedTasksNotice(tasks: PersistedBackgroundTask[], previousSessionId: string | null): string {
  const lines = tasks.map((t) => {
    const where = t.outputFile
      ? `its output may be at ${t.outputFile}`
      : `its output may be in the transcript of the previous session${previousSessionId ? ` (${previousSessionId})` : ""}`;
    return `- "${t.description}" (${t.taskId}), started ${t.startedAt}, ${where}`;
  });
  return `<system-notice>The previous process ended while these background tasks were still running:\n${lines.join("\n")}\nCheck on them before assuming they didn't finish.</system-notice>`;
}
