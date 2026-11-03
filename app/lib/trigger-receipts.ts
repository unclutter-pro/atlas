import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { isPidAlive } from "./trigger-socket.ts";

export type TriggerReceipt = {
  triggerName: string;
  sessionKey: string;
  eventId: string;
  channel: string;
  message: string;
  payload: string | null;
  state: "accepted" | "completed";
  sessionId: string | null;
  acceptedAt: string;
  completedAt: string | null;
  completionReason: string | null;
  messageHash: string;
  payloadHash: string | null;
  prunedAt: string | null;
};

const initialized = new WeakSet<Database>();

/** Kept separate from channel schemas so every trigger can use durable delivery. */
export function ensureTriggerReceipts(db: Database): void {
  if (initialized.has(db)) return;
  db.transaction(() => {
    db.exec(`
    CREATE TABLE IF NOT EXISTS trigger_delivery_receipts (
      trigger_name TEXT NOT NULL,
      session_key TEXT NOT NULL,
      event_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      message TEXT NOT NULL,
      payload TEXT,
      state TEXT NOT NULL DEFAULT 'accepted' CHECK(state IN ('accepted', 'completed')),
      session_id TEXT,
      accepted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      completed_at TEXT,
      completion_reason TEXT,
      message_hash TEXT,
      payload_hash TEXT,
      pruned_at TEXT,
      PRIMARY KEY (trigger_name, session_key, event_id)
    );
    CREATE INDEX IF NOT EXISTS trigger_delivery_pending
      ON trigger_delivery_receipts(trigger_name, session_key, state, accepted_at);
    CREATE TABLE IF NOT EXISTS trigger_delivery_owners (
      trigger_name TEXT NOT NULL,
      session_key TEXT NOT NULL,
      pid INTEGER NOT NULL,
      PRIMARY KEY (trigger_name, session_key)
    );
    `);
    const columns = db.query("PRAGMA table_info(trigger_delivery_receipts)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "completion_reason")) {
      db.exec("ALTER TABLE trigger_delivery_receipts ADD COLUMN completion_reason TEXT");
    }
    for (const column of ["message_hash", "payload_hash", "pruned_at"]) {
      if (!columns.some((existing) => existing.name === column)) {
        db.exec(`ALTER TABLE trigger_delivery_receipts ADD COLUMN ${column} TEXT`);
      }
    }
    const old = db.query("SELECT rowid, message, payload FROM trigger_delivery_receipts WHERE message_hash IS NULL")
      .all() as { rowid: number; message: string; payload: string | null }[];
    for (const receipt of old) {
      db.query("UPDATE trigger_delivery_receipts SET message_hash=?,payload_hash=? WHERE rowid=?")
        .run(triggerInputDigest(receipt.message), receipt.payload === null ? null : triggerInputDigest(receipt.payload), receipt.rowid);
    }
  }).immediate();
  initialized.add(db);
}

const receiptColumns = `trigger_name AS triggerName, session_key AS sessionKey,
  event_id AS eventId, channel, message, payload, state, session_id AS sessionId,
  accepted_at AS acceptedAt, completed_at AS completedAt, completion_reason AS completionReason,
  message_hash AS messageHash, payload_hash AS payloadHash, pruned_at AS prunedAt`;

