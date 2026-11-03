import { afterEach, expect, test } from "bun:test";
import { TalkLedger } from "./ledger.ts";
import { routePending } from "./router.ts";
import { coalesceGroupDeliveries } from "./batch.ts";
import type { TalkMessage, TalkRoom } from "./types.ts";

let ledger: TalkLedger;
afterEach(() => ledger?.close());
const config = { instance: "cloud", username: "atlas" };
const room = (token = "group", type = 2): TalkRoom => ({ token, type, name: token, displayName: token,
  readOnly: false, lastMessageId: 0, lastReadMessage: 0, isFederated: false });
function msg(id: number, extra: Partial<TalkMessage> = {}): TalkMessage {
  return { id, room: "group", actorType: "users", actorId: "max", actorDisplayName: "Max",
    message: "followup", text: `message ${id}`, messageParameters: {}, timestamp: 100,
    threadId: 1, parentId: null, parent: null, referenceId: "", systemMessage: "", deleted: false, editedAt: null, ...extra };
}
async function add(messages: TalkMessage[], target = room()) {
  ledger.ingest(config.instance, target, messages, messages.at(-1)!.id);
  await routePending(ledger, config);
}
function setup(now?: () => number) {
  ledger = new TalkLedger(":memory:", now);
  const owner = ledger.createConversation({ instance: config.instance, room: "group", threadId: 1 });
  ledger.bindThread(config.instance, "group", 1, owner.id);
  return owner;
}

test("passive group burst becomes one bounded delivery preserving every source reference", async () => {
  setup(); await add([msg(2), msg(3), msg(4)]);
  expect(coalesceGroupDeliveries(ledger, config.instance)).toBe(2);
  const pending = ledger.deliveries("pending"); expect(pending).toHaveLength(1);
  const payload = JSON.parse(pending[0].payload);
  expect(payload.message.id).toBe(4); expect(payload.earlierMessages.map((m: any) => m.id)).toEqual([2, 3]);
  expect(payload.batchMessages.map((m: any) => m.id)).toEqual([2, 3, 4]);
  expect(ledger.deliveries("completed").every(d => d.error === `batched:${pending[0].id}`)).toBe(true);
  expect(ledger.claimDelivery()?.id).toBe(pending[0].id);
});

test("batching excludes DMs, mentions, requests and different thread addresses", async () => {
  const owner = setup(); ledger.bindThread(config.instance, "group", 10, owner.id);
  await add([msg(2), msg(3, { threadId: 10 }), msg(4, { message: "@atlas please act" })]);
  await add([msg(5, { room: "direct", threadId: null }), msg(6, { room: "direct", threadId: null })], room("direct", 1));
  expect(coalesceGroupDeliveries(ledger, config.instance)).toBe(0);
  expect(ledger.deliveries("pending")).toHaveLength(5);
});

test("leased, accepted and retried payloads never change", async () => {
  setup(); await add([msg(2)]);
  const first = ledger.claimDelivery()!, payload = first.payload;
  ledger.acceptDelivery(first.id, first.leaseToken!);
  await add([msg(3), msg(4)]);
  expect(coalesceGroupDeliveries(ledger, config.instance)).toBe(1);
  expect(ledger.getDelivery(first.id)?.payload).toBe(payload);
  ledger.releaseDelivery(first.id, "retry safely");
  expect(coalesceGroupDeliveries(ledger, config.instance)).toBe(0);
  expect(ledger.getDelivery(first.id)?.payload).toBe(payload);
});

test("at most eight source messages join a batch even across repeated pump ticks", async () => {
  setup(); await add([msg(2), msg(3), msg(4)]);
  coalesceGroupDeliveries(ledger, config.instance);
  await add([msg(5), msg(6), msg(7), msg(8), msg(9), msg(10), msg(11)]);
  coalesceGroupDeliveries(ledger, config.instance);
  const batches = ledger.deliveries("pending").map(d => JSON.parse(d.payload));
  expect(batches).toHaveLength(2);
  expect(batches.map(p => p.batchMessages.length).sort()).toEqual([2, 8]);
  expect(new Set(batches.flatMap(p => p.batchMessages.map((m: any) => m.id))).size).toBe(10);
});

test("aggregate current and earlier messages obey encoded budget for Unicode and escaping", async () => {
  setup(); await add(Array.from({ length: 8 }, (_, i) => msg(i + 2, { text: "😀\"\n".repeat(5_000) })));
  coalesceGroupDeliveries(ledger, config.instance);
  const payload = JSON.parse(ledger.deliveries("pending")[0].payload);
  expect(Buffer.byteLength(JSON.stringify({ message: payload.message, earlierMessages: payload.earlierMessages }), "utf8")).toBeLessThanOrEqual(8_000);
  expect(payload.earlierMessages.every((m: any) => m.truncated)).toBe(true);
  expect(payload.batchMessages).toHaveLength(8);
  expect(ledger.readMessage(config.instance, "group", 2)?.text.length).toBe(20_000);
});

test("the two-second source window does not combine old backlog with new traffic", async () => {
  let now = 100; setup(() => now); await add([msg(2)]);
  now += 2_001; await add([msg(3)]);
  expect(coalesceGroupDeliveries(ledger, config.instance)).toBe(0);
  expect(ledger.deliveries("pending")).toHaveLength(2);
});

test("retention preserves merged source messages until their survivor delivery completes", async () => {
  let now = 100; setup(() => now); await add([msg(2), msg(3)]);
  coalesceGroupDeliveries(ledger, config.instance); now += 31 * 86_400_000;
  ledger.prune();
  expect(ledger.readMessage(config.instance, "group", 3)?.text).toBe("message 3");
  const survivor = ledger.claimDelivery()!; ledger.acceptDelivery(survivor.id, survivor.leaseToken!); ledger.completeDelivery(survivor.id);
  ledger.prune();
  expect(ledger.readMessage(config.instance, "group", 2)).toBeNull();
  expect(ledger.readMessage(config.instance, "group", 3)).toBeNull();
});
