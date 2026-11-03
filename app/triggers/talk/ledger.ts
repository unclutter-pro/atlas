import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  Conversation, Delivery, IncomingEvent, Outbound, PendingQuestion, PrepareSendInput,
  TalkAddress, TalkMessage, TalkRoom,
} from "./types.ts";

export function defaultLedgerPath(home = process.env.HOME ?? "/home/agent"): string {
  return join(home, ".index", "talk", "talk.db");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS talk_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS talk_rooms (
  instance TEXT NOT NULL, room TEXT NOT NULL, data TEXT NOT NULL,
  cursor INTEGER, enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL,
  PRIMARY KEY(instance,room)
);
CREATE TABLE IF NOT EXISTS talk_messages (
  instance TEXT NOT NULL, room TEXT NOT NULL, message_id INTEGER NOT NULL,
  data TEXT NOT NULL, revision TEXT NOT NULL, observed_at INTEGER NOT NULL,
  PRIMARY KEY(instance,room,message_id)
);
CREATE TABLE IF NOT EXISTS talk_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  instance TEXT NOT NULL, room TEXT NOT NULL, message_id INTEGER NOT NULL,
  data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS talk_event_pending ON talk_events(instance,status,sequence);
CREATE TABLE IF NOT EXISTS talk_conversations (
  id TEXT PRIMARY KEY, instance TEXT NOT NULL, room TEXT NOT NULL, data TEXT NOT NULL,
  trigger_name TEXT NOT NULL, session_key TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active',
  context_cursor INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS talk_conversation_owner ON talk_conversations(trigger_name,session_key);
CREATE TABLE IF NOT EXISTS talk_context_cursors (
  conversation_id TEXT NOT NULL REFERENCES talk_conversations(id), instance TEXT NOT NULL,
  room TEXT NOT NULL, thread_key INTEGER NOT NULL, cursor INTEGER NOT NULL,
  PRIMARY KEY(conversation_id,instance,room,thread_key)
);
CREATE TABLE IF NOT EXISTS talk_bindings (
  instance TEXT NOT NULL, room TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES talk_conversations(id),
  PRIMARY KEY(instance,room,kind,ref)
);
CREATE TABLE IF NOT EXISTS talk_deliveries (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, instance TEXT NOT NULL, room TEXT NOT NULL,
  conversation_id TEXT NOT NULL, trigger_name TEXT NOT NULL, session_key TEXT NOT NULL,
  payload TEXT NOT NULL, priority INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  lease_token TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS talk_delivery_pending ON talk_deliveries(status,priority,created_at);
CREATE TABLE IF NOT EXISTS talk_outbox (
  id TEXT PRIMARY KEY, instance TEXT NOT NULL, room TEXT NOT NULL, reference_id TEXT NOT NULL,
  data TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', message_id INTEGER,
  updated_at INTEGER NOT NULL, error TEXT NOT NULL DEFAULT '',
  UNIQUE(instance,reference_id)
);
CREATE TABLE IF NOT EXISTS talk_questions (
  id TEXT PRIMARY KEY, outbound_id TEXT NOT NULL UNIQUE REFERENCES talk_outbox(id),
  instance TEXT NOT NULL, room TEXT NOT NULL, conversation_id TEXT NOT NULL,
  origin_trigger TEXT NOT NULL, origin_session_key TEXT NOT NULL,
  task_id INTEGER, expected_user TEXT NOT NULL, blocking INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'preparing', message_id INTEGER, answer_message_id INTEGER,
  data TEXT NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER, resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS talk_question_owner ON talk_questions(origin_trigger,origin_session_key,state);
CREATE INDEX IF NOT EXISTS talk_question_answer ON talk_questions(instance,room,message_id);
`;

type Row = Record<string, any>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function messageRevision(message: TalkMessage): string {
  // Reaction/count changes do not turn the same message into a new instruction.
  return hash(JSON.stringify([message.text, message.editedAt, message.deleted,
    message.systemMessage, message.threadId, message.parentId]));
}
export function eventId(instance: string, message: TalkMessage): string {
  return `talk:${hash(JSON.stringify([instance, message.room, message.id, messageRevision(message)]))}`;
}

function conversation(row: Row | null): Conversation | null {
  return row ? { ...JSON.parse(row.data), state: row.state, updatedAt: row.updated_at } : null;
}
function outbound(row: Row | null): Outbound | null {
  return row ? { ...JSON.parse(row.data), state: row.state, messageId: row.message_id,
    updatedAt: row.updated_at, error: row.error } : null;
}
function question(row: Row | null): PendingQuestion | null {
  return row ? { ...JSON.parse(row.data), state: row.state, messageId: row.message_id,
    answerMessageId: row.answer_message_id, sentAt: row.sent_at, resolvedAt: row.resolved_at } : null;
}
function delivery(row: Row | null): Delivery | null {
  return row ? { id: row.id, eventId: row.event_id, instance: row.instance, room: row.room,
    conversationId: row.conversation_id, triggerName: row.trigger_name, sessionKey: row.session_key,
    payload: row.payload, priority: row.priority, status: row.status, leaseToken: row.lease_token,
    leaseUntil: row.lease_until, attempts: row.attempts, createdAt: row.created_at, error: row.error } : null;
}
function incoming(row: Row): IncomingEvent {
  return { id: row.id, instance: row.instance, room: row.room, message: JSON.parse(row.data),
    createdAt: row.created_at, status: row.status, reason: row.reason };
}

/** One SQLite database owns receive cursors, routing decisions and outgoing intents. */
export class TalkLedger {
  readonly db: Database;
  constructor(path = defaultLedgerPath(), readonly now: () => number = Date.now) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.db.exec(SCHEMA);
  }
  close(): void { this.db.close(); }
  transaction<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
  getMeta(key: string): string | null {
    return (this.db.query("SELECT value FROM talk_meta WHERE key=?").get(key) as Row)?.value ?? null;
  }
  setMeta(key: string, value: string): void {
    this.db.query("INSERT INTO talk_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }
  upsertRooms(instance: string, rooms: TalkRoom[]): void {
    this.transaction(() => { for (const room of rooms) this.upsertRoom(instance, room); });
  }
  /** Sending can advance Talk's read marker; pin our unread boundary before POST. */
  registerOutgoingRoom(instance: string, room: TalkRoom): void {
    this.transaction(() => {
      if (this.getCursor(instance, room.token) === null) this.ingest(instance, room, [], room.lastReadMessage, { historyOnly: true });
      else this.upsertRoom(instance, room);
    });
  }
  reconcileRooms(instance: string, rooms: TalkRoom[], snapshotStartedAt: number): void {
    this.transaction(() => {
      const present = new Set(rooms.map(room => room.token));
      const prior = this.db.query("SELECT room FROM talk_rooms WHERE instance=? AND enabled=1 AND updated_at<=?")
        .all(instance, snapshotStartedAt) as { room: string }[];
      for (const { room } of prior) if (!present.has(room)) this.revokeRoom(instance, room);
      for (const room of rooms) this.upsertRoom(instance, room);
      this.setMeta("active-instance", instance);
    });
  }
  private upsertRoom(instance: string, room: TalkRoom): void {
    this.db.query(`INSERT INTO talk_rooms(instance,room,data,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(instance,room) DO UPDATE SET data=excluded.data,enabled=1,updated_at=excluded.updated_at`)
      .run(instance, room.token, JSON.stringify(room), this.now());
  }
  getRooms(instance: string, enabledOnly = true): TalkRoom[] {
    return (this.db.query(`SELECT data FROM talk_rooms WHERE instance=? ${enabledOnly ? "AND enabled=1" : ""} ORDER BY room`).all(instance) as Row[])
      .map((r) => JSON.parse(r.data));
  }
  getRoom(instance: string, room: string): TalkRoom | null {
    const row = this.db.query("SELECT data FROM talk_rooms WHERE instance=? AND room=? AND enabled=1").get(instance, room) as Row;
    return row ? JSON.parse(row.data) : null;
  }
  revokeRoom(instance: string, room: string): void {
    this.transaction(() => {
      this.db.query("UPDATE talk_rooms SET enabled=0 WHERE instance=? AND room=?").run(instance, room);
      this.db.query("UPDATE talk_events SET status='ignored',reason='room-access-revoked' WHERE instance=? AND room=? AND status IN ('pending','waiting')").run(instance, room);
      this.db.query("UPDATE talk_questions SET state='cancelled' WHERE instance=? AND room=? AND state IN ('preparing','pending')").run(instance, room);
      this.db.query("UPDATE talk_deliveries SET status='completed',error='room-access-revoked',lease_token=NULL,lease_until=NULL WHERE instance=? AND room=? AND status='pending'").run(instance, room);
    });
  }
  getCursor(instance: string, room: string): number | null {
    return (this.db.query("SELECT cursor FROM talk_rooms WHERE instance=? AND room=?").get(instance, room) as Row)?.cursor ?? null;
  }
  /** Retrieval is not receipt: caching a quote must not consume unread inbox events. */
  cacheMessages(instance: string, room: string, messages: TalkMessage[]): void {
    this.transaction(() => {
      for (const message of messages) {
        if (message.room !== room) throw new Error("Cached message belongs to another room");
        const old = this.readMessage(instance, room, message.id);
        if (!old || (old.editedAt ?? 0) <= (message.editedAt ?? 0)) this.storeMessage(instance, message);
      }
    });
  }
  /** Atomic page storage; cursor advances only after every message is persisted. */
  ingest(instance: string, room: TalkRoom, messages: TalkMessage[], cursor: number | null,
    { historyOnly = false }: { historyOnly?: boolean } = {}): number {
    return this.transaction(() => {
      this.upsertRoom(instance, room);
      let inserted = 0;
      // Talk represents edits/deletions as a new system event whose parent is
      // the revised original message. Persist that revision under its real ID.
      const expanded = messages.flatMap(message => {
        if (message.parent && ["message_edited", "message_deleted"].includes(message.systemMessage)) {
          const revised = { ...message.parent, editedAt: message.parent.editedAt ?? message.timestamp,
            ...(message.systemMessage === "message_deleted" ? { deleted: true, text: "", message: "", messageParameters: {} } : {}) };
          return [revised, message];
        }
        return [message];
      });
      for (const message of expanded.sort((a, b) => a.id - b.id)) {
        if (message.room !== room.token || !Number.isSafeInteger(message.id) || message.id <= 0)
          throw new Error("Talk message does not belong to this room or has an invalid ID");
        const old = this.readMessage(instance, room.token, message.id);
        if (old && (old.editedAt ?? 0) > (message.editedAt ?? 0)) continue;
        const revisionId = eventId(instance, message);
        if (message.deleted) this.db.query("UPDATE talk_questions SET state='cancelled' WHERE instance=? AND room=? AND message_id=? AND state IN ('preparing','pending')")
          .run(instance, room.token, message.id);
        this.db.query(`UPDATE talk_deliveries SET status='completed',error='superseded-revision'
          WHERE status='pending' AND attempts=0 AND event_id IN
          (SELECT id FROM talk_events WHERE instance=? AND room=? AND message_id=? AND id!=?)`)
          .run(instance, room.token, message.id, revisionId);
        this.db.query(`UPDATE talk_events SET status='ignored',reason='superseded-revision'
          WHERE instance=? AND room=? AND message_id=? AND id!=? AND status IN ('pending','waiting')`)
          .run(instance, room.token, message.id, revisionId);
        this.storeMessage(instance, message);
        const created = this.db.query(`INSERT OR IGNORE INTO talk_events
          (id,instance,room,message_id,data,status,reason,created_at) VALUES (?,?,?,?,?,?,?,?)`)
          .run(eventId(instance, message), instance, room.token, message.id, JSON.stringify(message),
            historyOnly ? "ignored" : "pending", historyOnly ? "bootstrap-history" : "", this.now());
        inserted += Number(created.changes);
      }
      if (cursor !== null) {
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("Invalid Talk cursor");
        this.db.query("UPDATE talk_rooms SET cursor=MAX(COALESCE(cursor,0),?) WHERE instance=? AND room=?").run(cursor, instance, room.token);
      }
      return inserted;
    });
  }
  private storeMessage(instance: string, message: TalkMessage): void {
    this.db.query(`INSERT INTO talk_messages(instance,room,message_id,data,revision,observed_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(instance,room,message_id) DO UPDATE SET data=excluded.data,revision=excluded.revision,observed_at=excluded.observed_at`)
      .run(instance, message.room, message.id, JSON.stringify(message), messageRevision(message), this.now());
  }
  readMessage(instance: string, room: string, id: number): TalkMessage | null {
    const row = this.db.query("SELECT data FROM talk_messages WHERE instance=? AND room=? AND message_id=?").get(instance, room, id) as Row;
    return row ? JSON.parse(row.data) : null;
  }
  history(address: TalkAddress, { limit = 20, beforeId, afterId = 0 }: { limit?: number; beforeId?: number; afterId?: number } = {}): TalkMessage[] {
    return (this.db.query(`SELECT data FROM talk_messages WHERE instance=? AND room=?
      AND (json_extract(data,'$.threadId') IS ? OR message_id=?) AND message_id>? AND message_id<? ORDER BY message_id DESC LIMIT ?`)
      .all(address.instance, address.room, address.threadId, address.threadId, afterId, beforeId ?? Number.MAX_SAFE_INTEGER,
        Math.max(0, Math.min(100, Math.trunc(limit)))) as Row[]).map((r) => JSON.parse(r.data)).reverse();
  }
  pendingEvents(instance: string, limit = 100): IncomingEvent[] {
    return (this.db.query("SELECT * FROM talk_events WHERE instance=? AND status IN ('pending','waiting') ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,sequence LIMIT ?")
      .all(instance, limit) as Row[]).map(incoming);
  }
  getEvent(id: string): IncomingEvent | null {
    const row = this.db.query("SELECT * FROM talk_events WHERE id=?").get(id) as Row;
    return row ? incoming(row) : null;
  }
  finishEvent(id: string, reason: string, status: "ignored" | "waiting" = "ignored"): void {
    this.db.query("UPDATE talk_events SET status=?,reason=? WHERE id=? AND status IN ('pending','waiting')").run(status, reason, id);
  }
  createConversation(input: TalkAddress & { id?: string; title?: string; summary?: string; handoff?: string; triggerName?: string; sessionKey?: string }): Conversation {
    const id = input.id ?? `talk-${randomUUID()}`;
    const data: Conversation = { id, instance: input.instance, room: input.room, threadId: input.threadId,
      title: input.title ?? "", summary: input.summary ?? "", handoff: input.handoff ?? "",
      triggerName: input.triggerName ?? "talk-worker", sessionKey: input.sessionKey ?? id,
      state: "active", createdAt: this.now(), updatedAt: this.now() };
    this.db.query(`INSERT INTO talk_conversations(id,instance,room,data,trigger_name,session_key,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run(id, data.instance, data.room, JSON.stringify(data), data.triggerName, data.sessionKey, this.now());
    return data;
  }
  getConversation(id: string): Conversation | null {
    return conversation(this.db.query("SELECT * FROM talk_conversations WHERE id=?").get(id) as Row);
  }
  listConversations(instance: string, room?: string, limit = 10): Conversation[] {
    return (this.db.query(`SELECT * FROM talk_conversations WHERE instance=? ${room ? "AND room=?" : ""} ORDER BY updated_at DESC LIMIT ?`)
      .all(...(room ? [instance, room, Math.min(100, limit)] : [instance, Math.min(100, limit)])) as Row[]).map((r) => conversation(r)!);
  }
  recentMainlineConversations(instance: string, room: string, actorId: string, withinMs: number): Conversation[] {
    return (this.db.query(`SELECT c.* FROM talk_conversations c WHERE c.instance=? AND c.room=?
      AND c.state='active' AND c.updated_at>=? AND json_extract(c.data,'$.threadId') IS NULL
      AND EXISTS (SELECT 1 FROM talk_deliveries d JOIN talk_events e ON e.id=d.event_id
        WHERE d.conversation_id=c.id AND e.instance=c.instance AND e.room=c.room AND e.created_at>=?
        AND json_extract(e.data,'$.actorId')=? AND json_extract(e.data,'$.threadId') IS NULL)
      ORDER BY c.updated_at DESC LIMIT 11`).all(instance, room, this.now() - withinMs, this.now() - withinMs, actorId) as Row[])
      .map((r) => conversation(r)!);
  }
  updateConversation(id: string, updates: Partial<Pick<Conversation, "summary" | "title" | "handoff" | "state">>): Conversation {
    const current = this.getConversation(id);
    if (!current) throw new Error(`Unknown Talk conversation ${id}`);
    const next = { ...current, ...updates, updatedAt: this.now() };
    this.db.query("UPDATE talk_conversations SET data=?,state=?,updated_at=? WHERE id=?").run(JSON.stringify(next), next.state, this.now(), id);
    return next;
  }
  lookup(instance: string, room: string, kind: "thread" | "message" | "direct", ref: string | number): Conversation | null {
    const row = this.db.query("SELECT conversation_id FROM talk_bindings WHERE instance=? AND room=? AND kind=? AND ref=?")
      .get(instance, room, kind, String(ref)) as Row;
    return row ? this.getConversation(row.conversation_id) : null;
  }
  bind(instance: string, room: string, kind: "thread" | "message" | "direct", ref: string | number, conversationId: string): Conversation {
    const owner = this.getConversation(conversationId);
    if (!owner || owner.instance !== instance) throw new Error("Cannot bind an unknown or different-account conversation");
    this.db.query("INSERT INTO talk_bindings(instance,room,kind,ref,conversation_id) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING")
      .run(instance, room, kind, String(ref), conversationId);
    return this.lookup(instance, room, kind, ref)!;
  }
  bindThread(instance: string, room: string, threadId: number, conversationId: string): Conversation {
    return this.bind(instance, room, "thread", threadId, conversationId);
  }
  resolveAddress(triggerName: string, sessionKey: string): Conversation | null {
    return conversation(this.db.query("SELECT * FROM talk_conversations WHERE trigger_name=? AND session_key=? ORDER BY updated_at DESC LIMIT 1")
      .get(triggerName, sessionKey) as Row);
  }
  contextCursor(conversationId: string, address?: TalkAddress): number {
    if (address) return (this.db.query("SELECT cursor FROM talk_context_cursors WHERE conversation_id=? AND instance=? AND room=? AND thread_key=?")
      .get(conversationId, address.instance, address.room, address.threadId ?? 0) as Row)?.cursor ?? 0;
    return (this.db.query("SELECT context_cursor FROM talk_conversations WHERE id=?").get(conversationId) as Row)?.context_cursor ?? 0;
  }
  /** Must run in the same transaction as resolving a question and selecting its owner. */
  enqueue(event: IncomingEvent, owner: Conversation, payload: string, priority: number,
    { triggerName = owner.triggerName, sessionKey = owner.sessionKey, reason = "message" } = {}): Delivery {
    const id = `delivery:${event.id}`;
    this.db.query(`INSERT OR IGNORE INTO talk_deliveries
      (id,event_id,instance,room,conversation_id,trigger_name,session_key,payload,priority,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, event.id, event.instance, event.room, owner.id, triggerName, sessionKey, payload, priority, this.now());
    this.db.query("UPDATE talk_events SET status='routed',reason=? WHERE id=?").run(reason, event.id);
    this.db.query("UPDATE talk_conversations SET state='active',updated_at=?,context_cursor=MAX(context_cursor,?) WHERE id=?")
      .run(this.now(), event.message.id, owner.id);
    if (triggerName === owner.triggerName && sessionKey === owner.sessionKey) {
      this.db.query(`INSERT INTO talk_context_cursors(conversation_id,instance,room,thread_key,cursor) VALUES (?,?,?,?,?)
        ON CONFLICT(conversation_id,instance,room,thread_key) DO UPDATE SET cursor=MAX(cursor,excluded.cursor)`)
        .run(owner.id, event.instance, event.room, event.message.threadId ?? 0, event.message.id);
    }
    return this.getDelivery(id)!;
  }
  getDelivery(id: string): Delivery | null {
    return delivery(this.db.query("SELECT * FROM talk_deliveries WHERE id=?").get(id) as Row);
  }
  deliveries(status?: Delivery["status"]): Delivery[] {
    return (this.db.query(`SELECT * FROM talk_deliveries ${status ? "WHERE status=?" : ""} ORDER BY created_at,id`)
      .all(...(status ? [status] : [])) as Row[]).map((r) => delivery(r)!);
  }
  claimDelivery({ maxConcurrent = 4, leaseMs = 120_000, instance, eligibleTriggers, excludeSessions = [] }: {
    maxConcurrent?: number; leaseMs?: number; instance?: string; eligibleTriggers?: string[];
    excludeSessions?: Pick<Delivery, "triggerName" | "sessionKey">[];
  } = {}): Delivery | null {
    return this.transaction(() => {
      this.db.query("UPDATE talk_deliveries SET status='pending',lease_token=NULL,lease_until=NULL WHERE status='leased' AND lease_until<=?").run(this.now());
      if (eligibleTriggers?.length === 0) return null;
      const running = (this.db.query(`SELECT COUNT(*) AS n FROM talk_deliveries WHERE status IN ('leased','accepted')
        ${instance ? "AND instance=?" : ""}`).get(...(instance ? [instance] : [])) as Row).n;
      if (running >= Math.max(1, maxConcurrent)) return null;
      const filters: string[] = [], params: string[] = [];
      if (instance) { filters.push("d.instance=?"); params.push(instance); }
      if (eligibleTriggers) {
        filters.push(`d.trigger_name IN (${eligibleTriggers.map(() => "?").join(",")})`);
        params.push(...eligibleTriggers);
      }
      if (excludeSessions.length) {
        filters.push(`(d.trigger_name,d.session_key) NOT IN (VALUES ${excludeSessions.map(() => "(?,?)").join(",")})`);
        params.push(...excludeSessions.flatMap((session) => [session.triggerName, session.sessionKey]));
      }
      const row = this.db.query(`SELECT d.* FROM talk_deliveries d WHERE d.status='pending'
        ${filters.length ? `AND ${filters.join(" AND ")}` : ""}
        AND NOT EXISTS (SELECT 1 FROM talk_deliveries busy WHERE busy.instance=d.instance AND busy.trigger_name=d.trigger_name AND busy.session_key=d.session_key AND busy.status IN ('leased','accepted'))
        ORDER BY d.priority DESC,d.created_at,d.rowid LIMIT 1`).get(...params) as Row;
      if (!row) return null;
      const token = randomUUID();
      this.db.query("UPDATE talk_deliveries SET status='leased',lease_token=?,lease_until=?,attempts=attempts+1 WHERE id=?")
        .run(token, this.now() + Math.max(1000, leaseMs), row.id);
      return this.getDelivery(row.id);
    });
  }
  acceptDelivery(id: string, leaseToken: string): boolean {
    return this.db.query("UPDATE talk_deliveries SET status='accepted',lease_until=NULL,error='' WHERE id=? AND status='leased' AND lease_token=?")
      .run(id, leaseToken).changes > 0;
  }
  renewDeliveryLease(id: string, leaseToken: string, leaseMs = 120_000): void {
    this.db.query("UPDATE talk_deliveries SET lease_until=? WHERE id=? AND status='leased' AND lease_token=?")
      .run(this.now() + leaseMs, id, leaseToken);
  }
  completeDelivery(id: string, reason = ""): void {
    this.db.query("UPDATE talk_deliveries SET status='completed',lease_token=NULL,lease_until=NULL,error=? WHERE id=? AND status IN ('leased','accepted')").run(reason.slice(0, 500), id);
  }
  releaseDelivery(id: string, error: string, leaseToken?: string): void {
    this.db.query(`UPDATE talk_deliveries SET status='pending',lease_token=NULL,lease_until=NULL,error=? WHERE id=?
      AND status IN ('leased','accepted') ${leaseToken ? "AND lease_token=?" : ""}`)
      .run(...(leaseToken ? [error.slice(0, 500), id, leaseToken] : [error.slice(0, 500), id]));
  }
  prepareSend(input: PrepareSendInput): Outbound {
    return this.transaction(() => {
      const owner = this.getConversation(input.conversationId);
      if (!owner || owner.instance !== input.instance) throw new Error("Outgoing Talk message needs a conversation in the same account");
      if (!input.body.trim()) throw new Error("Outgoing Talk message must not be empty");
      if (input.title && (input.replyTo || input.threadId)) throw new Error("A new thread cannot also target an existing thread or quoted message");
      const threadOwner = input.threadId ? this.lookup(input.instance, input.room, "thread", input.threadId) : null;
      if (threadOwner && threadOwner.id !== owner.id && !input.replyTo)
        throw new Error("Target thread belongs to another conversation; use an explicit reply anchor");
      if (input.request && (!input.request.expectedUser || !input.request.originTrigger || !input.request.originSessionKey))
        throw new Error("A question needs its expected user and owning session");
      if (input.request?.blocking && (!input.request.taskId || !Number.isSafeInteger(input.request.taskId)))
        throw new Error("A blocking question must name an open task");
      const id = input.id ?? randomUUID();
      const old = this.getOutbound(id);
      if (old) {
        if (old.instance !== input.instance || old.room !== input.room || old.body !== input.body || old.conversationId !== input.conversationId)
          throw new Error("Outgoing intent ID already used for a different message");
        return old;
      }
      const requestId = input.request ? randomUUID() : null;
      const out: Outbound = { id, referenceId: hash(`${input.instance}:${id}`), instance: input.instance, room: input.room,
        threadId: input.threadId, conversationId: input.conversationId, body: input.body,
        title: input.title ?? null, replyTo: input.replyTo ?? null, silent: input.silent ?? false,
        state: "pending", messageId: null, requestId, createdAt: this.now(), updatedAt: this.now(), error: "" };
      this.db.query("INSERT INTO talk_outbox(id,instance,room,reference_id,data,updated_at) VALUES (?,?,?,?,?,?)")
        .run(id, out.instance, out.room, out.referenceId, JSON.stringify(out), this.now());
      if (input.request) {
        const r = input.request;
        const q: PendingQuestion = { id: requestId!, outboundId: id, conversationId: owner.id,
          instance: out.instance, room: out.room, threadId: out.threadId, originTrigger: r.originTrigger,
          originSessionKey: r.originSessionKey, taskId: r.taskId ?? null, expectedUser: r.expectedUser,
          blocking: r.blocking ?? false, state: "preparing", messageId: null, answerMessageId: null,
          createdAt: this.now(), sentAt: null, resolvedAt: null, prompt: out.body };
        this.db.query(`INSERT INTO talk_questions(id,outbound_id,instance,room,conversation_id,origin_trigger,origin_session_key,
          task_id,expected_user,blocking,data,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(q.id, id, q.instance, q.room, q.conversationId, q.originTrigger, q.originSessionKey,
            q.taskId, q.expectedUser, q.blocking ? 1 : 0, JSON.stringify(q), this.now());
      }
      return out;
    });
  }
  getOutbound(id: string): Outbound | null {
    return outbound(this.db.query("SELECT * FROM talk_outbox WHERE id=?").get(id) as Row);
  }
  pendingOutbox(instance?: string): Outbound[] {
    return (this.db.query(`SELECT * FROM talk_outbox WHERE state IN ('pending','sending','uncertain') ${instance ? "AND instance=?" : ""} ORDER BY rowid`)
      .all(...(instance ? [instance] : [])) as Row[]).map((r) => outbound(r)!);
  }
  findOutboundByReference(instance: string, referenceId: string): Outbound | null {
    return outbound(this.db.query("SELECT * FROM talk_outbox WHERE instance=? AND reference_id=?").get(instance, referenceId) as Row);
  }
  markSending(id: string): boolean {
    return this.db.query("UPDATE talk_outbox SET state='sending',updated_at=? WHERE id=? AND state='pending'").run(this.now(), id).changes > 0;
  }
  markSendUncertain(id: string, error: string): void {
    this.db.query("UPDATE talk_outbox SET state='uncertain',error=?,updated_at=? WHERE id=? AND state IN ('sending','uncertain')")
      .run(error.slice(0, 500), this.now(), id);
  }
  markSendFailed(id: string, error: string): void {
    this.transaction(() => {
      this.db.query("UPDATE talk_outbox SET state='failed',error=?,updated_at=? WHERE id=? AND state!='sent'").run(error.slice(0, 500), this.now(), id);
      this.db.query("UPDATE talk_questions SET state='cancelled' WHERE outbound_id=? AND state='preparing'").run(id);
    });
  }
  confirmSend(id: string, message: TalkMessage): Outbound {
    return this.transaction(() => {
      const out = this.getOutbound(id);
      if (!out) throw new Error(`Unknown outgoing Talk message ${id}`);
      if (!Number.isSafeInteger(message.id) || message.id <= 0 || message.actorType !== "users")
        throw new Error("Outgoing Talk confirmation must be an authenticated user message");
      if (out.room !== message.room || (message.referenceId && message.referenceId !== out.referenceId))
        throw new Error("Outgoing Talk message response does not match its intent");
      if (out.state === "sent" && out.messageId !== message.id) throw new Error("Outgoing intent already bound to another message");
      if ((out.title && message.threadId !== message.id) || (out.threadId !== null && message.threadId !== out.threadId))
        throw new Error("Outgoing Talk message did not confirm the requested native thread");
      const next = { ...out, threadId: message.threadId };
      this.db.query("UPDATE talk_outbox SET state='sent',message_id=?,data=?,error='',updated_at=? WHERE id=?")
        .run(message.id, JSON.stringify(next), this.now(), id);
      this.storeMessage(out.instance, { ...message, threadId: next.threadId });
      this.bind(out.instance, out.room, "message", message.id, out.conversationId);
      // Cross-thread quotes keep their own message anchor without taking over the other thread.
      if (next.threadId) this.bindThread(out.instance, out.room, next.threadId, out.conversationId);
      this.db.query("UPDATE talk_questions SET state='pending',message_id=?,sent_at=? WHERE outbound_id=? AND state='preparing'")
        .run(message.id, this.now(), id);
      if (out.requestId) {
        const q = this.getQuestion(out.requestId)!;
        this.db.query("UPDATE talk_questions SET data=? WHERE id=?").run(JSON.stringify({ ...q, threadId: next.threadId }), q.id);
      }
      return this.getOutbound(id)!;
    });
  }
  getQuestion(id: string): PendingQuestion | null {
    return question(this.db.query("SELECT * FROM talk_questions WHERE id=?").get(id) as Row);
  }
  questions(instance: string, room?: string): PendingQuestion[] {
    return (this.db.query(`SELECT * FROM talk_questions WHERE instance=? ${room ? "AND room=?" : ""} ORDER BY created_at,id`)
      .all(...(room ? [instance, room] : [instance])) as Row[]).map((r) => question(r)!);
  }
  questionByMessage(instance: string, room: string, messageId: number): PendingQuestion | null {
    return question(this.db.query("SELECT * FROM talk_questions WHERE instance=? AND room=? AND message_id=?").get(instance, room, messageId) as Row);
  }
  resolveQuestion(id: string, answerMessageId: number): boolean {
    return this.db.query("UPDATE talk_questions SET state='resolved',answer_message_id=?,resolved_at=? WHERE id=? AND state='pending'")
      .run(answerMessageId, this.now(), id).changes > 0;
  }
  cancelQuestion(id: string): void {
    this.db.query("UPDATE talk_questions SET state='cancelled' WHERE id=? AND state IN ('pending','preparing')").run(id);
  }
  pendingQuestionsForOwner(triggerName: string, sessionKey: string): PendingQuestion[] {
    return (this.db.query(`SELECT q.* FROM talk_questions q JOIN talk_outbox o ON o.id=q.outbound_id
      WHERE q.origin_trigger=? AND q.origin_session_key=? AND q.state='pending' AND q.blocking=1 AND q.task_id IS NOT NULL AND o.state='sent'
      AND NOT EXISTS (SELECT 1 FROM talk_meta WHERE key='active-instance' AND value!=q.instance)`)
      .all(triggerName, sessionKey) as Row[]).map((r) => question(r)!);
  }
  hasPendingQuestion(triggerName: string, sessionKey: string, taskId: number): boolean {
    return this.pendingQuestionsForOwner(triggerName, sessionKey).some((q) => q.taskId === taskId);
  }
  /** Keep routing identities, but expire cached chat text after terminal delivery. */
  prune(retentionDays = 30): number {
    const cutoff = this.now() - Math.max(1, retentionDays) * 86_400_000;
    return this.transaction(() => {
      const removed = this.db.query(`DELETE FROM talk_messages AS m WHERE observed_at<?
        AND NOT EXISTS (SELECT 1 FROM talk_questions q WHERE q.instance=m.instance AND q.room=m.room
          AND q.message_id=m.message_id AND q.state IN ('pending','preparing'))
        AND NOT EXISTS (SELECT 1 FROM talk_events e WHERE e.instance=m.instance AND e.room=m.room AND e.message_id=m.message_id
          AND (e.status IN ('pending','waiting') OR EXISTS (SELECT 1 FROM talk_deliveries d
            LEFT JOIN talk_deliveries batch ON batch.id=substr(d.error,9) AND d.error LIKE 'batched:%'
            WHERE d.event_id=e.id AND (d.status!='completed' OR batch.status!='completed'))))`)
        .run(cutoff);
      this.db.query(`UPDATE talk_events AS e SET data=json_set(data,'$.text','','$.message','',
        '$.messageParameters',json('{}'),'$.parent',NULL) WHERE created_at<? AND status IN ('routed','ignored')
        AND NOT EXISTS (SELECT 1 FROM talk_deliveries d LEFT JOIN talk_deliveries batch ON batch.id=substr(d.error,9) AND d.error LIKE 'batched:%'
          WHERE d.event_id=e.id AND (d.status!='completed' OR batch.status!='completed'))
        AND NOT EXISTS (SELECT 1 FROM talk_questions q WHERE q.instance=e.instance AND q.room=e.room
          AND q.message_id=e.message_id AND q.state IN ('pending','preparing'))`).run(cutoff);
      this.db.query("UPDATE talk_deliveries SET payload='{}' WHERE status='completed' AND created_at<?").run(cutoff);
      this.db.query(`UPDATE talk_outbox AS o SET data=json_set(data,'$.body','','$.title',NULL)
        WHERE state IN ('sent','failed') AND updated_at<? AND NOT EXISTS
        (SELECT 1 FROM talk_questions q WHERE q.outbound_id=o.id AND q.state IN ('pending','preparing'))`).run(cutoff);
      this.db.query("UPDATE talk_questions SET data=json_set(data,'$.prompt','') WHERE state IN ('resolved','cancelled') AND COALESCE(resolved_at,created_at)<?").run(cutoff);
      return Number(removed.changes);
    });
  }
}

/** Read-only lifecycle lookup; callers must verify returned task IDs are still open and owned. */
export function pendingQuestionTaskIds(triggerName: string, sessionKey: string, path = defaultLedgerPath()): number[] {
  if (!existsSync(path)) return [];
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    return (db.query(`SELECT DISTINCT q.task_id FROM talk_questions q JOIN talk_outbox o ON o.id=q.outbound_id
      WHERE q.origin_trigger=? AND q.origin_session_key=? AND q.state='pending' AND q.blocking=1 AND q.task_id IS NOT NULL AND o.state='sent'
      AND NOT EXISTS (SELECT 1 FROM talk_meta WHERE key='active-instance' AND value!=q.instance)`)
      .all(triggerName, sessionKey) as { task_id: number }[]).map((r) => r.task_id);
  } catch { return []; } finally { db?.close(); }
}

export function hasPendingQuestion(triggerName: string, sessionKey: string, taskId: number, path = defaultLedgerPath()): boolean {
  return pendingQuestionTaskIds(triggerName, sessionKey, path).includes(taskId);
}
