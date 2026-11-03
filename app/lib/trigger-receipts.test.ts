import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acceptTriggerReceipt, claimTriggerDeliveryOwner, completeTriggerReceipt,
  getTriggerDeliveryOwner, getTriggerReceipt, listPendingTriggerReceipts,
  pruneCompletedTriggerReceipts, releaseTriggerDeliveryOwner,
} from "./trigger-receipts.ts";

const dbs: Database[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const input = {
  triggerName: "worker", sessionKey: "conversation-1", eventId: "event-1",
  channel: "nextcloud-talk", message: "Please check the build", payload: '{"id":1}',
};
function database(path = ":memory:") {
  const db = new Database(path, { create: true });
  dbs.push(db);
  return db;
}

describe("durable trigger receipts", () => {
  test("acceptance is durable across reopening the database, and duplicate IDs keep one input", () => {
    const dir = mkdtempSync(join(tmpdir(), "atlas-receipts-"));
    directories.push(dir);
    const path = join(dir, "atlas.db");
    const writer = database(path);
    const first = acceptTriggerReceipt(writer, input);
    const reader = database(path);
    expect(getTriggerReceipt(reader, "worker", "conversation-1", "event-1")).toEqual(first);
    expect(acceptTriggerReceipt(reader, input)).toEqual(first);
    expect(listPendingTriggerReceipts(reader, "worker", "conversation-1")).toHaveLength(1);
    expect(first.state).toBe("accepted");
  });

  test("completion is limited to the actual turn's input and conversation", () => {
    const db = database();
    acceptTriggerReceipt(db, input);
    acceptTriggerReceipt(db, { ...input, eventId: "event-2" });
    acceptTriggerReceipt(db, { ...input, sessionKey: "conversation-2" });
    completeTriggerReceipt(db, "worker", "conversation-1", "event-1", "native-session");
    const first = getTriggerReceipt(db, "worker", "conversation-1", "event-1")!;
    expect(first.state).toBe("completed");
    expect(first.sessionId).toBe("native-session");
    expect(first.completedAt).not.toBeNull();
    expect(listPendingTriggerReceipts(db, "worker", "conversation-1").map((r) => r.eventId)).toEqual(["event-2"]);
    expect(getTriggerReceipt(db, "worker", "conversation-2", "event-1")?.state).toBe("accepted");
    expect(acceptTriggerReceipt(db, input)).toEqual(first);
  });

  test("an ID cannot silently change input or channel, including after completion", () => {
    const db = database();
    acceptTriggerReceipt(db, input);
    completeTriggerReceipt(db, "worker", "conversation-1", "event-1", "session");
    expect(() => acceptTriggerReceipt(db, { ...input, message: "different" })).toThrow("different input");
    expect(() => acceptTriggerReceipt(db, { ...input, payload: "different" })).toThrow("different input");
    expect(() => acceptTriggerReceipt(db, { ...input, channel: "email" })).toThrow("different input");
    expect(() => acceptTriggerReceipt(db, { ...input, eventId: " " })).toThrow("nonempty");
    expect(getTriggerReceipt(db, "worker", "conversation-1", "event-1")?.message).toBe(input.message);
  });

  test("session ownership refuses live competitors and recovers dead owners", () => {
    const db = database();
    expect(claimTriggerDeliveryOwner(db, "worker", "conversation-1", 101, () => true)).toBe(true);
    expect(claimTriggerDeliveryOwner(db, "worker", "conversation-1", 202, () => true)).toBe(false);
    expect(claimTriggerDeliveryOwner(db, "worker", "conversation-2", 202, () => true)).toBe(true);
    releaseTriggerDeliveryOwner(db, "worker", "conversation-1", 202);
    expect(getTriggerDeliveryOwner(db, "worker", "conversation-1")).toBe(101);
    expect(claimTriggerDeliveryOwner(db, "worker", "conversation-1", 202, () => false)).toBe(true);
    releaseTriggerDeliveryOwner(db, "worker", "conversation-1", 101);
    expect(getTriggerDeliveryOwner(db, "worker", "conversation-1")).toBe(202);
    releaseTriggerDeliveryOwner(db, "worker", "conversation-1", 202);
    expect(getTriggerDeliveryOwner(db, "worker", "conversation-1")).toBeNull();
  });

  test("30-day Talk pruning removes completed raw copies across channels but preserves deduplication and pending work", () => {
    const db = database();
    const completed = { ...input, triggerName: "github-worker", channel: "github", eventId: "talk:old" };
    const first = acceptTriggerReceipt(db, completed);
    acceptTriggerReceipt(db, { ...completed, eventId: "talk:pending" });
    acceptTriggerReceipt(db, { ...completed, eventId: "github:old" });
    for (const id of ["talk:old", "github:old"]) completeTriggerReceipt(db, "github-worker", "conversation-1", id, "session");
    db.exec("UPDATE trigger_delivery_receipts SET accepted_at='2000-01-01T00:00:00.000Z',completed_at=CASE WHEN state='completed' THEN '2000-01-01T00:00:00.000Z' ELSE NULL END");
    expect(pruneCompletedTriggerReceipts(db)).toBe(1);
    const pruned = getTriggerReceipt(db, "github-worker", "conversation-1", "talk:old")!;
    expect(pruned.message).toBe("");
    expect(pruned.payload).toBeNull();
    expect(pruned.messageHash).toBe(first.messageHash);
    expect(pruned.payloadHash).toBe(first.payloadHash);
    expect(pruned.prunedAt).not.toBeNull();
    expect(acceptTriggerReceipt(db, completed)).toEqual(pruned);
    expect(() => acceptTriggerReceipt(db, { ...completed, message: "changed" })).toThrow("different input");
    expect(getTriggerReceipt(db, "github-worker", "conversation-1", "talk:pending")?.message).toBe(input.message);
    expect(getTriggerReceipt(db, "github-worker", "conversation-1", "github:old")?.message).toBe(input.message);
    expect(pruneCompletedTriggerReceipts(db)).toBe(0);
  });
});
