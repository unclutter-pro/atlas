import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeMessage, normalizeRoom } from "../../integrations/talk/events.ts";
import { parseTalkConfig } from "../../integrations/talk/config.ts";
import { eventId, pendingQuestionTaskIds, TalkLedger } from "./ledger.ts";
import { queueHandoffs } from "./handoff.ts";
import { routeEvent } from "./router.ts";
import { runTalkService } from "./runtime.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const room = normalizeRoom({ token: "group", type: 2 });
const msg = (id: number, extra: Record<string, unknown> = {}) => normalizeMessage({ id, token: room.token, actorType: "users", actorId: "max", message: "@atlas start", timestamp: 1, ...extra }, room.token);
function ledger(now?: () => number) { const l = new TalkLedger(":memory:", now); cleanup.push(() => l.close()); return l; }

test("retrieved quote context leaves unread messages deliverable and does not advance reception", () => {
  const l = ledger();
  l.upsertRooms("account", [room]);
  l.cacheMessages("account", room.token, [msg(10), msg(11)]);
  expect(l.getCursor("account", room.token)).toBeNull();
  expect(l.pendingEvents("account")).toHaveLength(0);
  l.ingest("account", room, [msg(10), msg(11)], 11);
  expect(l.pendingEvents("account")).toHaveLength(2);
});

test("a cold-start send pins unread reception before the server advances its read marker", () => {
  const l = ledger();
  l.registerOutgoingRoom("account", { ...room, lastReadMessage: 10, lastMessageId: 12 });
  // The agent's POST causes a subsequent room refresh to report everything read.
  l.upsertRooms("account", [{ ...room, lastReadMessage: 13, lastMessageId: 13 }]);
  expect(l.getCursor("account", room.token)).toBe(10);
  l.ingest("account", room, [msg(11), msg(12)], 12);
  expect(l.pendingEvents("account").map(event => event.message.id)).toEqual([11, 12]);
  l.registerOutgoingRoom("account", { ...room, lastReadMessage: 13 });
  expect(l.getCursor("account", room.token)).toBe(12);
});

test("real Talk edit/delete system events replace the original and suppress unstarted stale work", () => {
  const l = ledger(), config = { instance: "account", username: "atlas" };
  const first = msg(10);
  l.ingest(config.instance, room, [first], 10);
  const routed = routeEvent(l, config, eventId(config.instance, first));
  const edited = { ...first, text: "@atlas corrected", message: "@atlas corrected", editedAt: 20 };
  l.ingest(config.instance, room, [msg(11, { systemMessage: "message_edited", parent: { ...edited, lastEditTimestamp: 20 }, timestamp: 20 })], 11);
  expect(l.readMessage(config.instance, room.token, 10)?.text).toBe("@atlas corrected");
  expect(l.getDelivery(routed.deliveryId!)?.error).toBe("superseded-revision");
  expect(l.getEvent(eventId(config.instance, edited))?.status).toBe("pending");
  l.ingest(config.instance, room, [msg(12, { systemMessage: "message_deleted", parent: { id: 10, deleted: true }, timestamp: 30 })], 12);
  expect(l.readMessage(config.instance, room.token, 10)).toMatchObject({ deleted: true, text: "" });
  expect(l.getCursor(config.instance, room.token)).toBe(12);
});

test("full room reconciliation revokes persisted rooms but preserves a DM created during the request", () => {
  let now = 100;
  const l = ledger(() => now), config = { instance: "account", username: "atlas" };
  l.ingest(config.instance, room, [msg(1)], 1);
  const result = routeEvent(l, config, eventId(config.instance, msg(1)));
  now = 200;
  const dm = normalizeRoom({ token: "newdm", type: 1 }); l.upsertRooms(config.instance, [dm]);
  now = 300; l.reconcileRooms(config.instance, [], 150);
  expect(l.getRoom(config.instance, room.token)).toBeNull();
  expect(l.getDelivery(result.deliveryId!)?.error).toBe("room-access-revoked");
  expect(l.getRoom(config.instance, dm.token)).not.toBeNull();
  expect(l.getMeta("active-instance")).toBe(config.instance);
});

