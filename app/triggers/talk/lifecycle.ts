import type { Database } from "bun:sqlite";
import { pendingQuestionTaskIds } from "./ledger.ts";

export function isTaskActive(db: Database, trigger: string, key: string, taskId: number): boolean {
  return !!db.query(`SELECT 1 FROM tasks t JOIN triggers g ON g.name=t.trigger_name
    WHERE t.id=? AND t.trigger_name=? AND t.session_key=? AND t.status IN ('open','in_progress') AND g.enabled=1`)
    .get(taskId, trigger, key);
}

/** A waiting question excuses its task and dependent work, never unrelated ready work. */
export function canPauseForTalk(db: Database, trigger: string, key: string, ledgerPath?: string): boolean {
  if (!trigger || !key) return false;
  const tasks = db.query("SELECT id,goal_id FROM tasks WHERE trigger_name=? AND session_key=? AND status IN ('open','in_progress')")
    .all(trigger, key) as { id: number; goal_id: number | null }[];
  if (!tasks.length) return false;
  const ownIds = new Set(tasks.map(t => t.id));
  const waiting = new Set(pendingQuestionTaskIds(trigger, key, ledgerPath).filter(id => ownIds.has(id)));
  if (!waiting.size) return false;
  const deps = db.query("SELECT task_id,depends_on FROM task_deps").all() as { task_id: number; depends_on: number }[];
  let changed = true;
  while (changed) {
    changed = false;
    for (const { task_id, depends_on } of deps) {
      if (ownIds.has(task_id) && waiting.has(depends_on) && !waiting.has(task_id)) { waiting.add(task_id); changed = true; }
    }
  }
  if (tasks.some(t => !waiting.has(t.id))) return false;
  const goals = db.query("SELECT id FROM goals WHERE trigger_name=? AND session_key=? AND status='active'").all(trigger, key) as { id: number }[];
  return goals.every(goal => tasks.some(task => task.goal_id === goal.id));
}
