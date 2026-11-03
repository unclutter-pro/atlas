import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { acceptTriggerReceipt, claimTriggerDeliveryOwner, completeTriggerReceipt } from "../../lib/trigger-receipts.ts";
import { normalizeMessage, normalizeRoom } from "../../integrations/talk/events.ts";
import { eventId, TalkLedger } from "./ledger.ts";
import { TalkDispatcher } from "./runtime.ts";
import type { Conversation, Delivery } from "./types.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function fixture() {
  let now = 10_000, sequence = 0;
  const instance = "current-account";
  const ledger = new TalkLedger(":memory:", () => now);
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE triggers(name TEXT PRIMARY KEY, enabled INTEGER, session_mode TEXT);
    INSERT INTO triggers VALUES ('talk-worker',1,'persistent'),('other-worker',1,'persistent'),('disabled-worker',0,'persistent');
    CREATE TABLE tasks(id INTEGER PRIMARY KEY, trigger_name TEXT, session_key TEXT, status TEXT);`);
  cleanup.push(() => { ledger.close(); db.close(); });
  const owners = new Map<string, Conversation>();
  const alive = new Set<number>();
  function enqueue(key: string, options: { trigger?: string; instance?: string; payload?: string; priority?: number } = {}): Delivery {
    const account = options.instance ?? instance, trigger = options.trigger ?? "talk-worker";
    const address = JSON.stringify([account, trigger, key]);
    let owner = owners.get(address);
    if (!owner) {
      owner = ledger.createConversation({ instance: account, room: "room1", threadId: null, triggerName: trigger, sessionKey: key });
      owners.set(address, owner);
    }
    const message = normalizeMessage({ id: ++sequence, token: "room1", actorType: "users", actorId: "max",
      timestamp: now, message: `message ${sequence}`, messageParameters: {} }, "room1");
    ledger.ingest(account, normalizeRoom({ token: "room1", type: 1 }), [message], message.id);
    const event = ledger.getEvent(eventId(account, message))!;
    return ledger.enqueue(event, owner, options.payload ?? JSON.stringify({ message: message.text }), options.priority ?? 50);
  }
  function accept(d: Delivery, pid?: number) {
    acceptTriggerReceipt(db, { triggerName: d.triggerName, sessionKey: d.sessionKey, eventId: d.eventId,
      channel: "nextcloud-talk", message: d.payload, payload: d.payload });
    if (pid !== undefined) {
      alive.add(pid);
      claimTriggerDeliveryOwner(db, d.triggerName, d.sessionKey, pid, p => alive.has(p));
    }
  }
  const finished = (d: Delivery) => completeTriggerReceipt(db, d.triggerName, d.sessionKey, d.eventId, "native-session");
  return { ledger, db, instance, alive, enqueue, accept, finished,
    now: () => now, advance: (ms: number) => { now += ms; },
    options: { now: () => now, isAlive: (pid: number) => alive.has(pid) } };
}

test("accepted receipts survive dispatcher restart and a dead owner is retried with the same ID", () => {
  const f = fixture(), d = f.enqueue("one"), calls: Delivery[] = [];
  const spawn = (delivery: Delivery) => {
    calls.push(delivery); f.accept(delivery, 101);
    return { exited: new Promise<number>(() => {}) };
  };
  const dispatcher = new TalkDispatcher(f.ledger, f.db, f.instance, { ...f.options, spawn });
  dispatcher.tick();
  expect(f.ledger.getDelivery(d.id)?.status).toBe("leased");
  dispatcher.tick();
  expect(f.ledger.getDelivery(d.id)?.status).toBe("accepted");
  const restarted = new TalkDispatcher(f.ledger, f.db, f.instance, { ...f.options, spawn });
  for (let i = 0; i < 10; i++) restarted.tick();
  expect(calls).toHaveLength(1);
  f.alive.delete(101);
  restarted.tick();
  expect(calls.map(call => call.eventId)).toEqual([d.eventId, d.eventId]);
  f.finished(d); restarted.tick();
  expect(f.ledger.getDelivery(d.id)?.status).toBe("completed");
  expect(calls).toHaveLength(2);
});

test("100 messages for one conversation use one slot and total active deliveries stay at four", () => {
  const f = fixture(), calls: Delivery[] = [];
  for (let i = 0; i < 100; i++) f.enqueue("busy");
  for (let i = 0; i < 10; i++) f.enqueue(`other-${i}`);
  const dispatcher = new TalkDispatcher(f.ledger, f.db, f.instance, { ...f.options, spawn: d => {
    calls.push(d); f.accept(d, 100 + calls.length); return { exited: new Promise<number>(() => {}) };
  } });
  for (let i = 0; i < 10; i++) dispatcher.tick();
  expect(calls).toHaveLength(4);
  expect(calls.filter(d => d.sessionKey === "busy")).toHaveLength(1);
  expect(new Set(calls.map(d => d.sessionKey)).size).toBe(4);
  expect(f.ledger.deliveries("accepted")).toHaveLength(4);
  f.finished(calls[0]); dispatcher.tick(); dispatcher.tick();
  expect(calls).toHaveLength(5);
  expect(f.ledger.deliveries("accepted")).toHaveLength(4);
});

test("disabled and abandoned old-account deliveries do not starve enabled workers", () => {
  const f = fixture(), calls: Delivery[] = [];
  for (let i = 0; i < 4; i++) f.enqueue(`old-${i}`, { instance: "old-account" });
  for (let i = 0; i < 4; i++) {
    const old = f.ledger.claimDelivery({ instance: "old-account" })!;
    f.ledger.acceptDelivery(old.id, old.leaseToken!);
  }
  for (let i = 0; i < 4; i++) f.enqueue(`disabled-${i}`, { trigger: "disabled-worker", priority: 100 });
  // Also recover leases that were acquired just before the trigger was disabled.
  for (let i = 0; i < 4; i++) expect(f.ledger.claimDelivery({ instance: f.instance })).not.toBeNull();
  for (let i = 0; i < 4; i++) f.enqueue(`healthy-${i}`);
  const dispatcher = new TalkDispatcher(f.ledger, f.db, f.instance, { ...f.options, spawn: d => {
    calls.push(d); f.accept(d, 200 + calls.length); return { exited: new Promise<number>(() => {}) };
  } });
  dispatcher.tick(); dispatcher.tick();
  expect(calls.map(d => d.triggerName)).toEqual(Array(4).fill("talk-worker"));
  expect(f.ledger.deliveries("pending").filter(d => d.triggerName === "disabled-worker")).toHaveLength(4);
  expect(f.ledger.deliveries("accepted").filter(d => d.instance === f.instance)).toHaveLength(4);
});

test("a failed startup frees slots, backs off the whole session, and never treats exit zero as acceptance", async () => {
  const f = fixture(), calls: Delivery[] = [];
  for (let i = 0; i < 100; i++) f.enqueue("failing");
  const dispatcher = new TalkDispatcher(f.ledger, f.db, f.instance, { ...f.options, spawn: d => {
    calls.push(d); return { exited: Promise.resolve(0) };
  } });
  dispatcher.tick(); await Promise.resolve(); dispatcher.tick();
  expect(calls).toHaveLength(1);
  expect(f.ledger.deliveries("leased")).toHaveLength(0);
  expect(f.ledger.deliveries("accepted")).toHaveLength(0);
  for (let i = 0; i < 100; i++) dispatcher.tick();
  expect(calls).toHaveLength(1);
  f.enqueue("healthy"); dispatcher.tick();
  expect(calls).toHaveLength(2);
  expect(calls[1].sessionKey).toBe("healthy");
  await Promise.resolve(); dispatcher.tick();
  f.advance(10_001); dispatcher.tick();
  expect(calls.filter(d => d.sessionKey === "failing")).toHaveLength(2);
});

test("an accepted input whose worker exits also backs off instead of respawning every tick", async () => {
  const f = fixture(), calls: Delivery[] = [];
  f.enqueue("one");
  const dispatcher = new TalkDispatcher(f.ledger, f.db, f.instance, { ...f.options, spawn: d => {
    calls.push(d); f.accept(d); return { exited: Promise.resolve(1) };
  } });
  dispatcher.tick(); await Promise.resolve(); dispatcher.tick();
  for (let i = 0; i < 100; i++) dispatcher.tick();
  expect(calls).toHaveLength(1);
  expect(f.ledger.deliveries("pending")).toHaveLength(1);
  f.advance(10_001); dispatcher.tick();
  expect(calls).toHaveLength(2);
  expect(calls[1].eventId).toBe(calls[0].eventId);
});

test("startup timeouts terminate the old attempt before any replacement and retain concurrency slots", async () => {
  const f = fixture(), calls: Delivery[] = [], exits: ((code: number) => void)[] = [], signals: string[] = [];
  for (let i = 0; i < 4; i++) f.enqueue(`slow-${i}`);
  const dispatcher = new TalkDispatcher(f.ledger, f.db, f.instance, { ...f.options, spawn: d => {
    calls.push(d);
    return { exited: new Promise<number>(resolve => exits.push(resolve)), kill: signal => { signals.push(signal!); } };
  } });
  dispatcher.tick();
  for (let i = 0; i < 4; i++) f.enqueue(`new-${i}`, { priority: 100 });
  f.advance(31_000); dispatcher.tick();
  expect(signals).toEqual(Array(4).fill("SIGTERM"));
  f.advance(200_000); dispatcher.tick();
  expect(signals.slice(4)).toEqual(Array(4).fill("SIGKILL"));
  expect(calls).toHaveLength(4);
  for (const exit of exits) exit(1);
  await Promise.resolve(); dispatcher.tick();
  expect(calls).toHaveLength(8);
  expect(calls.slice(4).every(d => d.sessionKey.startsWith("new-"))).toBe(true);
});

test("a task closed after its answer was routed is not launched", () => {
  const f = fixture(), calls: Delivery[] = [];
  f.db.query("INSERT INTO tasks VALUES (42,'talk-worker','task-session','open')").run();
  const d = f.enqueue("task-session", { payload: JSON.stringify({ type: "talk_message", request: {
    taskId: 42, originTrigger: "talk-worker", originSessionKey: "task-session",
  } }) });
  f.db.query("UPDATE tasks SET status='done' WHERE id=42").run();
  const dispatcher = new TalkDispatcher(f.ledger, f.db, f.instance, { ...f.options, spawn: d => {
    calls.push(d); return { exited: Promise.resolve(0) };
  } });
  dispatcher.tick();
  expect(calls).toHaveLength(0);
  expect(f.ledger.getDelivery(d.id)?.status).toBe("completed");
  expect(f.ledger.getDelivery(d.id)?.error).toContain("no longer active");
});