export function triggerInputDigest(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Original CLI payload identity survives prompt changes and raw-content pruning. */
export function triggerReceiptMatchesInput(receipt: TriggerReceipt, payload: string, renderedMessage: string): boolean {
  return receipt.payloadHash !== null
    ? receipt.payloadHash === triggerInputDigest(payload)
    : receipt.messageHash === triggerInputDigest(renderedMessage);
}

export function getTriggerReceipt(
  db: Database, triggerName: string, sessionKey: string, eventId: string,
): TriggerReceipt | null {
  ensureTriggerReceipts(db);
  return db.query(`SELECT ${receiptColumns} FROM trigger_delivery_receipts
    WHERE trigger_name = ? AND session_key = ? AND event_id = ?`)
    .get(triggerName, sessionKey, eventId) as TriggerReceipt | null;
}

/** Returns only work that still needs a successful turn, in acceptance order. */
export function listPendingTriggerReceipts(
  db: Database, triggerName: string, sessionKey: string,
): TriggerReceipt[] {
  ensureTriggerReceipts(db);
  return db.query(`SELECT ${receiptColumns} FROM trigger_delivery_receipts
    WHERE trigger_name = ? AND session_key = ? AND state = 'accepted'
    ORDER BY rowid`)
    .all(triggerName, sessionKey) as TriggerReceipt[];
}

/**
 * Commit the full input before acknowledging delivery. Reusing an ID for
 * different input is an error, including after the first input completed.
 */
export function acceptTriggerReceipt(
  db: Database,
  input: Pick<TriggerReceipt, "triggerName" | "sessionKey" | "eventId" | "channel" | "message"> & { payload?: string },
): TriggerReceipt {
  ensureTriggerReceipts(db);
  for (const value of [input.triggerName, input.sessionKey, input.eventId, input.channel]) {
    if (typeof value !== "string" || !value.trim()) throw new Error("Delivery identifiers must be nonempty strings");
  }
  if (typeof input.message !== "string" || !input.message.trim()) throw new Error("Delivery message must be nonempty");
  if (input.eventId.length > 512) throw new Error("Delivery event ID exceeds 512 characters");

  return db.transaction(() => {
    db.query(`INSERT INTO trigger_delivery_receipts
      (trigger_name, session_key, event_id, channel, message, payload, message_hash, payload_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .run(input.triggerName, input.sessionKey, input.eventId, input.channel, input.message, input.payload ?? null,
        triggerInputDigest(input.message), input.payload === undefined ? null : triggerInputDigest(input.payload));
    const receipt = getTriggerReceipt(db, input.triggerName, input.sessionKey, input.eventId)!;
    if (receipt.channel !== input.channel || receipt.messageHash !== triggerInputDigest(input.message)
      || (input.payload !== undefined && receipt.payloadHash !== triggerInputDigest(input.payload))) {
      throw new Error(`Delivery event ID already belongs to different input: ${input.eventId}`);
    }
    return receipt;
  }).immediate();
}

/** Expire completed Talk content across all origin triggers, preserving input identity. */
export function pruneCompletedTriggerReceipts(
  db: Database, { retentionDays = 30, eventIdPrefix = "talk:", now = Date.now() }: {
    retentionDays?: number; eventIdPrefix?: string; now?: number;
  } = {},
): number {
  ensureTriggerReceipts(db);
  const cutoff = new Date(now - Math.max(1, retentionDays) * 86_400_000).toISOString();
  return db.query(`UPDATE trigger_delivery_receipts SET message='',payload=NULL,pruned_at=?
    WHERE state='completed' AND completed_at<? AND pruned_at IS NULL
    AND substr(event_id,1,?)=?`)
    .run(new Date(now).toISOString(), cutoff, eventIdPrefix.length, eventIdPrefix).changes;
}

/**
 * A successful turn completes only the input assigned to that turn. A guard
 * may also settle obsolete work with a recorded completion reason. A crash
 * between external effects and this commit may replay those effects; callers
 * must use their own idempotency keys for actions such as sending messages.
 */
export function completeTriggerReceipt(
  db: Database, triggerName: string, sessionKey: string, eventId: string, sessionId: string | null,
  completionReason: string | null = null,
): void {
  ensureTriggerReceipts(db);
  db.query(`UPDATE trigger_delivery_receipts SET state = 'completed', session_id = ?,
    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), completion_reason = ?
    WHERE trigger_name = ? AND session_key = ? AND event_id = ? AND state = 'accepted'`)
    .run(sessionId, completionReason, triggerName, sessionKey, eventId);
}

export function getTriggerDeliveryOwner(db: Database, triggerName: string, sessionKey: string): number | null {
  ensureTriggerReceipts(db);
  const owner = db.query("SELECT pid FROM trigger_delivery_owners WHERE trigger_name = ? AND session_key = ?")
    .get(triggerName, sessionKey) as { pid: number } | null;
  return owner?.pid ?? null;
}

/** SQLite serializes ownership acquisition; PID files remain an observation API. */
export function claimTriggerDeliveryOwner(
  db: Database, triggerName: string, sessionKey: string, pid = process.pid,
  alive: (pid: number) => boolean = isPidAlive,
): boolean {
  ensureTriggerReceipts(db);
  return db.transaction(() => {
    const owner = getTriggerDeliveryOwner(db, triggerName, sessionKey);
    if (owner !== null && owner !== pid && alive(owner)) return false;
    db.query(`INSERT INTO trigger_delivery_owners (trigger_name, session_key, pid) VALUES (?, ?, ?)
      ON CONFLICT (trigger_name, session_key) DO UPDATE SET pid = excluded.pid`)
      .run(triggerName, sessionKey, pid);
    return true;
  }).immediate();
}

export function releaseTriggerDeliveryOwner(
  db: Database, triggerName: string, sessionKey: string, pid = process.pid,
): void {
  ensureTriggerReceipts(db);
  db.query("DELETE FROM trigger_delivery_owners WHERE trigger_name = ? AND session_key = ? AND pid = ?")
    .run(triggerName, sessionKey, pid);
}