test("failed old handoffs do not starve a confirmed handoff; revoked rooms cannot start children", () => {
  const l = ledger(); l.upsertRooms("account", [room]);
  for (let i = 0; i < 105; i++) {
    const owner = l.createConversation({ instance: "account", room: room.token, threadId: null, handoff: "x\n".repeat(5000) });
    l.setMeta(`handoff:start:${owner.id}`, "pending");
    if (i < 104) continue;
    const out = l.prepareSend({ instance: "account", room: room.token, threadId: null, conversationId: owner.id, body: "Opening" });
    l.confirmSend(out.id, msg(200, { actorId: "atlas", message: "Opening", referenceId: out.referenceId }));
  }
  expect(queueHandoffs(l, "account")).toBe(1);
  const payload = JSON.parse(l.deliveries()[0]!.payload);
  expect(payload.openingMessage).toBe("Opening");
  expect(Buffer.byteLength(JSON.stringify(payload.handoff))).toBeLessThanOrEqual(6000);
  expect(payload.handoffTruncated).toBe(true);
  expect(queueHandoffs(l, "account")).toBe(0);
  const owner = l.createConversation({ instance: "account", room: room.token, threadId: null, handoff: "Revoked child" });
  l.setMeta(`handoff:start:${owner.id}`, "pending");
  const out = l.prepareSend({ instance: "account", room: room.token, threadId: null, conversationId: owner.id, body: "Opening two" });
  l.confirmSend(out.id, msg(201, { actorId: "atlas", referenceId: out.referenceId }));
  l.revokeRoom("account", room.token);
  expect(queueHandoffs(l, "account")).toBe(0);
});

test("service refuses dispatch before authentication and room discovery succeed", async () => {
  const home = mkdtempSync(join(tmpdir(), "talk-startup-")); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const oldHome = process.env.HOME; process.env.HOME = home; cleanup.push(() => { process.env.HOME = oldHome; });
  const server = Bun.serve({ port: 0, fetch: () => new Response("Unauthorized", { status: 401 }) }); cleanup.push(() => server.stop(true));
  const config = parseTalkConfig({ talk: { url: server.url.origin, username: "atlas", allow_insecure_http: true } }, { home, env: { TALK_APP_PASSWORD: "test-password" } });
  const l = ledger(); l.ingest(config.instance, room, [msg(1)], 1);
  const routed = routeEvent(l, config, eventId(config.instance, msg(1)));
  const db = new Database(":memory:"); cleanup.push(() => db.close());
  await expect(runTalkService(config, l, db)).rejects.toThrow("authentication failed");
  expect(l.getDelivery(routed.deliveryId!)?.attempts).toBe(0);
});

test("questions from a previously configured account cannot excuse pausing the current task", () => {
  const dir = mkdtempSync(join(tmpdir(), "talk-account-switch-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "talk.db"), l = new TalkLedger(path); cleanup.push(() => l.close());
  const owner = l.createConversation({ instance: "old-account", room: room.token, threadId: null });
  const out = l.prepareSend({ instance: "old-account", room: room.token, threadId: null, conversationId: owner.id, body: "Need input", request: {
    originTrigger: "github-worker", originSessionKey: "repo-42", expectedUser: "max", taskId: 42, blocking: true,
  } });
  l.confirmSend(out.id, msg(1, { actorId: "atlas", referenceId: out.referenceId }));
  expect(pendingQuestionTaskIds("github-worker", "repo-42", path)).toEqual([42]);
  l.setMeta("active-instance", "new-account");
  expect(l.hasPendingQuestion("github-worker", "repo-42", 42)).toBe(false);
  expect(pendingQuestionTaskIds("github-worker", "repo-42", path)).toEqual([]);
});
