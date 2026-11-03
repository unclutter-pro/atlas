import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canPauseForTalk, isTaskActive } from "./lifecycle.ts";
import { TalkLedger } from "./ledger.ts";
import { routePending } from "./router.ts";
import type { TalkMessage } from "./types.ts";

let db: Database, ledger: TalkLedger, path: string, dir: string;
const config = { instance: "cloud", username: "atlas" };
const room = { token: "direct", type: 1, name: "Max", displayName: "Max", readOnly: false, lastMessageId: 0, lastReadMessage: 0, isFederated: false };
const message = (id: number, extra: Partial<TalkMessage> = {}): TalkMessage => ({ id, room: "direct", actorType: "users", actorId: "atlas", actorDisplayName: "Atlas",
  message: "Which environment?", text: "Which environment?", messageParameters: {}, timestamp: 100,
  threadId: null, parentId: null, parent: null, referenceId: "", systemMessage: "", deleted: false, editedAt: null, ...extra });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "talk-lifecycle-")); path = join(dir, "talk.db"); ledger = new TalkLedger(path);
  db = new Database(":memory:");
  db.exec(`CREATE TABLE triggers(name TEXT PRIMARY KEY, enabled INTEGER);
    CREATE TABLE goals(id INTEGER PRIMARY KEY,trigger_name TEXT,session_key TEXT,status TEXT);
    CREATE TABLE tasks(id INTEGER PRIMARY KEY,trigger_name TEXT,session_key TEXT,status TEXT,goal_id INTEGER);
    CREATE TABLE task_deps(task_id INTEGER,depends_on INTEGER);
    INSERT INTO triggers VALUES ('worker',1);
    INSERT INTO tasks VALUES (1,'worker','session','in_progress',NULL);`);
});
afterEach(() => { db.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); });
function question(taskId = 1, state: "pending" | "sent" | "failed" | "uncertain" = "sent", key = "session") {
  const owner = ledger.createConversation({ instance: "cloud", room: "direct", threadId: null });
  const out = ledger.prepareSend({ instance: "cloud", room: "direct", threadId: null, conversationId: owner.id, body: "Which environment?",
    request: { originTrigger: "worker", originSessionKey: key, taskId, blocking: true, expectedUser: "max" } });
  if (state !== "pending") ledger.markSending(out.id);
  if (state === "sent") ledger.confirmSend(out.id, message(100 + taskId, { referenceId: out.referenceId }));
  if (state === "failed") ledger.markSendFailed(out.id, "denied");
  if (state === "uncertain") ledger.markSendUncertain(out.id, "POST timed out");
  return out;
}
const pause = () => canPauseForTalk(db, "worker", "session", path);

describe("Talk question lifecycle gate", () => {
  test("ordinary conversation, prepared question and empty scope cannot excuse unfinished work", () => {
    expect(pause()).toBe(false); question(1, "pending"); expect(pause()).toBe(false);
    expect(canPauseForTalk(db, "", "", path)).toBe(false);
  });
  test.each(["failed", "uncertain"] as const)("%s delivery is not waiting for a user", state => {
    question(1, state); expect(pause()).toBe(false);
  });
  test("confirmed unresolved question permits its owning task to pause", () => {
    question(); expect(pause()).toBe(true);
  });
  test("a question for another owner or nonexistent task does not permit pausing", () => {
    question(1, "sent", "other-session"); expect(pause()).toBe(false);
    question(99); expect(pause()).toBe(false);
  });
  test("unrelated ready work must continue even while one task awaits an answer", () => {
    question(); db.exec("INSERT INTO tasks VALUES (2,'worker','session','open',NULL)");
    expect(pause()).toBe(false);
  });
  test("work transitively blocked on the waiting task may pause", () => {
    question(); db.exec(`INSERT INTO tasks VALUES (2,'worker','session','open',NULL),(3,'worker','session','open',NULL);
      INSERT INTO task_deps VALUES (2,1),(3,2);`);
    expect(pause()).toBe(true);
  });
  test("unrelated dependency cycle is not made resumable by an arbitrary question", () => {
    question(); db.exec(`INSERT INTO tasks VALUES (2,'worker','session','open',NULL),(3,'worker','session','open',NULL);
      INSERT INTO task_deps VALUES (2,3),(3,2);`);
    expect(pause()).toBe(false);
  });
  test("active goal without waiting task coverage keeps the session active", () => {
    question(); db.exec("INSERT INTO goals VALUES (1,'worker','session','active')"); expect(pause()).toBe(false);
    db.exec("UPDATE tasks SET goal_id=1 WHERE id=1"); expect(pause()).toBe(true);
  });
  test.each(["done", "cancelled"])("%s tasks cannot be revived by late answers", async status => {
    const out = question(); db.query("UPDATE tasks SET status=? WHERE id=1").run(status);
    expect(pause()).toBe(false); expect(isTaskActive(db, "worker", "session", 1)).toBe(false);
    ledger.ingest("cloud", room, [message(110, { actorId: "max", parentId: 101, text: "production" })], 110);
    await routePending(ledger, config, { isTaskActive: (trigger, key, task) => isTaskActive(db, trigger, key, task) });
    expect(ledger.getQuestion(out.requestId!)?.state).toBe("cancelled");
    expect(ledger.deliveries()[0].triggerName).not.toBe("worker");
  });
  test("disabled owner fails active-task validation", () => {
    expect(isTaskActive(db, "worker", "session", 1)).toBe(true);
    db.exec("UPDATE triggers SET enabled=0");
    expect(isTaskActive(db, "worker", "session", 1)).toBe(false);
  });
  test("answer/cancel makes conditional followups no-ops and removes the Stop exemption", async () => {
    const out = question(); expect(pause()).toBe(true);
    ledger.ingest("cloud", room, [message(110, { actorId: "max", parentId: 101, text: "staging" })], 110);
    await routePending(ledger, config, { isTaskActive: (trigger, key, task) => isTaskActive(db, trigger, key, task) });
    expect(ledger.getQuestion(out.requestId!)?.state).toBe("resolved"); expect(pause()).toBe(false);
    const next = question(1, "pending"); ledger.cancelQuestion(next.requestId!);
    expect(ledger.getQuestion(next.requestId!)?.state).toBe("cancelled"); expect(pause()).toBe(false);
  });
});
