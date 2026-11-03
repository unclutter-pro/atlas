import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventId, pendingQuestionTaskIds, TalkLedger } from "./ledger.ts";
import { buildDeliveryPayload, classifierCandidates, clipToTokenBudget, routeDeterministicPending, routeEvent, routePending } from "./router.ts";
import type { Conversation, RouterConfig, TalkMessage, TalkRoom } from "./types.ts";

const config: RouterConfig = { instance: "cloud:atlas", username: "atlas" };
const room = (token = "room1", type = 1): TalkRoom => ({ token, type, name: token, displayName: token,
  readOnly: false, lastMessageId: 0, lastReadMessage: 0, isFederated: false });
function msg(id: number, extra: Partial<TalkMessage> = {}): TalkMessage {
  return { id, room: "room1", actorType: "users", actorId: "max", actorDisplayName: "Max",
    message: "hello", text: "hello", timestamp: 100, messageParameters: {}, threadId: null,
    parentId: null, parent: null, referenceId: "", systemMessage: "", deleted: false, editedAt: null, ...extra };
}
const ledgers: TalkLedger[] = [], dirs: string[] = [];
function ledger(path = ":memory:", now?: () => number): TalkLedger {
  const l = new TalkLedger(path, now); ledgers.push(l); return l;
}
afterEach(() => { for (const l of ledgers.splice(0)) { try { l.close(); } catch {} } for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function receive(l: TalkLedger, message: TalkMessage, r = room(message.room), instance = config.instance): string {
  l.ingest(instance, r, [message], message.id); return eventId(instance, message);
}
function origin(l: TalkLedger, extra: Partial<Conversation> = {}): Conversation {
  return l.createConversation({ instance: config.instance, room: "group", threadId: null,
    triggerName: "github-worker", sessionKey: "repo:42", ...extra });
}
function ask(l: TalkLedger, owner = origin(l), id = 10, extra: { body?: string; taskId?: number; expectedUser?: string; threadId?: number } = {}) {
  const out = l.prepareSend({ instance: config.instance, room: "room1", threadId: extra.threadId ?? null,
    conversationId: owner.id, body: extra.body ?? "Deploy to staging?",
    request: { originTrigger: owner.triggerName, originSessionKey: owner.sessionKey, expectedUser: extra.expectedUser ?? "max",
      taskId: extra.taskId ?? 42, blocking: true } });
  l.markSending(out.id);
  return { out, owner, sent: msg(id, { actorId: "atlas", text: out.body, message: out.body, referenceId: out.referenceId,
    threadId: extra.threadId ?? null }) };
}

describe("durable Talk receive and addressing", () => {
  test("message revisions and room/account namespaces deduplicate independently", () => {
    const l = ledger(), one = msg(1);
    expect(l.ingest(config.instance, room(), [one, one], 1)).toBe(1);
    expect(l.ingest(config.instance, room(), [{ ...one, messageParameters: { reactionCount: 4 } }], 1)).toBe(0);
    receive(l, msg(1, { room: "other" }));
    receive(l, one, room(), "other:atlas");
    expect(l.pendingEvents(config.instance)).toHaveLength(2);
    expect(l.pendingEvents("other:atlas")).toHaveLength(1);
    const edit = { ...one, text: "corrected", editedAt: 200 };
    receive(l, edit);
    expect(l.getEvent(eventId(config.instance, one))?.reason).toBe("superseded-revision");
    expect(l.getEvent(eventId(config.instance, edit))?.status).toBe("pending");
    receive(l, one);
    expect(l.readMessage(config.instance, "room1", 1)?.text).toBe("corrected");
  });

  test("message page and receive cursor commit together, including restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "talk-ledger-")); dirs.push(dir);
    const path = join(dir, "talk.db"), l = ledger(path);
    receive(l, msg(1));
    expect(() => l.ingest(config.instance, room(), [msg(2), msg(3, { room: "wrong" })], 3)).toThrow();
    expect(l.readMessage(config.instance, "room1", 2)).toBeNull();
    expect(l.getCursor(config.instance, "room1")).toBe(1);
    l.close();
    const restored = ledger(path);
    expect(restored.getCursor(config.instance, "room1")).toBe(1);
    expect(restored.pendingEvents(config.instance)).toHaveLength(1);
  });

  test("bootstrap history is context only; subsequent unread messages wake a worker", async () => {
    const l = ledger();
    l.ingest(config.instance, room(), [msg(1)], 1, { historyOnly: true });
    receive(l, msg(2));
    await routePending(l, config);
    expect(l.deliveries()).toHaveLength(1);
    expect(JSON.parse(l.deliveries()[0].payload).context.messages[0].id).toBe(1);
  });

  test("DMs continue a stable session; passive group traffic stays in history", async () => {
    const l = ledger();
    receive(l, msg(1)); receive(l, msg(2));
    receive(l, msg(3, { room: "group" }), room("group", 2));
    await routePending(l, config);
    expect(l.deliveries()).toHaveLength(2);
    expect(new Set(l.deliveries().map((d) => d.sessionKey)).size).toBe(1);
    expect(l.getEvent(eventId(config.instance, msg(3, { room: "group" })))?.reason).toBe("passive-room-message");
  });

  test("two rooms and native threads never mix history or owner", async () => {
    const l = ledger();
    for (const [id, token, thread] of [[10, "group", 10], [20, "group", 20], [30, "other", 10]] as const) {
      receive(l, msg(id, { room: token, threadId: thread, message: "@atlas help", text: `topic ${id}` }), room(token, 2));
    }
    await routePending(l, config);
    const owners = [l.lookup(config.instance, "group", "thread", 10), l.lookup(config.instance, "group", "thread", 20), l.lookup(config.instance, "other", "thread", 10)];
    expect(new Set(owners.map((o) => o?.id)).size).toBe(3);
    receive(l, msg(40, { room: "group", threadId: 10, text: "followup" }), room("group", 2));
    await routePending(l, config);
    const last = l.deliveries().find((d) => d.eventId === eventId(config.instance, msg(40, { room: "group", threadId: 10, text: "followup" })))!;
    expect(last.conversationId).toBe(owners[0]!.id);
    expect(last.payload).not.toContain("topic 20"); expect(last.payload).not.toContain("topic 30");
  });

  test("explicit cross-thread quote retains destination thread ownership", async () => {
    const l = ledger(), a = origin(l, { room: "group" }), b = origin(l, { room: "group", sessionKey: "other" });
    l.bindThread(config.instance, "group", 10, a.id); l.bindThread(config.instance, "group", 20, b.id);
    l.bind(config.instance, "group", "message", 11, a.id);
    receive(l, msg(21, { room: "group", threadId: 20, parentId: 11 }), room("group", 2));
    await routePending(l, config);
    expect(l.deliveries()[0].conversationId).toBe(a.id);
    expect(l.lookup(config.instance, "group", "thread", 20)?.id).toBe(b.id);
    expect(JSON.parse(l.deliveries()[0].payload).address.threadId).toBe(20);
  });

  test("closed or expired passive thread does not wake; an explicit reply reopens it", async () => {
    let now = 100; const l = ledger(":memory:", () => now), owner = origin(l, { room: "group" });
    l.bindThread(config.instance, "group", 10, owner.id);
    l.bind(config.instance, "group", "message", 10, owner.id);
    l.updateConversation(owner.id, { state: "closed" }); now += 4_000_000;
    receive(l, msg(20, { room: "group", threadId: 10 }), room("group", 2));
    receive(l, msg(21, { room: "group", threadId: 10, parentId: 10 }), room("group", 2));
    await routePending(l, config);
    expect(l.deliveries()).toHaveLength(1);
    expect(l.getConversation(owner.id)?.state).toBe("active");
  });

  test("short mainline followups require one recent topic and the same participant", async () => {
    let now = 100; const l = ledger(":memory:", () => now);
    receive(l, msg(1, { room: "group", message: "@atlas help" }), room("group", 2));
    await routePending(l, config);
    const owner = l.deliveries()[0].conversationId;
    receive(l, msg(2, { room: "group", text: "and use staging" }), room("group", 2));
    receive(l, msg(3, { room: "group", actorId: "eve", text: "unrelated team chat" }), room("group", 2));
    await routePending(l, config);
    expect(l.deliveries()).toHaveLength(2);
    expect(l.deliveries().every(d => d.conversationId === owner)).toBe(true);
    now += 30 * 60_000 + 1;
    receive(l, msg(4, { room: "group", text: "much later" }), room("group", 2)); await routePending(l, config);
    expect(l.deliveries()).toHaveLength(2);
  });

  test("multiple active mainline topics leave an unaddressed followup in history", async () => {
    const l = ledger();
    receive(l, msg(1, { room: "group", message: "@atlas first topic" }), room("group", 2));
    receive(l, msg(2, { room: "group", message: "@atlas independent topic" }), room("group", 2));
    await routePending(l, config);
    expect(l.deliveries()).toHaveLength(2);
    receive(l, msg(3, { room: "group", text: "yes" }), room("group", 2)); await routePending(l, config);
    expect(l.deliveries()).toHaveLength(2);
  });

  test("separate thread child receives handoff/opening; same-task thread keeps owner", async () => {
    const l = ledger(), owner = origin(l), child = origin(l, { sessionKey: "child", handoff: "Investigate only the test failure." });
    const out = l.prepareSend({ instance: config.instance, room: "group", threadId: null, conversationId: owner.id, body: "Continue release", title: "Release" });
    l.markSending(out.id); l.confirmSend(out.id, msg(10, { room: "group", actorId: "atlas", text: out.body, referenceId: out.referenceId, threadId: 10 }));
    expect(l.lookup(config.instance, "group", "thread", 10)?.id).toBe(owner.id);
    l.bindThread(config.instance, "group", 20, child.id);
    l.ingest(config.instance, room("group", 2), [msg(20, { room: "group", threadId: 20, actorId: "atlas", text: "Opening investigation" })], 20, { historyOnly: true });
    receive(l, msg(21, { room: "group", threadId: 20 }), room("group", 2));
    await routePending(l, config);
    const payload = JSON.parse(l.deliveries()[0].payload);
    expect(payload.context.handoff).toContain("Investigate only");
    expect(payload.context.messages[0].text).toBe("Opening investigation");
    expect(l.deliveries()[0].sessionKey).toBe("child");
  });
});

describe("durable proactive questions", () => {
  test("quoted answer resumes its original trigger/session once, without a reminder", async () => {
    const l = ledger(), q = ask(l); l.confirmSend(q.out.id, q.sent);
    expect(l.hasPendingQuestion("github-worker", "repo:42", 42)).toBe(true);
    const answer = msg(11, { text: "staging", parentId: 10 }); receive(l, answer);
    await routePending(l, config); receive(l, answer); await routePending(l, config);
    expect(l.deliveries()).toHaveLength(1);
    expect(l.deliveries()[0].triggerName).toBe("github-worker");
    expect(l.deliveries()[0].sessionKey).toBe("repo:42");
    expect(l.getQuestion(q.out.requestId!)?.answerMessageId).toBe(11);
    expect(l.hasPendingQuestion("github-worker", "repo:42", 42)).toBe(false);
  });

  test("question anchors accept only the expected stable user ID", async () => {
    const l = ledger(), q = ask(l); l.confirmSend(q.out.id, q.sent);
    receive(l, msg(11, { actorId: "eve", parentId: 10 })); await routePending(l, config);
    expect(l.deliveries()).toHaveLength(0);
    expect(l.getQuestion(q.out.requestId!)?.state).toBe("pending");
  });

  test("fast reply waits until the send anchor is committed", async () => {
    const l = ledger(), q = ask(l);
    const answer = msg(11, { parentId: 10 }); receive(l, answer);
    expect((await routePending(l, config))[0].path).toBe("awaiting-send-reconciliation");
    expect(l.deliveries()).toHaveLength(0);
    expect(l.hasPendingQuestion("github-worker", "repo:42", 42)).toBe(false);
    l.confirmSend(q.out.id, q.sent); await routePending(l, config);
    expect(l.deliveries()[0].sessionKey).toBe("repo:42");
  });

  test("quoted parent reference reconciles a send before its HTTP response", async () => {
    const l = ledger(), q = ask(l);
    receive(l, msg(11, { parentId: 10, parent: q.sent })); await routePending(l, config);
    expect(l.getOutbound(q.out.id)?.state).toBe("sent");
    expect(l.getQuestion(q.out.requestId!)?.state).toBe("resolved");
    expect(l.deliveries()).toHaveLength(1);
  });

  test("timeout is uncertain, not permission to stop or resend; own echo reconciles without wake", async () => {
    const l = ledger(), q = ask(l); l.markSendUncertain(q.out.id, "timeout after POST");
    expect(l.markSending(q.out.id)).toBe(false);
    expect(l.hasPendingQuestion("github-worker", "repo:42", 42)).toBe(false);
    receive(l, q.sent); await routePending(l, config);
    expect(l.getOutbound(q.out.id)?.state).toBe("sent");
    expect(l.hasPendingQuestion("github-worker", "repo:42", 42)).toBe(true);
    expect(l.deliveries()).toHaveLength(0);
  });

  test("a permanently uncertain send does not hold all DM conversation forever", async () => {
    let now = 100; const l = ledger(":memory:", () => now), q = ask(l);
    l.markSendUncertain(q.out.id, "connection lost");
    receive(l, msg(11, { text: "hello?" })); await routePending(l, config);
    expect(l.deliveries()).toHaveLength(0);
    now += 30_001; await routePending(l, config);
    expect(l.deliveries()).toHaveLength(1);
    expect(l.deliveries()[0].triggerName).toBe("talk-worker");
    expect(JSON.parse(l.deliveries()[0].payload).reason).toBe("send-outcome-uncertain");
    expect(l.getQuestion(q.out.requestId!)?.state).toBe("preparing");
    expect(l.hasPendingQuestion("github-worker", "repo:42", 42)).toBe(false);
  });

  test("two same-user questions never let unquoted yes approve an arbitrary task", async () => {
    const l = ledger(), a = ask(l), b = ask(l, origin(l, { sessionKey: "repo:99" }), 20, { taskId: 99, body: "Delete staging?" });
    l.confirmSend(a.out.id, a.sent); l.confirmSend(b.out.id, b.sent);
    receive(l, msg(21, { text: "yes" })); await routePending(l, config);
    expect(l.getQuestion(a.out.requestId!)?.state).toBe("pending");
    expect(l.getQuestion(b.out.requestId!)?.state).toBe("pending");
    expect(l.deliveries()[0].triggerName).toBe("talk-worker");
    const payload = JSON.parse(l.deliveries()[0].payload);
    expect(payload.reason).toBe("question-ambiguous"); expect(payload.ambiguousRequests).toHaveLength(2);
    receive(l, msg(22, { parentId: 20, text: "yes to deleting staging" })); await routePending(l, config);
    expect(l.getQuestion(a.out.requestId!)?.state).toBe("pending");
    expect(l.getQuestion(b.out.requestId!)?.state).toBe("resolved");
  });

  test("one recent question with the current DM context accepts an unquoted answer", async () => {
    const l = ledger(), q = ask(l); l.confirmSend(q.out.id, q.sent);
    receive(l, msg(11, { text: "staging please" })); await routePending(l, config);
    expect(l.getQuestion(q.out.requestId!)?.state).toBe("resolved");
    expect(JSON.parse(l.deliveries()[0].payload).reason).toBe("question-answer-context");
  });

  test("correlated answer does not export unrelated private DM history to the task owner", async () => {
    const l = ledger();
    const privateOwner = l.createConversation({ instance: config.instance, room: "room1", threadId: null,
      summary: "Private personal note", handoff: "Unrelated personal information" });
    l.bind(config.instance, "room1", "direct", "main", privateOwner.id);
    l.ingest(config.instance, room(), [msg(1, { text: "Unrelated sensitive conversation" })], 1, { historyOnly: true });
    const q = l.prepareSend({ instance: config.instance, room: "room1", threadId: null, conversationId: privateOwner.id, body: "Use staging?",
      request: { originTrigger: "github-worker", originSessionKey: "external", taskId: 42, blocking: true, expectedUser: "max" } });
    l.confirmSend(q.id, msg(10, { actorId: "atlas", text: q.body, referenceId: q.referenceId }));
    receive(l, msg(11, { text: "yes", parentId: 10 })); await routePending(l, config);
    const delivery = l.deliveries()[0], payload = JSON.parse(delivery.payload);
    expect(delivery.sessionKey).toBe("external");
    expect(payload.context.messages).toEqual([]);
    expect(delivery.payload).not.toContain("Unrelated"); expect(delivery.payload).not.toContain("Private personal note");
    expect(payload.request.prompt).toBe("Use staging?"); expect(payload.message.text).toBe("yes");
    expect(l.contextCursor(privateOwner.id, { instance: config.instance, room: "room1", threadId: null })).toBe(0);
  });

  test("named question thread is recorded from server metadata and never guessed", () => {
    const l = ledger(), owner = origin(l);
    const out = l.prepareSend({ instance: config.instance, room: "room1", threadId: null, conversationId: owner.id,
      body: "Which deploy target?", title: "Deployment", request: { originTrigger: owner.triggerName, originSessionKey: owner.sessionKey, expectedUser: "max", taskId: 42, blocking: true } });
    l.markSending(out.id);
    expect(() => l.confirmSend(out.id, msg(10, { actorId: "atlas", referenceId: out.referenceId }))).toThrow("native thread");
    expect(l.getQuestion(out.requestId!)?.state).toBe("preparing");
    l.confirmSend(out.id, msg(10, { actorId: "atlas", referenceId: out.referenceId, threadId: 10 }));
    expect(l.getQuestion(out.requestId!)?.threadId).toBe(10);
  });

  test("late answer to finished task stays in the private conversation", async () => {
    const l = ledger(), q = ask(l); l.confirmSend(q.out.id, q.sent);
    receive(l, msg(11, { parentId: 10 })); await routePending(l, config, { isTaskActive: () => false });
    expect(l.getQuestion(q.out.requestId!)?.state).toBe("cancelled");
    expect(l.deliveries()[0].triggerName).toBe("talk-worker");
    expect(JSON.parse(l.deliveries()[0].payload).reason).toBe("question-no-longer-active");
  });

  test("failed sends cannot satisfy Stop; read-only Stop lookup survives restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "talk-stop-")); dirs.push(dir);
    const path = join(dir, "talk.db"), l = ledger(path), a = ask(l);
    l.markSendFailed(a.out.id, "forbidden");
    expect(pendingQuestionTaskIds("github-worker", "repo:42", path)).toEqual([]);
    const b = ask(l, a.owner, 20); l.confirmSend(b.out.id, b.sent);
    expect(pendingQuestionTaskIds("github-worker", "repo:42", path)).toEqual([42]);
    expect(pendingQuestionTaskIds("github-worker", "other", path)).toEqual([]);
    l.cancelQuestion(b.out.requestId!);
    expect(pendingQuestionTaskIds("github-worker", "repo:42", path)).toEqual([]);
  });

  test("waiting fast answers cannot starve newly received own echoes", async () => {
    const l = ledger(), q = ask(l);
    for (let i = 11; i <= 110; i++) receive(l, msg(i, { parentId: 10 }));
    await routePending(l, config);
    receive(l, q.sent); await routePending(l, config);
    expect(l.getOutbound(q.out.id)?.state).toBe("sent");
  });
});

