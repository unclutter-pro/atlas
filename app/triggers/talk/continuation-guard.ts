import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Queued input cannot outlive revocation or move to another configured account. */
export function talkAddressSkipReason(
  input: { payload: string }, home = process.env.HOME ?? "/home/agent",
): string | null {
  let payload: any;
  try { payload = JSON.parse(input.payload); } catch { return null; }
  if (payload?.type !== "talk_message" && payload?.type !== "talk_handoff") return null;
  const address = payload.address;
  if (typeof address?.instance !== "string" || !address.instance || typeof address?.room !== "string" || !address.room) {
    return "Talk message has no valid receive address";
  }
  const path = join(home, ".index", "talk", "talk.db");
  if (!existsSync(path)) return "Talk receive ledger is unavailable";
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    db.exec("PRAGMA busy_timeout=5000");
    const active = db.query("SELECT value FROM talk_meta WHERE key='active-instance'").get() as { value: string } | null;
    if (active && active.value !== address.instance) return "Talk account is no longer active";
    const room = db.query("SELECT enabled FROM talk_rooms WHERE instance=? AND room=?")
      .get(address.instance, address.room) as { enabled: number } | null;
    return room?.enabled === 1 ? null : "Talk room is no longer enabled";
  } catch {
    return "Talk receive eligibility could not be verified";
  } finally { db?.close(); }
}

/** Check at dispatch and again immediately before a queued answer starts a turn. */
export function talkContinuationSkipReason(
  db: Database, input: { triggerName: string; sessionKey: string; payload: string },
): string | null {
  let payload: any;
  try { payload = JSON.parse(input.payload); } catch { return null; }
  if (payload?.type !== "talk_message" || payload.request?.taskId == null) return null;
  const request = payload.request;
  if (!Number.isSafeInteger(request.taskId) || request.taskId <= 0
    || request.originTrigger !== input.triggerName || request.originSessionKey !== input.sessionKey) {
    return "Talk answer does not match its task owner";
  }
  const active = db.query(`SELECT 1 FROM tasks t JOIN triggers g ON g.name=t.trigger_name
    WHERE t.id=? AND t.trigger_name=? AND t.session_key=?
    AND t.status IN ('open','in_progress') AND g.enabled=1`)
    .get(request.taskId, input.triggerName, input.sessionKey);
  return active ? null : "Talk answer's task is no longer active for this session";
}