describe("delivery, isolation and bounded context", () => {
  test("leases recover, accepted deliveries serialize each owner, global cap applies", async () => {
    let now = 100; const l = ledger(":memory:", () => now);
    receive(l, msg(1)); receive(l, msg(2)); receive(l, msg(1, { room: "second" }));
    await routePending(l, config);
    const first = l.claimDelivery({ maxConcurrent: 1, leaseMs: 1_000 })!;
    expect(l.claimDelivery({ maxConcurrent: 1 })).toBeNull();
    now += 1_001;
    const recovered = l.claimDelivery({ maxConcurrent: 1 })!;
    expect(recovered.id).toBe(first.id); expect(recovered.attempts).toBe(2);
    expect(l.acceptDelivery(first.id, first.leaseToken!)).toBe(false);
    expect(l.acceptDelivery(recovered.id, recovered.leaseToken!)).toBe(true);
    const other = l.claimDelivery({ maxConcurrent: 2 })!;
    expect(other.sessionKey).not.toBe(first.sessionKey);
    expect(l.claimDelivery({ maxConcurrent: 4 })).toBeNull();
    l.completeDelivery(first.id);
    expect(l.claimDelivery({ maxConcurrent: 4 })?.sessionKey).toBe(first.sessionKey);
  });

  test("lost runner receipt releases the same delivery identity for safe retry", async () => {
    const l = ledger(); receive(l, msg(1)); await routePending(l, config);
    const d = l.claimDelivery()!; l.acceptDelivery(d.id, d.leaseToken!);
    l.releaseDelivery(d.id, "runner crashed before completion");
    expect(l.claimDelivery()?.eventId).toBe(d.eventId);
  });

  test("revoked room cancels pending worker deliveries and pending questions", async () => {
    const l = ledger(), q = ask(l); l.confirmSend(q.out.id, q.sent);
    receive(l, msg(11, { text: "other user message", actorId: "another" })); await routePending(l, config);
    l.revokeRoom(config.instance, "room1");
    expect(l.claimDelivery()).toBeNull(); expect(l.getQuestion(q.out.requestId!)?.state).toBe("cancelled");
  });

  test("outgoing reply may retain an anchor owner without taking over a different thread", () => {
    const l = ledger(), a = origin(l), b = origin(l, { sessionKey: "other" });
    l.bindThread(config.instance, "group", 20, b.id);
    const out = l.prepareSend({ instance: config.instance, room: "group", threadId: 20,
      replyTo: 21, conversationId: a.id, body: "Answer in the quoted message's actual thread" });
    l.confirmSend(out.id, msg(22, { room: "group", actorId: "atlas", threadId: 20, parentId: 21, referenceId: out.referenceId }));
    expect(l.lookup(config.instance, "group", "message", 22)?.id).toBe(a.id);
    expect(l.lookup(config.instance, "group", "thread", 20)?.id).toBe(b.id);
  });

  test("retention expires all terminal raw copies but keeps IDs, pending work and question anchors", async () => {
    let now = 100; const l = ledger(":memory:", () => now);
    const first = msg(1, { text: "old private body" }); receive(l, first); await routePending(l, config);
    const d = l.claimDelivery()!; l.acceptDelivery(d.id, d.leaseToken!); l.completeDelivery(d.id);
    const q = ask(l); l.confirmSend(q.out.id, q.sent);
    receive(l, msg(20, { text: "not processed yet" }));
    now += 31 * 86_400_000;
    expect(l.prune()).toBe(1);
    expect(l.readMessage(config.instance, "room1", 1)).toBeNull();
    expect(l.getEvent(eventId(config.instance, first))?.message.text).toBe("");
    expect(l.getDelivery(d.id)?.payload).toBe("{}");
    expect(l.lookup(config.instance, "room1", "message", 1)?.id).toBe(d.conversationId);
    expect(l.readMessage(config.instance, "room1", 10)?.text).toBe(q.out.body);
    expect(l.readMessage(config.instance, "room1", 20)?.text).toBe("not processed yet");
    receive(l, first); expect(l.getEvent(eventId(config.instance, first))?.status).toBe("routed");
  });

  test("context and current-message byte budgets hold for Unicode and escaped text", () => {
    const l = ledger(), owner = origin(l, { room: "room1", summary: "😀\"\n".repeat(4_000), handoff: "x".repeat(20_000) });
    for (let i = 1; i <= 20; i++) receive(l, msg(i, { text: "😀\"\n".repeat(500) }));
    const current = msg(21, { text: "😀\"\n".repeat(10_000) }), id = receive(l, current);
    const payload = JSON.parse(buildDeliveryPayload(l, config, l.getEvent(id)!, owner, "direct-message"));
    expect(Buffer.byteLength(JSON.stringify(payload.context))).toBeLessThanOrEqual(6_000);
    expect(Buffer.byteLength(JSON.stringify(payload.message))).toBeLessThanOrEqual(8_000);
    expect(payload.message.truncated).toBe(true);
    expect(l.readMessage(config.instance, "room1", 21)?.text).toBe(current.text);
    expect(clipToTokenBudget("😀abc", 3)).toBe(""); expect(clipToTokenBudget("😀abc", 5)).toBe("😀a");
  });

  test("classifier sees bounded same-room summaries and deterministic paths bypass it", async () => {
    const l = ledger(), a = origin(l, { room: "group", summary: "group topic" });
    origin(l, { room: "private", summary: "private secret" });
    receive(l, msg(1, { room: "group", message: "@atlas continue", text: "continue" }), room("group", 2));
    let calls = 0;
    const classify = async ({ candidates }: any) => { calls++; expect(candidates.map((c: any) => c.id)).toEqual([a.id]); return { kind: "existing" as const, conversationId: a.id }; };
    await routePending(l, config, { classify });
    expect(l.deliveries()[0].conversationId).toBe(a.id);
    receive(l, msg(2, { room: "group", parentId: 1 }), room("group", 2));
    await routePending(l, config, { classify }); expect(calls).toBe(1);
    for (let i = 0; i < 15; i++) origin(l, { room: "group", summary: "😀".repeat(5_000) });
    const candidates = classifierCandidates(l, config.instance, "group");
    expect(candidates.length).toBeLessThanOrEqual(10);
    expect(Buffer.byteLength(JSON.stringify(candidates))).toBeLessThanOrEqual(2_000);
    expect(JSON.stringify(candidates)).not.toContain("private secret");
  });

  test("classifier cannot route across rooms and failure starts independent work", async () => {
    const l = ledger(), a = origin(l, { room: "group" }), privateOwner = origin(l, { room: "private" });
    receive(l, msg(1, { room: "group", message: "@atlas help" }), room("group", 2));
    await routePending(l, config, { classify: async () => ({ kind: "existing", conversationId: privateOwner.id }) });
    expect(l.deliveries()[0].conversationId).not.toBe(privateOwner.id);
    expect(l.deliveries()[0].conversationId).not.toBe(a.id);
  });

  test("deterministic DMs are routed while cold classification waits, with one classifier per pass", async () => {
    const l = ledger(); origin(l, { room: "group" });
    receive(l, msg(1, { room: "group", message: "@atlas first" }), room("group", 2));
    receive(l, msg(2, { room: "group", message: "@atlas second" }), room("group", 2));
    let release!: () => void, calls = 0;
    const classify = async () => { calls++; await new Promise<void>(done => { release = done; }); return { kind: "new" as const }; };
    const background = routePending(l, config, { classify });
    receive(l, msg(3, { text: "urgent DM" }));
    routeDeterministicPending(l, config, { classify });
    expect(l.deliveries().some(d => JSON.parse(d.payload).message.text === "urgent DM")).toBe(true);
    expect(calls).toBe(1); release(); await background;
    expect(l.pendingEvents(config.instance)).toHaveLength(1);
  });
});
